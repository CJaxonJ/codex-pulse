import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { codexInvocation, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { ownedWindowsProcessInvocation } from "../src/windows-process-bridge.mjs";
import { WindowsPluginOperation, pulsePluginId } from "./windows-plugin-operation.mjs";

const sourceRoot = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "pulse-plugin-official-"));
const home = path.join(root, "codex"), dataDir = path.join(root, "data");
await mkdir(home); await mkdir(dataDir);
const config = path.join(home, "config.toml");
await writeFile(config, '# user setting must survive\nmodel = "user-selected-model"\n');
const env = { ...process.env, CODEX_HOME: home, CODEX_BINARY: resolveCodexExecutable(), CODEX_PULSE_DATA_DIR: dataDir };
const calls = [];
const runJson = async args => {
  assert.equal(args[0], "plugin", "This acceptance must not contact an account or start a model"); calls.push(args);
  const call = ownedWindowsProcessInvocation(codexInvocation(env.CODEX_BINARY, args));
  return JSON.parse((await promisify(execFile)(call.file, call.args, { env, cwd: dataDir, encoding: "utf8", timeout: 90000, windowsHide: true })).stdout);
};
const options = { sourceRoot, dataDir, env, runJson };
const first = new WindowsPluginOperation(options);
try {
  assert.equal((await first.prepare()).reusedExistingInstall, false);
  await first.install();
  const before = await readFile(config, "utf8");
  assert.match(before, /user-selected-model/); assert.doesNotMatch(before, /\[hooks\.state\./);
  const reused = new WindowsPluginOperation(options);
  assert.equal((await reused.prepare()).reusedExistingInstall, true);
  await reused.install(); await reused.rollback();
  assert.equal(await readFile(config, "utf8"), before, "Reuse must preserve config and trust byte-for-byte");
  await first.rollback();
  assert(!(await runJson(["plugin", "list", "--json"])).installed.some(p => p.pluginId === pulsePluginId));
  assert(!(await runJson(["plugin", "marketplace", "list", "--json"])).marketplaces.some(p => p.name === "codex-pulse-local"));
  await assert.rejects(access(first.root), { code: "ENOENT" });
  const lost = new WindowsPluginOperation({ ...options, runJson: async args => {
    const result = await runJson(args);
    if (args[1] === "add") throw Error("Lost acknowledgement after official plugin add");
    return result;
  } });
  await lost.prepare(); await assert.rejects(lost.install(), /Lost acknowledgement/); await lost.rollback();
  assert(!(await runJson(["plugin", "list", "--json"])).installed.some(p => p.pluginId === pulsePluginId));
  assert.match(await readFile(config, "utf8"), /user-selected-model/);
  assert(!calls.some(args => args.includes("hooks") || args.includes("--yes")));
  console.log(JSON.stringify({ ok: true, realOfficialCLI: true, platform: process.platform, freshInstallAndRollback: true,
    reusedWithoutTrustChanges: true, lostAcknowledgementRecovered: true, accountOrModelUsed: false, productionConfigTouched: false }));
} catch (error) {
  if (process.platform === "win32") {
    const spellings = [root, await realpath(root)];
    const redact = value => typeof value === "string" ? spellings.reduce((text, prefix) => text.replaceAll(prefix, "<isolated-fixture>"), value)
      : Array.isArray(value) ? value.map(redact) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)])) : value;
    try { console.error(JSON.stringify({ isolatedOfficialInventory: redact(await first.inventory()) })); }
    catch { console.error("Official inventory unavailable; no cleanup guessed."); }
  }
  console.error("Isolated official plugin acceptance failed; evidence preserved at " + root);
  throw error;
}
