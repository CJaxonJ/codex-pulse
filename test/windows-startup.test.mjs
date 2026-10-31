import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { windowsUIFixture } from "../scripts/test-support/windows-ui-fixture.mjs";

const execute = promisify(execFile), windows = { skip: process.platform !== "win32", timeout: 120000 };
async function until(check) {
  const deadline = Date.now() + 30000;
  do { const result = await check(); if (result) return result; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
  throw Error("The task scheduler did not launch the isolated background");
}
async function setup() {
  const f = await windowsUIFixture({ installed: true });
  const executable = path.join(f.appRoot, "CodexPulse.exe");
  const call = async args => JSON.parse((await execute(executable, args, { env: f.env, windowsHide: true, encoding: "utf8", timeout: 45000 })).stdout);
  const control = command => call(["--startup", command]);
  const initial = await control("status");
  assert.equal(initial.installed, false, "Each isolated data directory must map to a fresh task");
  assert.deepEqual(await control("status"), initial, "An absent task must be a stable status, not a COM lookup failure");
  const scheduler = async operation => {
    const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\\');$name=$env:PULSE_ISOLATED_TASK;
if($env:PULSE_ISOLATED_OP -eq 'foreign'){$d=$s.NewTask(0);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$d.Principal.UserId=$sid;$d.Principal.LogonType=3;$d.Principal.RunLevel=0;$d.RegistrationInfo.Source='other-application';$trigger=$d.Triggers.Create(9);$trigger.UserId=$sid;$trigger.Enabled=$false;$a=$d.Actions.Create(0);$a.Path=$env:SystemRoot+'\\System32\\notepad.exe';$null=$folder.RegisterTaskDefinition($name,$d,2,$sid,$null,3,$null)}
if($env:PULSE_ISOLATED_OP -eq 'delete'){try{$folder.DeleteTask($name,0)}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};if($e.HResult -ne -2147024894){throw}};Write-Output '{}';exit}
$t=$folder.GetTask($name);$d=$t.Definition;@{xml=$t.Xml;enabled=$t.Enabled;instances=$t.GetInstances(0).Count;lastResult=$t.LastTaskResult;user=$d.Principal.UserId;runLevel=$d.Principal.RunLevel;logonType=$d.Principal.LogonType;action=$d.Actions.Item(1).Path;arguments=$d.Actions.Item(1).Arguments;workdir=$d.Actions.Item(1).WorkingDirectory;source=$d.RegistrationInfo.Source;trigger=$d.Triggers.Item(1).Type;battery=$d.Settings.DisallowStartIfOnBatteries;network=$d.Settings.RunOnlyIfNetworkAvailable;limit=$d.Settings.ExecutionTimeLimit;restart=$d.Settings.RestartInterval;restartCount=$d.Settings.RestartCount;multiple=$d.Settings.MultipleInstances}|ConvertTo-Json -Compress`;
    return JSON.parse((await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
      env: { ...process.env, PULSE_ISOLATED_TASK: initial.taskName, PULSE_ISOLATED_OP: operation }, windowsHide: true, encoding: "utf8", timeout: 30000,
    })).stdout.replace(/^\uFEFF/, ""));
  };
  return { ...f, executable, call, control, scheduler };
}

test("real Windows scheduler preserves isolated context and starts one background without a shell, password or elevated run level", windows, async () => {
  const f = await setup(), peer = path.join(f.root, "Codex 测试"), calls = path.join(f.root, "requests.jsonl");
  const entry = path.join(peer, "node_modules/@openai/codex/bin"); await mkdir(entry, { recursive: true });
  await writeFile(path.join(peer, "codex.cmd"), "@echo off\r\nrem npm entry resolved without a shell\r\n");
  await writeFile(path.join(entry, "codex.js"), `const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:m.method,home:process.env.CODEX_HOME,pid:process.pid})+'\\n');if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='account/read'?{account:null}: {}})+'\\n');});`);
  f.env.CODEX_BINARY = path.join(peer, "codex.cmd"); f.env.DO_NOT_PERSIST_TOKEN = "isolated-decoy-not-a-real-token";
  await f.cli(["settings", "--update", JSON.stringify({ tiboEnabled: false })]);
  const contextPath = path.join(f.dataDir, "startup-context.json"), statePath = path.join(f.dataDir, "background-status.json");
  const health = async () => { try { return JSON.parse(await readFile(statePath, "utf8")); } catch (e) { if (e.code === "ENOENT") return {}; throw e; } };
  try {
    const preview = await f.control("preview-context");
    assert.equal(preview.ok, true); assert.equal(JSON.parse(preview.text).codexHome, f.env.CODEX_HOME);
    await assert.rejects(readFile(contextPath), { code: "ENOENT" }, "Preview must not publish context or grant startup");
    assert.equal((await f.control("status")).installed, false);
    const enabled = await f.control("enable"); assert.equal(enabled.enabled, true);
    const originalDataSpelling = f.env.CODEX_PULSE_DATA_DIR;
    f.env.CODEX_PULSE_DATA_DIR = await realpath(f.dataDir);
    assert.equal((await f.control("status")).taskName, enabled.taskName, "Long/short spellings of one directory must refer to the same startup task");
    f.env.CODEX_PULSE_DATA_DIR = originalDataSpelling;
    const definition = await f.scheduler("inspect");
    assert.equal(definition.runLevel, 0); assert.equal(definition.logonType, 3); assert.equal(definition.trigger, 9);
    // Windows may expand an 8.3 TEMP prefix in the loaded executable's base
    // directory. Compare actual existing files/directories, not path spelling;
    // bad Unicode must still fail realpath rather than being normalized away.
    assert.equal(await realpath(definition.action), await realpath(f.executable));
    assert.equal(await realpath(definition.workdir), await realpath(f.appRoot));
    assert.equal(definition.arguments, `--startup-background "${await realpath(f.dataDir)}"`);
    assert.equal(definition.battery, false); assert.equal(definition.network, false);
    assert.equal(definition.limit, "PT0S"); assert.equal(definition.restart, "PT1M"); assert.equal(definition.restartCount, 3); assert.equal(definition.multiple, 2);
    assert(!/<Password>/i.test(definition.xml));
    const saved = await readFile(contextPath, "utf8"), context = JSON.parse(saved);
    assert.equal(saved, preview.text, "The preview must match the exact bytes activation will publish");
    assert.deepEqual(Object.keys(context).sort(), ["appRoot", "codexBinary", "codexHome", "dataDir", "userSid", "version"]);
    assert.equal(context.codexHome, f.env.CODEX_HOME); assert.equal(context.codexBinary, f.env.CODEX_BINARY);
    assert(!saved.includes(f.env.DO_NOT_PERSIST_TOKEN));
    assert.equal((await f.control("enable")).enabled, true, "Enabling twice must not create another task");
    assert.equal(await readFile(contextPath, "utf8"), saved);

    await writeFile(contextPath, JSON.stringify({ ...context, token: "must-not-be-loaded" }));
    await assert.rejects(f.control("start"), "An unrecognized context must fail before scheduling execution");
    assert.equal((await f.scheduler("inspect")).instances, 0);
    await writeFile(contextPath, saved);
    await f.control("start");
    const first = await until(async () => { const h = await health(); return h.state === "running" ? h : null; });
    assert(first.watcherPid > 0);
    const methods = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse);
    assert(methods.some(r => r.method === "initialize")); assert(methods.every(r => r.home === f.env.CODEX_HOME));
    assert(methods.every(r => ["initialize", "initialized", "account/read", "account/rateLimits/read"].includes(r.method)), "No model, queue or consume request is permitted");
    await f.control("start");
    assert.equal((await health()).generation, first.generation);
    assert.equal((await f.scheduler("inspect")).instances, 1);
    assert.equal((await f.control("disable")).enabled, false);
    assert.equal((await health()).generation, first.generation, "Disabling login startup must not kill a running user task");
    await assert.rejects(f.control("start"));
    await f.call(["--stop-background"]);
    await until(async () => (await f.scheduler("inspect")).instances === 0);
    assert.equal((await health()).state, "stopped");
    assert.equal((await f.control("remove")).installed, false);
    assert.equal((await f.control("status")).installed, false);
  } finally {
    // This exact task name was derived from this test's random data directory.
    // Never enumerate or delete production startup tasks or kill recorded PIDs.
    try { await f.control("disable"); } catch {}
    try { await f.call(["--stop-background"]); } catch {}
    await f.scheduler("delete");
  }
});

test("startup refuses a same-name foreign task without changing its definition, context or enabled state", windows, async () => {
  const f = await setup(), sentinel = path.join(f.dataDir, "startup-context.json");
  await writeFile(sentinel, "preserve unrelated context");
  try {
    const before = await f.scheduler("foreign");
    for (const operation of ["status", "enable", "disable", "start", "remove"]) {
      await assert.rejects(f.control(operation));
      const after = await f.scheduler("inspect");
      assert.equal(after.xml, before.xml); assert.equal(after.enabled, before.enabled); assert.equal(after.instances, 0);
      assert.equal(await readFile(sentinel, "utf8"), "preserve unrelated context");
    }
  } finally { await f.scheduler("delete"); }
});
