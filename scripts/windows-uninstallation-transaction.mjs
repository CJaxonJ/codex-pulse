import { lstat, readFile, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { runtimeFingerprint } from "./windows-installation-transaction.mjs";
import { lockInstallation } from "./installation-transaction.mjs";
import { writeJsonSnapshotAtomic } from "../src/atomic-file.mjs";
import { ensureWindowsPrivateDirectory } from "../src/private-directory.mjs";
import { assertInstallerOutsideRuntime, openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";

async function snapshot(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 ** 2) throw Error("卸载记录异常，未继续。");
    return await readFile(file);
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function unchanged(file, expected) {
  const current = await snapshot(file);
  if (expected === null ? current !== null : !current?.equals(expected)) throw Error("卸载期间安装上下文发生变化，已保留现场。");
}

// Source-package entry only: Node and the native lease must run outside the
// installed app. We never delete the data root, CODEX_HOME or a stored PID.
// Interrupted removals keep their snapshots for verified source-entry repair.
// Newly changed or unknown files must still be preserved rather than erased.
export async function removeWindowsInstallation({ dataDir, service, plugin,
  acquireLock = () => lockInstallation(dataDir), acquireLease = () => openWindowsInstallationLease() }) {
  if (!path.isAbsolute(dataDir) || typeof service?.reserveStop !== "function" || !plugin) throw Error("卸载事务参数不完整。");
  await ensureWindowsPrivateDirectory(dataDir);
  await assertInstallerOutsideRuntime({ dataDir });
  if (service.sourceBinary) await assertInstallerOutsideRuntime({ dataDir, executable: service.sourceBinary });
  const release = await acquireLock(); let lease, stopReservation;
  const app = path.join(dataDir, "app"), marker = path.join(dataDir, "windows-installation.json"), context = path.join(dataDir, "startup-context.json");
  const journal = path.join(dataDir, "uninstallation-in-progress.json");
  let started = false;
  try {
    const names = await readdir(dataDir);
    if (names.includes("installation-in-progress.json") || names.includes("uninstallation-in-progress.json")
        || names.some(name => /^app-backup-[a-f0-9]{32}$/.test(name))) throw Error("发现未完成的安装或卸载记录，已保留，未猜测清理。");
    const markerBytes = await snapshot(marker), contextBytes = await snapshot(context);
    const hash = await runtimeFingerprint(app), record = markerBytes && JSON.parse(markerBytes);
    if (record?.name !== "codex-pulse" || record.schema !== 1 || record.fingerprint !== hash) throw Error("运行目录没有匹配的产品安装记录，或包含未确认的更改，未卸载其中的文件。");
    await plugin.prepareRemoval(); // Read-only: an external/changed source must fail before stopping anything.
    stopReservation = await service.reserveStop(true);
    const original = await service.capture(true);
    if (typeof original?.running !== "boolean" || typeof original.startup?.installed !== "boolean" || typeof original.startup?.enabled !== "boolean") throw Error("原后台状态未知，未继续卸载。");
    const retired = "app-failed-" + randomUUID().replaceAll("-", "");
    const progress = { schema: 2, operation: "uninstall", retired, fingerprint: hash, phase: "prepared",
      marker: markerBytes.toString("base64"), context: contextBytes?.toString("base64") ?? null };
    await writeJsonSnapshotAtomic(journal, progress); started = true;
    const phase = async value => { progress.phase = value; await writeJsonSnapshotAtomic(journal, progress); };
    await phase("quiescing"); await service.quiesce();
    await phase("removing_plugin"); await plugin.rollback(); await plugin.verifyRemoved();
    await phase("removing_startup"); await service.removeStartup();
    lease = await acquireLease();
    await unchanged(marker, markerBytes); await unchanged(context, contextBytes);
    if (await runtimeFingerprint(app) !== hash) throw Error("运行文件在卸载期间发生变化，未删除。");
    await phase("retiring_runtime"); await lease.move("app", retired);
    await service.verifyRemoved();
    if (await runtimeFingerprint(path.join(dataDir, retired)) !== hash) throw Error("退役运行目录已改变，未删除。");
    await phase("removing_runtime"); await lease.removeRetired(retired);
    if ((await readdir(dataDir)).includes(retired)) throw Error("运行文件未确认移除。");
    await phase("cleaning_context");
    await unchanged(marker, markerBytes); await unchanged(context, contextBytes);
    if (contextBytes !== null) await rm(context);
    await rm(marker); await rm(journal);
    return { ok: true, runtimeRemoved: true, pluginRemoved: true, startupRemoved: true, historyPreserved: true };
  } catch (cause) {
    if (!started) throw cause;
    throw new Error("卸载未完成，后台已请求停止；已保留操作记录和未确认的文件，请勿手工删除运行目录。", { cause });
  } finally { try { await lease?.release(); } finally { try { await stopReservation?.release(); } finally { await release(); } } }
}
