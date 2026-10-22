import assert from "node:assert/strict";
import test from "node:test";

import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import {
  ChatContinuityStore,
  MemoryChatContinuityStore,
} from "../src/chat-continuity-store.mjs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function summary(remainingPercent, resetsAt = 2_000_000_000) {
  return {
    planType: "plus",
    fiveHour: { remainingPercent, usedPercent: 100 - remainingPercent, resetsAt },
  };
}

function pausedChat(overrides = {}) {
  return {
    id: "chat:thread-1",
    sessionId: "thread-1",
    status: "paused_quota",
    cwd: "/tmp/project",
    turnId: "turn-1",
    autoResume: true,
    resumeMode: "native_goal",
    goalWasActive: true,
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
    ...overrides,
  };
}

class FakeClient {
  constructor() {
    this.calls = [];
    this.latestTurnId = "turn-1";
    this.latestTurnStatus = "completed";
    this.goalStatus = "paused";
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: this.latestTurnId, status: this.latestTurnStatus }] };
    }
    if (method === "thread/goal/get") {
      return { goal: this.goalStatus ? { status: this.goalStatus } : null };
    }
    if (method === "thread/goal/set") {
      this.goalStatus = params.status;
      return { goal: { status: this.goalStatus } };
    }
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") {
      this.latestTurnId = "turn-2";
      return { turn: { id: "turn-2", status: "inProgress" } };
    }
    return {};
  }
}

test("ordinary chat reactivates its native Goal exactly once and releases its lock", async () => {
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
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.turnId, "turn-1");
  assert.equal(record.resumeCount, 1);
  assert.deepEqual(
    client.calls.find((call) => call.method === "thread/goal/set")?.params,
    { threadId: "thread-1", status: "active", origin: "automatic" },
  );
  assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);

  await controller.reconcile(summary(85, 200), { now: 21 });
  assert.equal(client.calls.filter((call) => call.method === "thread/goal/set").length, 1);

  client.latestTurnId = "turn-native";
  client.goalStatus = "complete";
  await controller.reconcile(summary(85, 200), { now: 22 });
  record = await store.get("thread-1");
  assert.equal(record.status, "complete");
  assert.equal(record.turnId, "turn-native");
  assert.equal(record.worktreeLock, null);
  assert.equal(locks.size, 0);
  assert.deepEqual(emitted, ["chat_continuity_resumed", "chat_continuity_complete"]);
});

test("ordinary chat resumes with the original Goal plus the pause-time continuation plan", async () => {
  const originalObjective = "Ship the requested feature with tests.";
  const continuationObjective = [
    "Original user-approved goal (authoritative; preserve exactly):",
    originalObjective,
    "Remaining: add the end-to-end test",
    "Next action: implement the fixture",
  ].join("\n");
  const store = new MemoryChatContinuityStore([
    pausedChat({
      initialGoal: { objective: originalObjective, tokenBudget: null },
      goalAtPause: { objective: originalObjective, tokenBudget: null },
      checkpoint: {
        summary: "Remaining: add the end-to-end test\nNext action: implement the fixture",
        workspaceFingerprint: "same",
        continuationGoal: {
          originalObjective,
          objective: continuationObjective,
        },
      },
    }),
  ]);
  const client = new FakeClient();
  client.request = async function request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: "turn-1", status: "completed" }] };
    }
    if (method === "thread/goal/get") {
      return { goal: { status: "paused", objective: originalObjective } };
    }
    if (method === "thread/goal/set") {
      return { goal: { status: params.status, objective: params.objective } };
    }
    return {};
  };
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
  assert.equal(events[0].type, "chat_continuity_resumed");
  const activation = client.calls.find((call) => call.method === "thread/goal/set");
  assert.deepEqual(activation.params, {
    threadId: "thread-1",
    objective: continuationObjective,
    status: "active",
    origin: "automatic",
  });
});

