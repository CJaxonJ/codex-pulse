#!/usr/bin/env node

import { WorktreeLockManager } from "../../src/worktree-lock-manager.mjs";

const [dataDir, workspace, taskId, mode = "attempt"] = process.argv.slice(2);
const manager = new WorktreeLockManager(dataDir);

try {
  const result = await manager.acquire(workspace, taskId);
  process.send?.({ ok: true, result });
  if (mode === "hold" && result.acquired) {
    const shutdown = async () => {
      await manager.release(result.handle);
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    setInterval(() => {}, 60_000);
  } else {
    if (result.acquired) await manager.release(result.handle);
    process.exit(0);
  }
} catch (error) {
  process.send?.({ ok: false, error: error.message });
  process.exit(1);
}
