import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, readFile, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILES = 2_000;
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
const MAX_FINGERPRINT_MS = 2_200;

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

export class WorkspaceInspector {
  async exists(cwd) {
    try {
      await access(cwd);
      return true;
    } catch {
      return false;
    }
  }

  async fingerprint(cwd) {
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
      return null;
    }
  }
}
