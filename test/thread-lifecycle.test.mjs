import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readPersistedLifecycle, readLatestTurn } from "../src/thread-lifecycle.mjs";

const event = payload => JSON.stringify({ type: "event_msg", payload }) + "\n";
test("an unloaded interrupted replay cannot override the live Desktop lifecycle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-lifecycle-"));
  const log = path.join(root, "rollout.jsonl");
  await writeFile(log, event({ type: "task_started", turn_id: "live" }));
  const client = { async request(method) {
    return method === "thread/read" ? { thread: { path: log, status: { type: "notLoaded" } } }
      : { data: [{ id: "live", status: "interrupted" }] };
  } };
  assert.equal((await readLatestTurn(client, "thread")).status, "inProgress");
  await appendFile(log, event({ type: "task_complete", turn_id: "live",
    error: { codex_error_info: "usage_limit_exceeded" } }));
  assert.equal((await readLatestTurn(client, "thread")).status, "failed");
});

test("lifecycle parser tolerates large split lines and partial final writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-lifecycle-"));
  const log = path.join(root, "rollout.jsonl");
  await writeFile(log, event({ type: "task_started", turn_id: "live" }) +
    JSON.stringify({ type: "response_item", payload: { text: "x".repeat(400000) } }) + "\n{partial");
  assert.deepEqual(await readPersistedLifecycle(log), { id: "live", status: "inProgress" });
  assert.equal(await readPersistedLifecycle(log, { maxBytes: 10000 }), null);
});

test("missing lifecycle evidence stays unknown instead of assuming stopped", async () => {
  const client = { async request(method) {
    return method === "thread/read" ? { thread: {} } : { data: [{ id: "turn", status: "interrupted" }] };
  } };
  assert.equal((await readLatestTurn(client, "thread")).status, "unknown");
});

test("legacy history is loaded when the installed server does not support list_turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-legacy-lifecycle-"));
  const log = path.join(root, "rollout.jsonl");
  await writeFile(log, event({ type: "task_complete", turn_id: "legacy-turn" }));
  const client = { async request(method, params) {
    if (method === "thread/turns/list") throw Error("list_turns is not supported yet");
    return { thread: { path: log, turns: params.includeTurns ? [
      { id: "legacy-turn", status: "interrupted", items: [] },
    ] : [] } };
  } };
  const actual = await readLatestTurn(client, "thread");
  assert.equal(actual.id, "legacy-turn");
  assert.equal(actual.status, "completed");
});
