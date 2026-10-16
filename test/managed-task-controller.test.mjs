import assert from "node:assert/strict";
import test from "node:test";

import { ManagedTaskController } from "../src/managed-task-controller.mjs";
import { MemoryTaskStore } from "../src/managed-task-store.mjs";

function summary(remainingPercent, resetsAt = 2_000_000_000) {
  return {
    planType: "plus",
    fiveHour: { remainingPercent, usedPercent: 100 - remainingPercent, resetsAt },
    weekly: null,
    resetCredits: { availableCount: 0, expiries: [] },
  };
}

function queuedTask() {
  return {
    id: "task-1",
    status: "queued",
    objective: "Implement the feature and make tests pass",
    cwd: "/tmp/project",
    model: "gpt-6.1-sol",
    quotaPolicy: "strict_reserve",
    autoResume: true,
    resumeFloor: 50,
    threadId: null,
    turnId: null,
    lastPlan: [],
    lastDiffHash: null,
    checkpoint: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

class FakeClient {
  constructor() {
    this.calls = [];
    this.turnNumber = 0;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "turn/start") {
      this.turnNumber += 1;
      return { turn: { id: `turn-${this.turnNumber}`, status: "inProgress" } };
    }
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/turns/list") return { data: [{ id: "turn-1" }] };
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    return {};
  }
}

test("managed task drains, pauses, and resumes exactly once after personal recovery", async () => {
  const store = new MemoryTaskStore([queuedTask()]);
  const client = new FakeClient();
  const emitted = [];
  const workspace = {
    async exists() {
      return true;
    },
    async fingerprint() {
      return "workspace-fingerprint";
    },
  };
  const controller = new ManagedTaskController({
    client,
    store,
    workspace,
    onEvent: async (event) => emitted.push(event),
  });

  await controller.reconcile(summary(90), { now: 100 });
  let task = (await store.list())[0];
  assert.equal(task.status, "running");
  assert.equal(task.threadId, "thread-1");
  assert.equal(task.turnId, "turn-1");

  await controller.handleNotification({
    method: "turn/plan/updated",
    params: {
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "inProgress" },
        { step: "Test", status: "pending" },
      ],
    },
  });

  await controller.reconcile(summary(14), { now: 200 });
  task = (await store.list())[0];
  assert.equal(task.status, "draining");
  assert.equal(client.calls.filter((call) => call.method === "turn/steer").length, 1);

  await controller.reconcile(summary(9), { now: 300 });
  task = (await store.list())[0];
  assert.equal(task.status, "paused_quota");
  assert.equal(task.checkpoint.completed[0].step, "Inspect");
  assert.equal(task.checkpoint.currentStep, "Implement");
  assert.equal(task.usageSegments[0].consumedPercent, 81);
  assert.equal(task.usageSegments[0].endReason, "quota_pause");
  assert.equal(client.calls.filter((call) => call.method === "turn/interrupt").length, 1);

  await controller.reconcile(summary(9), { now: 320 });
  assert.equal(client.calls.filter((call) => call.method === "thread/resume").length, 0);

  await controller.reconcile(summary(90, 2_000_018_000), { now: 400 });
  task = (await store.list())[0];
  assert.equal(task.status, "running");
  assert.equal(task.turnId, "turn-2");
  assert.equal(task.resumeCount, 1);
  assert.equal(task.usageSegments.length, 2);
  assert.equal(task.usageSegments[1].reason, "quota_resume");
  assert.equal(client.calls.filter((call) => call.method === "thread/resume").length, 1);

  await controller.reconcile(summary(90, 2_000_018_000), { now: 420 });
  assert.equal(client.calls.filter((call) => call.method === "thread/resume").length, 1);
  assert.deepEqual(
    emitted.map((event) => event.type),
    [
      "managed_task_started",
      "managed_task_draining",
      "managed_task_paused",
      "managed_task_resumed",
    ],
  );
});

