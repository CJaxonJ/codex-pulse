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
    workspaceValidationMode: "pre_tool_hook_v1",
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
    this.goalObjective = null;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: this.latestTurnId, status: this.latestTurnStatus }] };
    }
    if (method === "thread/goal/get") {
      return {
        goal: this.goalStatus
          ? { status: this.goalStatus, objective: this.goalObjective }
          : null,
      };
    }
    if (method === "thread/goal/set") {
      this.goalStatus = params.status;
      this.goalObjective = params.objective ?? this.goalObjective;
      return { goal: { status: this.goalStatus, objective: this.goalObjective } };
    }
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") {
      this.latestTurnId = "turn-2";
      return { turn: { id: "turn-2", status: "inProgress" } };
    }
    return {};
  }
}

function observingChat(overrides = {}) {
  const baseline = pausedChat();
  return { ...baseline, status: "observing", quotaPolicy: "strict_reserve",
    initialGoal: { objective: "Finish the original user task" }, observationWindowKey: 100,
    reserveBaseline: baseline.checkpoint, ...overrides };
}

test("an independent recovery submits the official wake only after arming first-tool validation", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({ wakeAdmissionVersion: 1 })]);
  const client = new FakeClient();
  let wakes = 0;
  client.assertWakeReady = async () => {};
  client.wakeThread = async record => {
    wakes++;
    const saved = await store.get(record.sessionId);
    assert.equal(saved.status, "native_goal_active");
    assert.equal(saved.workspaceValidationRequired, true);
    assert.equal(record.pausedTurnId, "turn-1");
  };
  const controller = new ChatContinuityController({ client, store });
  await controller.reconcile(summary(100), { now: 20 });
  assert.equal((await store.get("thread-1")).wakeSubmittedAt, 20);
  await controller.reconcile(summary(100), { now: 21 });
  assert.equal(wakes, 1);
});

test("an ambiguous wake failure preserves validation and does not requeue after execution is observed", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({ wakeAdmissionVersion: 1 })]);
  const client = new FakeClient(); let wakes = 0;
  client.wakeThread = async () => { wakes++; throw Error("network timeout after delivery"); };
  const controller = new ChatContinuityController({ client, store });
  await controller.reconcile(summary(100), { now: 20 });
  assert.equal((await store.get("thread-1")).workspaceValidationRequired, true);
  client.latestTurnId = "actual-woken-turn"; client.latestTurnStatus = "inProgress";
  await controller.reconcile(summary(100), { now: 60 });
  assert.equal(wakes, 1);
  assert.equal((await store.get("thread-1")).executionObservedAt, 60);
});

test("unreviewed recovery hooks stop before Goal activation or queue submission", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  client.assertWakeReady = async () => { const error = Error("review required"); error.code = "PULSE_HOOK_REVIEW_REQUIRED"; throw error; };
  const events = await new ChatContinuityController({ client, store }).reconcile(summary(100), { now: 20 });
  assert.equal(events[0].reason, "hook_review_required");
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("after a day-long observation gap a replacement watcher observes execution without a second wake", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-long-gap-"));
  const store = new ChatContinuityStore(dataDir);
  await store.put(pausedChat({ wakeAdmissionVersion: 1,
    initialGoal: { objective: "Preserve the exact user-approved task" } }));
  const first = new FakeClient();
  first.goalObjective = "Preserve the exact user-approved task";
  let wakeCalls = 0;
  first.wakeThread = async () => {
    wakeCalls++;
    throw Error("network timeout after potentially accepted delivery");
  };
  await new ChatContinuityController({ client: first, store })
    .reconcile(summary(100), { now: 20 });
  const persisted = await store.get("thread-1");
  assert.equal(persisted.status, "native_goal_active");
  assert.equal(persisted.workspaceValidationRequired, true);

  // Reopen disk state without any watcher memory. A clock jump exercises an
  // observation gap; it does not claim that the physical OS was suspended.
  const replacementStore = new ChatContinuityStore(dataDir);
  const replacement = new FakeClient();
  replacement.goalStatus = "active";
  replacement.goalObjective = first.goalObjective;
  replacement.latestTurnId = "actually-started-while-watcher-was-away";
  replacement.latestTurnStatus = "inProgress";
  replacement.wakeThread = async () => { wakeCalls++; };
  const controller = new ChatContinuityController({ client: replacement, store: replacementStore });
  const events = await controller.reconcile(summary(100), { now: 86420 });
  assert.equal(events.filter(e => e.activationPhase === "started").length, 1);
  await controller.reconcile(summary(100), { now: 86480 });
  const after = await replacementStore.get("thread-1");
  assert.equal(wakeCalls, 1);
  assert.equal(after.initialGoal.objective, "Preserve the exact user-approved task");
  assert.equal(after.executionObservedAt, 86420);
  assert.equal(after.workspaceValidationRequired, true);
  assert.equal(replacement.calls.some(c => c.method === "thread/goal/set"), false);
});

