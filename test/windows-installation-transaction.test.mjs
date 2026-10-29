import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { replaceWindowsRuntime, runtimeFingerprint } from "../scripts/windows-installation-transaction.mjs";

// Filesystem orchestration tests use modeled service/lease ports. Native
// Windows process and scheduler integration is in the separate native suite.
const stageName = () => "app-install-" + randomUUID().replaceAll("-", "");
async function bundle(root, version) {
  for (const [name, value] of Object.entries({ "package.json": JSON.stringify({ name: "codex-pulse", version }), "CodexPulse.exe": "native-test-port", "CodexPulse.exe.config": "native-config", "runtime/node.exe": "node-test-port", "bin/codex-pulse.mjs": "isolated-runtime" })) {
    const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value);
  }
}
async function fixture({ old = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-install-transaction-")), app = path.join(dataDir, "app"), stagedName = stageName(), events = [];
  await bundle(path.join(dataDir, stagedName), "0.9.22");
  if (old) {
    await bundle(app, "0.9.21");
    await writeFile(path.join(dataDir, "windows-installation.json"), JSON.stringify({ name: "codex-pulse", schema: 1, fingerprint: await runtimeFingerprint(app), version: "0.9.21" }));
  }
  const originalContext = Buffer.from('{"original":"context"}\r\n'); await writeFile(path.join(dataDir, "startup-context.json"), originalContext);
  await writeFile(path.join(dataDir, "history.txt"), "user goal, checkpoint and credit ledger must survive");
  let state = { startup: { installed: old, enabled: old }, running: old };
  const service = {
    capture: async () => structuredClone(state),
    quiesce: async () => { events.push("stop"); state.startup.enabled = false; state.running = false; },
    undoActivation: async original => { events.push("undo-activation"); if (!original.startup.installed) state.startup = { installed: false, enabled: false }; },
    activate: async (original, fresh) => { events.push("activate"); state = { startup: { installed: original.startup.installed || fresh, enabled: original.startup.installed ? original.startup.enabled : fresh }, running: fresh || original.running }; await writeFile(path.join(dataDir, "startup-context.json"), '{"new":"context"}'); },
    verify: async () => { events.push("verify"); },
    restore: async (original, { restoreFiles }) => { events.push("restore"); await restoreFiles(); state = structuredClone(original); },
    verifyRestored: async original => assert.deepEqual(state, original),
  };
  const acquireLease = async () => ({
    move: async (from, to) => { events.push("move:" + from + ":" + to); await rename(path.join(dataDir, from), path.join(dataDir, to)); },
    release: async () => { events.push("lease-release"); },
  });
  const options = { dataDir, stagedName, service, acquireLease, preflight: async () => { events.push("preflight"); }, installSideEffects: async () => { events.push("plugin-install"); }, rollbackSideEffects: async () => { events.push("plugin-rollback"); } };
  return { dataDir, app, stagedName, events, service, options, acquireLease, originalContext, state: () => state };
}
const version = async app => JSON.parse(await readFile(path.join(app, "package.json"))).version;
async function historyIntact(f) { assert.equal(await readFile(path.join(f.dataDir, "history.txt"), "utf8"), "user goal, checkpoint and credit ledger must survive"); }

test("installation stages and preflights before quiescing, commits an owned runtime and preserves user history", async () => {
  const f = await fixture();
  const result = await replaceWindowsRuntime(f.options);
  assert.equal(result.ok, true); assert.equal(result.cleanupPending, false); assert.equal(await version(f.app), "0.9.22");
  const marker = JSON.parse(await readFile(path.join(f.dataDir, "windows-installation.json")));
  assert.equal(marker.fingerprint, await runtimeFingerprint(f.app));
  assert(f.events.indexOf("preflight") < f.events.indexOf("stop"));
  assert(f.events.indexOf("plugin-install") < f.events.indexOf("activate"));
  assert(!(await readdir(f.dataDir)).some(name => /^app-backup-/.test(name) || name === "installation-in-progress.json"));
  await historyIntact(f);
});

test("a preflight failure never stops the old service or changes its context/runtime", async () => {
  const f = await fixture(), hash = await runtimeFingerprint(f.app);
  await assert.rejects(replaceWindowsRuntime({ ...f.options, preflight: async () => { throw Error("isolated missing dependency"); } }), /missing dependency/);
  assert.deepEqual(f.events, []); assert.equal(await runtimeFingerprint(f.app), hash);
  assert.deepEqual(await readFile(path.join(f.dataDir, "startup-context.json")), f.originalContext); await historyIntact(f);
});

test("post-activation failure restores exact old marker/context/startup state without reverting concurrent preferences", async () => {
  const f = await fixture(), marker = await readFile(path.join(f.dataDir, "windows-installation.json"));
  f.service.verify = async () => { await writeFile(path.join(f.dataDir, "preferences.json"), '{"userChanged":true}'); throw Error("injected activation failure"); };
  await assert.rejects(replaceWindowsRuntime(f.options), /原运行目录和启动状态已恢复/);
  assert.equal(await version(f.app), "0.9.21"); assert.deepEqual(await readFile(path.join(f.dataDir, "windows-installation.json")), marker);
  assert.deepEqual(await readFile(path.join(f.dataDir, "startup-context.json")), f.originalContext);
  assert.deepEqual(f.state(), { startup: { installed: true, enabled: true }, running: true });
  assert.equal(await readFile(path.join(f.dataDir, "preferences.json"), "utf8"), '{"userChanged":true}');
  assert(f.events.indexOf("plugin-rollback") < f.events.indexOf("restore")); await historyIntact(f);
});

test("first-install failure removes only the new activation and rolls back side effects before retiring the runtime", async () => {
  const f = await fixture({ old: false }); f.service.verify = async () => { throw Error("isolated fresh install failure"); };
  await assert.rejects(replaceWindowsRuntime(f.options), /原运行目录和启动状态已恢复/);
  assert(!(await readdir(f.dataDir)).includes("app"));
  assert(f.events.includes("undo-activation"));
  assert(f.events.findIndex(e => e === "plugin-rollback") < f.events.findIndex(e => e.startsWith("move:app:app-failed-")));
  assert.deepEqual(f.state(), { startup: { installed: false, enabled: false }, running: false }); await historyIntact(f);
});

test("failed side-effect cleanup keeps the new runtime and old backup rather than leaving a dangling Hook", async () => {
  const f = await fixture(); f.service.verify = async () => { throw Error("activation failure"); };
  await assert.rejects(replaceWindowsRuntime({ ...f.options, rollbackSideEffects: async () => { throw Error("plugin removal refused"); } }), /无法安全确认完整回滚/);
  assert.equal(await version(f.app), "0.9.22");
  const names = await readdir(f.dataDir); assert(names.some(n => n.startsWith("app-backup-"))); assert(names.includes("installation-in-progress.json"));
  assert(!f.events.includes("restore")); await historyIntact(f);
});

test("an acknowledgement lost after the old-directory move is resolved from real filesystem evidence", async () => {
  const f = await fixture(); let injected = false;
  const acquireLease = async () => {
    const lease = await f.acquireLease();
    return { ...lease, move: async (from, to) => { await lease.move(from, to); if (!injected && from === "app" && to.startsWith("app-backup-")) { injected = true; throw Error("acknowledgement lost after actual move"); } } };
  };
  await assert.rejects(replaceWindowsRuntime({ ...f.options, acquireLease }), /原运行目录和启动状态已恢复/);
  assert(injected); assert.equal(await version(f.app), "0.9.21"); assert.deepEqual(f.state(), { startup: { installed: true, enabled: true }, running: true }); await historyIntact(f);
});

test("unknown backups, interrupted journals and changed/unowned runtime fail before quiescing", async () => {
  for (const condition of ["backup", "journal", "changed", "unowned"]) {
    const f = await fixture();
    if (condition === "backup") await mkdir(path.join(f.dataDir, "app-backup-" + "a".repeat(32)));
    if (condition === "journal") await writeFile(path.join(f.dataDir, "installation-in-progress.json"), "preserve interrupted state");
    if (condition === "changed") await writeFile(path.join(f.app, "user-added.txt"), "do not delete my work");
    if (condition === "unowned") await writeFile(path.join(f.dataDir, "windows-installation.json"), '{}');
    await assert.rejects(replaceWindowsRuntime(f.options)); assert(!f.events.includes("stop")); await historyIntact(f);
  }
});
