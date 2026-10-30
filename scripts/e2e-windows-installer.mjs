import assert from "node:assert/strict";
import { cp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { windowsRecoveryBackgroundFixture } from "./test-support/windows-recovery-background-fixture.mjs";
import { codexInvocation, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { ownedWindowsProcessInvocation } from "../src/windows-process-bridge.mjs";
import { WindowsRuntimeService } from "./windows-runtime-service.mjs";
import { runtimeFingerprint } from "./windows-installation-transaction.mjs";
import { pulsePluginId } from "./windows-plugin-operation.mjs";

if (process.platform !== "win32") throw Error("This acceptance requires real Windows");
const execute = promisify(execFile), project = path.resolve(import.meta.dirname, "..");
const official = resolveCodexExecutable();
const versionCall = codexInvocation(official, ["--version"]);
assert.match((await execute(versionCall.file, versionCall.args, { encoding: "utf8", timeout: 15000 })).stdout, /0\.163\.0-alpha\.11\.1/);

async function fixture({ failAfterActivation = false } = {}) {
  const f = await windowsRecoveryBackgroundFixture({ installed: false, nativeRateReads: true });
  for (const name of ["scripts", "plugin", ".agents"]) await cp(path.join(project, name), path.join(f.appRoot, name), { recursive: true });
  // Account/RPC is isolated and synthetic. Plugin commands use the actual
  // pinned official CLI and this fixture's separate CODEX_HOME, without auth.
  const peer = path.join(path.dirname(f.env.CODEX_BINARY), "node_modules", "@openai", "codex", "bin", "codex.js");
  const original = await readFile(peer, "utf8"), invocation = codexInvocation(official, []);
  await writeFile(peer, `if(process.argv[2]==='plugin'){
    const result=require('node:child_process').spawnSync(${JSON.stringify(invocation.file)},[...${JSON.stringify(invocation.args)},...process.argv.slice(2)],{env:process.env,stdio:'inherit',windowsHide:true});
    if(result.error)throw result.error;process.exit(result.status===null?1:result.status);
  }\n` + original);
  if (failAfterActivation) {
    const serviceFile = path.join(f.appRoot, "scripts", "windows-runtime-service.mjs");
    const source = await readFile(serviceFile, "utf8"), needle = "async verify(original, fresh) {";
    assert.equal(source.split(needle).length, 2);
    await writeFile(serviceFile, source.replace(needle, needle + '\n    throw Error("Deliberate isolated failure after real activation");'));
  }
  const runEntry = async (entry, env) => {
    try {
      const result = await execute(path.join(f.appRoot, "runtime", "node.exe"), [path.join(f.appRoot, "scripts", entry)],
        { env: env || f.env, encoding: "utf8", windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 ** 2 });
      return { code: 0, value: JSON.parse(result.stdout), stderr: result.stderr };
    } catch (error) { return { code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  };
  const run = env => runEntry("install-windows.mjs", env), uninstall = () => runEntry("uninstall-windows.mjs");
  const cli = async args => {
    assert.equal(args[0], "plugin");
    const call = ownedWindowsProcessInvocation(codexInvocation(official, args));
    return JSON.parse((await execute(call.file, call.args, { env: f.env, cwd: f.dataDir, encoding: "utf8", windowsHide: true, timeout: 30000 })).stdout);
  };
  const service = new WindowsRuntimeService({ dataDir: f.dataDir, sourceBinary: path.join(f.appRoot, "CodexPulse.exe"), env: f.env });
  const cleanup = async () => {
    await service.quiesce();
    const names = await readdir(f.dataDir), native = names.includes("app") ? service.target() : service.sourceBinary;
    if ((await service.call(native, ["--startup", "status"])).installed) await service.call(native, ["--startup", "remove"]);
    if ((await cli(["plugin", "list", "--json"])).installed.some(p => p.pluginId === pulsePluginId)) await cli(["plugin", "remove", pulsePluginId, "--json"]);
    if ((await cli(["plugin", "marketplace", "list", "--json"])).marketplaces.some(p => p.name === "codex-pulse-local")) await cli(["plugin", "marketplace", "remove", "codex-pulse-local", "--json"]);
  };
  return { ...f, run, uninstall, cli, service, cleanup };
}

async function verify(f, body) {
  let primary;
  try { await body(); } catch (error) { primary = error; throw error; }
  finally { try { await f.cleanup(); } catch (cleanup) { throw primary ? new AggregateError([primary, cleanup], "Installer acceptance and cleanup failed") : cleanup; } }
}

const failed = await fixture({ failAfterActivation: true });
await verify(failed, async () => {
  await writeFile(path.join(failed.dataDir, "keep-checkpoint"), "keep original task and unknown credit ledger");
  const result = await failed.run(); assert.notEqual(result.code, 0); assert.match(result.stderr, /原运行目录和启动状态已恢复/);
  const names = await readdir(failed.dataDir);
  assert(!names.includes("app")); assert(!names.includes("marketplace")); assert(!names.includes("installation-in-progress.json"));
  assert(names.some(name => name.startsWith("app-failed-")), "The new real native runtime must have activated before rollback");
  assert(!(await failed.cli(["plugin", "list", "--json"])).installed.some(p => p.pluginId === pulsePluginId));
  assert(!(await failed.cli(["plugin", "marketplace", "list", "--json"])).marketplaces.some(p => p.name === "codex-pulse-local"));
  assert.equal(await readFile(path.join(failed.dataDir, "keep-checkpoint"), "utf8"), "keep original task and unknown credit ledger");
  assert.deepEqual(await failed.queueLog(), []);
});

const f = await fixture();
await verify(f, async () => {
  await writeFile(path.join(f.env.CODEX_HOME, "config.toml"), '# unrelated user setting\nmodel = "user-selected-model"\n');
  const installed = await f.run(); assert.equal(installed.code, 0, installed.stderr); assert.equal(installed.value.ok, true);
  const original = await f.service.capture(true);
  assert.deepEqual(original, { startup: { installed: true, enabled: true }, running: true });
  const config = path.join(f.env.CODEX_HOME, "config.toml"), before = await readFile(config, "utf8");
  assert.doesNotMatch(before, /\[hooks\.state\./, "Installation cannot grant hook trust");
  const again = await f.run(); assert.equal(again.code, 0, again.stderr);
  assert.equal(await readFile(config, "utf8"), before, "Reinstallation must not rewrite existing config or consent");
  const hash = await runtimeFingerprint(path.join(f.dataDir, "app"));
  const generation = JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"))).generation;
  const unavailable = await f.run({ ...f.env, CODEX_BINARY: path.join(f.root, "missing-codex.exe") });
  assert.notEqual(unavailable.code, 0);
  assert.equal(await runtimeFingerprint(path.join(f.dataDir, "app")), hash);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"))).generation, generation, "Failed preflight must not restart the existing service");
  assert.deepEqual(await f.service.capture(true), original); assert.deepEqual(await f.queueLog(), []);
  for (const name of ["checkpoint.json", "credit-ledger.json", "preferences-note.txt"]) await writeFile(path.join(f.dataDir, name), name + " preserved");
  const userNote = path.join(f.dataDir, "marketplace", "user-note.txt"); await writeFile(userNote, "unknown user content");
  const refused = await f.uninstall(); assert.notEqual(refused.code, 0);
  assert.equal(await readFile(userNote, "utf8"), "unknown user content");
  assert.equal(await runtimeFingerprint(path.join(f.dataDir, "app")), hash);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"))).generation, generation, "Unsafe uninstall must fail before stopping the service");
  assert(!(await readdir(f.dataDir)).includes("uninstallation-in-progress.json"));
  await rm(userNote); // Only this isolated acceptance's own injected file.
  const removed = await f.uninstall(); assert.equal(removed.code, 0, removed.stderr); assert.equal(removed.value.ok, true);
  assert.deepEqual(await f.service.capture(false), { startup: { installed: false, enabled: false }, running: false });
  const names = await readdir(f.dataDir);
  for (const name of ["app", "marketplace", "startup-context.json", "windows-installation.json", "uninstallation-in-progress.json"]) assert(!names.includes(name), name + " was not removed");
  assert(!names.some(name => name.startsWith("app-failed-") || name.startsWith("app-backup-")));
  assert(!(await f.cli(["plugin", "list", "--json"])).installed.some(p => p.pluginId === pulsePluginId));
  assert(!(await f.cli(["plugin", "marketplace", "list", "--json"])).marketplaces.some(p => p.name === "codex-pulse-local"));
  for (const name of ["checkpoint.json", "credit-ledger.json", "preferences-note.txt"]) assert.equal(await readFile(path.join(f.dataDir, name), "utf8"), name + " preserved");
  assert.match(await readFile(config, "utf8"), /user-selected-model/); assert.deepEqual(await f.queueLog(), []);
});
console.log(JSON.stringify({ ok: true, nativeWindowsInstallerEntry: true, realOfficialPluginCommands: true, realTaskScheduler: true,
  freshInstallReinstallAndFailedPreflight: true, postActivationRollback: true, uninstallAndPreserveHistory: true, unsafeUninstallRefusedBeforeStop: true,
  accountRPC: "isolated synthetic peer", modelCalls: 0, realResetCardsUsed: 0,
  guiPackageOrPhysicalSleepVerified: false, productionInstallTouched: false }));