test("a long observation gap never turns unknown or still-live execution into a restart", async () => {
  for (const status of ["unknown", "inProgress"]) {
    const store = new MemoryChatContinuityStore([pausedChat({
      status: "native_goal_active", resumedAt: 20, wakeAdmissionVersion: 1,
      pausedTurnId: "turn-1", wakeAttempts: 1, wakeRetryAt: 50,
      workspaceValidationRequired: true,
    })]);
    const client = new FakeClient();
    client.goalStatus = "active";
    client.latestTurnStatus = status;
    let wakes = 0;
    client.wakeThread = async () => { wakes++; };
    const events = await new ChatContinuityController({ client, store })
      .reconcile(summary(100), { now: 86420 });
    assert.deepEqual(events, []);
    assert.equal(wakes, 0);
    assert.equal((await store.get("thread-1")).status, "native_goal_active");
    assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
  }
});

test("first-tool validation cannot hide actual execution from the replacement watcher", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({
    status: "native_goal_active", resumedAt: 20, wakeAttempts: 1, wakeRetryAt: 50,
    pausedTurnId: "turn-1", wakeSourceTurnId: "turn-1",
    // PreToolUse has already replaced turnId with the resumed turn.
    turnId: "resumed-and-validated", workspaceValidatedAt: 21,
    workspaceValidationRequired: false,
  })]);
  const client = new FakeClient();
  client.goalStatus = "active";
  client.latestTurnId = "resumed-and-validated";
  client.latestTurnStatus = "completed";
  let wakes = 0;
  client.wakeThread = async () => { wakes++; };
  const controller = new ChatContinuityController({ client, store });
  const events = await controller.reconcile(summary(100), { now: 86420 });
  assert.equal(events.filter(e => e.activationPhase === "started").length, 1);
  await controller.reconcile(summary(100), { now: 86480 });
  assert.equal((await store.get("thread-1")).executionObservedAt, 86420);
  assert.equal(wakes, 0);
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("history RPC racing a successful Hook preserves the fresh workspace validation", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({
    status: "native_goal_active", resumedAt: 20, pausedTurnId: "turn-1",
    workspaceValidationRequired: true,
  })]);
  const client = new FakeClient();
  client.goalStatus = "active";
  client.latestTurnId = "resumed-turn";
  client.latestTurnStatus = "inProgress";
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/turns/list") {
      const current = await store.get("thread-1");
      await store.put({ ...current, turnId: "resumed-turn",
        workspaceValidationRequired: false, workspaceValidatedAt: 21 });
    }
    return request(method, params);
  };
  await new ChatContinuityController({ client, store }).reconcile(summary(100), { now: 30 });
  const after = await store.get("thread-1");
  assert.equal(after.workspaceValidationRequired, false);
  assert.equal(after.workspaceValidatedAt, 21);
  assert.equal(after.executionObservedAt, 30);
});

test("history RPC racing a new explicit user task cannot overwrite that task", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({
    status: "native_goal_active", resumedAt: 20, pausedTurnId: "turn-1",
  })]);
  const client = new FakeClient();
  client.goalStatus = "active";
  client.latestTurnId = "explicit-user-turn";
  client.latestTurnStatus = "inProgress";
  const request = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/turns/list") {
      await store.put({ sessionId: "thread-1", status: "observing",
        turnId: "explicit-user-turn", initialGoal: { objective: "New user task" } });
    }
    return request(method, params);
  };
  const events = await new ChatContinuityController({ client, store })
    .reconcile(summary(100), { now: 30 });
  assert.deepEqual(events, []);
  const after = await store.get("thread-1");
  assert.equal(after.status, "observing");
  assert.equal(after.initialGoal.objective, "New user task");
  assert.equal(after.executionObservedAt, undefined);
});

