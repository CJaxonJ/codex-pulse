import assert from "node:assert/strict";
import test from "node:test";

import { MemoryUsageObservationStore } from "../src/usage-observation-store.mjs";

test("usage observations can be updated without storing prompt content", async () => {
  const store = new MemoryUsageObservationStore();
  await store.put({
    id: "session-turn",
    model: "gpt-6.1-sol",
    taskSize: "small",
    startRemaining: 50,
  });
  const current = await store.get("session-turn");
  await store.put({ ...current, endRemaining: 44, consumedPercent: 6 });
  const [saved] = await store.list();
  assert.equal(saved.consumedPercent, 6);
  assert.equal("prompt" in saved, false);
});
