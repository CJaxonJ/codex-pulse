import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";

test("manual continuation retains the failed recovery's plan and snapshot without listing a duplicate task", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pulse-retained-incident-"));
  const store = new ChatContinuityStore(dir);
  const failed = { sessionId: "chat", turnId: "recovery", status: "needs_attention",
    blocker: "workspace_unverifiable", checkpoint: { summary: "Remaining: Windows validation", workspaceFingerprint: "original" } };
  await store.put(failed);
  await store.put({ sessionId: "chat", turnId: "manual", status: "observing" });
  const incident = await store.getLastFailure("chat");
  assert.equal(incident.turnId, "recovery");
  assert.deepEqual(incident.checkpoint, failed.checkpoint);
  assert.equal((await store.get("chat")).turnId, "manual");
  assert.equal((await store.list()).length, 1);
});

test("incident capture failure does not prevent persisting a recovery safety refusal", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pulse-refusal-persistence-"));
  await mkdir(path.join(dir, "chat-continuity"));
  await writeFile(path.join(dir, "chat-continuity", "incidents"), "not a directory");
  const store = new ChatContinuityStore(dir);
  await store.put({ sessionId: "chat", status: "needs_attention", blocker: "workspace_changed", autoResume: false });
  const saved = await store.get("chat");
  assert.equal(saved.status, "needs_attention");
  assert.equal(saved.autoResume, false);
  assert.equal(saved.incidentCaptureFailed, true);
});
