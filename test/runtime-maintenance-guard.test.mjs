import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import { RuntimeMaintenanceGuard, assertManagedRecordsAllowMaintenance, assertMaintenanceRuntimeProtocol } from "../src/runtime-maintenance-guard.mjs";

test("maintenance rejects legacy protocol and an unrelated live runtime instead of guessing participation", async () => {
  const app = await mkdtemp(path.join(os.tmpdir(), "pulse-protocol-")), other = await mkdtemp(path.join(os.tmpdir(), "pulse-other-runtime-"));
  await writeFile(path.join(app, "package.json"), JSON.stringify({ codexPulse: {} }));
  await assert.rejects(assertMaintenanceRuntimeProtocol(app, { running: false }), { code: "PULSE_RUNTIME_PROTOCOL_UNCONFIRMED" });
  await writeFile(path.join(app, "package.json"), JSON.stringify({ codexPulse: { runtimeOperationProtocol: 1 } }));
  await assertMaintenanceRuntimeProtocol(app, { running: false });
  for (const health of [null, { runtimeRoot: app }, { runtimeRoot: other, runtimeOperationProtocol: 1 }]) {
    await assert.rejects(assertMaintenanceRuntimeProtocol(app, { running: true, health }), { code: "PULSE_RUNTIME_PROTOCOL_UNCONFIRMED" });
  }
  await assertMaintenanceRuntimeProtocol(app, { running: true, health: { runtimeRoot: app, runtimeOperationProtocol: 1 } });
});

test("interrupted maintenance keeps model callbacks fenced even after its original owner has gone", async () => {
  for (const name of ["installation-in-progress.json", "uninstallation-in-progress.json"]) {
    const f = await fixture(); await writeFile(path.join(f.data, name), "unknown interrupted phase");
    let calls = 0; assert.deepEqual(await f.guard.runOperation(async () => calls++), { executed: false, reason: "incomplete_maintenance" });
    assert.equal(calls, 0); await rm(path.join(f.data, name));
    assert.equal((await f.guard.runOperation(async () => ++calls)).value, 1);
  }
});

test("shutdown waits for operation owner publication, not just the main watcher ownership", async () => {
  const f = await fixture(); let begin, finish;
  const entered = new Promise(resolve => begin = resolve), ready = new Promise(resolve => finish = resolve);
  const acquire = f.guard.manager.acquire.bind(f.guard.manager);
  f.guard.manager.acquire = async (...args) => { begin(); await ready; return acquire(...args); };
  const operation = f.guard.runOperation(async () => {}); await entered;
  let finished = false; const waiting = f.guard.waitForOwnershipPublication().then(() => finished = true);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  finish(); await waiting; await operation; assert.equal(finished, true);
});

async function fixture() {
  const data = await mkdtemp(path.join(os.tmpdir(), "pulse-runtime-maintenance-")), tasks = path.join(data, "managed-tasks");
  await mkdir(tasks); return { data, tasks, guard: new RuntimeMaintenanceGuard(data) };
}
const pending = { id: "task-1", status: "queued", threadId: null, turnId: null, objective: "private objective must not appear in errors" };
async function save(f, patch = {}) { await writeFile(path.join(f.tasks, "task-1.json"), JSON.stringify({ ...pending, ...patch })); }

