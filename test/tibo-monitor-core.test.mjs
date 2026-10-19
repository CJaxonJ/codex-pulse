import assert from "node:assert/strict";
import test from "node:test";

import {
  attachPersonalLanding,
  evaluateTiboFetchFailure,
  evaluateTiboSnapshot,
  normalizeTiboSnapshot,
} from "../src/tibo-monitor-core.mjs";

function raw({ resetAt = "2026-10-15T06:13:01.000Z", tweets = [] } = {}) {
  return {
    forecast: {
      last_reset_at: resetAt,
      latest_alert: resetAt
        ? { id: `reset-${resetAt}`, state: "confirmed", source_at: resetAt }
        : null,
    },
    feed: { tweets },
  };
}

test("first Tibo snapshot establishes a baseline without historical alerts", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const snapshot = normalizeTiboSnapshot(raw(), { now });
  const result = evaluateTiboSnapshot(null, snapshot, { now });
  assert.deepEqual(result.events, []);
  assert.ok(result.state.lastConfirmedKey);
});

test("a source-less snapshot never masquerades as the legacy service", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const snapshot = normalizeTiboSnapshot(raw(), { now });
  assert.equal(snapshot.source, "unknown");
});

test("new reset signal produces one preview and not a duplicate", () => {
  const firstNow = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const baseline = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(raw(), { now: firstNow }),
    { now: firstNow },
  );
  const signalAt = "2026-10-15T07:05:00Z";
  const nextSnapshot = normalizeTiboSnapshot(
    raw({
      tweets: [
        {
          id: "signal-1",
          text: "Landing within the next 2 hours",
          created_at: signalAt,
          kind: "signal",
          reset_verification_status: "pending",
        },
      ],
    }),
    { now: firstNow + 360 },
  );
  const firstSignal = evaluateTiboSnapshot(baseline.state, nextSnapshot, {
    now: firstNow + 360,
  });
  assert.equal(firstSignal.events[0].type, "tibo_preview");
  const duplicate = evaluateTiboSnapshot(firstSignal.state, nextSnapshot, {
    now: firstNow + 420,
  });
  assert.deepEqual(duplicate.events, []);
});

test("a later public reset is confirmed once and waits for personal landing", () => {
  const firstNow = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const baseline = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(raw(), { now: firstNow }),
    { now: firstNow },
  );
  const resetAt = "2026-10-15T08:00:00Z";
  const confirmed = evaluateTiboSnapshot(
    baseline.state,
    normalizeTiboSnapshot(raw({ resetAt }), { now: firstNow + 3700 }),
    { now: firstNow + 3700 },
  );
  assert.equal(confirmed.events[0].type, "tibo_confirmed");
  assert.ok(confirmed.state.pendingPublicReset);

  const landing = attachPersonalLanding(
    [{ type: "reset", remainingPercent: 98, resetsAt: 2_000_000_000 }],
    confirmed.state,
    { now: firstNow + 3800 },
  );
  assert.equal(landing.events[0].type, "personal_landed");
  assert.equal(landing.tiboState.pendingPublicReset, null);
});

test("a new limits post creates one informational event and is then deduplicated", () => {
  const firstNow = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const baselineTweet = {
    id: "old-post",
    text: "ordinary update",
    created_at: "2026-10-15T06:30:00Z",
    kind: "other",
  };
  const baseline = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(raw({ tweets: [baselineTweet] }), { now: firstNow }),
    { now: firstNow },
  );
  const limitsTweet = {
    id: "limits-1",
    text: "More compute has landed and model capacity errors should be rarer.",
    created_at: "2026-10-15T07:05:00Z",
    kind: "limits",
    tibo_lane: "reset_related",
  };
  const snapshot = normalizeTiboSnapshot(
    raw({ tweets: [limitsTweet, baselineTweet] }),
    { now: firstNow + 360 },
  );
  const first = evaluateTiboSnapshot(baseline.state, snapshot, {
    now: firstNow + 360,
  });
  assert.equal(first.events[0].type, "tibo_limits_update");
  assert.equal(first.events[0].id, "limits-1");
  const duplicate = evaluateTiboSnapshot(first.state, snapshot, {
    now: firstNow + 420,
  });
  assert.deepEqual(duplicate.events, []);
});

