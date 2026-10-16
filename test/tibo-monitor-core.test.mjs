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

test("three fetch failures emit one source-health alert and recovery emits one event", () => {
  const now = Date.parse("2026-10-15T07:00:00Z") / 1000;
  const baseline = evaluateTiboSnapshot(
    null,
    normalizeTiboSnapshot(raw(), { now }),
    { now },
  );
  const first = evaluateTiboFetchFailure(baseline.state, { now: now + 60 });
  const second = evaluateTiboFetchFailure(first.state, { now: now + 120 });
  const third = evaluateTiboFetchFailure(second.state, { now: now + 180 });
  assert.deepEqual(first.events, []);
  assert.deepEqual(second.events, []);
  assert.equal(third.events[0].type, "tibo_source_unhealthy");
  const fourth = evaluateTiboFetchFailure(third.state, { now: now + 240 });
  assert.deepEqual(fourth.events, []);

  const healthyRaw = raw();
  healthyRaw.feed.fetched_at = new Date((now + 300) * 1000).toISOString();
  healthyRaw.feed.stale = false;
  const recovered = evaluateTiboSnapshot(
    fourth.state,
    normalizeTiboSnapshot(healthyRaw, { now: now + 300 }),
    { now: now + 300 },
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
