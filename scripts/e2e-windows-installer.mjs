import assert from "node:assert/strict";
import { readFile, writeFile, readdir, rm, mkdtemp } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
import { windowsRecoveryBackgroundFixture } from "./test-support/windows-recovery-background-fixture.mjs";
import { codexInvocation, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { ownedWindowsProcessInvocation } from "../src/windows-process-bridge.mjs";
import { WindowsRuntimeService } from "./windows-runtime-service.mjs";
import { runtimeFingerprint } from "./windows-installation-transaction.mjs";
import { pulsePluginId } from "./windows-plugin-operation.mjs";
import { writeWindowsBundleManifest } from "./windows-bundle-manifest.mjs";
import { packageWindows } from "./package-windows.mjs";
import { ManagedTaskStore } from "../src/managed-task-store.mjs";
import { inspectWindowsUI, waitForWindowsUI } from "./test-support/windows-ui-fixture.mjs";

if (process.platform !== "win32") throw Error("This acceptance requires real Windows");
const execute = promisify(execFile);
const official = resolveCodexExecutable();
const versionCall = codexInvocation(official, ["--version"]);
assert.match((await execute(versionCall.file, versionCall.args, { encoding: "utf8", timeout: 15000 })).stdout, /0\.163\.0-alpha\.11\.1/);
const packaged = await packageWindows(), extracted = await mkdtemp(path.join(os.tmpdir(), "pulse 包 验收-"));
await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory($env:PULSE_ZIP_OUTPUT,$env:PULSE_ZIP_EXTRACT)"],
{ env: { ...process.env, PULSE_ZIP_OUTPUT: packaged.archive, PULSE_ZIP_EXTRACT: extracted }, windowsHide: true, encoding: "utf8", timeout: 90000 });
const sourceBundle = path.join(extracted, path.basename(packaged.archive, ".zip"));

