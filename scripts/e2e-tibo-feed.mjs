#!/usr/bin/env node

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { TiboResetClient } from "../src/tibo-client.mjs";
import { normalizeTiboSnapshot } from "../src/tibo-monitor-core.mjs";

let observedSinceId = null;
let observedAuthorization = null;
const createdAt = new Date().toISOString();
const server = createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  observedAuthorization = request.headers.authorization || null;
  response.setHeader("content-type", "application/json");
  if (url.pathname === "/2/users/by/username/thsottiaux") {
    response.end(
      JSON.stringify({
        data: {
          id: "42",
          username: "thsottiaux",
          name: "Tibo",
          public_metrics: { followers_count: 123 },
        },
      }),
    );
    return;
  }
  if (url.pathname === "/2/users/42/tweets") {
    observedSinceId = url.searchParams.get("since_id");
    response.end(
      JSON.stringify({
        data: [
          {
            id: "2119999999999999999",
            text: "Done and dusted",
            created_at: createdAt,
            conversation_id: "2118888888888888888",
            referenced_posts: [
              { type: "replied_to", id: "2118888888888888888" },
            ],
          },
        ],
        includes: {
          posts: [
            {
              id: "2118888888888888888",
              text: "Has the Codex usage limit reset finished?",
            },
          ],
        },
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  const client = new TiboResetClient({
    source: "x-api",
    tokenProvider: async () => "e2e-secret",
    xApiBaseUrl: `http://127.0.0.1:${address.port}`,
  });
  const now = Math.floor(Date.now() / 1000);
  const raw = await client.readSnapshot({ sinceId: "2117777777777777777" });
  const snapshot = normalizeTiboSnapshot(raw, { now });

  assert.equal(observedAuthorization, "Bearer e2e-secret");
  assert.equal(observedSinceId, "2117777777777777777");
  assert.equal(snapshot.source, "x-api");
  assert.equal(snapshot.sourceHealth.status, "healthy");
  assert.equal(snapshot.latestPost.kind, "reset");
  assert.equal(snapshot.confirmed.key, "2119999999999999999");
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: snapshot.source,
        sourceHealth: snapshot.sourceHealth,
        contextualReplyClassification: snapshot.latestPost.kind,
        confirmedKey: snapshot.confirmed.key,
        network: "local mock X API",
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
