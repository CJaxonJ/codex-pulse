import assert from "node:assert/strict";
import test from "node:test";

import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { MemoryChatContinuityStore } from "../src/chat-continuity-store.mjs";

function summary(remainingPercent, resetsAt = 2_000_000_000) {
  return {
    planType: "plus",
    fiveHour: { remainingPercent, usedPercent: 100 - remainingPercent, resetsAt },
  };
}

function pausedChat() {
  return {
    id: "chat:thread-1",
    sessionId: "thread-1",
    status: "paused_quota",
    cwd: "/tmp/project",
    turnId: "turn-1",
    autoResume: true,
    resumeFloor: 50,
    pausedWindowKey: 100,
    pausedRemaining: 9,
    pausedAt: 10,
    checkpoint: {
      summary: "Completed phase one. Remaining: create proof and verify it.",
      workspaceFingerprint: "same",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

class FakeClient {
  constructor() {
    this.calls = [];
    this.latestTurnId = "turn-1";
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") return { data: [{ id: this.latestTurnId }] };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") {
      this.latestTurnId = "turn-2";
      return { turn: { id: "turn-2", status: "inProgress" } };
    }
    return {};
  }
}

test("ordinary chat resumes the same thread exactly once and releases its lock", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  const locks = new Map();
  const lockManager = {
    holderId: "watcher",
    async acquire(cwd, taskId) {
      const handle = { key: cwd, token: "token", holderId: "watcher", taskId };
      locks.set(cwd, handle);
      return { acquired: true, handle };
    },
    async release(handle) {
      locks.delete(handle.key);
      return true;
    },
  };
  const emitted = [];
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return "same";
      },
    },
    lockManager,
    onEvent: async (event) => emitted.push(event.type),
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  let record = await store.get("thread-1");
  assert.equal(events[0].type, "chat_continuity_resumed");
  assert.equal(record.status, "running");
  assert.equal(record.turnId, "turn-2");
  assert.equal(record.resumeCount, 1);
  assert.match(
    client.calls.find((call) => call.method === "turn/start").params.input[0].text,
    /Completed phase one/,
  );

  await controller.reconcile(summary(85, 200), { now: 21 });
  assert.equal(client.calls.filter((call) => call.method === "turn/start").length, 1);

  await controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-2",
      turn: { id: "turn-2", status: "completed" },
    },
  });
  record = await store.get("thread-1");
  assert.equal(record.status, "complete");
  assert.equal(record.worktreeLock, null);
  assert.equal(locks.size, 0);
  assert.deepEqual(emitted, ["chat_continuity_resumed", "chat_continuity_complete"]);
});

test("ordinary chat refuses resume after workspace divergence", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return "changed";
      },
    },
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  assert.equal(events[0].reason, "workspace_changed");
  assert.equal((await store.get("thread-1")).status, "needs_attention");
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
});

test("ordinary chat fails closed when the workspace fingerprint is unavailable", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return null;
      },
    },
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  assert.equal(events[0].reason, "workspace_unverifiable");
  assert.equal((await store.get("thread-1")).status, "needs_attention");
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
});

test("ordinary chat refuses resume when a newer turn exists", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  client.latestTurnId = "turn-user-created";
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return "same";
      },
    },
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  assert.equal(events[0].reason, "newer_thread_activity");
  assert.equal((await store.get("thread-1")).status, "needs_attention");
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
});

test("ordinary chat ignores completion from a different turn in the same thread", async () => {
  const running = {
    ...pausedChat(),
    status: "running",
    turnId: "turn-resumed",
  };
  const store = new MemoryChatContinuityStore([running]);
  const controller = new ChatContinuityController({
    client: new FakeClient(),
    store,
    workspace: {},
  });

  await controller.handleNotification({
    method: "turn/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-user-created",
      turn: { id: "turn-user-created", status: "completed" },
    },
  });

  assert.equal((await store.get("thread-1")).status, "running");
});

test("ordinary chat interrupts a resumed turn before releasing its worktree lock", async () => {
  const running = {
    ...pausedChat(),
    status: "running",
    turnId: "turn-resumed",
    worktreeLock: {
      key: "project",
      token: "token",
      taskId: "chat:thread-1",
      holderId: "watcher",
    },
  };
  const store = new MemoryChatContinuityStore([running]);
  const client = new FakeClient();
  const released = [];
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {},
    lockManager: {
      holderId: "watcher",
      async release(handle) {
        released.push(handle);
        return true;
      },
    },
  });

  await controller.handleServerRequest({
    id: 99,
    method: "item/tool/requestUserInput",
    params: { threadId: "thread-1", turnId: "turn-resumed" },
  });

  assert.equal(
    client.calls.some(
      (call) => call.method === "turn/interrupt" && call.params.turnId === "turn-resumed",
    ),
    true,
  );
  assert.equal(released.length, 1);
  assert.equal((await store.get("thread-1")).worktreeLock, null);
  assert.equal((await store.get("thread-1")).status, "needs_attention");
});

test("replacement watcher reconciles a completed resumed turn and clears the stale lock", async () => {
  const running = {
    ...pausedChat(),
    status: "running",
    turnId: "turn-resumed",
    worktreeLock: {
      key: "project",
      token: "old-token",
      taskId: "chat:thread-1",
      holderId: "old-watcher",
    },
  };
  const store = new MemoryChatContinuityStore([running]);
  const client = new FakeClient();
  client.latestTurnId = "turn-resumed";
  client.request = async function request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: "turn-resumed", status: "completed" }] };
    }
    return {};
  };
  const released = [];
  const lockManager = {
    holderId: "new-watcher",
    async acquire(cwd, taskId) {
      return {
        acquired: true,
        handle: {
          key: "project",
          token: "new-token",
          taskId,
          holderId: "new-watcher",
          cwd,
        },
      };
    },
    async release(handle) {
      released.push(handle.token);
      return true;
    },
  };
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {},
    lockManager,
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  const record = await store.get("thread-1");
  assert.equal(events[0].type, "chat_continuity_complete");
  assert.equal(record.status, "complete");
  assert.equal(record.worktreeLock, null);
  assert.deepEqual(released, ["new-token"]);
});