test("a different replayed turn id without lifecycle evidence does not prove execution", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({
    status: "native_goal_active", resumedAt: 20, pausedTurnId: "turn-1",
    wakeAttempts: 1, workspaceValidationRequired: true,
  })]);
  const client = new FakeClient();
  client.goalStatus = "active";
  client.latestTurnId = "metadata-only-turn";
  client.latestTurnStatus = "unknown";
  let wakes = 0;
  client.wakeThread = async () => { wakes++; };
  const events = await new ChatContinuityController({ client, store })
    .reconcile(summary(100), { now: 86420 });
  assert.deepEqual(events, []);
  assert.equal(wakes, 0);
  assert.equal((await store.get("thread-1")).executionObservedAt, undefined);
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("quota failure during inference recovers with no later tool or Stop event", async () => {
  const store = new MemoryChatContinuityStore([observingChat()]);
  const client = new FakeClient();
  client.goalStatus = "active";
  client.goalObjective = "Finish the original user task";
  const request = client.request.bind(client);
  client.request = async (method, params) => method === "thread/turns/list"
    ? { data: [{ id: "turn-1", status: "failed", error: { codexErrorInfo: "UsageLimitExceeded" } }] }
    : request(method, params);
  const controller = new ChatContinuityController({ client, store });
  await controller.reconcile(summary(100), { now: 200 });
  const record = await store.get("thread-1");
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.checkpoint.source, "watcher_no_tool_fallback");
  assert.match(record.checkpoint.continuationGoal.objective, /Finish the original user task/);
  assert.deepEqual(client.calls.filter(c => c.method === "thread/goal/set").map(c => c.params.status), ["paused", "active"]);
});

test("at the hard floor a live inference gets a pending checkpoint but is not assumed stopped", async () => {
  const store = new MemoryChatContinuityStore([observingChat()]);
  const client = new FakeClient();
  client.goalStatus = "active";
  client.goalObjective = "Finish the original user task";
  client.latestTurnStatus = "inProgress";
  await new ChatContinuityController({ client, store }).reconcile(summary(9), { now: 200 });
  assert.equal((await store.get("thread-1")).status, "checkpoint_requested");
  assert.equal(client.goalStatus, "paused");
  assert.equal(client.calls.some(c => c.method === "turn/start"), false);
});

