import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { recoverWindowsMaintenance } from "../scripts/windows-maintenance-recovery.mjs";
import { runtimeFingerprint } from "../scripts/windows-installation-transaction.mjs";
import { RuntimeMaintenanceGuard } from "../src/runtime-maintenance-guard.mjs";

// Real temporary files, modeled service/kernel/plugin ports. The separate
// ZIP E2E must prove native process death and official plugin recovery.
const encoded = value => value === null ? null : Buffer.from(value).toString("base64");
const json = value => JSON.stringify(value, null, 2) + "\n";
async function fixture({ sameRuntime = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-maintenance-recovery-"));
  const file = name => path.join(dataDir, name), id = randomUUID().replaceAll("-", "");
  const names = { backup: "app-backup-" + id, failed: "app-failed-" + id, stagedName: "app-install-" + randomUUID().replaceAll("-", "") };
  for (const [name, value] of [["app", "new"], [names.backup, sameRuntime ? "new" : "old"]]) {
    await mkdir(file(name)); await writeFile(path.join(file(name), "runtime.txt"), value);
  }
  const newHash = await runtimeFingerprint(file("app")), oldHash = await runtimeFingerprint(file(names.backup));
  const oldMarker = json({ name: "codex-pulse", schema: 1, fingerprint: oldHash });
  const newMarker = json({ name: "codex-pulse", schema: 1, transactionId: id, version: "0.9.22", fingerprint: newHash });
  const oldContext = '{"original":"paths"}\r\n', newContext = '{"intended":"paths"}';
  await writeFile(file("windows-installation.json"), oldMarker); await writeFile(file("startup-context.json"), newContext);
  for (const name of ["checkpoint.json", "credit-ledger.json", "preferences.json", "user-history.txt"]) await writeFile(file(name), name + " untouched");
  const original = { startup: { installed: true, enabled: true }, running: true };
  const record = { schema: 2, id, ...names, hadOld: true, oldHash, newHash, original, phase: "verifying",
    oldMarker: encoded(oldMarker), oldContext: encoded(oldContext), expectedMarker: encoded(newMarker), expectedContext: encoded(newContext),
    pluginRollback: { schema: 1, reused: false, hash: "b".repeat(64), version: "0.9.22" } };
  const journal = file("installation-in-progress.json"), save = () => writeFile(journal, json(record)); await save();
  const events = [], guard = new RuntimeMaintenanceGuard(dataDir);
  const service = {
    reserveStop: async () => guard.reserveMaintenance(),
    quiesce: async () => { events.push("stop"); },
    undoActivation: async () => { events.push("undo"); },
    previewContext: async () => Buffer.from(newContext),
    restore: async (state, { restoreFiles }) => { events.push("restore"); await writeFile(file("startup-context.json"), newContext); await restoreFiles(); },
    verifyRestored: async state => { events.push("verify-restored"); assert.deepEqual(state, original); },
    removeStartup: async () => { events.push("remove-startup"); },
    verifyRemoved: async () => { events.push("verify-removed"); },
  };
  const plugin = {
    prepareRecovery: async value => { events.push("plugin-check"); assert.deepEqual(value, record.pluginRollback); },
    rollback: async () => { events.push("plugin-remove"); },
    prepareRemoval: async () => { events.push("plugin-check"); },
    verifyRemoved: async () => { events.push("plugin-absent"); },
    verifyPresent: async () => { events.push("plugin-present"); },
  };
  const lease = {
    move: async (from, to) => { events.push("move:" + from); await rename(file(from), file(to)); },
    removeRetired: async name => { events.push("delete-retired"); await rm(file(name), { recursive: true }); },
    release: async () => { events.push("lease-release"); },
  };
  const options = { dataDir, service, pluginFor: () => plugin, acquireLease: async () => lease };
  return { dataDir, file, record, journal, save, oldMarker, newMarker, oldContext, newContext, events, service, plugin, lease, guard, options };
}
async function historyIntact(f) {
  for (const name of ["checkpoint.json", "credit-ledger.json", "preferences.json", "user-history.txt"]) assert.equal(await readFile(f.file(name), "utf8"), name + " untouched");
}

test("interrupted install rolls back from actual directory evidence, preserving snapshots and releasing the fence", async () => {
  for (const phase of ["prepared", "quiescing", "moving_old", "moving_new", "applying_side_effects", "activating", "verifying", "committing"]) {
    const f = await fixture(); f.record.phase = phase;
    if (["prepared", "quiescing"].includes(phase)) {
      await rename(f.file("app"), f.file(f.record.stagedName)); await rename(f.file(f.record.backup), f.file("app"));
    } else if (phase === "moving_old") await rename(f.file("app"), f.file(f.record.stagedName));
    if (["prepared", "quiescing", "moving_old", "moving_new", "applying_side_effects"].includes(phase)) {
      f.record.expectedContext = null; await writeFile(f.file("startup-context.json"), f.oldContext);
    }
    if (phase === "committing") await writeFile(f.file("windows-installation.json"), f.newMarker);
    await f.save();
    assert.equal((await f.guard.runOperation(() => assert.fail("unfinished journal cannot start work"))).executed, false);
    assert.equal((await recoverWindowsMaintenance(f.options)).operation, "installation_rollback");
    assert.equal(await runtimeFingerprint(f.file("app")), f.record.oldHash);
    assert.equal(await readFile(f.file("windows-installation.json"), "utf8"), f.oldMarker);
    assert.equal(await readFile(f.file("startup-context.json"), "utf8"), f.oldContext);
    assert.deepEqual(await recoverWindowsMaintenance(f.options), { repaired: false });
    assert.equal((await f.guard.runOperation(() => "released")).value, "released"); await historyIntact(f);
  }
});

test("identical reinstall hashes do not confuse old/new directory placement", async () => {
  const f = await fixture({ sameRuntime: true });
  assert.equal(f.record.oldHash, f.record.newHash);
  await recoverWindowsMaintenance(f.options);
  assert.equal(await runtimeFingerprint(f.file("app")), f.record.oldHash);
  assert((await readdir(f.dataDir)).includes(f.record.failed)); await historyIntact(f);
});

test("interrupted fresh install restores absence, without inventing an old runtime or startup", async () => {
  for (const moved of [false, true]) {
    const f = await fixture(); await rm(f.file(f.record.backup), { recursive: true }); await rm(f.file("windows-installation.json"));
    f.record.hadOld = false; f.record.oldHash = null; f.record.oldMarker = null; f.record.oldContext = null;
    f.record.original = { startup: { installed: false, enabled: false }, running: false };
    if (!moved) {
      await rename(f.file("app"), f.file(f.record.stagedName)); await rm(f.file("startup-context.json"));
      f.record.expectedContext = null; f.record.phase = "prepared";
    }
    f.service.restore = async (original, { hadOld, restoreFiles }) => { assert.equal(hadOld, false); await restoreFiles(); };
    f.service.verifyRestored = async original => assert.deepEqual(original, f.record.original);
    await f.save(); await recoverWindowsMaintenance(f.options);
    const names = await readdir(f.dataDir);
    for (const name of ["app", "windows-installation.json", "startup-context.json", "installation-in-progress.json"]) assert(!names.includes(name));
    await historyIntact(f);
  }
});

test("committed cleanup keeps the current monitor and user context intact, and refuses changed backups", async () => {
  for (const changed of [false, true]) {
    const f = await fixture(); f.record.phase = "committed"; await f.save();
    await writeFile(f.file("windows-installation.json"), f.newMarker); await writeFile(f.file("startup-context.json"), "user changed this after commit");
    if (changed) await writeFile(path.join(f.file(f.record.backup), "user.txt"), "do not erase");
    if (changed) await assert.rejects(recoverWindowsMaintenance(f.options));
    else assert.equal((await recoverWindowsMaintenance(f.options)).operation, "committed_cleanup");
    assert(!f.events.includes("stop")); assert.equal(await runtimeFingerprint(f.file("app")), f.record.newHash);
    assert.equal(await readFile(f.file("startup-context.json"), "utf8"), "user changed this after commit"); await historyIntact(f);
  }
});

test("repair survives lost move acknowledgements and a second failure after snapshot restore", async () => {
  for (const failure of ["move", "restore"]) {
    const f = await fixture(); let injected = false;
    if (failure === "move") {
      const move = f.lease.move; f.lease.move = async (...args) => { await move(...args); if (!injected) { injected = true; throw Error("lost move acknowledgement"); } };
    } else {
      const restore = f.service.restore; f.service.restore = async (...args) => { await restore(...args); if (!injected) { injected = true; throw Error("crash after restoring snapshots"); } };
    }
    await assert.rejects(recoverWindowsMaintenance(f.options));
    assert((await readdir(f.dataDir)).includes("installation-in-progress.json"));
    await recoverWindowsMaintenance(f.options); assert.equal(injected, true);
    assert.equal(await runtimeFingerprint(f.file("app")), f.record.oldHash); await historyIntact(f);
  }
});

test("unknown files, snapshots, paths, live tasks and damaged journals refuse without stopping or deleting", async () => {
  for (const changed of ["app", "backup", "context", "marker", "traversal", "legacy", "damaged", "both", "active"]) {
    const f = await fixture();
    if (changed === "app" || changed === "backup") await writeFile(path.join(f.file(changed === "app" ? "app" : f.record.backup), "user.txt"), "keep my work");
    if (changed === "context") await writeFile(f.file("startup-context.json"), "unknown user context");
    if (changed === "marker") await writeFile(f.file("windows-installation.json"), '{}');
    if (changed === "traversal") { f.record.backup = "../outside"; await f.save(); }
    if (changed === "legacy") { f.record.schema = 1; await f.save(); }
    if (changed === "damaged") await writeFile(f.journal, "incomplete JSON");
    if (changed === "both") await writeFile(f.file("uninstallation-in-progress.json"), '{}');
    if (changed === "active") { await mkdir(f.file("managed-tasks")); await writeFile(f.file("managed-tasks/task.json"), json({ id: "task", status: "running" })); }
    const before = await runtimeFingerprint(f.file("app"));
    await assert.rejects(recoverWindowsMaintenance(f.options));
    assert(!f.events.includes("stop")); assert.equal(await runtimeFingerprint(f.file("app")), before);
    assert((await readdir(f.dataDir)).includes("installation-in-progress.json")); await historyIntact(f);
  }
});

test("interrupted uninstall resumes before/after rename and deletion without removing history", async () => {
  for (const state of ["prepared", "removing_plugin", "retiring_runtime", "removing_runtime", "deleted", "cleaning_context"]) {
    const f = await fixture(); await rm(f.file(f.record.backup), { recursive: true }); await rm(f.journal);
    const retired = "app-failed-" + randomUUID().replaceAll("-", "");
    const record = { schema: 2, operation: "uninstall", retired, fingerprint: f.record.newHash,
      marker: encoded(f.newMarker), context: encoded(f.newContext), phase: state === "deleted" ? "removing_runtime" : state };
    await writeFile(f.file("windows-installation.json"), f.newMarker);
    if (["retiring_runtime", "removing_runtime"].includes(state)) await rename(f.file("app"), f.file(retired));
    if (["deleted", "cleaning_context"].includes(state)) await rm(f.file("app"), { recursive: true });
    if (state === "cleaning_context") await rm(f.file("startup-context.json"));
    await writeFile(f.file("uninstallation-in-progress.json"), json(record));
    assert.equal((await recoverWindowsMaintenance(f.options)).operation, "uninstall");
    for (const name of ["app", retired, "windows-installation.json", "startup-context.json", "uninstallation-in-progress.json"]) assert(!(await readdir(f.dataDir)).includes(name));
    assert.deepEqual(await recoverWindowsMaintenance(f.options), { repaired: false }); await historyIntact(f);
  }
});

test("uninstall recovery journals deletion BEFORE deleting a retired runtime, and retries a lost deletion reply", async () => {
  const f = await fixture(); await rm(f.file(f.record.backup), { recursive: true }); await rm(f.journal);
  const record = { schema: 2, operation: "uninstall", retired: f.record.failed, fingerprint: f.record.newHash,
    marker: encoded(f.newMarker), context: encoded(f.newContext), phase: "prepared" };
  await writeFile(f.file("windows-installation.json"), f.newMarker);
  await writeFile(f.file("uninstallation-in-progress.json"), json(record));
  const remove = f.lease.removeRetired; let once = false;
  f.lease.removeRetired = async name => {
    assert.equal(JSON.parse(await readFile(f.file("uninstallation-in-progress.json"))).phase, "removing_runtime");
    await remove(name); if (!once) { once = true; throw Error("lost delete reply"); }
  };
  await assert.rejects(recoverWindowsMaintenance(f.options)); await recoverWindowsMaintenance(f.options); await historyIntact(f);
});
