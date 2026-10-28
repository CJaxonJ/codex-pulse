import assert from "node:assert/strict";
import test from "node:test";
import { resolveTiboWindow, describeTiboWindow } from "../src/tibo-reset-window.mjs";
import { normalizeTiboSnapshot, evaluateTiboSnapshot, evaluateTiboFetchFailure } from "../src/tibo-monitor-core.mjs";
import { notificationForEvent, applyNotificationPreferences } from "../src/macos-notifier.mjs";
import { classifyTiboPost } from "../src/tibo-classifier.mjs";
import { TiboResetClient } from "../src/tibo-client.mjs";

const at = (iso) => Date.parse(iso) / 1000;
const posted = at("2026-10-28T02:43:38Z");
const deadline = at("2026-10-28T07:00:00Z");
// Public-source response shape, not a prediction or a claim of personal landing.
function signal(overrides = {}) {
  return { tweet_id: "timing-1", summary: "Lands by midnight PST.", at: new Date(posted * 1000).toISOString(),
    window: { start_at: new Date(posted * 1000).toISOString(), end_at: "2026-10-28T07:00:00Z",
      target_at: "2026-10-28T07:00:00Z", target_kind: "deadline", time_zone: "America/Los_Angeles" },
    ...overrides };
}
function snapshot(value, now = posted + 60, confirmedAt = null) {
  return normalizeTiboSnapshot({ source: "codex-reset",
    forecast: { official_signal: value, last_reset_at: confirmedAt },
    feed: { fetched_at: new Date(now * 1000).toISOString(), tweets: [] },
  }, { now });
}
function baseline() {
  return evaluateTiboSnapshot(null, snapshot(null, posted - 60)).state;
}
function announce(value = signal()) {
  return evaluateTiboSnapshot(baseline(), snapshot(value));
}

test("upstream deadline is preserved end-to-end and PST ambiguity is visible in Beijing time", async () => {
  const client = new TiboResetClient({ source: "codex-reset", fetchImpl: async (input) =>
    new Response(JSON.stringify(new URL(input).pathname === "/api/forecast"
      ? { official_signal: signal(), time_window: { label: "4 AM - 7 AM" } }
      : { tweets: [], fetched_at: "2026-10-28T02:44:38Z" }), { headers: { "content-type": "application/json" } }),
  });
  const normalized = normalizeTiboSnapshot(await client.readSnapshot(), { now: posted + 60 });
  const result = evaluateTiboSnapshot(baseline(), normalized);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].resetWindow.endAt, deadline);
  assert.equal(result.events[0].resetWindow.expiresAt, deadline + 3600);
  const notice = notificationForEvent(result.events[0]);
  assert.match(notice.title, /北京时间 10月28日 15:00 或 10月28日 16:00 前/);
  assert.match(notice.body, /两种截止时间解释，不是到账区间/);
  assert.match(notice.body, /不代表你的账户已到账/);
  assert.equal(notice.severity, "warning");
});

test("aligned summer PDT and winter PST do not produce artificial ambiguity", () => {
  const summer = snapshot(signal({ summary: "Lands by midnight PDT." })).preview.resetWindow;
  assert.equal(summer.alternateAt, null);
  const winter = resolveTiboWindow({ occurredAt: at("2026-12-01T02:00:00Z"), text: "Lands by midnight PST.",
    window: { target_kind: "deadline", target_at: "2026-12-01T08:00:00Z", time_zone: "America/Los_Angeles" } });
  assert.equal(winter.alternateAt, null);
  assert.match(describeTiboWindow(winter).title, /12月1日 16:00 前/);
});

test("relative durations use post time, including word numbers, never the poll time", () => {
  for (const text of ["Landing within the next 2 hours", "Landing within two hours"]) {
    const value = signal({ summary: text, window: null });
    const early = snapshot(value).preview.resetWindow;
    const late = snapshot(value, posted + 3600).preview.resetWindow;
    assert.equal(early.endAt, posted + 7200);
    assert.deepEqual(early, late);
  }
});

test("unknown, invalid, or statistical timing never becomes an invented reset schedule", () => {
  const invalid = [
    { target_at: "2026-10-28T07:00:00", target_kind: "deadline" },
    { target_at: "garbage", target_kind: "deadline" },
    { target_at: Infinity, target_kind: "deadline" },
    { target_at: "2026-10-28T01:00:00Z", target_kind: "deadline" },
    { target_at: "2027-10-28T07:00:00Z", target_kind: "deadline" },
    { target_at: "2026-10-28T07:00:00Z", target_kind: "deadline", time_zone: "Invalid/Zone" },
    { start_at: "2026-10-28T08:00:00Z", end_at: "2026-10-28T07:00:00Z", target_kind: "range" },
    { target_at: "2026-10-28T07:00:00Z", target_kind: "prediction" },
  ];
  for (const window of invalid) assert.equal(snapshot(signal({ window })).preview.resetWindow, null);
  const normalized = normalizeTiboSnapshot({ forecast: { official_signal: signal({ summary: "Reset soon", window: null }),
    time_window: { start_hour: 4, end_hour: 7 }, teased_window: { end_at: "2026-10-28T07:00:00Z" } } }, { now: posted + 60 });
  assert.equal(normalized.preview.resetWindow, null);
  assert.match(notificationForEvent({ type: "tibo_preview", ...normalized.preview }).title, /具体时间未定/);
});

test("range and exact-time notices have distinct wording and retain cross-day dates", () => {
  const range = resolveTiboWindow({ occurredAt: posted, window: { target_kind: "range",
    start_at: "2026-10-28T15:00:00Z", end_at: "2026-10-28T17:00:00Z" } });
  assert.match(describeTiboWindow(range).title, /10月28日 23:00 至 10月29日 01:00/);
  const exact = resolveTiboWindow({ occurredAt: posted, window: { target_kind: "at", target_at: "2026-10-28T07:00:00Z" } });
  assert.match(describeTiboWindow(exact).title, /15:00 左右/);
});