test("watcher never pauses or overwrites a user-changed Goal", async () => {
  const store = new MemoryChatContinuityStore([observingChat()]);
  const client = new FakeClient();
  client.goalStatus = "active"; client.goalObjective = "New user objective";
  const events = await new ChatContinuityController({ client, store }).reconcile(summary(9), { now: 200 });
  assert.equal(events[0].reason, "native_goal_changed");
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("a normally completed no-Goal turn is not restarted when quota later falls", async () => {
  const store = new MemoryChatContinuityStore([observingChat({ initialGoal: null })]);
  const client = new FakeClient();
  client.goalStatus = null;
  await new ChatContinuityController({ client, store }).reconcile(summary(9), { now: 200 });
  assert.equal((await store.get("thread-1")).status, "complete");
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("watcher does not resume an explicit user interruption without a Stop event", async () => {
  const store = new MemoryChatContinuityStore([observingChat()]);
  const client = new FakeClient(); client.latestTurnStatus = "interrupted";
  await new ChatContinuityController({ client, store }).reconcile(summary(9), { now: 200 });
  assert.equal((await store.get("thread-1")).status, "complete");
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("a quota failure without Stop or final text repairs the pending checkpoint and requests recovery once", async () => {
  const objective = "Keep this exact user-approved objective";
  const store = new MemoryChatContinuityStore([pausedChat({
    status: "checkpoint_requested", initialGoal: { objective }, goalAtPause: { objective },
    checkpoint: { workspaceFingerprint: "same" },
  })]);
  const client = new FakeClient();
  client.goalObjective = objective;
  client.latestTurnStatus = "failed";
  const controller = new ChatContinuityController({ store, client });
  const events = await controller.reconcile(summary(100), { now: 20 });
  const record = await store.get("thread-1");
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.checkpoint.repairedFromTurnStatus, "failed");
  assert.match(record.checkpoint.continuationGoal.objective, /Keep this exact user-approved objective/);
  assert.match(record.checkpoint.summary, /No final progress report/);
  assert.equal(events.at(-1).activationPhase, "requested");
  await controller.reconcile(summary(100), { now: 21 });
  assert.equal(client.calls.filter(c => c.method === "thread/goal/set").length, 1);
});

test("pending checkpoint waits for a live turn even after a long observation gap", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({ status: "checkpoint_requested" })]);
  const client = new FakeClient();
  client.latestTurnStatus = "inProgress";
  await new ChatContinuityController({ store, client }).reconcile(summary(100), { now: 100000 });
  assert.equal((await store.get("thread-1")).status, "checkpoint_requested");
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("pending checkpoint without a pause-time snapshot alerts instead of silently disappearing or inventing a baseline", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({
    status: "checkpoint_requested", checkpoint: {},
  })]);
  const client = new FakeClient();
  client.latestTurnStatus = "failed";
  const events = await new ChatContinuityController({ store, client }).reconcile(summary(100), { now: 20 });
  assert.equal((await store.get("thread-1")).status, "needs_attention");
  assert.equal(events[0].reason, "checkpoint_missing_fingerprint");
  assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
});

test("pending checkpoint survives offline and replacement watcher before recovery", async () => {
  const store = new MemoryChatContinuityStore([pausedChat({ status: "checkpoint_requested" })]);
  await new ChatContinuityController({ store, client: {
    async request() { throw new Error("network offline"); },
  } }).reconcile(summary(100), { now: 20 });
  assert.equal((await store.get("thread-1")).retryNotBefore, 50);
  const client = new FakeClient();
  client.goalStatus = null;
  client.latestTurnStatus = "failed";
  const controller = new ChatContinuityController({ store, client });
  await controller.reconcile(summary(100), { now: 49 });
  assert.equal(client.calls.length, 0);
  await controller.reconcile(summary(100), { now: 50 });
  assert.equal((await store.get("thread-1")).status, "native_goal_active");
});

test("pending checkpoint never resumes over a newer turn or an explicit interruption", async () => {
  for (const kind of ["newer", "interrupted"]) {
    const store = new MemoryChatContinuityStore([pausedChat({ status: "checkpoint_requested" })]);
    const client = new FakeClient();
    if (kind === "newer") client.latestTurnId = "new-user-turn";
    else client.latestTurnStatus = "interrupted";
    const events = await new ChatContinuityController({ store, client }).reconcile(summary(100), { now: 20 });
    assert.equal(events[0].type, "chat_continuity_attention");
    assert.equal(client.calls.some(c => c.method === "thread/goal/set"), false);
  }
});

test("Goal activation arms workspace validation before the RPC can dispatch tools", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  const originalRequest = client.request.bind(client);
  client.request = async (method, params) => {
    if (method === "thread/goal/set") {
      const record = await store.get("thread-1");
      assert.equal(record.status, "resuming");
      assert.equal(record.workspaceValidationRequired, true);
    }
    return originalRequest(method, params);
  };
  await new ChatContinuityController({ store, client }).reconcile(summary(100), { now: 20 });
});

test("Goal activation with no actual new turn produces an alert rather than reporting execution", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  const controller = new ChatContinuityController({ store, client });
  const events = await controller.reconcile(summary(100), { now: 20 });
  assert.equal(events[0].activationPhase, "requested");
  const stalled = await controller.reconcile(summary(100), { now: 200 });
  assert.equal(stalled[0].reason, "native_goal_not_started");
  assert.equal((await store.get("thread-1")).status, "needs_attention");
});

test("a new native turn is observed once before announcing actual execution", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  const controller = new ChatContinuityController({ store, client });
  await controller.reconcile(summary(100), { now: 20 });
  client.latestTurnId = "actual-new-turn";
  client.latestTurnStatus = "inProgress";
  assert.equal((await controller.reconcile(summary(100), { now: 21 }))[0].activationPhase, "started");
  assert.deepEqual(await controller.reconcile(summary(100), { now: 22 }), []);
});

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

test("ordinary chat without a native Goal bootstraps a recovery Goal exactly once", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      autoResume: false,
      resumeMode: "manual",
      goalWasActive: false,
      resumeUnavailableReason: "native_goal_required",
    }),
  ]);
  const client = new FakeClient();
  client.goalStatus = null;
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
  assert.equal(events[0].type, "chat_continuity_resumed");
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.autoResume, true);
  assert.equal(record.resumeMode, "native_goal");
  assert.equal(record.goalWasActive, true);
  assert.equal(record.resumeCount, 1);
  const activation = client.calls.find((call) => call.method === "thread/goal/set");
  assert.equal(activation.params.status, "active");
  assert.equal(activation.params.origin, "automatic");
  assert.match(activation.params.objective, /existing thread context as the source of truth/);
  assert.match(activation.params.objective, /create proof and verify it/);
  assert.equal(client.calls.some((call) => call.method === "thread/resume"), false);
  assert.equal(client.calls.some((call) => call.method === "turn/start"), false);

  await controller.reconcile(summary(85, 200), { now: 21 });
  assert.equal(client.calls.filter((call) => call.method === "thread/goal/set").length, 1);
});

