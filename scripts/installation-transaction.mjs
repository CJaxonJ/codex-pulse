import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";

// All entry points share this process-owned lock, separate from task locks.
export async function lockInstallation(dataDir) {
  const manager = new WorktreeLockManager(path.join(dataDir, "installation-guard"));
  const result = await manager.acquire(dataDir, "installation");
  if (!result.acquired) throw Error("Codex Pulse 正在安装、更新或卸载，请等该操作结束后重试。");
  return () => manager.release(result.handle);
}

export function serviceLoaded(service) {
  try { execFileSync("/bin/launchctl", ["print", service], { stdio: "ignore", timeout: 15_000 }); return true; }
  catch (error) {
    // launchctl uses ESRCH/113 for a missing service. Permission failures and
    // timeouts are unknown, not evidence that a writer has stopped.
    if ([3, 113].includes(error.status)) return false;
    throw new Error("无法核对后台服务状态，未继续替换文件。", {cause:error});
  }
}

export function stopService(service, plistPath) {
  try { execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}`, plistPath], { stdio: "ignore", timeout: 15_000 }); }
  catch (error) { if (serviceLoaded(service)) throw error; }
  if (serviceLoaded(service)) throw Error("后台服务尚未停止，未替换运行文件。");
}

// Staging must finish before entry. Failed validation restores every component,
// including the native App, not just the JavaScript runtime.
export function replaceInstallation({ components, service, plistPath, activate = () => {}, verify = () => {}, rollback = () => {} }) {
  const entries = components.map(([target, staged]) => ({ target, staged,
    backup: `${target}.pulse-backup-${process.pid}`, backedUp: false, activated: false }));
  const wasRunning = serviceLoaded(service);
  let switching = false;
  try {
    for (const entry of entries) {
      const parent=path.dirname(entry.target), prefix=`${path.basename(entry.target)}.pulse-backup-`;
      if (existsSync(parent) && readdirSync(parent).some(name=>name.startsWith(prefix)))
        throw Error("发现未处理的安装备份，未覆盖备份。请先检查上次未完成的安装。");
    }
    if (wasRunning) stopService(service, plistPath);
    switching = true;
    for (const entry of entries) {
      if (existsSync(entry.target)) { renameSync(entry.target, entry.backup); entry.backedUp = true; }
      entry.activated = true;
      if (entry.staged) renameSync(entry.staged, entry.target);
    }
    activate();
    execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { timeout: 15_000 });
    execFileSync("/bin/launchctl", ["kickstart", "-k", service], { timeout: 15_000 });
    verify();
  } catch (error) {
    const failures = [];
    if (switching) {
      // Never delete files beneath a replacement service that could not stop.
      try { stopService(service, plistPath); }
      catch { throw new Error("安装失败且后台服务无法停止；已保留原组件备份，请勿删除备份。", { cause: error }); }
      try { rollback(); } catch { failures.push("插件清理失败"); }
      for (const entry of entries.toReversed()) {
        try {
          if (entry.activated) rmSync(entry.target, { recursive: true, force: true });
          if (entry.backedUp) renameSync(entry.backup, entry.target);
        } catch { failures.push("组件恢复失败，已保留备份"); }
      }
      if (wasRunning && existsSync(plistPath)) {
        try { execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], { timeout: 15_000 }); }
        catch { failures.push("旧后台服务未启动"); }
      }
    }
    if (failures.length) throw new Error(`安装失败，需处理：${failures.join("；")}`, { cause: error });
    throw error;
  } finally {
    for (const entry of entries) if (entry.staged) rmSync(entry.staged, { recursive: true, force: true });
  }
  for (const entry of entries) if (entry.backedUp) rmSync(entry.backup, { recursive: true, force: true });
}
