import { AppServerClient } from "./app-server-client.mjs";

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
        };
      }
      const updated = await client.request("thread/goal/set", {
        threadId,
        status: "paused",
        origin: "automatic",
      });
      return {
        paused: updated.goal?.status === "paused",
        status: updated.goal?.status || null,
      };
    } finally {
      client.stop();
    }
  }
}