test("finish-current mode does not destroy an almost-finished turn at ten percent", async () => {
  const task = {
    ...queuedTask(),
    status: "draining",
    quotaPolicy: "finish_current",
    threadId: "thread-1",
    turnId: "turn-1",
    drainRequestedAt: 100,
    usageSegments: [
      { startedAt: 50, startRemaining: 30, windowKey: 2_000_000_000 },
    ],
  };
  const store = new MemoryTaskStore([task]);
  const client = new FakeClient();
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async fingerprint() {
        return "workspace-fingerprint";
      },
    },
  });

  await controller.reconcile(summary(9), { now: 200 });
  assert.equal((await store.list())[0].status, "draining");
  assert.equal(client.calls.filter((call) => call.method === "turn/interrupt").length, 0);

  await controller.reconcile(summary(4), { now: 220 });
  assert.equal((await store.list())[0].status, "paused_quota");
  assert.equal(client.calls.filter((call) => call.method === "turn/interrupt").length, 1);
});

test("deadline mode waits until critical quota before asking the turn to drain", async () => {
  const task = {
    ...queuedTask(),
    status: "running",
    quotaPolicy: "deadline",
    threadId: "thread-1",
    turnId: "turn-1",
  };
  const store = new MemoryTaskStore([task]);
  const client = new FakeClient();
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {},
  });

  await controller.reconcile(summary(14), { now: 100 });
  assert.equal((await store.list())[0].status, "running");
  assert.equal(client.calls.length, 0);

  await controller.reconcile(summary(5), { now: 200 });
  assert.equal((await store.list())[0].status, "draining");
  assert.equal(client.calls.filter((call) => call.method === "turn/steer").length, 1);
});

test("managed task refuses automatic resume when workspace changed", async () => {
  const paused = {
    ...queuedTask(),
    status: "paused_quota",
    threadId: "thread-1",
    turnId: "turn-1",
    pausedWindowKey: 100,
    pausedRemaining: 9,
    checkpoint: { workspaceFingerprint: "before" },
  };
  const store = new MemoryTaskStore([paused]);
  const client = new FakeClient();
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
      async fingerprint() {
        return "after";
      },
    },
  });

  const events = await controller.reconcile(summary(90, 200), { now: 500 });
  assert.equal(events[0].type, "managed_task_attention");
  assert.equal(events[0].reason, "workspace_changed");
  assert.equal((await store.list())[0].status, "needs_attention");
  assert.equal(client.calls.filter((call) => call.method === "thread/resume").length, 0);
});

test("managed task uses the desktop App Server sandbox enum and requeues a failed start", async () => {
  const store = new MemoryTaskStore([queuedTask()]);
  const client = {
    calls: [],
    async request(method, params) {
      this.calls.push({ method, params });
      throw new Error("simulated start failure");
    },
  };
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
    },
  });

  await assert.rejects(controller.reconcile(summary(90), { now: 600 }), /simulated/);
  const task = (await store.list())[0];
  assert.equal(task.status, "queued");
  assert.equal(task.retryNotBefore, 660);
  assert.equal(task.lastStartError, "simulated start failure");
  assert.equal(client.calls[0].params.sandbox, "workspace-write");
});

test("Pro starts managed work without inventing a five-hour window", async () => {
  const store = new MemoryTaskStore([
    { ...queuedTask(), startFloor: 0, weeklyFloor: 10 },
  ]);
  const client = new FakeClient();
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
    },
  });

  await controller.reconcile(
    {
      planType: "pro",
      fiveHour: null,
      weekly: { remainingPercent: 70 },
      resetCredits: { availableCount: 0, expiries: [] },
    },
    { now: 700 },
  );
  assert.equal((await store.list())[0].status, "running");
});

test("normal-priority work waits when weekly capacity is in its final ten percent", async () => {
  const store = new MemoryTaskStore([
    {
      ...queuedTask(),
      startFloor: 20,
      weeklyFloor: 10,
      priority: "normal",
    },
  ]);
  const client = new FakeClient();
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
    },
  });

  await controller.reconcile(
    {
      ...summary(90),
      weekly: { remainingPercent: 8 },
    },
    { now: 800 },
  );
  assert.equal((await store.list())[0].status, "queued");
  assert.equal(client.calls.length, 0);
});

