import path from "node:path";
import { WorktreeLockManager } from "./worktree-lock-manager.mjs";
import { currentWindowsProcessIdentity } from "./windows-process-bridge.mjs";
import { openWindowsInstallationLease } from "./windows-installation-lease.mjs";

export async function acquireWatcherInstance(dataDir, { startupGate = true, prepare = async () => {} } = {}) {
  const gate = process.platform === "win32" && startupGate ? await openWindowsInstallationLease({ gate: true, env: { ...process.env, CODEX_PULSE_DATA_DIR: dataDir } }) : null;
  try {
  await prepare();
  const manager = new WorktreeLockManager(path.join(dataDir, "watcher-instance"), { processIdentity: currentWindowsProcessIdentity() });
  const result = await manager.acquire(dataDir, "watcher");
  if (!result.acquired) {
    const error = new Error("已有监控在运行或启动状态待核对，未重复启动。");
    error.code = "PULSE_WATCHER_BUSY"; throw error;
  }
  return () => manager.release(result.handle);
  } finally { await gate?.release(); }
}