test("maintenance accepts only never-started queued work or explicitly completed records, preserving all bytes", async () => {
  const f = await fixture(); await save(f);
  await assertManagedRecordsAllowMaintenance(f.data);
  await save(f, { status: "complete", threadId: "thread", turnId: "turn", completedAt: 100 });
  const file = path.join(f.tasks, "task-1.json"), before = await readFile(file);
  const reservation = await f.guard.reserveMaintenance(); await reservation.release(); await reservation.release();
  assert.deepEqual(await readFile(file), before);
});
test("active, starting, paused, pending approval, incomplete and unknown states refuse without calling a stop", async () => {
  for (const status of ["starting", "running", "draining", "pausing", "resuming", "paused_quota", "needs_attention", "approval_required", "unknown"]) {
    const f = await fixture(); await save(f, { status });
    let stopped = false;
    await assert.rejects((async () => { const reservation = await f.guard.reserveMaintenance(); try { stopped = true; } finally { await reservation.release(); } })(), { code: "PULSE_MANAGED_WORK_UNCONFIRMED" });
    assert.equal(stopped, false); assert.equal((await f.guard.runOperation(async () => "can retry later")).executed, true);
    assert.equal(JSON.parse(await readFile(path.join(f.tasks, "task-1.json"))).status, status);
  }
});
test("corrupt, missing identity, false completion or inconsistent records never become idle by being ignored", async () => {
  for (const content of ["{", "null", JSON.stringify({ status: "complete" }), JSON.stringify({ ...pending, id: "different" }),
    JSON.stringify({ ...pending, threadId: "possibly-started" }), JSON.stringify({ ...pending, status: "complete", threadId: "t", turnId: "u" }),
    JSON.stringify({ ...pending, holdWorktreeLock: true })]) {
    const f = await fixture(); await writeFile(path.join(f.tasks, "task-1.json"), content);
    await assert.rejects(f.guard.reserveMaintenance(), error => error.code === "PULSE_MANAGED_WORK_UNCONFIRMED" && !error.message.includes("private objective"));
    assert.equal(await readFile(path.join(f.tasks, "task-1.json"), "utf8"), content);
  }
});
test("maintenance rejects linked records or record directories without touching external contents", async () => {
  const f = await fixture(), outside = await fixture(); await save(outside);
  await symlink(outside.tasks, path.join(f.tasks, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.guard.reserveMaintenance(), { code: "PULSE_MANAGED_WORK_UNCONFIRMED" });
  await rm(f.tasks, { recursive: true }); await symlink(outside.tasks, f.tasks, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.guard.reserveMaintenance(), { code: "PULSE_MANAGED_WORK_UNCONFIRMED" });
  assert.deepEqual(JSON.parse(await readFile(path.join(outside.tasks, "task-1.json"))), pending);
});
test("an in-flight start excludes maintenance, and retained maintenance excludes every new operation", async () => {
  const f = await fixture(), installer = new RuntimeMaintenanceGuard(f.data);
  let entered, finish; const started = new Promise(resolve => entered = resolve), exit = new Promise(resolve => finish = resolve);
  const operation = f.guard.runOperation(async () => { entered(); await exit; }); await started;
  await assert.rejects(installer.reserveMaintenance(), { code: "PULSE_RUNTIME_BUSY" });
  finish(); await operation;
  const reservation = await installer.reserveMaintenance(); let called = 0;
  try {
    for (let i = 0; i < 10; i++) assert.equal((await f.guard.runOperation(async () => called++)).executed, false);
    assert.equal(called, 0);
    await assert.rejects(new RuntimeMaintenanceGuard(f.data).reserveMaintenance(), { code: "PULSE_RUNTIME_BUSY" });
  } finally { await reservation.release(); }
  assert.equal((await f.guard.runOperation(async () => ++called)).value, 1);
  await assert.rejects(f.guard.runOperation(async () => { throw Error("injected failure"); }), /injected failure/);
  const next = await installer.reserveMaintenance(); await next.release();
});

test("a second real Node process cannot start work while the maintenance owner lives and can recover after its death", { timeout: 30000 }, async () => {
  const f = await fixture(), module = pathToFileURL(path.resolve(import.meta.dirname, "../src/runtime-maintenance-guard.mjs")).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {RuntimeMaintenanceGuard} from ${JSON.stringify(module)};
const reservation=await new RuntimeMaintenanceGuard(process.argv[1]).reserveMaintenance();console.log('reserved');process.stdin.resume();`, f.data], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const closed = once(child, "exit"), lines = createInterface({ input: child.stdout }); let diagnostic = "";
  child.stderr.on("data", b => diagnostic += b);
  let timer;
  try {
    await Promise.race([once(lines, "line").then(([line]) => assert.equal(line, "reserved")), closed.then(() => { throw Error(diagnostic || "Owner exited before acquiring its real lock"); }),
      new Promise((_, reject) => timer = setTimeout(() => reject(Error("Owner did not reach its reservation")), 10000))]);
    clearTimeout(timer);
    assert.equal((await f.guard.runOperation(async () => { throw Error("must not execute"); })).executed, false);
    child.kill(); await closed;
    assert.equal((await f.guard.runOperation(async () => "recovered")).value, "recovered");
    assert.equal((await readdir(f.tasks)).length, 0);
  } finally { clearTimeout(timer); lines.close(); if (child.exitCode == null && child.signalCode == null) { child.kill(); await closed; } }
});
