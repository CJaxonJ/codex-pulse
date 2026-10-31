import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { lockInstallation } from "./installation-transaction.mjs";
import { runtimeFingerprint, readInstallationSnapshot as snapshot, restoreInstallationSnapshot as restore } from "./windows-installation-transaction.mjs";
import { ensureWindowsPrivateDirectory } from "../src/private-directory.mjs";
import { assertInstallerOutsideRuntime, openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";
import { writeJsonSnapshotAtomic } from "../src/atomic-file.mjs";

const installName = "installation-in-progress.json", uninstallName = "uninstallation-in-progress.json";
const markerName = "windows-installation.json", contextName = "startup-context.json";
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const refuse = () => Object.assign(new Error("中断记录或文件归属无法安全核实，已保留现场。请勿删除运行目录、备份或任务记录。"), { code: "PULSE_MAINTENANCE_RECOVERY_REQUIRED" });
const same = (a, b) => a === null ? b === null : Buffer.isBuffer(b) && a.equals(b);
function decode(value) {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 1400000) throw refuse();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || bytes.length > 1024 ** 2) throw refuse();
  return bytes;
}
async function fingerprintOrAbsent(file) {
  try { await lstat(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
  return runtimeFingerprint(file);
}
function checkOriginal(value) {
  if (typeof value?.running !== "boolean" || typeof value.startup?.installed !== "boolean"
      || typeof value.startup?.enabled !== "boolean" || !value.startup.installed && value.startup.enabled) throw refuse();
}
function checkInstall(value) {
  if (![1, 2].includes(value?.schema) || !/^[a-f0-9]{32}$/.test(value.id)
      || value.backup !== "app-backup-" + value.id || value.failed !== "app-failed-" + value.id
      || !/^app-install-[a-f0-9]{32}$/.test(value.stagedName) || !hash(value.newHash)
      || typeof value.hadOld !== "boolean" || (value.hadOld ? !hash(value.oldHash) : value.oldHash !== null)
      || !["prepared", "quiescing", "moving_old", "moving_new", "applying_side_effects", "activating", "verifying", "committing", "committed"].includes(value.phase)) throw refuse();
  checkOriginal(value.original);
}
function checkUninstall(value) {
  if (value?.schema !== 2 || value.operation !== "uninstall" || !hash(value.fingerprint)
      || !/^app-failed-[a-f0-9]{32}$/.test(value.retired)
      || !["prepared", "quiescing", "removing_plugin", "removing_startup", "retiring_runtime", "removing_runtime", "cleaning_context"].includes(value.phase)) throw refuse();
}
async function assertSnapshot(file, alternatives) {
  if (!alternatives.some(bytes => same(bytes, file.current))) throw refuse();
}

// Only a verified source package may repair an interrupted transaction. The
// installation lock and runtime gate cover ALL repair and rollback actions.
// Unknown states are preserved; we never infer termination from elapsed time.
export async function recoverWindowsMaintenance({ dataDir, service, pluginFor,
  acquireLock = () => lockInstallation(dataDir), acquireLease = () => openWindowsInstallationLease() }) {
  if (!path.isAbsolute(dataDir) || typeof service?.reserveStop !== "function" || typeof pluginFor !== "function") throw refuse();
  await ensureWindowsPrivateDirectory(dataDir);
  await assertInstallerOutsideRuntime({ dataDir });
  if (service.sourceBinary) await assertInstallerOutsideRuntime({ dataDir, executable: service.sourceBinary });
  const release = await acquireLock(); let reservation, lease;
  const file = name => path.join(dataDir, name), app = file("app"), marker = file(markerName), context = file(contextName);
  try {
    const installation = await snapshot(file(installName)), uninstallation = await snapshot(file(uninstallName));
    if (!installation && !uninstallation) return { repaired: false };
    if (installation && uninstallation) throw refuse();
    const bytes = installation || uninstallation, journal = file(installation ? installName : uninstallName);
    let expectedJournal = bytes;
    const record = JSON.parse(bytes);
    const checkJournal = async () => { if (!same(expectedJournal, await snapshot(journal))) throw refuse(); };
    const persist = async next => {
      await checkJournal(); await writeJsonSnapshotAtomic(journal, next);
      expectedJournal = Buffer.from(JSON.stringify(next, null, 2) + "\n");
    };
    if (installation) checkInstall(record); else checkUninstall(record);
    const names = await readdir(dataDir);
    if (names.some(name => /^app-backup-[a-f0-9]{32}$/.test(name) && name !== record.backup)) throw refuse();
    let appHash = await fingerprintOrAbsent(app);
    if (installation && record.phase === "committed") {
      // The installation already passed activation and committed its marker.
      // Cleanup never stops the current monitor or rewrites user preferences.
      const installed = JSON.parse(await snapshot(marker));
      if (appHash !== record.newHash || installed?.name !== "codex-pulse" || installed.schema !== 1
          || installed.transactionId !== record.id || installed.fingerprint !== record.newHash) throw refuse();
      const backup = file(record.backup), backupHash = await fingerprintOrAbsent(backup);
      if (backupHash !== null && (!record.hadOld || backupHash !== record.oldHash)) throw refuse();
      const plugin = pluginFor(app); await plugin.verifyPresent();
      reservation = await service.reserveStop(true);
      await checkJournal();
      if (await runtimeFingerprint(app) !== record.newHash || !same(await snapshot(marker), Buffer.from(JSON.stringify(installed, null, 2) + "\n"))) throw refuse();
      if (backupHash !== null) {
        if (await runtimeFingerprint(backup) !== record.oldHash) throw refuse();
        await rm(backup, { recursive: true });
      }
      await checkJournal(); await rm(journal);
      return { repaired: true, operation: "committed_cleanup", historyPreserved: true };
    }
    if (installation) {
      if (record.schema !== 2) throw refuse(); // Legacy records lack durable rollback snapshots.
      const oldMarker = decode(record.oldMarker), oldContext = decode(record.oldContext), expectedMarker = decode(record.expectedMarker), expectedContext = decode(record.expectedContext);
      if (!expectedMarker || record.hadOld !== (oldMarker !== null)) throw refuse();
      if (record.hadOld) {
        const old = JSON.parse(oldMarker);
        if (old?.name !== "codex-pulse" || old.schema !== 1 || old.fingerprint !== record.oldHash) throw refuse();
      }
      const next = JSON.parse(expectedMarker);
      if (next?.name !== "codex-pulse" || next.schema !== 1 || next.transactionId !== record.id || next.fingerprint !== record.newHash) throw refuse();
      const backup = file(record.backup), failed = file(record.failed);
      const backupHash = await fingerprintOrAbsent(backup), failedHash = await fingerprintOrAbsent(failed);
      const stagedHash = await fingerprintOrAbsent(file(record.stagedName));
      const newAtApp = appHash === record.newHash && (!record.hadOld || backupHash !== null);
      if (backupHash !== null && (!record.hadOld || backupHash !== record.oldHash)
          || failedHash !== null && failedHash !== record.newHash || stagedHash !== null && stagedHash !== record.newHash
          || appHash !== null && appHash !== record.newHash && appHash !== record.oldHash
          || record.hadOld && !(backupHash === record.oldHash && (appHash === null || appHash === record.newHash) || backupHash === null && appHash === record.oldHash)
          || newAtApp && failedHash !== null) throw refuse();
      const markerBefore = await snapshot(marker), contextBefore = await snapshot(context);
      await assertSnapshot({ current: markerBefore }, [oldMarker, expectedMarker]);
      await assertSnapshot({ current: contextBefore }, expectedContext === null ? [oldContext] : [oldContext, expectedContext]);
      const plugin = pluginFor(appHash === null ? file(record.stagedName) : app);
      await plugin.prepareRecovery(record.pluginRollback);
      reservation = await service.reserveStop(appHash !== null);
      await checkJournal();
      if (!same(markerBefore, await snapshot(marker)) || !same(contextBefore, await snapshot(context))) throw refuse();
      await service.quiesce();
      await plugin.rollback(); // Uses the exact persisted ownership/hash, never a whole config restore.
      if (newAtApp) await service.undoActivation(record.original);
      lease = await acquireLease();
      if (appHash !== null && await runtimeFingerprint(app) !== appHash) throw refuse();
      if (backupHash !== null && await runtimeFingerprint(backup) !== record.oldHash) throw refuse();
      if (newAtApp) { await lease.move("app", record.failed); appHash = null; }
      if (backupHash !== null) await lease.move(record.backup, "app");
      await lease.release(); lease = null;
      const restoreContext = record.hadOld && service.previewContext ? await service.previewContext() : contextBefore;
      await service.restore(record.original, { hadOld: record.hadOld, hasContext: oldContext !== null,
        restoreFiles: async () => {
          if (!same(markerBefore, await snapshot(marker))) throw refuse();
          await assertSnapshot({ current: await snapshot(context) }, [contextBefore, restoreContext]);
          await restore(marker, oldMarker); await restore(context, oldContext);
        } });
      if (record.hadOld && await runtimeFingerprint(app) !== record.oldHash) throw refuse();
      await service.verifyRestored(record.original, record.hadOld);
      await checkJournal(); await rm(journal);
      return { repaired: true, operation: "installation_rollback", historyPreserved: true };
    }
    const savedMarker = decode(record.marker), savedContext = decode(record.context);
    const ownership = savedMarker && JSON.parse(savedMarker);
    if (ownership?.name !== "codex-pulse" || ownership.schema !== 1 || ownership.fingerprint !== record.fingerprint) throw refuse();
    const retired = file(record.retired), retiredHash = await fingerprintOrAbsent(retired);
    if (appHash !== null && appHash !== record.fingerprint || retiredHash !== null && retiredHash !== record.fingerprint
        || appHash !== null && retiredHash !== null
        || appHash === null && retiredHash === null && !["removing_runtime", "cleaning_context"].includes(record.phase)) throw refuse();
    const late = record.phase === "cleaning_context";
    await assertSnapshot({ current: await snapshot(marker) }, late ? [savedMarker, null] : [savedMarker]);
    await assertSnapshot({ current: await snapshot(context) }, late ? [savedContext, null] : [savedContext]);
    const plugin = pluginFor(appHash !== null ? app : retired);
    await plugin.prepareRemoval();
    reservation = await service.reserveStop(appHash !== null);
    await checkJournal();
    await service.quiesce(); await plugin.rollback(); await plugin.verifyRemoved();
    if (appHash !== null) await service.removeStartup();
    else await service.verifyRemoved(); // An absent app never authorizes removing a foreign scheduled task.
    lease = await acquireLease();
    const verifySnapshots = async () => {
      await assertSnapshot({ current: await snapshot(marker) }, late ? [savedMarker, null] : [savedMarker]);
      await assertSnapshot({ current: await snapshot(context) }, late ? [savedContext, null] : [savedContext]);
    };
    await verifySnapshots();
    if (appHash !== null) {
      if (await runtimeFingerprint(app) !== record.fingerprint) throw refuse();
      await lease.move("app", record.retired);
    }
    await service.verifyRemoved();
    if (appHash !== null || retiredHash !== null) {
      if (await runtimeFingerprint(retired) !== record.fingerprint) throw refuse();
      await verifySnapshots();
      await persist({ ...record, phase: "removing_runtime" });
      await lease.removeRetired(record.retired);
    }
    // Persist the cleanup phase before deleting either snapshot so retries can
    // distinguish our completed deletion from an unexplained missing file.
    const cleaned = { ...record, phase: "cleaning_context" };
    await persist(cleaned);
    await assertSnapshot({ current: await snapshot(marker) }, [savedMarker, null]);
    await assertSnapshot({ current: await snapshot(context) }, [savedContext, null]);
    if (await snapshot(context) !== null) await rm(context);
    if (await snapshot(marker) !== null) await rm(marker);
    await rm(journal);
    return { repaired: true, operation: "uninstall", runtimeRemoved: true, pluginRemoved: true, startupRemoved: true, historyPreserved: true };
  } finally {
    try { await lease?.release(); } finally { try { await reservation?.release(); } finally { await release(); } }
  }
}
