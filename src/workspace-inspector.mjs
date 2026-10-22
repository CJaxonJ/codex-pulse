import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const MAX_UNTRACKED_FILES = 10_000;
const MAX_UNTRACKED_BYTES = 20 * 1024 * 1024;
const MAX_FINGERPRINT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
const MAX_FALLBACK_ENTRIES = 20_000;
const MAX_FALLBACK_CONTENT_BYTES = 20 * 1024 * 1024;
const FINGERPRINT_ATTEMPTS = 2;
const FINGERPRINT_RETRY_DELAY_MS = 25;
const FALLBACK_EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  ".cache",
]);

class FingerprintError extends Error {
  constructor(code, cause = null) {
    super(code, cause ? { cause } : undefined);
    this.fingerprintCode = code;
  }
}

function fingerprintError(code, error) {
  if (error instanceof FingerprintError) return error;
  return new FingerprintError(code, error);
}

function transientEntryError(error) {
  if (error?.code === "ENOENT" || error?.code === "ESTALE") {
    return fingerprintError("workspace_changed_during_scan", error);
  }
  return error;
}

function failureReason(error, fallback) {
  if (error?.fingerprintCode) return error.fingerprintCode;
  if (error?.code === "ENOENT" || error?.code === "ESTALE") {
    return "workspace_changed_during_scan";
  }
  if (error?.code === "ETIMEDOUT" || error?.signal === "SIGKILL") {
    return "fingerprint_timeout";
  }
  return fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryFingerprint(strategy, fallbackReason, operation) {
  let lastError;
  for (let attempt = 1; attempt <= FINGERPRINT_ATTEMPTS; attempt += 1) {
    try {
      return { ok: true, value: await operation(), failure: null };
    } catch (error) {
      lastError = error;
      if (attempt < FINGERPRINT_ATTEMPTS) {
        await delay(FINGERPRINT_RETRY_DELAY_MS);
      }
    }
  }
  return {
    ok: false,
    value: null,
    failure: {
      strategy,
      reason: failureReason(lastError, fallbackReason),
      attempts: FINGERPRINT_ATTEMPTS,
    },
  };
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return stdout;
}

async function gitRoot(candidate) {
  try {
    const details = await lstat(candidate);
    const cwd = details.isDirectory() ? candidate : path.dirname(candidate);
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    try {
      return (await git(path.dirname(candidate), ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      return null;
    }
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function hashUntracked(cwd, list, startedAt) {
  const names = list.split("\0").filter(Boolean);
  if (names.length > MAX_UNTRACKED_FILES) {
    throw new FingerprintError("untracked_file_limit");
  }
  const root = path.resolve(cwd);
  const hash = createHash("sha256");
  let totalBytes = 0;
  for (const name of names) {
    if (Date.now() - startedAt > MAX_FINGERPRINT_MS) {
      throw new FingerprintError("fingerprint_timeout");
    }
    const filePath = path.resolve(root, name);
    if (!inside(root, filePath)) throw new FingerprintError("path_outside_workspace");
    let details;
    try {
      details = await lstat(filePath);
    } catch (error) {
      throw transientEntryError(error);
    }
    hash.update(name).update("\0");
    if (details.isSymbolicLink()) {
      try {
        hash.update("symlink\0").update(await readlink(filePath)).update("\0");
      } catch (error) {
        throw transientEntryError(error);
      }
      continue;
    }
    if (!details.isFile()) throw new FingerprintError("unsupported_untracked_entry");
    totalBytes += details.size;
    if (totalBytes > MAX_UNTRACKED_BYTES) {
      throw new FingerprintError("untracked_content_limit");
    }
    try {
      hash.update("file\0").update(await readFile(filePath)).update("\0");
    } catch (error) {
      throw transientEntryError(error);
    }
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
      throw new FingerprintError("fingerprint_timeout");
    }
    const relativeDirectory = queue.shift();
    const absoluteDirectory = path.join(root, relativeDirectory);
    let children;
    try {
      children = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      throw transientEntryError(error);
    }
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (relativeDirectory === "" && FALLBACK_EXCLUDED_DIRECTORIES.has(child.name)) {
        continue;
      }
      entries += 1;
      if (entries > MAX_FALLBACK_ENTRIES) {
        throw new FingerprintError("filesystem_entry_limit");
      }
      const relative = path.join(relativeDirectory, child.name);
      const absolute = path.resolve(root, relative);
      if (!inside(root, absolute)) throw new FingerprintError("path_outside_workspace");
      let details;
      try {
        details = await lstat(absolute);
      } catch (error) {
        throw transientEntryError(error);
      }
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
        try {
          hash.update("symlink\0").update(await readlink(absolute)).update("\0");
        } catch (error) {
          throw transientEntryError(error);
        }
      } else if (details.isFile() && contentBytes + details.size <= MAX_FALLBACK_CONTENT_BYTES) {
        try {
          hash.update("file\0").update(await readFile(absolute)).update("\0");
        } catch (error) {
          throw transientEntryError(error);
        }
        contentBytes += details.size;
      }
    }
  }
  return `fs:${hash.digest("hex")}`;
}

async function gitFingerprint(cwd) {
  const startedAt = Date.now();
  const [head, status, diff, untracked] = await Promise.all([
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    git(cwd, ["diff", "--binary", "HEAD"]),
    git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const untrackedHash = await hashUntracked(cwd, untracked, startedAt);
  if (Date.now() - startedAt > MAX_FINGERPRINT_MS) {
    throw new FingerprintError("fingerprint_timeout");
  }
  return createHash("sha256")
    .update(head)
    .update(status)
    .update(diff)
    .update(untrackedHash)
    .digest("hex");
}

export class WorkspaceInspector {
  constructor() {
    this.lastFingerprintFailure = null;
  }

  failureDiagnostic() {
    if (!this.lastFingerprintFailure) return null;
    return {
      type: this.lastFingerprintFailure.type,
      failures: this.lastFingerprintFailure.failures.map((failure) => ({ ...failure })),
    };
  }

  async exists(cwd) {
    try {
      await access(cwd);
      return true;
    } catch {
      return false;
    }
  }

  async fingerprint(cwd, options = {}) {
    this.lastFingerprintFailure = null;
    if (options.strategy === "filesystem") {
      const result = await retryFingerprint(
        "filesystem",
        "filesystem_scan_failed",
        () => filesystemFingerprint(cwd),
      );
      if (result.ok) return result.value;
      this.lastFingerprintFailure = {
        type: "workspace_fingerprint_failed",
        failures: [result.failure],
      };
      return null;
    }
    const gitResult = await retryFingerprint("git", "git_scan_failed", () =>
      gitFingerprint(cwd),
    );
    if (gitResult.ok) return gitResult.value;
    const filesystemResult = await retryFingerprint(
      "filesystem",
      "filesystem_scan_failed",
      () => filesystemFingerprint(cwd),
    );
    if (filesystemResult.ok) return filesystemResult.value;
    this.lastFingerprintFailure = {
      type: "workspace_fingerprint_failed",
      failures: [gitResult.failure, filesystemResult.failure],
    };
    return null;
  }

  async snapshot(cwd, options = {}) {
    let base;
    try {
      base = await realpath(path.resolve(cwd));
    } catch (error) {
      this.lastFingerprintFailure = {
        type: "workspace_fingerprint_failed",
        failures: [{
          strategy: "scope",
          reason: failureReason(error, "scope_unavailable"),
          attempts: 1,
        }],
      };
      return null;
    }
    const hints = [...new Set((options.hints || []).map((hint) => String(hint)).filter(Boolean))];
    const scopeRoots = new Set();

    for (const hint of hints) {
      const candidate = path.resolve(base, hint);
      if (!inside(base, candidate)) continue;
      const root = await gitRoot(candidate);
      if (root && inside(base, path.resolve(root))) scopeRoots.add(path.resolve(root));
    }
    if (!scopeRoots.size) scopeRoots.add(base);

    const scopes = [];
    for (const root of [...scopeRoots].sort()) {
      const fingerprint = await this.fingerprint(root);
      if (fingerprint == null) return null;
      scopes.push({
        root: path.relative(base, root) || ".",
        fingerprint,
      });
    }
    const digest = createHash("sha256").update(JSON.stringify(scopes)).digest("hex");
    return { version: 1, digest, scopes };
  }

  async compareSnapshot(cwd, snapshot) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.scopes)) {
      return {
        verifiable: false,
        same: false,
        changedScopes: [],
        failure: {
          type: "workspace_fingerprint_failed",
          failures: [{ strategy: "scope", reason: "invalid_snapshot", attempts: 1 }],
        },
      };
    }
    let base;
    try {
      base = await realpath(path.resolve(cwd));
    } catch (error) {
      const failure = {
        type: "workspace_fingerprint_failed",
        failures: [{
          strategy: "scope",
          reason: failureReason(error, "scope_unavailable"),
          attempts: 1,
        }],
      };
      this.lastFingerprintFailure = failure;
      return { verifiable: false, same: false, changedScopes: [], failure };
    }
    const currentScopes = [];
    const changedScopes = [];
    for (const scope of snapshot.scopes) {
      let root;
      try {
        root = await realpath(path.resolve(base, scope.root || "."));
      } catch {
        this.lastFingerprintFailure = {
          type: "workspace_fingerprint_failed",
          failures: [{ strategy: "scope", reason: "scope_unavailable", attempts: 1 }],
        };
        return {
          verifiable: false,
          same: false,
          changedScopes: [],
          failure: this.failureDiagnostic(),
        };
      }
      if (!inside(base, root)) {
        this.lastFingerprintFailure = {
          type: "workspace_fingerprint_failed",
          failures: [{ strategy: "scope", reason: "path_outside_workspace", attempts: 1 }],
        };
        return {
          verifiable: false,
          same: false,
          changedScopes: [],
          failure: this.failureDiagnostic(),
        };
      }
      const fingerprint = await this.fingerprint(root, {
        strategy: String(scope.fingerprint || "").startsWith("fs:")
          ? "filesystem"
          : undefined,
      });
      if (fingerprint == null) {
        return {
          verifiable: false,
          same: false,
          changedScopes: [],
          failure: this.failureDiagnostic(),
        };
      }
      currentScopes.push({ root: scope.root || ".", fingerprint });
      if (fingerprint !== scope.fingerprint) changedScopes.push(scope.root || ".");
    }
    return {
      verifiable: true,
      same: changedScopes.length === 0,
      changedScopes,
      current: {
        version: 1,
        digest: createHash("sha256").update(JSON.stringify(currentScopes)).digest("hex"),
        scopes: currentScopes,
      },
    };
  }
}
