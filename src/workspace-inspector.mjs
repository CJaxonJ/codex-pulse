import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILES = 2_000;
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
const MAX_FINGERPRINT_MS = 2_200;
const MAX_FALLBACK_ENTRIES = 20_000;
const MAX_FALLBACK_CONTENT_BYTES = 20 * 1024 * 1024;
const FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  ".cache",
]);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: 1_500,
    killSignal: "SIGKILL",
  });
  return stdout;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function hashUntracked(cwd, list, startedAt) {
  const names = list.split("\0").filter(Boolean);
  if (names.length > MAX_UNTRACKED_FILES) {
    throw new Error("too many untracked files to fingerprint safely");
  }
  const root = path.resolve(cwd);
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const name of names) {
    if (Date.now() - startedAt > MAX_FINGERPRINT_MS) {
      throw new Error("workspace fingerprint timed out");
    }
    const filePath = path.resolve(root, name);
    if (!inside(root, filePath)) throw new Error("untracked path escaped workspace");
    const details = await lstat(filePath);
    hash.update(name).update("\0");
    if (details.isSymbolicLink()) {
      hash.update("symlink\0").update(await readlink(filePath)).update("\0");
      continue;
    }
    if (!details.isFile()) throw new Error("unsupported untracked entry");
    totalBytes += details.size;
    if (totalBytes > MAX_UNTRACKED_BYTES) {
      throw new Error("untracked content exceeds safe fingerprint limit");
    }
    hash.update("file\0").update(await readFile(filePath)).update("\0");
  }
  return hash.digest("hex");
}

async function filesystemFingerprint(cwd) {
  const startedAt = Date.now();
  const root = path.resolve(cwd);
  const queue = [""];
  const hash = createHash("sha256");
  let entries = 0;
  let contentBytes = 0;

  while (queue.length) {
    if (Date.now() - startedAt > MAX_FINGERPRINT_MS) {
      throw new Error("filesystem fingerprint timed out");
    }
    const relativeDirectory = queue.shift();
    const absoluteDirectory = path.join(root, relativeDirectory);
    const children = await readdir(absoluteDirectory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (relativeDirectory === "" && FALLBACK_EXCLUDED_DIRECTORIES.has(child.name)) {
        continue;
      }
      entries += 1;
      if (entries > MAX_FALLBACK_ENTRIES) {
        throw new Error("filesystem fingerprint entry limit exceeded");
      }
      const relative = path.join(relativeDirectory, child.name);
      const absolute = path.resolve(root, relative);
      if (!inside(root, absolute)) throw new Error("filesystem path escaped workspace");
      const details = await lstat(absolute);
      hash
        .update(relative)
        .update("\0")
        .update(String(details.mode))
        .update("\0")
        .update(String(details.size))
        .update("\0")
        .update(String(details.mtimeMs))
        .update("\0");
      if (details.isDirectory()) {
        queue.push(relative);
      } else if (details.isSymbolicLink()) {
        hash.update("symlink\0").update(await readlink(absolute)).update("\0");
      } else if (details.isFile() && contentBytes + details.size <= MAX_FALLBACK_CONTENT_BYTES) {
        hash.update("file\0").update(await readFile(absolute)).update("\0");
        contentBytes += details.size;
      }
    }
  }
  return `fs:${hash.digest("hex")}`;
}

export class WorkspaceInspector {
  async exists(cwd) {
    try {
      await access(cwd);
      return true;
    } catch {
      return false;
    }
  }

  async fingerprint(cwd, options = {}) {
    if (options.strategy === "filesystem") {
      try {
        return await filesystemFingerprint(cwd);
      } catch {
        return null;
      }
    }
    try {
      const startedAt = Date.now();
      const [head, status, diff, untracked] = await Promise.all([
        git(cwd, ["rev-parse", "HEAD"]),
        git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
        git(cwd, ["diff", "--binary", "HEAD"]),
        git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      const untrackedHash = await hashUntracked(cwd, untracked, startedAt);
      if (Date.now() - startedAt > MAX_FINGERPRINT_MS) {
        throw new Error("workspace fingerprint timed out");
      }
      return createHash("sha256")
        .update(head)
        .update(status)
        .update(diff)
        .update(untrackedHash)
        .digest("hex");
    } catch {
      try {
        return await filesystemFingerprint(cwd);
      } catch {
        return null;
      }
    }
  }
}
