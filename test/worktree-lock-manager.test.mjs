import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ManagedTaskController } from "../src/managed-task-controller.mjs";
import { MemoryTaskStore } from "../src/managed-task-store.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-lock-"));
  const cwd = path.join(root, "worktree");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd };
}

function queuedTask(id, cwd, createdAt) {
  return {
    id,
    status: "queued",
    objective: `Run ${id}`,
    cwd,
    model: "gpt-6.1-sol",
    quotaPolicy: "finish_current",
    taskSize: "medium",
    priority: "normal",
    autoResume: true,
    startFloor: 50,
    resumeFloor: 50,
    threadId: null,
    turnId: null,
    lastPlan: [],
    usageSegments: [],
    createdAt,
    updatedAt: createdAt,
  };
}

function summary() {
  return {
    planType: "plus",
    fiveHour: { remainingPercent: 90, usedPercent: 10, resetsAt: 2_000_000_000 },
    weekly: { remainingPercent: 90 },
    resetCredits: { availableCount: 0, expiries: [] },
  };
}

class FakeClient {
  constructor(name) {
    this.name = name;
    this.calls = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/start") return { thread: { id: `${this.name}-thread` } };
    if (method === "turn/start") return { turn: { id: `${this.name}-turn` } };
    return {};
  }
}

test("one durable lock excludes another live watcher from the same worktree", async (t) => {
  const { root, cwd } = await fixture(t);
  const alive = () => true;
  const first = new WorktreeLockManager(root, {
    holderId: "watcher-a",
    pid: 101,
    isProcessAlive: alive,
  });
  const second = new WorktreeLockManager(root, {
    holderId: "watcher-b",
    pid: 202,
    isProcessAlive: alive,
  });

  const acquired = await first.acquire(cwd, "task-a");
  const blocked = await second.acquire(cwd, "task-b");
  assert.equal(acquired.acquired, true);
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.reason, "worktree_busy");

  assert.equal(await first.release(acquired.handle), true);
  assert.equal((await second.acquire(cwd, "task-b")).acquired, true);
});

test("a replacement watcher reclaims a lock only after its owner is dead", async (t) => {
  const { root, cwd } = await fixture(t);
  const oldWatcher = new WorktreeLockManager(root, {
    holderId: "old-watcher",
    pid: 303,
    isProcessAlive: () => true,
  });
  const old = await oldWatcher.acquire(cwd, "task-a");

  const restartedWatcher = new WorktreeLockManager(root, {
    holderId: "new-watcher",
    pid: 404,
    isProcessAlive: (pid) => pid !== 303,
  });
  const reclaimed = await restartedWatcher.acquire(cwd, "task-a");
  assert.equal(reclaimed.acquired, true);
  assert.notEqual(reclaimed.handle.token, old.handle.token);
  assert.equal(await oldWatcher.release(old.handle), false);
  assert.equal(await restartedWatcher.release(reclaimed.handle), true);
});

test("two watcher controllers never start two tasks in one worktree", async (t) => {
  const { root, cwd } = await fixture(t);
  const store = new MemoryTaskStore([
    queuedTask("task-a", cwd, 1),
    queuedTask("task-b", cwd, 2),
  ]);
  const firstClient = new FakeClient("first");
  const secondClient = new FakeClient("second");
  const workspace = {
    async exists() {
      return true;
    },
  };
  const first = new ManagedTaskController({
    client: firstClient,
    store,
    workspace,
    lockManager: new WorktreeLockManager(root, { holderId: "watcher-a" }),
  });
  const second = new ManagedTaskController({
    client: secondClient,
    store,
    workspace,
    lockManager: new WorktreeLockManager(root, { holderId: "watcher-b" }),
  });

  await Promise.all([
    first.reconcile(summary(), { now: 100 }),
    second.reconcile(summary(), { now: 100 }),
  ]);

  const starts = [...firstClient.calls, ...secondClient.calls].filter(
    (call) => call.method === "thread/start",
  );
  const tasks = await store.list();
  assert.equal(starts.length, 1);
  assert.equal(tasks.filter((task) => task.status === "running").length, 1);
  assert.equal(tasks.filter((task) => task.status === "queued").length, 1);
});
