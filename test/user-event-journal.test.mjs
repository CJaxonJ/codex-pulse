import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UserEventJournal } from "../src/user-event-journal.mjs";

test("user-visible events remain inspectable even after a notification disappears", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-events-"));
  const journal = new UserEventJournal(dataDir, { limit: 2 });
  const first = await journal.append({
    type: "threshold",
    title: "已到 10% 保护线",
    body: "正在保存检查点",
    occurredAt: 100,
    deliveryStatus: "pending",
  });
  await journal.updateDeliveryStatus(first.id, "notification_request_accepted");
  await Promise.all([
    journal.append({ type: "paused", title: "已暂停", occurredAt: 101 }),
    journal.append({ type: "resumed", title: "已续跑", occurredAt: 102 }),
  ]);

  const events = await journal.list();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.type), ["paused", "resumed"]);
  assert.equal((await journal.latest()).title, "已续跑");
});
