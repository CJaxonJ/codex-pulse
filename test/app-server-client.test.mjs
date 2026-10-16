import assert from "node:assert/strict";
import test from "node:test";

import { AppServerClient } from "../src/app-server-client.mjs";

test("server-initiated requests are not mistaken for ordinary notifications", () => {
  const client = new AppServerClient();
  const requests = [];
  const notifications = [];
  client.on("serverRequest", (message) => requests.push(message));
  client.on("notification", (message) => notifications.push(message));

  client._onLine(
    JSON.stringify({
      id: 91,
      method: "item/tool/requestUserInput",
      params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
    }),
  );
  client._onLine(
    JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }),
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].id, 91);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "turn/started");
});