async function fixture({ failAfterActivation = false } = {}) {
  const f = await windowsRecoveryBackgroundFixture({ installed: false, nativeRateReads: true, sourceBundle });
  // Account/RPC is isolated and synthetic. Plugin commands use the actual
  // pinned official CLI and this fixture's separate CODEX_HOME, without auth.
  const peer = path.join(path.dirname(f.env.CODEX_BINARY), "node_modules", "@openai", "codex", "bin", "codex.js");
  const original = await readFile(peer, "utf8"), invocation = codexInvocation(official, []);
  const requests = path.join(f.root, "model-start-attempts.jsonl"), requestNeedle = "const m=JSON.parse(line);if(m.id==null)return;";
  assert.equal(original.split(requestNeedle).length, 2);
  const traced = original.replace(requestNeedle, requestNeedle + `if(['thread/start','turn/start','thread/resume'].includes(m.method))fs.appendFileSync(${JSON.stringify(requests)},JSON.stringify({method:m.method})+'\\n');`);
  await writeFile(peer, `if(process.argv[2]==='plugin'){
    const result=require('node:child_process').spawnSync(${JSON.stringify(invocation.file)},[...${JSON.stringify(invocation.args)},...process.argv.slice(2)],{env:process.env,stdio:'inherit',windowsHide:true});
    if(result.error)throw result.error;process.exit(result.status===null?1:result.status);
  }\n` + traced);
  if (failAfterActivation) {
    const serviceFile = path.join(f.appRoot, "scripts", "windows-runtime-service.mjs");
    const source = await readFile(serviceFile, "utf8"), needle = "async verify(original, fresh) {";
    assert.equal(source.split(needle).length, 2);
    await writeFile(serviceFile, source.replace(needle, needle + '\n    throw Error("Deliberate isolated failure after real activation");'));
    // This is an explicitly fault-injected derivative of the verified bundle.
    // The normal install/uninstall below uses unchanged extracted ZIP bytes.
    await writeWindowsBundleManifest(f.appRoot, { appVersion: JSON.parse(await readFile(path.join(f.appRoot, "package.json"))).version, nodeVersion: process.version });
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
  const modelRequests = async () => { try { return (await readFile(requests, "utf8")).trim().split("\n").filter(Boolean); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
  return { ...f, run, uninstall, cli, service, cleanup, modelRequests };
}

async function verify(f, body) {
  let primary;
  try { await body(); } catch (error) { primary = error; throw error; }
  finally { try { await f.cleanup(); } catch (cleanup) { throw primary ? new AggregateError([primary, cleanup], "Installer acceptance and cleanup failed") : cleanup; } }
}

async function setupUI(f, { uninstall = false } = {}) {
  const session = f.start(), title = "Codex Pulse · 安装";
  const button = (ui, name) => ui.buttons.some(b => b.name === name && b.enabled && !b.offscreen);
  try {
    await waitForWindowsUI(session, ui => button(ui, uninstall ? "卸载" : "安装"), { title });
    if (uninstall) {
      await inspectWindowsUI(session, { title, click: "卸载" });
      await waitForWindowsUI(session, ui => button(ui, "确认卸载"), { title });
      await inspectWindowsUI(session, { title, click: "确认卸载" });
    } else await inspectWindowsUI(session, { title, click: "安装" });
    const state = await waitForWindowsUI(session, ui => button(ui, uninstall ? "重新安装" : "打开设置") || button(ui, uninstall ? "重试卸载" : "重试安装"), { title, timeoutMs: 180000 });
    assert(button(state, uninstall ? "重新安装" : "打开设置"), state.content.join("\n"));
    assert.doesNotMatch(state.content.join("\n"), /node\.exe|install-windows\.mjs|powershell/i);
    return state;
  } finally {
    if (session.child.exitCode == null) {
      await waitForWindowsUI(session, ui => button(ui, "关闭") || button(ui, "返回"), { title, timeoutMs: 180000 });
      // A failed uninstall retains its inline confirmation; Back then Close.
      let state = await inspectWindowsUI(session, { title });
      if (button(state, "返回")) await inspectWindowsUI(session, { title, click: "返回" });
      await inspectWindowsUI(session, { title, click: "关闭" }); await session.closed;
    }
  }
}

// Kill only a ChildProcess created by this test, after real activation. The
// next unmodified entry must recover disk state and official plugin effects;
// a thrown callback inside the original process is not a crash-recovery proof.
const interrupted = await fixture();
await verify(interrupted, async () => {
  const serviceFile = path.join(interrupted.appRoot, "scripts", "windows-runtime-service.mjs");
  const source = await readFile(serviceFile, "utf8"), ready = path.join(interrupted.root, "installer-waiting");
  const needle = "async verify(original, fresh) {"; assert.equal(source.split(needle).length, 2);
  await writeFile(serviceFile, source.replace(needle, needle + `\n    await (await import('node:fs/promises')).writeFile(${JSON.stringify(ready)},'ready'); await new Promise(()=>setInterval(()=>{},1000));`));
  const manifest = async () => writeWindowsBundleManifest(interrupted.appRoot, { appVersion: JSON.parse(await readFile(path.join(interrupted.appRoot, "package.json"))).version, nodeVersion: process.version });
  await manifest();
  const child = spawn(path.join(interrupted.appRoot, "runtime", "node.exe"), [path.join(interrupted.appRoot, "scripts", "install-windows.mjs")],
    { env: interrupted.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let diagnostics = "", exited = false;
  child.stdout.on("data", b => { diagnostics = (diagnostics + b).slice(-4000); }); child.stderr.on("data", b => { diagnostics = (diagnostics + b).slice(-4000); });
  const closed = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", () => { exited = true; resolve(); }); });
  try {
    const deadline = Date.now() + 90000; let reached = false;
    do {
      try { reached = await readFile(ready, "utf8") === "ready"; } catch (e) { if (e.code !== "ENOENT") throw e; }
      if (reached || exited) break; await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.equal(reached, true, diagnostics);
    assert.equal((await interrupted.service.capture(true)).running, true);
    child.kill(); await closed;
    assert.equal(JSON.parse(await readFile(path.join(interrupted.dataDir, "installation-in-progress.json"))).schema, 2);
    await writeFile(serviceFile, source); await manifest();
    const retry = await interrupted.run(); assert.equal(retry.code, 0, retry.stderr);
    assert(!(await readdir(interrupted.dataDir)).includes("installation-in-progress.json"));
    assert.deepEqual(await interrupted.service.capture(true), { startup: { installed: true, enabled: true }, running: true });
    assert.deepEqual(await interrupted.modelRequests(), []);
    assert.equal((await interrupted.uninstall()).code, 0);
  } finally { if (!exited) child.kill(); await closed; }
});

const failed = await fixture({ failAfterActivation: true });
await verify(failed, async () => {
  await writeFile(path.join(failed.dataDir, "keep-checkpoint"), "keep original task and unknown credit ledger");
  const task = await new ManagedTaskStore(failed.dataDir).queue({ cwd: failed.workspace, objective: "This isolated eligible task must not start during a failing installation", startFloor: 50, resumeFloor: 50 });
  const taskFile = path.join(failed.dataDir, "managed-tasks", task.id + ".json"), taskBefore = await readFile(taskFile);
  const result = await failed.run(); assert.notEqual(result.code, 0); assert.match(result.stderr, /原运行目录和启动状态已恢复/);
  const names = await readdir(failed.dataDir);
  assert(!names.includes("app")); assert(!names.includes("marketplace")); assert(!names.includes("installation-in-progress.json"));
  assert(names.some(name => name.startsWith("app-failed-")), "The new real native runtime must have activated before rollback");
  assert(!(await failed.cli(["plugin", "list", "--json"])).installed.some(p => p.pluginId === pulsePluginId));
  assert(!(await failed.cli(["plugin", "marketplace", "list", "--json"])).marketplaces.some(p => p.name === "codex-pulse-local"));
  assert.equal(await readFile(path.join(failed.dataDir, "keep-checkpoint"), "utf8"), "keep original task and unknown credit ledger");
  assert.deepEqual(await failed.queueLog(), []);
  assert.deepEqual(await readFile(taskFile), taskBefore, "Even eligible queued work must wait until the runtime commits");
  assert.deepEqual(await failed.modelRequests(), [], "A real model-start RPC must not even be attempted during failing activation");
});

const f = await fixture();
await verify(f, async () => {
  await writeFile(path.join(f.env.CODEX_HOME, "config.toml"), '# unrelated user setting\nmodel = "user-selected-model"\n');
  await setupUI(f);
  const shortcut = path.join(f.dataDir, "shortcuts", "Codex Pulse.lnk"); assert((await readFile(shortcut)).length > 100);
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
  const sourceEntry = path.join(f.appRoot, "bin", "codex-pulse.mjs"), sourceBytes = await readFile(sourceEntry);
  try {
    await writeFile(sourceEntry, "throw Error('Corrupted isolated package must not execute');");
    const corrupt = await f.run(); assert.notEqual(corrupt.code, 0); assert.match(corrupt.stderr, /内容与清单不一致/);
    assert.equal(await runtimeFingerprint(path.join(f.dataDir, "app")), hash);
    assert.equal(JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"))).generation, generation, "Corrupt bundle must not stop the old service");
  } finally { await writeFile(sourceEntry, sourceBytes); }
  for (const name of ["checkpoint.json", "credit-ledger.json", "preferences-note.txt"]) await writeFile(path.join(f.dataDir, name), name + " preserved");
  const userNote = path.join(f.dataDir, "marketplace", "user-note.txt"); await writeFile(userNote, "unknown user content");
  const refused = await f.uninstall(); assert.notEqual(refused.code, 0);
  assert.equal(await readFile(userNote, "utf8"), "unknown user content");
  assert.equal(await runtimeFingerprint(path.join(f.dataDir, "app")), hash);
  assert.equal(JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"))).generation, generation, "Unsafe uninstall must fail before stopping the service");
  assert(!(await readdir(f.dataDir)).includes("uninstallation-in-progress.json"));
  await rm(userNote); // Only this isolated acceptance's own injected file.
  const serviceFile = path.join(f.appRoot, "scripts", "windows-runtime-service.mjs"), serviceSource = await readFile(serviceFile, "utf8");
  const removalNeedle = "async removeStartup() {"; assert.equal(serviceSource.split(removalNeedle).length, 2);
  await writeFile(serviceFile, serviceSource.replace(removalNeedle, removalNeedle + '\n    await this.call(this.target(), ["--startup", "remove"]); throw Error("Isolated interruption after real task removal");'));
  const appVersion = JSON.parse(await readFile(path.join(f.appRoot, "package.json"))).version;
  await writeWindowsBundleManifest(f.appRoot, { appVersion, nodeVersion: process.version });
  const interruptedRemoval = await f.uninstall(); assert.notEqual(interruptedRemoval.code, 0);
  assert((await readdir(f.dataDir)).includes("uninstallation-in-progress.json"));
  assert.equal(await runtimeFingerprint(path.join(f.dataDir, "app")), hash);
  await writeFile(serviceFile, serviceSource); await writeWindowsBundleManifest(f.appRoot, { appVersion, nodeVersion: process.version });
  await setupUI(f, { uninstall: true });
  await assert.rejects(readFile(shortcut), { code: "ENOENT" });
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
  verifiedZipEntryAndBundledNode: true, corruptBundleRejectedBeforeStop: true, nodeLicensePreserved: true, archiveSHA256: packaged.checksum,
  maintenanceBlocksQueuedActivation: true,
  killedInstallerRecoveredByNextEntry: true, interruptedUninstallResumed: true,
  nativeSetupInstallAndUninstall: true, ownedShortcutCreatedAndRemoved: true,
  accountRPC: "isolated synthetic peer", modelCalls: 0, realResetCardsUsed: 0,
  guiPackageOrPhysicalSleepVerified: false, productionInstallTouched: false }));