test("a user-input request disables auto-resume and records only request metadata", async () => {
  const task = {
    ...queuedTask(),
    status: "running",
    threadId: "thread-1",
    turnId: "turn-1",
    usageSegments: [
      { startedAt: 100, startRemaining: 50, windowKey: 2_000_000_000 },
    ],
  };
  const store = new MemoryTaskStore([task]);
  const client = new FakeClient();
  const emitted = [];
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async fingerprint() {
        return "workspace-fingerprint";
      },
    },
    onEvent: async (event) => emitted.push(event),
  });
  await controller.reconcile(summary(40), { now: 150 });
  await controller.handleServerRequest({
    id: 77,
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-9",
      questions: [{ question: "Secret prompt text must not be saved" }],
    },
  });

  const blocked = (await store.list())[0];
  assert.equal(blocked.status, "needs_attention");
  assert.equal(blocked.blocker, "user_input_required");
  assert.equal(blocked.autoResume, false);
  assert.deepEqual(Object.keys(blocked.pendingRequest).sort(), [
    "itemId",
    "method",
    "receivedAt",
    "requestId",
    "threadId",
    "turnId",
  ]);
  assert.equal(JSON.stringify(blocked).includes("Secret prompt"), false);
  assert.equal(
    client.calls.filter((call) => call.method === "turn/interrupt").length,
    1,
  );
  assert.equal(emitted[0].reason, "user_input_required");

  await controller.reconcile(summary(90, 2_000_018_000), { now: 300 });
  assert.equal(
    client.calls.filter((call) => call.method === "thread/resume").length,
    0,
  );
});

test("only one waiting task starts, ordered by priority before expected cost", async () => {
  const low = {
    ...queuedTask(),
    id: "low-small",
    priority: "low",
    taskSize: "small",
    createdAt: 1,
  };
  const normal = {
    ...queuedTask(),
    id: "normal-small",
    priority: "normal",
    taskSize: "small",
    createdAt: 2,
  };
  const high = {
    ...queuedTask(),
    id: "high-large",
    priority: "high",
    taskSize: "large",
    createdAt: 3,
  };
  const store = new MemoryTaskStore([low, normal, high]);
  const client = new FakeClient();
  const controller = new ManagedTaskController({
    client,
    store,
    workspace: {
      async exists() {
        return true;
      },
    },
  });

  await controller.reconcile(summary(90), { now: 900 });
  const tasks = await store.list();
  assert.equal(tasks.find((task) => task.id === "high-large").status, "running");
  assert.equal(tasks.find((task) => task.id === "normal-small").status, "queued");
  assert.equal(tasks.find((task) => task.id === "low-small").status, "queued");
  assert.equal(client.calls.filter((call) => call.method === "thread/start").length, 1);
});

test("a newer user turn prevents quota recovery from reviving stale work", async () => {
  const paused = {
    ...queuedTask(),
    status: "paused_quota",
    threadId: "thread-1",
    turnId: "turn-1",
    pausedWindowKey: 100,
    pausedRemaining: 9,
    checkpoint: { workspaceFingerprint: "same" },
  };
  const store = new MemoryTaskStore([paused]);
  const client = new FakeClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/turns/list") {
      client.calls.push({ method, params });
      return { data: [{ id: "newer-user-turn" }] };
    }
    return originalRequest(method, params);
  };
  const controller = new ManagedTaskController({
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

  const events = await controller.reconcile(summary(90, 200), { now: 1_000 });
  const task = (await store.list())[0];
  assert.equal(task.status, "needs_attention");
  assert.equal(task.blocker, "newer_thread_activity");
  assert.equal(task.latestTurnId, "newer-user-turn");
  assert.equal(events[0].reason, "newer_thread_activity");
  assert.equal(client.calls.filter((call) => call.method === "thread/resume").length, 0);
});