test("a checkpoint from the old Hook never resumes without trusted workspace validation", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      autoResume: false,
      resumeMode: "manual",
      goalWasActive: false,
      resumeUnavailableReason: "native_goal_required",
      workspaceValidationMode: null,
    }),
  ]);
  const client = new FakeClient();
  client.goalStatus = null;
  const controller = new ChatContinuityController({ client, store });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  const record = await store.get("thread-1");
  assert.equal(events[0].reason, "workspace_validation_upgrade_required");
  assert.equal(record.status, "needs_attention");
  assert.equal(record.autoResume, false);
  assert.equal(client.calls.some((call) => call.method === "thread/goal/set"), false);
});

test("network loss defers recovery and a later watcher resumes after backoff", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      autoResume: false,
      resumeMode: "manual",
      goalWasActive: false,
      resumeUnavailableReason: "native_goal_required",
    }),
  ]);
  const offlineClient = new FakeClient();
  offlineClient.request = async function request(method, params) {
    this.calls.push({ method, params });
    throw new Error("thread/turns/list timed out after 15000ms");
  };
  const offlineController = new ChatContinuityController({
    client: offlineClient,
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

  const offlineEvents = await offlineController.reconcile(summary(85, 200), { now: 20 });
  let record = await store.get("thread-1");
  assert.deepEqual(offlineEvents, []);
  assert.equal(record.status, "paused_quota");
  assert.equal(record.retryCount, 1);
  assert.equal(record.retryNotBefore, 50);
  assert.notEqual(record.status, "needs_attention");

  const recoveredClient = new FakeClient();
  recoveredClient.goalStatus = null;
  const recoveredController = new ChatContinuityController({
    client: recoveredClient,
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
  assert.deepEqual(
    await recoveredController.reconcile(summary(85, 200), { now: 49 }),
    [],
  );
  const events = await recoveredController.reconcile(summary(85, 200), { now: 50 });
  record = await store.get("thread-1");
  assert.equal(events[0].type, "chat_continuity_resumed");
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.retryCount, 0);
  assert.equal(record.retryNotBefore, null);
  assert.equal(
    recoveredClient.calls.filter((call) => call.method === "thread/goal/set").length,
    1,
  );
});

test("an ambiguous Goal activation timeout is retried without a second activation", async () => {
  const store = new MemoryChatContinuityStore([
    pausedChat({
      autoResume: false,
      resumeMode: "manual",
      goalWasActive: false,
      resumeUnavailableReason: "native_goal_required",
    }),
  ]);
  const client = new FakeClient();
  client.goalStatus = null;
  let activationAttempts = 0;
  const baseRequest = client.request.bind(client);
  client.request = async function request(method, params) {
    if (method === "thread/goal/set") {
      activationAttempts += 1;
      this.goalStatus = params.status;
      this.goalObjective = params.objective;
      this.calls.push({ method, params });
      throw new Error("App Server request timed out after accepting the Goal");
    }
    return baseRequest(method, params);
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

  assert.deepEqual(await controller.reconcile(summary(85, 200), { now: 20 }), []);
  let record = await store.get("thread-1");
  assert.equal(record.status, "paused_quota");
  assert.equal(record.retryNotBefore, 50);
  assert.equal(activationAttempts, 1);

  const events = await controller.reconcile(summary(85, 200), { now: 50 });
  record = await store.get("thread-1");
  assert.equal(events[0].type, "chat_continuity_resumed");
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.resumeCount, 1);
  assert.equal(activationAttempts, 1);
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

test("ordinary chat delegates workspace validation to the trusted pre-tool hook", async () => {
  const store = new MemoryChatContinuityStore([pausedChat()]);
  const client = new FakeClient();
  let workspaceRead = false;
  const controller = new ChatContinuityController({
    client,
    store,
    workspace: {
      async exists() {
        workspaceRead = true;
        throw new Error("background watcher must not read the protected workspace");
      },
      async fingerprint() {
        workspaceRead = true;
        throw new Error("background watcher must not read the protected workspace");
      },
    },
  });

  const events = await controller.reconcile(summary(85, 200), { now: 20 });
  const record = await store.get("thread-1");
  assert.equal(events[0].type, "chat_continuity_resumed");
  assert.equal(record.status, "native_goal_active");
  assert.equal(record.workspaceValidationRequired, true);
  assert.equal(workspaceRead, false);
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
