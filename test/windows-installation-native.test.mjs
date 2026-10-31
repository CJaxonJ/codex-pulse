import test from "node:test";
import assert from "node:assert/strict";
import { cp, writeFile, readFile, readdir, lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { windowsRecoveryBackgroundFixture } from "../scripts/test-support/windows-recovery-background-fixture.mjs";
import { replaceWindowsRuntime, runtimeFingerprint } from "../scripts/windows-installation-transaction.mjs";
import { WindowsRuntimeService } from "../scripts/windows-runtime-service.mjs";
import { openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";

const windows = { skip: process.platform !== "win32", timeout: 240000 };
async function setup() {
  const f = await windowsRecoveryBackgroundFixture({ installed: false, nativeRateReads: true });
  await f.cli(["background-prepare"]);
  const sourceBinary = path.join(f.appRoot, "CodexPulse.exe"), service = new WindowsRuntimeService({ dataDir: f.dataDir, sourceBinary, env: f.env, startAtLogin: false });
  const lease = () => openWindowsInstallationLease({ binary: sourceBinary, env: f.env });
  const stage = async version => {
    const stagedName = "app-install-" + randomUUID().replaceAll("-", "");
    const directory = path.join(f.dataDir, stagedName); await cp(f.appRoot, directory, { recursive: true });
    const file = path.join(directory, "package.json"), manifest = JSON.parse(await readFile(file));
    manifest.version = version; await writeFile(file, JSON.stringify(manifest));
    return stagedName;
  };
  const install = async (stagedName, overrides = {}) => replaceWindowsRuntime({ dataDir: f.dataDir, stagedName, service, acquireLease: lease,
    preflight: async () => {}, installSideEffects: async () => {}, rollbackSideEffects: async () => {}, ...overrides });
  const cleanup = async () => {
    try {
      await service.quiesce();
      let binary = service.target();
      try { await lstat(binary); } catch (e) { if (e.code !== "ENOENT") throw e; binary = sourceBinary; }
      const startup = await service.call(binary, ["--startup", "status"]);
      if (startup.installed) await service.call(binary, ["--startup", "remove"]);
    } catch (error) {
      // This is a test failure too; do not silently report a passing test that
      // left an isolated scheduled task behind.
      throw Error("Isolated native installation cleanup failed", { cause: error });
    }
  };
  return { ...f, service, lease, stage, install, cleanup, target: path.join(f.dataDir, "app") };
}
const version = async directory => JSON.parse(await readFile(path.join(directory, "package.json"))).version;

test("real Windows installation transaction restores actual old runtime, context, enabled system task and running background after upgrade validation fails", windows, async () => {
  const f = await setup(); let failure;
  try {
    assert.equal((await f.install(await f.stage("0.9.21"))).ok, true);
    await f.service.call(f.service.target(), ["--startup", "enable"]);
    const original = await f.service.capture(true);
    assert.deepEqual(original, { startup: { installed: true, enabled: true }, running: true });
    const oldHash = await runtimeFingerprint(f.target), oldMarker = await readFile(path.join(f.dataDir, "windows-installation.json")), oldContext = await readFile(path.join(f.dataDir, "startup-context.json"));
    const beforeSample = (await f.service.quota()).quotaSampleId; assert.equal(typeof beforeSample, "string");
    await writeFile(path.join(f.dataDir, "user-checkpoint.txt"), "preserve original user objective and plan");
    await writeFile(path.join(f.dataDir, "credit-operation-sentinel.txt"), "never consume or forget an uncertain credit operation");
    const verify = f.service.verify.bind(f.service); let validatedNew = false;
    f.service.verify = async (...args) => { await verify(...args); assert.equal(await version(f.target), "0.9.22"); validatedNew = true; throw Error("deliberate failure after actual new host/task validation"); };
    let upgradeFailure;
    await assert.rejects(f.install(await f.stage("0.9.22")), error => { upgradeFailure = error; return /原运行目录和启动状态已恢复/.test(error.message); });
    const causes = []; let cause = upgradeFailure;
    while (cause && causes.length < 6) { causes.push({ name: cause.name, code: cause.code, message: String(cause.message).slice(0, 1200) }); cause = cause.cause; }
    assert(validatedNew, "The failure must occur after the real new version was activated, not before switching: " + JSON.stringify(causes));
    assert.equal(await runtimeFingerprint(f.target), oldHash); assert.equal(await version(f.target), "0.9.21");
    assert.deepEqual(await readFile(path.join(f.dataDir, "windows-installation.json")), oldMarker);
    assert.deepEqual(await readFile(path.join(f.dataDir, "startup-context.json")), oldContext);
    assert.deepEqual(await f.service.capture(true), original);
    assert.notEqual((await f.service.quota()).quotaSampleId, beforeSample, "New and restored hosts must not be mistaken for an unchanged old quota file");
    assert.equal(await readFile(path.join(f.dataDir, "user-checkpoint.txt"), "utf8"), "preserve original user objective and plan");
    assert.equal(await readFile(path.join(f.dataDir, "credit-operation-sentinel.txt"), "utf8"), "never consume or forget an uncertain credit operation");
    assert(!(await readdir(f.dataDir)).includes("installation-in-progress.json"));
    assert.deepEqual(await f.queueLog(), []);
    // Also prove a subsequent ordinary upgrade succeeds after the rollback.
    f.service.verify = verify;
    const upgraded = await f.install(await f.stage("0.9.22"));
    assert.equal(upgraded.ok, true); assert.equal(upgraded.cleanupPending, false); assert.equal(await version(f.target), "0.9.22");
    assert.deepEqual(await f.service.capture(true), original);
  } catch (error) { failure = error; throw error; }
  finally { try { await f.cleanup(); } catch (cleanupError) { throw failure ? new AggregateError([failure, cleanupError], "Native transaction and cleanup failed") : cleanupError; } }
});

test("real Windows transaction recovers a move whose acknowledgement was lost while preserving a disabled, stopped installation", windows, async () => {
  const f = await setup(); let failure;
  try {
    assert.equal((await f.install(await f.stage("0.9.21"))).ok, true);
    await f.service.quiesce();
    const original = await f.service.capture(true), oldHash = await runtimeFingerprint(f.target);
    assert.deepEqual(original, { startup: { installed: false, enabled: false }, running: false });
    let injected = false;
    const acquireLease = async () => {
      const actual = await f.lease();
      return { ...actual, move: async (from, to) => { await actual.move(from, to); if (!injected && from === "app" && to.startsWith("app-backup-")) { injected = true; throw Error("lost acknowledgement after actual native Directory.Move"); } } };
    };
    await assert.rejects(f.install(await f.stage("0.9.22"), { acquireLease }), /原运行目录和启动状态已恢复/);
    assert(injected); assert.equal(await runtimeFingerprint(f.target), oldHash);
    assert.deepEqual(await f.service.capture(true), original);
    assert(!(await readdir(f.dataDir)).includes("installation-in-progress.json"));
    assert.deepEqual(await f.queueLog(), []);
  } catch (error) { failure = error; throw error; }
  finally { try { await f.cleanup(); } catch (cleanupError) { throw failure ? new AggregateError([failure, cleanupError], "Native transaction and cleanup failed") : cleanupError; } }
});

test("an unrelated actual file holder cannot be captured as a running host to restart during installation", windows, async () => {
  const f = await setup();
  await writeFile(path.join(f.dataDir, "background-status.json"), JSON.stringify({ generation: randomUUID(), state: "stopped", supervisorPid: process.pid, supervisorCreationTime: "0" }));
  const script = `$ErrorActionPreference='Stop';$f=[IO.File]::Open($env:PULSE_GUARD_FILE,'OpenOrCreate','ReadWrite',[IO.FileShare]::None);try{[Console]::WriteLine('locked');[Console]::Out.Flush();$null=[Console]::ReadLine()}finally{$f.Dispose()}`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    env: { ...f.env, PULSE_GUARD_FILE: path.join(f.dataDir, "background.guard") }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(child, "exit"); let output = ""; child.stdout.on("data", b => output += b); child.stdin.on("error", () => {});
  try {
    const deadline = Date.now() + 15000;
    while (!output.includes("locked")) { if (child.exitCode != null || Date.now() > deadline) throw Error("The actual guard holder never became ready"); await new Promise(r => setTimeout(r, 50)); }
    await assert.rejects(f.install(await f.stage("0.9.21")), /--background-info/);
    const names = await readdir(f.dataDir); assert(!names.includes("app")); assert(!names.includes("installation-in-progress.json"));
    assert.equal(child.exitCode, null, "Status inspection must not kill an unrelated holder");
  } finally {
    child.stdin.end("release\n");
    const timer = setTimeout(() => { if (child.exitCode == null) child.kill(); }, 5000);
    try { await closed; } finally { clearTimeout(timer); }
    await f.cleanup();
  }
});
