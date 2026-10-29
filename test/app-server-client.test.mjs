import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

test("stopping a connection rejects pending work and old exits cannot erase a replacement connection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-connection-lifecycle-"));
  const peer = path.join(root, "peer.cjs");
  await writeFile(peer, `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!=null && m.method!=='wait')process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n');});`);
  const client = new AppServerClient({ binary: process.execPath, binaryArgs: [peer] });
  try {
    await client.start();
    const previous = (await client.request("proof")).pid;
    const pending = assert.rejects(client.request("wait"), /was stopped/);
    client.stop();
    await pending;
    await client.start();
    assert.notEqual((await client.request("proof")).pid, previous);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(client.child, "A late exit from the old connection must not clear the new child");
    assert.equal(client.pending.size, 0);
    assert((await client.request("proof")).pid > 0);
  } finally { client.stop(); }
});
