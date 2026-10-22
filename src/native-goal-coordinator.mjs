import { AppServerClient } from "./app-server-client.mjs";

function snapshotGoal(goal) {
  if (!goal) return null;
  return {
    objective: goal.objective,
    tokenBudget: goal.tokenBudget ?? null,
    createdAt: goal.createdAt ?? null,
    updatedAt: goal.updatedAt ?? null,
  };
}

export class NativeGoalCoordinator {
  constructor({ clientFactory = () => new AppServerClient() } = {}) {
    this.clientFactory = clientFactory;
  }

  async pauseIfActive(threadId) {
    const client = this.clientFactory();
    try {
      await client.start();
      const current = await client.request("thread/goal/get", { threadId });
      if (current.goal?.status !== "active") {
        return {
          paused: false,
          status: current.goal?.status || null,
          goalSnapshot: snapshotGoal(current.goal),
        };
      }
      const goalSnapshot = snapshotGoal(current.goal);
      const updated = await client.request("thread/goal/set", {
        threadId,
        status: "paused",
        origin: "automatic",
      });
      return {
        paused: updated.goal?.status === "paused",
        status: updated.goal?.status || null,
        goalSnapshot,
      };
    } finally {
      client.stop();
    }
  }
}
