import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, cp, symlink } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";
import { windowsRecoveryBackgroundFixture } from "../scripts/test-support/windows-recovery-background-fixture.mjs";
import { windowsUIFixture } from "../scripts/test-support/windows-ui-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 120000 };
const ownedName = kind => "app-" + kind + "-" + randomUUID().replaceAll("-", "");
async function until(check) {
  const deadline = Date.now() + 25000;
  do { const value = await check(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } while (Date.now() < deadline);
  throw Error("The actual Windows process condition was not observed");
}
const options = f => ({ binary: path.join(f.appRoot, "CodexPulse.exe"), env: f.env });
async function seed(f, name, value) { await mkdir(path.join(f.dataDir, name)); await writeFile(path.join(f.dataDir, name, "payload.txt"), value); }
const payload = (f, name) => readFile(path.join(f.dataDir, name, "payload.txt"), "utf8");

test("native installation lease excludes background, CLI and another installer while performing actual reversible runtime moves", windows, async () => {
  const f = await windowsRecoveryBackgroundFixture({ installed: false });
  await f.cli(["background-prepare"]);
  const staged = ownedName("install"), backup = ownedName("backup"), failed = ownedName("failed");
  await seed(f, "app", "old runtime"); await seed(f, staged, "new runtime");
  await writeFile(path.join(f.dataDir, "user-checkpoint.txt"), "keep original goal and plan");
  const lease = await openWindowsInstallationLease(options(f)); let background;
  try {
    await assert.rejects(openWindowsInstallationLease(options(f)), /维护锁/);
    for (const command of ["configure", "enable", "disable", "remove"]) {
      await assert.rejects(promisify(execFile)(path.join(f.appRoot, "CodexPulse.exe"), ["--startup", command], {
        env: f.env, encoding: "utf8", windowsHide: true, timeout: 20000,
      }), error => error.code === 1 && /IOException/.test(error.stderr || ""), "A concurrent settings process cannot mutate startup under maintenance: " + command);
    }
    const startup = JSON.parse((await promisify(execFile)(path.join(f.appRoot, "CodexPulse.exe"), ["--startup", "status"], {
      env: f.env, encoding: "utf8", windowsHide: true, timeout: 20000,
    })).stdout);
    assert.equal(startup.installed, false);
    assert(!(await readdir(f.dataDir)).includes("startup-context.json"));
    background = f.start("--background"); assert.notEqual((await background.closed)[0], 0);
    await assert.rejects(f.cli(["watch", "--once"]), error => /维护锁/.test(error.stderr || ""), "A direct CLI must stop before ACL preparation or model connection");
    await assert.rejects(lease.move("../outside", backup));
    await lease.move("app", backup); await lease.move(staged, "app");
    assert.equal(await payload(f, "app"), "new runtime"); assert.equal(await payload(f, backup), "old runtime");
    // Exercise the actual OS rollback primitives without pretending that this
    // already implements installer orchestration or plugin/config rollback.
    await lease.move("app", failed); await lease.move(backup, "app");
    assert.equal(await payload(f, "app"), "old runtime"); assert.equal(await payload(f, failed), "new runtime");
    await assert.rejects(lease.removeRetired("app"));
    await assert.rejects(lease.removeRetired("../outside"));
    await lease.removeRetired(failed); assert(!(await readdir(f.dataDir)).includes(failed));
    assert.equal(await readFile(path.join(f.dataDir, "user-checkpoint.txt"), "utf8"), "keep original goal and plan");
    assert.deepEqual(await f.queueLog(), []);
  } finally { await lease.release(); if (background?.child.exitCode == null) background.child.kill(); }
});

test("native installer refuses both a live tray host and a standalone CLI watcher without stopping either", windows, async () => {
  const f = await windowsRecoveryBackgroundFixture({ installed: false });
  const host = f.start("--background"); let stop, direct;
  try {
    await until(async () => {
      if (host.child.exitCode != null) throw Error(host.diagnostic());
      try { return JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"), "utf8")).generation; }
      catch (error) { if (error.code === "ENOENT") return false; throw error; }
    });
    await assert.rejects(openWindowsInstallationLease(options(f)), /维护锁/);
    assert.equal(host.child.exitCode, null);
    stop = f.start("--stop-background"); assert.equal((await stop.closed)[0], 0, stop.diagnostic()); assert.equal((await host.closed)[0], 0);
    const child = spawn(path.join(f.appRoot, "runtime/node.exe"), [path.join(f.appRoot, "bin/codex-pulse.mjs"), "watch"], { env: f.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", errors = ""; const closed = once(child, "exit"); child.stdout.on("data", b => output += b); child.stderr.on("data", b => errors += b); direct = { child, closed };
    await until(() => { if (child.exitCode != null) throw Error(errors); return output.includes("watcher started"); });
    await assert.rejects(openWindowsInstallationLease(options(f)), /维护锁/);
    assert.equal(child.exitCode, null, "Inspecting a live writer must not terminate it");
    child.kill(); await closed;
    const lease = await openWindowsInstallationLease(options(f)); await lease.release();
    assert.deepEqual(await f.queueLog(), []);
  } finally { for (const session of [host, stop, direct]) if (session?.child.exitCode == null) session.child.kill(); }
});

test("killing the actual lease helper forbids further moves and releases its OS guard; protocol cannot move outside owned runtime names", windows, async () => {
  const f = await windowsRecoveryBackgroundFixture({ installed: false }); await f.cli(["background-prepare"]);
  const backup = ownedName("backup"); await seed(f, "app", "preserve old runtime");
  const lease = await openWindowsInstallationLease(options(f));
  lease.child.kill(); await lease.closed;
  await assert.rejects(lease.move("app", backup)); await assert.rejects(lease.removeRetired(ownedName("failed"))); await assert.rejects(lease.release());
  assert.equal(await payload(f, "app"), "preserve old runtime");
  const next = await openWindowsInstallationLease(options(f));
  const outside = path.join(f.root, "outside"); await mkdir(outside); await writeFile(path.join(outside, "keep.txt"), "not product data");
  // Bypass only the JS argument validator: the real native endpoint must
  // refuse traversal too. Its unexpected reply closes this isolated client.
  next.child.stdin.write(JSON.stringify({ id: 999, op: "move", from: "../outside", to: backup }) + "\n");
  await next.closed; await assert.rejects(next.release());
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "not product data");
  assert.equal(await payload(f, "app"), "preserve old runtime");
  assert(!(await readdir(f.dataDir)).includes(backup));
  const recovered = await openWindowsInstallationLease(options(f)); await recovered.release();
});

test("actual native retired cleanup rejects a junction before any deletion and cannot delete the active app", windows, async () => {
  const f = await windowsUIFixture(); await f.cli(["background-prepare"]);
  const retired = ownedName("failed"), outside = path.join(f.root, "outside");
  await seed(f, retired, "keep retired evidence"); await seed(f, "app", "keep active app");
  await mkdir(outside); await writeFile(path.join(outside, "keep.txt"), "external file");
  await symlink(outside, path.join(f.dataDir, retired, "junction"), "junction");
  const lease = await openWindowsInstallationLease(options(f));
  try {
    await assert.rejects(lease.removeRetired(retired), /维护锁/);
    assert.equal(await payload(f, retired), "keep retired evidence");
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "external file");
    assert.equal(await payload(f, "app"), "keep active app");
    // Bypass JS validation to exercise the actual native rejection too.
    lease.child.stdin.write(JSON.stringify({ id: 999, op: "remove-retired", name: "app" }) + "\n");
    await lease.closed; await assert.rejects(lease.release());
    assert.equal(await payload(f, "app"), "keep active app");
  } finally { await lease.release().catch(() => {}); }
});

test("actual Windows open-file denial keeps retired data, then cleanup succeeds after that exact handle closes", windows, async () => {
  const f = await windowsUIFixture(); await f.cli(["background-prepare"]);
  const retired = ownedName("failed"); await seed(f, retired, "retired file still mapped");
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ErrorActionPreference='Stop';$f=[IO.File]::Open($env:PULSE_LOCK_FILE,'Open','Read','Read');try{[Console]::Out.WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{$f.Dispose()}"],
  { env: { ...f.env, PULSE_LOCK_FILE: path.join(f.dataDir, retired, "payload.txt") }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(holder, "exit"); let ready = "", diagnostic = "";
  holder.stdout.on("data", chunk => ready += chunk); holder.stderr.on("data", chunk => diagnostic += chunk);
  let lease;
  try {
    await until(() => { if (holder.exitCode != null) throw Error(diagnostic); return ready.includes("held"); });
    lease = await openWindowsInstallationLease(options(f));
    await assert.rejects(lease.removeRetired(retired), /维护锁/);
    assert.equal(await payload(f, retired), "retired file still mapped");
    holder.stdin.end("release\n"); assert.equal((await closed)[0], 0, diagnostic);
    await lease.removeRetired(retired); assert(!(await readdir(f.dataDir)).includes(retired));
  } finally { if (holder.exitCode == null) { holder.kill(); await closed; } await lease?.release(); }
});

for (const transient of [true, false]) test(`actual native directory move ${transient ? "recovers from" : "bounds"} a held Windows directory handle`, windows, async () => {
  const f = await windowsUIFixture(); await f.cli(["background-prepare"]);
  const retired = ownedName("failed"); await seed(f, "app", "owned move payload");
  // Deliberately omit FILE_SHARE_DELETE. This actual OS handle denies the
  // rename until closed, rather than hoping an indexer happens to interfere.
  const script = `$ErrorActionPreference='Stop';
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class DirectoryHolder{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr CreateFileW(string p,uint a,uint s,IntPtr z,uint c,uint f,IntPtr t);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}';
$h=[DirectoryHolder]::CreateFileW($env:PULSE_HELD_DIRECTORY,128,3,[IntPtr]::Zero,3,33554432,[IntPtr]::Zero);
if($h -eq [IntPtr](-1)){throw (New-Object ComponentModel.Win32Exception([Runtime.InteropServices.Marshal]::GetLastWin32Error()))};
try{[Console]::Out.WriteLine('held');[Console]::Out.Flush();[Console]::ReadLine()|Out-Null}finally{[DirectoryHolder]::CloseHandle($h)|Out-Null}`;
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...f.env, PULSE_HELD_DIRECTORY: path.join(f.dataDir, "app") }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = once(holder, "exit"); let ready = "", diagnostic = "", retries = "", released = false, lease;
  holder.stdout.on("data", value => ready += value); holder.stderr.on("data", value => diagnostic += value);
  const releaseHandle = () => { if (!released) { released = true; holder.stdin.end("release\n"); } };
  try {
    await until(() => { if (holder.exitCode != null) throw Error(diagnostic); return ready.includes("held"); });
    lease = await openWindowsInstallationLease(options(f));
    lease.child.stderr.on("data", value => {
      retries += value;
      if (transient && retries.includes("PULSE_DIRECTORY_RETRY:")) releaseHandle();
    });
    if (transient) await lease.move("app", retired);
    else {
      await assert.rejects(lease.move("app", retired), /维护锁/);
      assert.equal(await payload(f, "app"), "owned move payload");
      assert(!(await readdir(f.dataDir)).includes(retired));
    }
    assert.match(retries, /PULSE_DIRECTORY_RETRY:(?:5|32|33)/, "An actual denied move must have reached the bounded retry");
    releaseHandle(); assert.equal((await closed)[0], 0, diagnostic);
    if (!transient) await lease.move("app", retired);
    assert.equal(await payload(f, retired), "owned move payload");
  } finally {
    if (holder.exitCode == null) { holder.kill(); await closed; }
    await lease?.release();
  }
});

test("installation helper running inside the installed runtime refuses to move its own executable", windows, async () => {
  const f = await windowsUIFixture({ installed: true }); await f.cli(["background-prepare"]);
  await assert.rejects(openWindowsInstallationLease(options(f)), /维护锁/);
  assert((await readdir(f.appRoot)).includes("CodexPulse.exe"));
});

test("neither a staged native helper nor the actual bundled Node running from staging may replace itself", windows, async () => {
  const f = await windowsUIFixture({ installed: true }); await f.cli(["background-prepare"]);
  const staged = ownedName("install"), stage = path.join(f.dataDir, staged);
  // This case tests actual execution from staging, not directory rename. Build
  // staging directly so an unrelated transient move cannot mask that check.
  await cp(f.appRoot, stage, { recursive: true, force: false, errorOnExist: true });
  await assert.rejects(openWindowsInstallationLease({ binary: path.join(stage, "CodexPulse.exe"), env: f.env }), /维护锁/);
  const outside = path.join(f.root, "outside-installer"); await mkdir(outside);
  for (const name of ["CodexPulse.exe", "CodexPulse.exe.config"]) await cp(path.join(stage, name), path.join(outside, name));
  const module = pathToFileURL(path.join(stage, "src/windows-installation-lease.mjs")).href;
  await assert.rejects(promisify(execFile)(path.join(stage, "runtime/node.exe"), ["--input-type=module", "-e", `import {openWindowsInstallationLease} from ${JSON.stringify(module)};await openWindowsInstallationLease({binary:${JSON.stringify(path.join(outside, "CodexPulse.exe"))}});`], {
    env: f.env, windowsHide: true, encoding: "utf8", timeout: 20000,
  }), error => /不能替换正在执行安装操作的运行时/.test(error.stderr || ""));
  assert((await readdir(stage)).includes("CodexPulse.exe"));
});