test("same post gains a deadline or a correction: each update notifies once across restart", () => {
  let result = announce(signal({ window: null }));
  assert.equal(result.events[0].type, "tibo_preview");
  result = evaluateTiboSnapshot(result.state, snapshot(signal()));
  assert.equal(result.events[0].type, "tibo_preview");
  result = evaluateTiboSnapshot(JSON.parse(JSON.stringify(result.state)), snapshot(signal()));
  assert.deepEqual(result.events, []);
  const corrected = signal({ window: { target_kind: "deadline", target_at: "2026-10-28T09:00:00Z" } });
  result = evaluateTiboSnapshot(result.state, snapshot(corrected));
  assert.equal(result.events[0].resetWindow.endAt, deadline + 7200);
  assert.deepEqual(evaluateTiboSnapshot(result.state, snapshot(corrected)).events, []);
});

test("withdrawn or invalid timing updates the same post to unknown instead of preserving an obsolete deadline", () => {
  for (const updated of [signal({ summary: "Reset coming, exact timing TBD", window: null }),
    signal({ window: { target_kind: "deadline", target_at: "invalid" } })]) {
    const result = evaluateTiboSnapshot(announce().state, snapshot(updated));
    assert.equal(result.events[0].type, "tibo_preview");
    assert.match(notificationForEvent(result.events[0]).title, /具体时间未定/);
    assert.equal(result.state.activePreview.resetWindow, null);
    assert.deepEqual(evaluateTiboSnapshot(result.state, snapshot(updated)).events, []);
  }
});

test("baseline is quiet and same-ID legacy state learns timing once", () => {
  const first = evaluateTiboSnapshot(null, snapshot(signal()));
  assert.deepEqual(first.events, []);
  assert.deepEqual(evaluateTiboSnapshot(first.state, snapshot(signal())).events, []);
  const legacy = { ...baseline(), lastPreviewId: "timing-1" };
  assert.equal(evaluateTiboSnapshot(legacy, snapshot(signal())).events[0].type, "tibo_preview");
  const old = evaluateTiboSnapshot(null, snapshot(signal(), deadline + 7200));
  assert.deepEqual(evaluateTiboSnapshot(old.state, snapshot(null, deadline + 7300)).events, []);
});

test("empty and partial feeds retain a deadline; expiry alerts once, even after process restart", () => {
  let result = announce();
  result = evaluateTiboSnapshot(result.state, snapshot(signal({ window: null }), deadline + 1800));
  assert.equal(result.state.activePreview.resetWindow.expiresAt, deadline + 3600);
  assert.deepEqual(result.events, []);
  result = evaluateTiboSnapshot(result.state, snapshot(null, deadline + 3600));
  assert.equal(result.events[0].type, "tibo_preview_expired");
  const notice = notificationForEvent(result.events[0]);
  assert.match(notice.title, /时间已过，尚未确认/);
  assert.equal(notice.severity, "warning");
  assert.equal(applyNotificationPreferences(result.events[0], notice, { tiboSource: "disabled" }).enabled, false);
  assert.deepEqual(evaluateTiboSnapshot(JSON.parse(JSON.stringify(result.state)), snapshot(null, deadline + 7200)).events, []);
});

test("offline expiry remains uncertain and is not repeated after fetching resumes", () => {
  let result = evaluateTiboFetchFailure(announce().state, { now: deadline + 7200 });
  assert.equal(result.events[0].type, "tibo_preview_expired");
  assert.match(notificationForEvent(result.events[0]).body, /不代表重置未发生/);
  result = evaluateTiboFetchFailure(result.state, { now: deadline + 7300 });
  assert.deepEqual(result.events, []);
  assert.deepEqual(evaluateTiboSnapshot(result.state, snapshot(null, deadline + 7400)).events, []);
});

test("new confirmation clears expiry, including stale backfills; earlier confirmation does not erase a later preview", () => {
  const state = announce().state;
  const result = evaluateTiboSnapshot(state, snapshot(null, deadline + 7200, "2026-10-28T06:30:00Z"));
  assert.deepEqual(result.events.map((event) => event.type), ["tibo_confirmed"]);
  assert.equal(result.state.activePreview, null);
  assert.deepEqual(evaluateTiboSnapshot(result.state, snapshot(signal(), deadline + 7300)).events, []);
  const backfilled = evaluateTiboSnapshot(result.state, snapshot(null, deadline + 7300, "2026-10-27T01:00:00Z"));
  assert.equal(backfilled.state.lastConfirmedAt, at("2026-10-28T06:30:00Z"));
  assert.deepEqual(evaluateTiboSnapshot(backfilled.state, snapshot(signal(), deadline + 7400)).events, []);
  const older = evaluateTiboSnapshot(state, snapshot(null, posted + 60, "2026-10-28T01:00:00Z"));
  assert.ok(older.state.activePreview);
});

test("older signals cannot displace a newer active preview", () => {
  const result = evaluateTiboSnapshot(announce().state, snapshot(signal({ tweet_id: "old", at: "2026-10-28T02:00:00Z" })));
  assert.equal(result.state.activePreview.id, "timing-1");
  assert.deepEqual(result.events, []);
});

test("midnight reply is classified only with reset context, not an ordinary product announcement", () => {
  const reply = { text: "Lands by midnight PST.", referenced_posts: [{ type: "replied_to", id: "parent" }] };
  assert.equal(classifyTiboPost(reply, { text: "Today is a reset." }).kind, "signal");
  assert.equal(classifyTiboPost(reply, { text: "New Calendar plugin" }).kind, "other");
});
