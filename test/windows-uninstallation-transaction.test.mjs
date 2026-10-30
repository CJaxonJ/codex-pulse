import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runtimeFingerprint } from "../scripts/windows-installation-transaction.mjs";
import { removeWindowsInstallation } from "../scripts/windows-uninstallation-transaction.mjs";

// These filesystem tests model the native ports, not a Windows proof. Actual
// native deletion and official plugin removal run in the installer E2E.
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-uninstall-transaction-")), app = path.join(dataDir, "app"), events = [];
  await mkdir(app); await writeFile(path.join(app, "runtime.txt"), "owned runtime");
  const marker = path.join(dataDir, "windows-installation.json"), context = path.join(dataDir, "startup-context.json");
  await writeFile(marker, JSON.stringify({ name: "codex-pulse", schema: 1, fingerprint: await runtimeFingerprint(app) }));
  await writeFile(context, '{"installed":"context"}');
  for (const name of ["preferences.json", "checkpoint.json", "credit-ledger.json", "state.json"]) await writeFile(path.join(dataDir, name), name + " must survive");
  const service = {
    capture: async () => ({ startup: { installed: true, enabled: true }, running: true }),
    quiesce: async () => { events.push("stop"); },
    removeStartup: async () => { events.push("remove-startup"); },
    verifyRemoved: async () => { events.push("verify-stopped"); },
  };
  const plugin = { prepareRemoval: async () => { events.push("plugin-preflight"); }, rollback: async () => { events.push("remove-plugin"); }, verifyRemoved: async () => { events.push("verify-plugin"); } };
  const lease = {
    move: async (from, to) => { events.push("move"); await rename(path.join(dataDir, from), path.join(dataDir, to)); },
    removeRetired: async name => { events.push("remove-retired"); await rm(path.join(dataDir, name), { recursive: true }); },
    release: async () => { events.push("release-lease"); },
  };
  return { dataDir, app, marker, context, service, plugin, lease, events,
    options: { dataDir, service, plugin, acquireLease: async () => lease } };
}
async function historyIntact(f) {
  for (const name of ["preferences.json", "checkpoint.json", "credit-ledger.json", "state.json"]) assert.equal(await readFile(path.join(f.dataDir, name), "utf8"), name + " must survive");
}

test("uninstall removes only the verified runtime and context after official plugin removal and verified startup stop", async () => {
  const f = await fixture();
  assert.deepEqual(await removeWindowsInstallation(f.options), { ok: true, runtimeRemoved: true, pluginRemoved: true, startupRemoved: true, historyPreserved: true });
  const names = await readdir(f.dataDir);
  for (const name of ["app", "windows-installation.json", "startup-context.json", "uninstallation-in-progress.json"]) assert(!names.includes(name));
  assert(!names.some(name => name.startsWith("app-failed-")));
  for (const [first, second] of [["plugin-preflight", "stop"], ["verify-plugin", "move"], ["remove-startup", "move"], ["verify-stopped", "remove-retired"]]) assert(f.events.indexOf(first) < f.events.indexOf(second));
  await historyIntact(f);
});

test("changed runtime, ownership marker or interrupted install/uninstall refuses before touching the running service", async () => {
  for (const condition of ["changed", "marker", "install-journal", "uninstall-journal", "backup", "plugin-source"]) {
    const f = await fixture();
    if (condition === "changed") await writeFile(path.join(f.app, "user-note.txt"), "keep my work");
    if (condition === "marker") await writeFile(f.marker, "{}");
    if (condition === "install-journal") await writeFile(path.join(f.dataDir, "installation-in-progress.json"), "preserve evidence");
    if (condition === "uninstall-journal") await writeFile(path.join(f.dataDir, "uninstallation-in-progress.json"), "preserve evidence");
    if (condition === "backup") await mkdir(path.join(f.dataDir, "app-backup-" + "a".repeat(32)));
    if (condition === "plugin-source") f.plugin.prepareRemoval = async () => { throw Error("external source"); };
    await assert.rejects(removeWindowsInstallation(f.options));
    assert(!f.events.includes("stop")); assert(!f.events.includes("move")); await historyIntact(f);
    assert.equal(await readFile(path.join(f.app, "runtime.txt"), "utf8"), "owned runtime");
  }
});

test("failed stop, unknown plugin or failed task removal keeps runtime and durable uninstall journal", async () => {
  for (const stage of ["stop", "plugin", "plugin-readback", "startup", "acquire-lease"]) {
    const f = await fixture();
    const fail = async () => { throw Error("injected refusal"); };
    if (stage === "stop") f.service.quiesce = fail;
    if (stage === "plugin") f.plugin.rollback = fail;
    if (stage === "plugin-readback") f.plugin.verifyRemoved = fail;
    if (stage === "startup") f.service.removeStartup = fail;
    const options = stage === "acquire-lease" ? { ...f.options, acquireLease: fail } : f.options;
    await assert.rejects(removeWindowsInstallation(options), /卸载未完成/);
    assert.equal(await readFile(path.join(f.app, "runtime.txt"), "utf8"), "owned runtime");
    assert((await readdir(f.dataDir)).includes("uninstallation-in-progress.json"));
    assert(!f.events.includes("move")); await historyIntact(f);
  }
});

test("changes after preflight prevent runtime deletion and preserve changed context or files", async () => {
  for (const changed of ["runtime", "context"]) {
    const f = await fixture();
    f.service.removeStartup = async () => {
      if (changed === "runtime") await writeFile(path.join(f.app, "user-note.txt"), "new work");
      else await writeFile(f.context, "new context");
    };
    await assert.rejects(removeWindowsInstallation(f.options), /卸载未完成/);
    assert(!f.events.includes("move")); assert(!f.events.includes("remove-retired"));
    if (changed === "runtime") assert.equal(await readFile(path.join(f.app, "user-note.txt"), "utf8"), "new work");
    else assert.equal(await readFile(f.context, "utf8"), "new context");
    await historyIntact(f);
  }
});

test("move acknowledgement loss and locked deletion retain exact retired runtime and evidence, never erase history", async () => {
  for (const failure of ["move-ack-lost", "delete-refused", "still-running"]) {
    const f = await fixture(), hash = await runtimeFingerprint(f.app);
    if (failure === "move-ack-lost") {
      const move = f.lease.move; f.lease.move = async (...args) => { await move(...args); throw Error("lost reply"); };
    } else if (failure === "delete-refused") f.lease.removeRetired = async () => { throw Error("file still open"); };
    else f.service.verifyRemoved = async () => { throw Error("unknown background"); };
    await assert.rejects(removeWindowsInstallation(f.options), /卸载未完成/);
    const names = await readdir(f.dataDir), retired = names.find(name => name.startsWith("app-failed-"));
    assert(retired); assert.equal(await runtimeFingerprint(path.join(f.dataDir, retired)), hash);
    assert(names.includes("uninstallation-in-progress.json")); assert(names.includes("windows-installation.json"));
    assert(f.events.includes("release-lease")); await historyIntact(f);
  }
});