test("incremental empty reads preserve dedupe history across a later backfill", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const baseline = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(raw(), { now }),
    { now },
  );
  const update = {
    id: "limits-backfill",
    text: "More compute is now available.",
    created_at: "2026-10-15T07:01:00Z",
    kind: "limits",
  };
  const first = evaluateTiboSnapshot(
    baseline.state,
    normalizeTiboSnapshot(raw({ tweets: [update] }), { now: now + 60 }),
    { now: now + 60 },
  );
  assert.equal(first.events[0].type, "tibo_limits_update");
  const empty = evaluateTiboSnapshot(
    first.state,
    normalizeTiboSnapshot(raw({ tweets: [] }), { now: now + 120 }),
    { now: now + 120 },
  );
  const backfill = evaluateTiboSnapshot(
    empty.state,
    normalizeTiboSnapshot(raw({ tweets: [update] }), { now: now + 180 }),
    { now: now + 180 },
  );
  assert.deepEqual(backfill.events, []);
});

test("banked and explicit-reset posts are strong previews, not limits updates", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const snapshot = normalizeTiboSnapshot(
    raw({
      resetAt: "2026-10-15T06:00:00Z",
      tweets: [
        {
          id: "banked-1",
          text: "Loading a banked reset",
          created_at: "2026-10-15T06:30:00Z",
          kind: "banked",
        },
      ],
    }),
    { now },
  );
  assert.equal(snapshot.preview.id, "banked-1");
  assert.equal(snapshot.operationalUpdates.length, 0);
});

test("a confirmed feed post survives a missing forecast endpoint", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const snapshot = normalizeTiboSnapshot(
    {
      source: "codex-reset",
      forecast: {},
      degradedComponents: ["forecast"],
      feed: {
        fetched_at: "2026-10-15T07:00:00Z",
        tweets: [
          {
            id: "confirmed-from-feed",
            text: "Done and dusted",
            created_at: "2026-10-15T06:59:00Z",
            kind: "reset",
            reset_verification_status: "confirmed",
          },
        ],
      },
    },
    { now },
  );
  assert.equal(snapshot.confirmed.key, "confirmed-from-feed");
  assert.deepEqual(snapshot.degradedComponents, ["forecast"]);
});

test("short outages stay quiet; a sustained outage emits one source-health alert", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const baseline = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(raw(), { now }),
    { now },
  );
  let failed = baseline;
  for (let attempt = 1; attempt <= 14; attempt += 1) {
    failed = evaluateTiboFetchFailure(failed.state, { now: now + attempt * 60 });
    assert.deepEqual(failed.events, []);
  }
  const sustained = evaluateTiboFetchFailure(failed.state, { now: now + 15 * 60 });
  assert.equal(sustained.events[0].type, "tibo_source_unhealthy");
  const repeated = evaluateTiboFetchFailure(sustained.state, { now: now + 16 * 60 });
  assert.deepEqual(repeated.events, []);

  const healthyRaw = raw();
  healthyRaw.feed.fetched_at = new Date((now + 300) * 1000).toISOString();
  healthyRaw.feed.stale = false;
  const recovered = evaluateTiboSnapshot(
    repeated.state,
    normalizeTiboSnapshot(healthyRaw, { now: now + 17 * 60 }),
    { now: now + 17 * 60 },
  );
  assert.equal(recovered.events[0].type, "tibo_source_recovered");
  assert.equal(recovered.state.consecutiveSourceFailures, 0);
});

test("an explicitly stale feed produces a source-health alert", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const staleRaw = raw();
  staleRaw.feed.fetched_at = "2026-10-15T06:00:00Z";
  staleRaw.feed.stale = true;
  const result = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(staleRaw, { now }),
    { now },
  );
  assert.equal(result.events[0].type, "tibo_source_unhealthy");
});
