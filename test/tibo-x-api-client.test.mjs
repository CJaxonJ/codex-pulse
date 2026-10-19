import assert from "node:assert/strict";
import test from "node:test";

import { TiboResetClient } from "../src/tibo-client.mjs";
import { TiboXApiClient } from "../src/tibo-x-api-client.mjs";

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

test("X API source reads replies, expands parent context, and returns the existing snapshot contract", async () => {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, authorization: options.headers.Authorization });
    if (url.pathname.includes("/by/username/")) {
      return jsonResponse({
        data: {
          id: "42",
          username: "thsottiaux",
          name: "Tibo",
          public_metrics: { followers_count: 123 },
        },
      });
    }
    return jsonResponse({
      data: [
        {
          id: "200",
          text: "Done and dusted",
          created_at: "2026-10-19T12:00:00.000Z",
          conversation_id: "100",
          referenced_posts: [{ type: "replied_to", id: "100" }],
        },
      ],
      includes: {
        posts: [{ id: "100", text: "Did the Codex usage limit reset finish?" }],
      },
    });
  };
  const client = new TiboXApiClient({ bearerToken: "secret", fetchImpl });
  const snapshot = await client.readSnapshot({ sinceId: "199" });

  assert.equal(snapshot.source, "x-api");
  assert.equal(snapshot.feed.tweets[0].kind, "reset");
  assert.equal(snapshot.feed.tweets[0].is_reply, true);
  assert.equal(snapshot.forecast.latest_alert.state, "confirmed");
  assert.equal(calls[1].url.searchParams.get("since_id"), "199");
  assert.equal(calls[1].url.searchParams.get("exclude"), "retweets");
  assert.equal(calls[0].authorization, "Bearer secret");
});

test("auto source uses the zero-configuration aggregator and X remains explicit", async () => {
  let fetchCount = 0;
  const automatic = new TiboResetClient({
    source: "auto",
    legacyBaseUrl: "https://reset.example",
    fetchImpl: async (input) => {
      fetchCount += 1;
      const url = new URL(input);
      return url.pathname === "/api/forecast"
        ? jsonResponse({ last_reset_at: null })
        : jsonResponse({ fetched_at: "2026-10-19T12:00:00.000Z", tweets: [] });
    },
  });
  const automaticSnapshot = await automatic.readSnapshot();
  assert.equal(automaticSnapshot.source, "codex-reset");
  assert.equal(fetchCount, 2);

  const enabled = new TiboResetClient({
    source: "x-api",
    tokenProvider: async () => "secret",
    fetchImpl: async (input) => {
      fetchCount += 1;
      const url = new URL(input);
      return url.pathname.includes("/by/username/")
        ? jsonResponse({ data: { id: "42", username: "thsottiaux" } })
        : jsonResponse({ data: [], meta: { result_count: 0 } });
    },
  });
  const snapshot = await enabled.readSnapshot();
  assert.equal(snapshot.source, "x-api");
  assert.equal(fetchCount, 4);
});

test("the aggregator keeps the live feed when its forecast endpoint is down", async () => {
  const client = new TiboResetClient({
    source: "codex-reset",
    legacyBaseUrl: "https://reset.example",
    fetchImpl: async (input) => {
      const url = new URL(input);
      return url.pathname === "/api/forecast"
        ? jsonResponse({ error: "temporarily unavailable" }, 503)
        : jsonResponse({
            fetched_at: "2026-10-19T12:00:00.000Z",
            tweets: [],
          });
    },
  });
  const snapshot = await client.readSnapshot();
  assert.equal(snapshot.source, "codex-reset");
  assert.deepEqual(snapshot.forecast, {});
  assert.deepEqual(snapshot.degradedComponents, ["forecast"]);
});

test("X API errors never reveal the bearer token", async () => {
  const token = "do-not-leak-this-token";
  const client = new TiboXApiClient({
    bearerToken: token,
    fetchImpl: async () => jsonResponse({ title: "rate limited" }, 429, {
      "retry-after": "60",
    }),
  });
  await assert.rejects(
    client.readSnapshot(),
    (error) => !error.message.includes(token) && /HTTP 429/.test(error.message),
  );
});
