import path from "node:path";
import { WorktreeLockManager } from "./worktree-lock-manager.mjs";
import { currentWindowsProcessIdentity } from "./windows-process-bridge.mjs";

export async function acquireWatcherInstance(dataDir) {
  const manager = new WorktreeLockManager(path.join(dataDir, "watcher-instance"), { processIdentity: currentWindowsProcessIdentity() });
  const result = await manager.acquire(dataDir, "watcher");
  if (!result.acquired) {
    const error = new Error("已有监控在运行或启动状态待核对，未重复启动。");
    error.code = "PULSE_WATCHER_BUSY"; throw error;
  }
  return () => manager.release(result.handle);
}
