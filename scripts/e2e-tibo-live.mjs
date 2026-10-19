#!/usr/bin/env node

import assert from "node:assert/strict";

import { TiboResetClient } from "../src/tibo-client.mjs";
import { normalizeTiboSnapshot } from "../src/tibo-monitor-core.mjs";

const client = new TiboResetClient({
  source: "auto",
  timeoutMs: 15_000,
});
const raw = await client.readSnapshot();
const now = Math.floor(Date.now() / 1000);
const snapshot = normalizeTiboSnapshot(raw, { now });

assert.equal(raw?.source, "codex-reset", "auto must use the zero-configuration source");
assert.ok(raw?.feed && typeof raw.feed === "object", "feed is missing");
assert.ok(Array.isArray(raw.feed.tweets), "feed.tweets must be an array");
assert.ok(raw.feed.tweets.length > 0, "live feed unexpectedly contains no posts");
assert.ok(raw.feed.fetched_at, "live feed is missing fetched_at");
assert.equal(snapshot.sourceHealth.status, "healthy", "live feed is stale or unhealthy");

console.log(
  JSON.stringify(
    {
      ok: true,
      adapter: raw.source,
      upstreamSource: raw.feed.source || null,
      fetchedAt: raw.feed.fetched_at,
      postCount: raw.feed.tweets.length,
      sourceHealth: snapshot.sourceHealth.status,
      forecastAvailable: !raw.degradedComponents?.includes("forecast"),
      degradedComponents: raw.degradedComponents || [],
    },
    null,
    2,
  ),
);
