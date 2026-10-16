import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const INCOMPLETE_LOCK_GRACE_MS = 30_000;

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function canonicalPath(cwd) {
  try {
    return await realpath(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function lockKey(cwd) {
  return createHash("sha256").update(cwd).digest("hex");
}

export class WorktreeLockManager {
  constructor(
    dataDir,
    {
      holderId = randomUUID(),
      pid = process.pid,
      isProcessAlive = processIsAlive,
      now = () => Date.now(),
    } = {},
  ) {
    this.rootDir = path.join(dataDir, "worktree-locks");
    this.holderId = holderId;
    this.pid = pid;
    this.isProcessAlive = isProcessAlive;
    this.now = now;
  }

  async acquire(cwd, taskId) {
    const canonicalCwd = await canonicalPath(cwd);
    const key = lockKey(canonicalCwd);
    const lockDir = path.join(this.rootDir, `${key}.lock`);
    await mkdir(this.rootDir, { recursive: true });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = randomUUID();
      try {
        await mkdir(lockDir);
        const handle = {
          key,
          cwd: canonicalCwd,
          taskId,
          holderId: this.holderId,
          pid: this.pid,
          token,
          acquiredAt: this.now(),
        };
        try {
          await writeFile(
            path.join(lockDir, "owner.json"),
            `${JSON.stringify(handle, null, 2)}\n`,
            "utf8",
          );
        } catch (error) {
          await rm(lockDir, { recursive: true, force: true });
          throw error;
        }
        return { acquired: true, handle };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const owner = await this.#readOwner(lockDir);
      if (
        owner?.holderId === this.holderId &&
        owner?.taskId === taskId &&
        owner?.cwd === canonicalCwd
      ) {
        return { acquired: true, handle: owner };
      }

      if (owner && this.isProcessAlive(owner.pid)) {
        return { acquired: false, reason: "worktree_busy", owner };
      }
      if (!owner && !(await this.#incompleteLockIsStale(lockDir))) {
        return { acquired: false, reason: "worktree_lock_initializing", owner: null };
      }

      const tombstone = `${lockDir}.stale-${this.holderId}-${randomUUID()}`;
      try {
        await rename(lockDir, tombstone);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "EEXIST") continue;
        throw error;
      }
      await rm(tombstone, { recursive: true, force: true });
    }

    return { acquired: false, reason: "worktree_lock_contention", owner: null };
  }

  async release(handle) {
    if (!handle?.key || !handle?.token) return false;
    const lockDir = path.join(this.rootDir, `${handle.key}.lock`);
    const owner = await this.#readOwner(lockDir);
    if (
      owner?.holderId !== this.holderId ||
      owner?.taskId !== handle.taskId ||
      owner?.token !== handle.token
    ) {
      return false;
    }
    await rm(lockDir, { recursive: true, force: true });
    return true;
  }

  async #readOwner(lockDir) {
    try {
      return JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async #incompleteLockIsStale(lockDir) {
    try {
      const details = await stat(lockDir);
      return this.now() - details.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS;
    } catch (error) {
      return error?.code === "ENOENT";
    }
  }
}
