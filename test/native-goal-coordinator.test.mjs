import assert from "node:assert/strict";
import test from "node:test";

import { NativeGoalCoordinator } from "../src/native-goal-coordinator.mjs";

class FakeClient {
  constructor(goalStatus) {
    this.goalStatus = goalStatus;
    this.goal = goalStatus
      ? {
          status: goalStatus,
          objective: "Ship the original user outcome",
          tokenBudget: 50_000,
          createdAt: 10,
          updatedAt: 20,
        }
      : null;
    this.calls = [];
  }

  async start() {
    this.calls.push({ method: "start" });
  }

  stop() {
    this.calls.push({ method: "stop" });
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/goal/get") {
      return { goal: this.goal };
    }
    if (method === "thread/goal/set") {
      this.goalStatus = params.status;
      this.goal = { ...this.goal, ...params, status: this.goalStatus };
      return { goal: this.goal };
    }
    throw new Error(`unexpected method: ${method}`);
  }
}

test("pauses an active native Goal through the public App Server protocol", async () => {
  const client = new FakeClient("active");
  const coordinator = new NativeGoalCoordinator({ clientFactory: () => client });

  const result = await coordinator.pauseIfActive("thread-1");

  assert.deepEqual(result, {
    paused: true,
    status: "paused",
    goalSnapshot: {
      objective: "Ship the original user outcome",
      tokenBudget: 50_000,
      createdAt: 10,
      updatedAt: 20,
    },
  });
  assert.deepEqual(client.calls, [
    { method: "start" },
    { method: "thread/goal/get", params: { threadId: "thread-1" } },
    {
      method: "thread/goal/set",
      params: { threadId: "thread-1", status: "paused", origin: "automatic" },
    },
    { method: "stop" },
  ]);
});

test("does not mutate a thread that has no active Goal", async () => {
  const client = new FakeClient(null);
  const coordinator = new NativeGoalCoordinator({ clientFactory: () => client });

  const result = await coordinator.pauseIfActive("thread-2");

  assert.deepEqual(result, { paused: false, status: null, goalSnapshot: null });
  assert.equal(client.calls.some((call) => call.method === "thread/goal/set"), false);
  assert.equal(client.calls.at(-1).method, "stop");
});
