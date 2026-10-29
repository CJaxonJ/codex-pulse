import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { windowsRecoveryBackgroundFixture } from "../scripts/test-support/windows-recovery-background-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 120000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function readOptional(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function until(f, check) {
  const deadline = Date.now() + 25000;
  while (true) {
    const value = await check(); if (value) return value;
    if (Date.now() > deadline) throw Error("Native recovery state was not observed: " + JSON.stringify({ health: await readOptional(path.join(f.dataDir, "background-status.json")), record: await f.store.get("native-windows-thread"), queues: await f.queueLog() }));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
async function start(f, sessions, percent) {
  const host = f.start("--background"); sessions.push(host);
  return until(f, async () => {
    if (host.child.exitCode != null) throw Error(host.diagnostic());
    const health = await readOptional(path.join(f.dataDir, "background-status.json")), state = await readOptional(path.join(f.dataDir, "state.json"));
    if (health?.supervisorPid !== host.child.pid || health.state !== "running" || state?.lastSummary?.fiveHour?.remainingPercent !== percent) return null;
    assert(alive(health.watcherPid)); return { host, health, state };
  });
}
async function stop(f, sessions, active) {
  const stopping = f.start("--stop-background"); sessions.push(stopping);
  assert.equal((await stopping.closed)[0], 0, stopping.diagnostic());
  assert.equal((await active.host.closed)[0], 0, active.host.diagnostic());
  assert.equal(alive(active.health.watcherPid), false);
}
async function pause(f, sessions) {
  const active = await start(f, sessions, 70);
  await f.invoke({ hook_event_name: "UserPromptSubmit", prompt: f.objective });
  assert.equal((await f.store.get("native-windows-thread")).initialGoal.objective, f.objective);
  await f.setQuota(10);
  await until(f, async () => (await readOptional(path.join(f.dataDir, "state.json")))?.lastSummary?.fiveHour?.remainingPercent === 10);
  const blocked = await f.invoke({ hook_event_name: "PreToolUse", tool_name: "apply_patch" });
  assert.equal(blocked.decision, "block");
  const saved = await f.invoke({ hook_event_name: "Stop", last_assistant_message: f.plan });
  assert.equal(saved.continue, false);
  await f.setTurn("completed");
  const record = await f.store.get("native-windows-thread");
  assert.equal(record.status, "paused_quota");
  assert.equal(record.initialGoal.objective, f.objective);
  assert.equal(record.checkpoint.summary, f.plan);
  assert(record.checkpoint.workspaceFingerprint);
  assert.equal((await f.queueLog()).length, 0);
  return active;
}

test("native Windows background preserves the original goal and checkpoint, queues once after replacement, and keeps first-tool fencing across another replacement", windows, async () => {
  const f = await windowsRecoveryBackgroundFixture(), sessions = [];
  try {
    const original = await pause(f, sessions);
    await stop(f, sessions, original);
    await f.setQuota(100);
    const recovered = await start(f, sessions, 100);
    const record = await until(f, async () => { const value = await f.store.get("native-windows-thread"); return value?.executionObservedAt && value.status === "native_goal_active" ? value : null; });
    assert.notEqual(recovered.health.watcherPid, original.health.watcherPid);
    assert.equal(record.initialGoal.objective, f.objective);
    assert.equal(record.checkpoint.summary, f.plan);
    assert.equal(record.resumeCount, 1);
    const queue = await f.queueLog(); assert.equal(queue.length, 1);
    assert.deepEqual(queue[0].args.slice(0, 4), ["queue", "--thread", "native-windows-thread", "--message"]);
    const prompt = queue[0].args[4]; assert(prompt.includes(f.objective)); assert(prompt.includes("Next action:"));
    const admitted = await f.invoke({ hook_event_name: "UserPromptSubmit", turn_id: "resumed-turn", prompt });
    assert.notEqual(admitted?.decision, "block");
    const first = await f.invoke({ hook_event_name: "PreToolUse", turn_id: "resumed-turn", tool_name: "apply_patch" });
    assert.notEqual(first?.decision, "block");
    assert((await f.store.get("native-windows-thread")).workspaceValidatedAt);
    await stop(f, sessions, recovered);
    const samples = (await readOptional(path.join(f.dataDir, "state.json"))).fiveHour.samples.length;
    const again = await start(f, sessions, 100);
    await until(f, async () => (await readOptional(path.join(f.dataDir, "state.json"))).fiveHour.samples.length >= samples + 3);
    const repeated = await f.store.get("native-windows-thread");
    assert.equal(repeated.resumeCount, 1); assert(repeated.workspaceValidatedAt);
    assert.equal((await f.queueLog()).length, 1, "Replacing a real native host again must not queue a second writer");
    const duplicate = await f.invoke({ hook_event_name: "UserPromptSubmit", turn_id: "duplicate-turn", prompt });
    assert.equal(duplicate.decision, "block");
    assert.equal(await readFile(path.join(f.workspace, "existing.txt"), "utf8"), "preserve the user's existing work");
    await stop(f, sessions, again);
  } finally { for (const session of sessions) if (session.child.exitCode == null) session.child.kill(); }
});

for (const lifecycle of [null, "inProgress"]) test(`native Windows background does not wake after recovery while lifecycle is ${lifecycle || "unknown"}`, windows, async () => {
  const f = await windowsRecoveryBackgroundFixture(), sessions = [];
  try {
    const original = await pause(f, sessions); await stop(f, sessions, original);
    await f.setTurn(lifecycle); await f.setQuota(100);
    const samples = (await readOptional(path.join(f.dataDir, "state.json"))).fiveHour.samples.length;
    const recovered = await start(f, sessions, 100);
    await until(f, async () => (await readOptional(path.join(f.dataDir, "state.json"))).fiveHour.samples.length >= samples + 3);
    assert.equal((await f.queueLog()).length, 0);
    const record = await f.store.get("native-windows-thread");
    assert.equal(record.status, "paused_quota"); assert.equal(record.initialGoal.objective, f.objective); assert.equal(record.checkpoint.summary, f.plan);
    await stop(f, sessions, recovered);
  } finally { for (const session of sessions) if (session.child.exitCode == null) session.child.kill(); }
});
