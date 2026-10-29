import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
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
    background = f.start("--background"); assert.notEqual((await background.closed)[0], 0);
    await assert.rejects(f.cli(["watch", "--once"]), error => /维护锁/.test(error.stderr || ""), "A direct CLI must stop before ACL preparation or model connection");
    await assert.rejects(lease.move("../outside", backup));
    await lease.move("app", backup); await lease.move(staged, "app");
    assert.equal(await payload(f, "app"), "new runtime"); assert.equal(await payload(f, backup), "old runtime");
    // Exercise the actual OS rollback primitives without pretending that this
    // already implements installer orchestration or plugin/config rollback.
    await lease.move("app", failed); await lease.move(backup, "app");
    assert.equal(await payload(f, "app"), "old runtime"); assert.equal(await payload(f, failed), "new runtime");
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
  await assert.rejects(lease.move("app", backup)); await assert.rejects(lease.release());
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

test("installation helper running inside the installed runtime refuses to move its own executable", windows, async () => {
  const f = await windowsUIFixture({ installed: true }); await f.cli(["background-prepare"]);
  await assert.rejects(openWindowsInstallationLease(options(f)), /维护锁/);
  assert((await readdir(f.appRoot)).includes("CodexPulse.exe"));
});
