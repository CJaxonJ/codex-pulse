import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, cp, readFile, writeFile, access, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WindowsPluginOperation, pulsePluginId } from "../scripts/windows-plugin-operation.mjs";

const project = path.resolve(import.meta.dirname, "..");
async function fixture({ reused = false } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-plugin-operation-")), sourceRoot = path.join(dataDir, "source");
  await mkdir(sourceRoot);
  for (const name of ["plugin", ".agents"]) await cp(path.join(project, name), path.join(sourceRoot, name), { recursive: true });
  const calls = [], state = { plugins: reused ? [{ pluginId: pulsePluginId }] : [], catalogs: [] };
  let mode = "";
  const runJson = async args => {
    calls.push(args);
    const verb = args.slice(0, 3).join(" ");
    if (verb === "plugin list --json") return { installed: structuredClone(state.plugins) };
    if (verb === "plugin marketplace list") return { marketplaces: structuredClone(state.catalogs) };
    if (verb === "plugin marketplace add") state.catalogs.push({ name: "codex-pulse-local", root: args[3], marketplaceSource: { sourceType: "local", source: args[3] } });
    else if (args[1] === "add") { state.plugins.push({ pluginId: pulsePluginId, version: "0.9.22", enabled: true, source: { source: "local", path: path.join(dataDir, "marketplace", "plugin") } }); if (mode === "add-ack-lost") throw Error("Acknowledgement lost after add"); }
    else if (args[1] === "remove") { if (mode === "remove-denied") throw Error("Removal denied"); state.plugins = []; if (mode === "remove-ack-lost") throw Error("Lost removal response"); }
    else if (verb === "plugin marketplace remove") state.catalogs = [];
    else throw Error("Unexpected test command: " + args);
    return { ok: true };
  };
  const op = new WindowsPluginOperation({ sourceRoot, dataDir, runJson, check: async () => ({ ok: true, reusedExistingInstall: reused, pluginId: pulsePluginId }) });
  return { dataDir, sourceRoot, calls, state, op, mode: value => mode = value };
}
const removalFor = f => new WindowsPluginOperation({ sourceRoot: f.sourceRoot, dataDir: f.dataDir, runJson: f.op.runJson });
test("uninstall independently proves the private catalog against the owned installed runtime before removal", async () => {
  const f = await fixture(); await f.op.prepare(); await f.op.install();
  const removal = removalFor(f); await removal.prepareRemoval(); await removal.rollback(); await removal.verifyRemoved();
  assert.deepEqual(f.state.plugins, []); assert.deepEqual(f.state.catalogs, []);
  assert(!f.calls.some(args => args.includes("hooks") || args.includes("--yes")));
});
test("uninstall refuses extra private-market files, modified plugin code or another registered source", async () => {
  for (const change of ["extra", "plugin", "source", "other-plugin"]) {
    const f = await fixture(); await f.op.prepare(); await f.op.install();
    if (change === "extra") await writeFile(path.join(f.op.root, "user-note"), "keep");
    if (change === "plugin") await writeFile(path.join(f.op.root, "plugin", "user-note"), "keep");
    if (change === "source") f.state.plugins[0].source.path = f.sourceRoot;
    if (change === "other-plugin") f.state.plugins.push({ pluginId: "other@codex-pulse-local", marketplaceName: "codex-pulse-local" });
    const count = f.calls.length; await assert.rejects(removalFor(f).prepareRemoval());
    assert(!f.calls.slice(count).some(args => args.includes("remove")));
    assert.equal(f.state.plugins[0].pluginId, pulsePluginId); await access(f.op.root);
  }
});
test("an absent plugin is rechecked, not assumed absent from an earlier preflight", async () => {
  const f = await fixture(), removal = removalFor(f); await removal.prepareRemoval();
  f.state.plugins.push({ pluginId: pulsePluginId });
  await removal.rollback(); await assert.rejects(removal.verifyRemoved(), /仍存在/);
});
test("fresh plugin rollback removes only owned official definitions and preserves unrelated data", async () => {
  const f = await fixture(); await writeFile(path.join(f.dataDir, "checkpoint"), "keep");
  await f.op.prepare(); await f.op.install(); await f.op.rollback();
  assert.deepEqual(f.state.plugins, []); assert.deepEqual(f.state.catalogs, []);
  await assert.rejects(access(f.op.root), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.dataDir, "checkpoint"), "utf8"), "keep");
  assert(!f.calls.flat().some(value => value === "--yes" || value === "hooks"));
});
test("an installed compatible plugin is reused without add/remove or any catalog rewrite", async () => {
  const f = await fixture({ reused: true }); await f.op.prepare(); await f.op.install(); await f.op.rollback();
  assert(f.calls.every(args => args[1] === "list" || args[2] === "list"));
  assert.equal(f.state.plugins.length, 1);
});
test("an add acknowledgement lost after installation is recovered by checking actual inventory", async () => {
  const f = await fixture(); await f.op.prepare(); f.mode("add-ack-lost");
  await assert.rejects(f.op.install(), /Acknowledgement/);
  f.mode("remove-ack-lost"); await f.op.rollback();
  assert.deepEqual(f.state.plugins, []); assert.deepEqual(f.state.catalogs, []);
});
test("a resolved catalog snapshot is not confused with its registered local source", async () => {
  const f = await fixture(); await f.op.prepare(); await f.op.install();
  f.state.catalogs[0].root = path.join(f.dataDir, "official-resolved-snapshot");
  await f.op.rollback(); assert.deepEqual(f.state.plugins, []); assert.deepEqual(f.state.catalogs, []);
});
test("legacy name/root catalog is accepted only at the exact owned local directory", async () => {
  const f = await fixture(); await f.op.prepare(); await f.op.install();
  delete f.state.catalogs[0].marketplaceSource;
  await f.op.rollback(); assert.deepEqual(f.state.plugins, []);
  const other = await fixture(); await other.op.prepare(); await other.op.install();
  delete other.state.catalogs[0].marketplaceSource; other.state.catalogs[0].root = other.sourceRoot;
  await assert.rejects(other.op.rollback(), /市场来源已改变/);
  assert.equal(other.state.plugins.length, 1);
});
test("Windows local verbatim source is equivalent but UNC metadata cannot redirect cleanup", { skip: process.platform !== "win32" }, async () => {
  const f = await fixture(); await f.op.prepare(); await f.op.install();
  f.state.catalogs[0].marketplaceSource.source = "\\\\?\\" + await realpath(f.op.root);
  f.state.plugins[0].source.path = "\\\\?\\" + await realpath(path.join(f.op.root, "plugin"));
  await f.op.assertOwned(await f.op.inventory());
  f.state.catalogs[0].marketplaceSource.source = (await realpath(f.op.root)).replaceAll("\\", "/");
  await f.op.rollback(); assert.deepEqual(f.state.plugins, []);
  const other = await fixture(); await other.op.prepare(); await other.op.install();
  other.state.catalogs[0].marketplaceSource.source = "\\\\unrelated.invalid\\share";
  await assert.rejects(other.op.rollback(), /市场来源已改变/);
  assert.equal(other.state.plugins.length, 1); await access(other.op.root);
});
test("failed plugin removal leaves its catalog/runtime dependency in place", async () => {
  const f = await fixture(); await f.op.prepare(); await f.op.install(); f.mode("remove-denied");
  await assert.rejects(f.op.rollback(), /未确认移除/);
  assert.equal(f.state.plugins.length, 1); assert.equal(f.state.catalogs.length, 1); await access(f.op.root);
});
test("unknown existing catalog, modified files and replaced sources are not deleted", async () => {
  const first = await fixture(); await mkdir(first.op.root); await writeFile(path.join(first.op.root, "user.txt"), "keep");
  await assert.rejects(first.op.prepare(), /未覆盖/);
  assert.equal(await readFile(path.join(first.op.root, "user.txt"), "utf8"), "keep");
  const f = await fixture(); await f.op.prepare(); await f.op.install();
  await writeFile(path.join(f.op.root, "user-note"), "keep");
  await assert.rejects(f.op.rollback(), /已改变/); assert.equal(f.state.plugins.length, 1);
  const other = await fixture(); await other.op.prepare(); await other.op.install();
  other.state.plugins[0].source.path = other.sourceRoot;
  await assert.rejects(other.op.rollback(), /来源已改变/); assert.equal(other.state.catalogs.length, 1);
});
