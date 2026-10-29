import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, rm, open } from "node:fs/promises";
import path from "node:path";
import { writeJsonSnapshotAtomic } from "../src/atomic-file.mjs";
import { openWindowsInstallationLease, assertInstallerOutsideRuntime } from "../src/windows-installation-lease.mjs";
import { lockInstallation } from "./installation-transaction.mjs";
import { ensureWindowsPrivateDirectory } from "../src/private-directory.mjs";

const markerName = "windows-installation.json", journalName = "installation-in-progress.json";
async function exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } }
export async function runtimeFingerprint(root) {
  const result = createHash("sha256"); let count = 0, total = 0;
  async function visit(relative) {
    const file = path.join(root, relative), stat = await lstat(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error("运行目录包含链接或特殊文件，未继续安装。");
    if (++count > 5000) throw Error("运行目录过大，未继续安装。");
    if (stat.isDirectory()) {
      result.update(JSON.stringify(["directory", relative]));
      for (const name of (await readdir(file)).sort()) await visit(path.join(relative, name));
    } else {
      if ((total += stat.size) > 2 * 1024 ** 3) throw Error("运行文件超过安装检查上限。");
      const hash = createHash("sha256"); for await (const data of createReadStream(file)) hash.update(data);
      result.update(JSON.stringify(["file", relative, stat.size, hash.digest("hex")]));
    }
  }
  await visit(""); return result.digest("hex");
}
async function snapshot(file) {
  try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw Error("安装上下文异常。"); return await readFile(file); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
async function restoreSnapshot(file, bytes) {
  if (bytes === null) { await rm(file, { force: true }); return; }
  const temporary = file + "." + randomUUID() + ".tmp";
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  // Same atomic replacement/retry used for checkpoints, no unlink gap.
  const { renameAtomic } = await import("../src/atomic-file.mjs");
  try { await renameAtomic(temporary, file); } finally { await rm(temporary, { force: true }); }
}
export async function replaceWindowsRuntime({ dataDir, stagedName, service, preflight, installSideEffects, rollbackSideEffects,
  acquireLease = () => openWindowsInstallationLease(), acquireLock = () => lockInstallation(dataDir) }) {
  if (!path.isAbsolute(dataDir) || !/^app-install-[a-f0-9]{32}$/.test(stagedName)
      || ![preflight, installSideEffects, rollbackSideEffects].every(f => typeof f === "function")) throw Error("安装事务参数不完整。");
  await ensureWindowsPrivateDirectory(dataDir);
  await assertInstallerOutsideRuntime({ dataDir });
  if (service.sourceBinary) await assertInstallerOutsideRuntime({ dataDir, executable: service.sourceBinary });
  const release = await acquireLock();
  const id = randomUUID().replaceAll("-", ""), backup = "app-backup-" + id, failed = "app-failed-" + id;
  const app = path.join(dataDir, "app"), staged = path.join(dataDir, stagedName), journal = path.join(dataDir, journalName);
  const marker = path.join(dataDir, markerName), context = path.join(dataDir, "startup-context.json");
  let original, hadOld, oldHash, newHash, oldMarker, oldContext, lease, switchStarted = false, sideEffectsStarted = false, movedNew = false;
  try {
    if (await exists(journal) || (await readdir(dataDir)).some(name => /^app-backup-[a-f0-9]{32}$/.test(name))) throw Error("发现上次未处理的安装记录或备份，已保留现场，未覆盖安装。");
    await preflight(); // Complete auth/plugin/package checks and staging before disabling anything.
    const stageStat = await lstat(staged);
    if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw Error("暂存目录不正确。");
    const manifestBytes = await snapshot(path.join(staged, "package.json"));
    if (!manifestBytes) throw Error("安装包缺少版本说明。");
    const manifest = JSON.parse(manifestBytes);
    if (manifest.name !== "codex-pulse" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw Error("安装包身份不正确。");
    for (const name of ["CodexPulse.exe", "CodexPulse.exe.config", "runtime/node.exe", "bin/codex-pulse.mjs"]) {
      const stat = await lstat(path.join(staged, name)); if (!stat.isFile() || stat.isSymbolicLink()) throw Error("安装包不完整。");
    }
    hadOld = await exists(app); oldMarker = await snapshot(marker); oldContext = await snapshot(context);
    newHash = await runtimeFingerprint(staged);
    if (hadOld) {
      oldHash = await runtimeFingerprint(app);
      if (!oldMarker) throw Error("现有运行目录没有本产品安装记录，未覆盖其中的文件。");
      const value = JSON.parse(oldMarker);
      if (value.name !== "codex-pulse" || value.schema !== 1 || value.fingerprint !== oldHash) throw Error("现有运行文件已改变或不属于本安装，已保留。");
    } else if (oldMarker) throw Error("安装记录与运行目录不一致，已保留现场。");
    original = await service.capture(hadOld);
    if (typeof original?.running !== "boolean" || typeof original.startup?.installed !== "boolean" || typeof original.startup?.enabled !== "boolean") throw Error("原启动状态未知。");
    if (!hadOld && (original.running || original.startup.installed)) throw Error("没有现有安装却发现正在运行的后台或自启任务，未接管未知状态。");
    const record = { schema: 1, id, stagedName, backup, failed, hadOld, oldHash: oldHash || null, newHash, original, phase: "prepared" };
    await writeJsonSnapshotAtomic(journal, record);
    const phase = async next => { record.phase = next; await writeJsonSnapshotAtomic(journal, record); };
    const restoreFiles = async () => { await restoreSnapshot(marker, oldMarker); await restoreSnapshot(context, oldContext); };
    try {
      await phase("quiescing"); await service.quiesce();
      lease = await acquireLease(); switchStarted = true;
      if (hadOld) { await phase("moving_old"); await lease.move("app", backup); }
      await phase("moving_new"); await lease.move(stagedName, "app"); movedNew = true;
      await lease.release(); lease = null;
      await phase("applying_side_effects"); sideEffectsStarted = true; await installSideEffects();
      await phase("activating"); await service.activate(original, !hadOld);
      await phase("verifying"); await service.verify(original, !hadOld);
      if (await runtimeFingerprint(app) !== newHash) throw Error("新运行目录验证时发生变化。");
      await phase("committing"); await writeJsonSnapshotAtomic(marker, { name: "codex-pulse", schema: 1, transactionId: id, version: manifest.version, fingerprint: newHash });
      await phase("committed");
    } catch (cause) {
      try {
        if (lease) { await lease.release(); lease = null; }
        // Unknown/failed stops and failed plugin cleanup must keep runtime
        // files and backups in place, never leave a dangling active Hook.
        await service.quiesce();
        if (sideEffectsStarted) await rollbackSideEffects();
        if (movedNew) await service.undoActivation(original);
        if (switchStarted) {
          lease = await acquireLease();
          const hasBackup = await exists(path.join(dataDir, backup)), hasApp = await exists(app);
          if (hasBackup) {
            if (!hadOld || await runtimeFingerprint(path.join(dataDir, backup)) !== oldHash) throw Error("备份与原记录不一致。");
            if (hasApp) {
              if (await runtimeFingerprint(app) !== newHash) throw Error("新目录包含未确认的更改，未移除。");
              await lease.move("app", failed);
            }
            await lease.move(backup, "app");
          } else if (!hadOld && hasApp) {
            if (await runtimeFingerprint(app) !== newHash) throw Error("首次安装目录已改变，未移除。");
            await lease.move("app", failed);
          } else if (hadOld && (!hasApp || await runtimeFingerprint(app) !== oldHash)) throw Error("原目录位置未知，未猜测恢复。");
          await lease.release(); lease = null;
        }
        await service.restore(original, { hadOld, restoreFiles, hasContext: oldContext !== null });
        if (hadOld && await runtimeFingerprint(app) !== oldHash) throw Error("旧版本恢复验证失败。");
        await service.verifyRestored(original, hadOld);
        await rm(journal);
      } catch (rollbackError) {
        throw new Error("安装失败且无法安全确认完整回滚，已保留运行目录、备份和安装记录，请勿删除。", { cause: new AggregateError([cause, rollbackError]) });
      }
      throw new Error("安装未成功，原运行目录和启动状态已恢复；失败版本已保留供检查。", { cause });
    }
    // Delete only the exact backup whose contents were verified against the
    // original ownership marker. A still-open old notice can prevent deletion;
    // leave the committed journal as evidence instead of deleting other files.
    let cleanupPending = false;
    if (hadOld) {
      if (await runtimeFingerprint(path.join(dataDir, backup)) !== oldHash) throw Error("安装已验证，但旧备份发生变化，已保留安装记录。");
      try { await rm(path.join(dataDir, backup), { recursive: true }); } catch { cleanupPending = true; }
    }
    if (!cleanupPending) await rm(journal);
    return { ok: true, version: manifest.version, cleanupPending, transactionId: id };
  } finally {
    try { await lease?.release(); } finally { await release(); }
  }
}