test("ordinary chat never overwrites a Goal changed by the user while paused", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      initialGoal: { objective: "Original goal" },
      goalAtPause: { objective: "Original goal" },
      checkpoint: {
        summary: "Remaining: continue",
        workspaceFingerprint: "same",
        continuationGoal: {
          originalObjective: "Original goal",
          objective: "Original goal plus the continuation plan",
        },
      },
    }),
  ]);
  const client = new FakeClient();
  client.request = async function request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: "turn-1", status: "completed" }] };
    }
    if (method === "thread/goal/get") {
      return { goal: { status: "paused", objective: "User changed this goal" } };
    }
    return {};
  };
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
  assert.equal(events[0].reason, "native_goal_changed");
  assert.equal((await store.get("thread-1")).status, "needs_attention");
  assert.equal(client.calls.some((call) => call.method === "thread/goal/set"), false);
});

test("ordinary chat never reopens a Goal completed while Pulse was paused", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      initialGoal: { objective: "Original goal" },
      goalAtPause: { objective: "Original goal" },
    }),
  ]);
  const client = new FakeClient();
  client.request = async function request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: "turn-1", status: "completed" }] };
    }
    if (method === "thread/goal/get") {
      return { goal: { status: "complete", objective: "Original goal" } };
    }
    return {};
  };
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
  assert.equal(events[0].type, "chat_continuity_complete");
  assert.equal((await store.get("thread-1")).status, "complete");
  assert.equal(client.calls.some((call) => call.method === "thread/goal/set"), false);
});

test("file-backed chat records tolerate concurrent atomic writes in one process", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-chat-store-"));
  const first = new ChatContinuityStore(dataDir);
  const second = new ChatContinuityStore(dataDir);

  await Promise.all([
    first.put(pausedChat({ updatedBy: "first" })),
    second.put(pausedChat({ updatedBy: "second" })),
  ]);

  const saved = await first.get("thread-1");
  assert.equal(saved.sessionId, "thread-1");
  assert.ok(["first", "second"].includes(saved.updatedBy));
});

test("ordinary chat without a native Goal stays manual and never starts an external turn", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      autoResume: true,
      resumeMode: "manual",
      goalWasActive: false,
    }),
  ]);
  const client = new FakeClient();
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
  const record = await store.get("thread-1");
  assert.equal(events[0].reason, "native_goal_required");
  assert.equal(record.status, "needs_attention");
  assert.equal(record.autoResume, false);
  assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);
});

test("a quota-paused chat emits one user-visible pause event", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({ sessionId: "paused-thread", id: "chat:paused-thread", pauseNotifiedAt: null }),
  ]);
  const emitted = [];
  const controller = new ChatContinuityController({
    client: new FakeClient(),
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return "same";
      },
    },
    onEvent: async (event) => emitted.push(event.type),
  });

  await controller.reconcile({ fiveHour: { remainingPercent: 9, resetsAt: 100 } }, { now: 10 });
  await controller.reconcile({ fiveHour: { remainingPercent: 9, resetsAt: 100 } }, { now: 11 });

  assert.deepEqual(emitted, ["chat_continuity_paused"]);
  assert.equal((await store.get("paused-thread")).pauseNotifiedAt, 10);
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

test("ordinary chat uses a scoped snapshot and reports the changed scope", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      checkpoint: {
        summary: "Continue scoped work.",
        workspaceFingerprint: "legacy",
        workspaceSnapshot: {
          version: 1,
          digest: "before",
          scopes: [{ root: "product/app", fingerprint: "before" }],
        },
      },
    }),
  ]);
  const client = new FakeClient();
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async compareSnapshot() {
        return { verifiable: true, same: false, changedScopes: ["product/app"] };
      },
    },
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  assert.equal(events[0].reason, "workspace_changed");
  assert.deepEqual(events[0].changedScopes, ["product/app"]);
  assert.deepEqual((await store.get("thread-1")).blockerDetails, {
    changedScopes: ["product/app"],
  });
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

test("a checkpoint missing its pause-time fingerprint is identified explicitly", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      checkpoint: {
        summary: "Legacy checkpoint created before workspace fingerprints were reliable.",
        workspaceFingerprint: null,
      },
    }),
  ]);
  const client = new FakeClient();
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return "current";
      },
    },
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  assert.equal(events[0].reason, "checkpoint_missing_fingerprint");
  assert.equal((await store.get("thread-1")).blocker, "checkpoint_missing_fingerprint");
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
