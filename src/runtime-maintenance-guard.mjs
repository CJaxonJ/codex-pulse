import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { WorktreeLockManager } from "./worktree-lock-manager.mjs";
import { currentWindowsProcessIdentity } from "./windows-process-bridge.mjs";
import { readJsonSnapshot } from "./atomic-file.mjs";

const unknown = () => Object.assign(new Error("托管任务尚未确认结束或记录无法核实，未允许升级或卸载。请先处理任务，不要删除其记录。"), { code: "PULSE_MANAGED_WORK_UNCONFIRMED" });
const busy = () => Object.assign(new Error("后台正在处理任务，或已有安装维护操作，未请求停机。请稍后重试。"), { code: "PULSE_RUNTIME_BUSY" });
const isId = value => typeof value === "string" && value.length > 0 && value.length <= 200;

export async function assertMaintenanceRuntimeProtocol(appRoot, { running, health, platform = process.platform }) {
  const deny = () => Object.assign(new Error("无法确认旧后台支持安全停机协议，未自动升级或卸载。请先核实旧开发版状态。"), { code: "PULSE_RUNTIME_PROTOCOL_UNCONFIRMED" });
  try {
    const manifest = await readJsonSnapshot(path.join(appRoot, "package.json"));
    if (manifest.codexPulse?.runtimeOperationProtocol !== 1 || typeof running !== "boolean") throw deny();
    if (!running) return;
    const root = health?.runtimeRoot;
    if (health?.runtimeOperationProtocol !== 1 || typeof root !== "string" || !path.isAbsolute(root)
        || platform === "win32" && (!/^[a-z]:[\\/]/i.test(root) || root.slice(0, 2).toLowerCase() !== appRoot.slice(0, 2).toLowerCase())) throw deny();
    const [actual, expected] = await Promise.all([realpath(root), realpath(appRoot)]);
    if (actual.toLowerCase() !== expected.toLowerCase()) throw deny();
  } catch (cause) {
    if (cause.code === "PULSE_RUNTIME_PROTOCOL_UNCONFIRMED") throw cause;
    throw Object.assign(new Error(deny().message, { cause }), { code: "PULSE_RUNTIME_PROTOCOL_UNCONFIRMED" });
  }
}

// Safety reader, intentionally NOT ManagedTaskStore.list(), whose interactive
// list ignores damaged records. Absence of readable records is not idle proof.
// This is a conservative local predicate, not a remote turn-liveness probe.
export async function assertManagedRecordsAllowMaintenance(dataDir) {
  const directory = path.join(dataDir, "managed-tasks");
  try {
    let stat;
    try { stat = await lstat(directory); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unknown();
    const names = await readdir(directory);
    if (names.length > 2000) throw unknown();
    let bytes = 0;
    for (const name of names) {
      const file = path.join(directory, name), entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) throw unknown();
      if (!name.endsWith(".json")) {
        // Normal atomic-publication temporaries do not authorize execution.
        // The caller must hold the shared operation gate across this scan.
        if (!name.endsWith(".tmp")) throw unknown();
        continue;
      }
      if (entry.size > 1024 ** 2 || (bytes += entry.size) > 16 * 1024 ** 2) throw unknown();
      const value = JSON.parse(await readFile(file, "utf8"));
      if (!value || !isId(value.id) || name !== value.id + ".json" || value.holdWorktreeLock === true) throw unknown();
      const neverStarted = value.status === "queued" && value.threadId == null && value.turnId == null;
      const confirmedComplete = value.status === "complete" && isId(value.threadId) && isId(value.turnId)
        && Number.isFinite(value.completedAt) && value.completedAt > 0;
      // Paused quota / pending approval / start-incomplete are NOT terminal.
      if (!neverStarted && !confirmedComplete) throw unknown();
    }
  } catch (cause) {
    if (cause.code === "PULSE_MANAGED_WORK_UNCONFIRMED") throw cause;
    throw Object.assign(new Error(unknown().message, { cause }), { code: "PULSE_MANAGED_WORK_UNCONFIRMED" });
  }
}

// Integration contract: every model-starting poll must use runOperation(), and
// install/uninstall must retain reserveMaintenance() through activation and
// rollback. A running legacy watcher cannot be assumed to participate and
// must be rejected before any stop request.
export class RuntimeMaintenanceGuard {
  constructor(dataDir) {
    if (!path.isAbsolute(dataDir)) throw Error("An absolute runtime data directory is required");
    this.dataDir = dataDir;
    this.pendingClaims = new Set();
    this.manager = new WorktreeLockManager(path.join(dataDir, "runtime-operations"), { processIdentity: currentWindowsProcessIdentity() });
  }
  async claim() {
    const pending = this.manager.acquire(this.dataDir, "runtime-operation");
    this.pendingClaims.add(pending);
    let result;
    try { result = await pending; } finally { this.pendingClaims.delete(pending); }
    if (!result.acquired) return null;
    let released = false;
    return async () => { if (!released) { released = true; await this.manager.release(result.handle); } };
  }
  async waitForOwnershipPublication() { await Promise.allSettled([...this.pendingClaims]); }
  async runOperation(operation) {
    if (typeof operation !== "function") throw new TypeError("An operation is required");
    const release = await this.claim();
    if (!release) return { executed: false, reason: "runtime_busy" };
    try {
      // If a maintenance owner dies after activation, a new watcher must not
      // start queued work in a runtime whose transaction is still unfinished.
      for (const name of ["installation-in-progress.json", "uninstallation-in-progress.json"]) {
        try { await lstat(path.join(this.dataDir, name)); return { executed: false, reason: "incomplete_maintenance" }; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      return { executed: true, value: await operation() };
    }
    finally { await release(); }
  }
  async reserveMaintenance() {
    const release = await this.claim();
    if (!release) throw busy();
    try { await assertManagedRecordsAllowMaintenance(this.dataDir); return { release }; }
    catch (error) { await release(); throw error; }
  }
}
