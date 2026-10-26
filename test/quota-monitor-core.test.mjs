import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateFiveHourSample,
  evaluateResetCredits,
  summarizeRateLimits,
} from "../src/quota-monitor-core.mjs";

function summary(remainingPercent, resetsAt = 2_000_000_000) {
  return {
    planType: "plus",
    fiveHour: {
      usedPercent: 100 - remainingPercent,
      remainingPercent,
      resetsAt,
    },
    weekly: null,
    resetCredits: { availableCount: 0, expiries: [] },
  };
}

function summaryWithWeekly(remainingPercent, weeklyRemainingPercent, resetsAt = 2_000_000_000) {
  return {
    ...summary(remainingPercent, resetsAt),
    weekly: {
      usedPercent: 100 - weeklyRemainingPercent,
      remainingPercent: weeklyRemainingPercent,
      resetsAt: resetsAt + 500_000,
    },
  };
}

test("summarizes the five-hour and weekly windows", () => {
  const result = summarizeRateLimits({
    planType: "plus",
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 10 },
        secondary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: 20 },
      },
    },
  });
  assert.equal(result.fiveHour.remainingPercent, 70);
  assert.equal(result.weekly.remainingPercent, 95);
});

test("warns once when remaining quota falls from 70% to 10%", () => {
  const first = evaluateFiveHourSample(null, summary(70), { now: 1_000 });
  const second = evaluateFiveHourSample(first.state, summary(10), { now: 1_120 });
  assert.equal(second.events.filter((event) => event.type === "threshold").length, 1);
  assert.equal(
    second.events.find((event) => event.type === "threshold").threshold,
    10,
  );
  const third = evaluateFiveHourSample(second.state, summary(10), { now: 1_180 });
  assert.equal(third.events.filter((event) => event.type === "threshold").length, 0);
});

test("forecasts reaching 10% when recent consumption is fast", () => {
  const first = evaluateFiveHourSample(null, summary(40), { now: 1_000 });
  const second = evaluateFiveHourSample(first.state, summary(30), { now: 1_300 });
  const forecast = second.events.find((event) => event.type === "forecast");
  assert.ok(forecast);
  assert.equal(forecast.minutesToTarget, 10);
});

test("detects a five-hour reset", () => {
  const first = evaluateFiveHourSample(null, summary(8), { now: 1_000 });
  const second = evaluateFiveHourSample(first.state, summary(100, 2_000_018_000), {
    now: 1_060,
  });
  const reset = second.events.find((event) => event.type === "reset");
  assert.ok(reset);
  assert.equal(reset.previousRemainingPercent, 8);
  assert.equal(reset.remainingPercent, 100);
  assert.equal(second.state.lastDetectedReset.detectedAt, 1_060);
  assert.equal(reset.resetKind, "unknown");
});

test("distinguishes a rolling five-hour recovery from a full reset", () => {
  const first = evaluateFiveHourSample(
    null,
    summaryWithWeekly(8, 58),
    { now: 1_000 },
  );
  const rolling = evaluateFiveHourSample(
    first.state,
    summaryWithWeekly(100, 58, 2_000_018_000),
    { now: 1_060 },
  );
  assert.equal(rolling.events.find((event) => event.type === "reset").resetKind, "five_hour");

  const full = evaluateFiveHourSample(
    first.state,
    summaryWithWeekly(100, 100, 2_000_018_000),
    { now: 1_060 },
  );
  assert.equal(full.events.find((event) => event.type === "reset").resetKind, "full");
});

test("warns for a reset credit at 24h, 6h, and 1h without duplicates", () => {
  const expiresAt = 100_000;
  const withCredit = {
    ...summary(50),
    resetCredits: { availableCount: 1, expiries: [expiresAt] },
  };
  const at24h = evaluateResetCredits(null, withCredit, {
    now: expiresAt - 23 * 3600,
  });
  assert.equal(at24h.events[0].thresholdHours, 24);

  const duplicate = evaluateResetCredits(at24h.state, withCredit, {
    now: expiresAt - 22 * 3600,
  });
  assert.deepEqual(duplicate.events, []);

  const at6h = evaluateResetCredits(duplicate.state, withCredit, {
    now: expiresAt - 5 * 3600,
  });
  assert.equal(at6h.events[0].thresholdHours, 6);

  const at1h = evaluateResetCredits(at6h.state, withCredit, {
    now: expiresAt - 30 * 60,
  });
  assert.equal(at1h.events[0].thresholdHours, 1);
  const at10m = evaluateResetCredits(at1h.state, withCredit, { now: expiresAt - 600 });
  assert.deepEqual(at10m.events, []);
  const urgent = evaluateResetCredits(at10m.state, withCredit, { now: expiresAt - 599 });
  assert.equal(urgent.events[0].thresholdHours, 1 / 6);
  assert.deepEqual(evaluateResetCredits(urgent.state, withCredit, { now: expiresAt - 400 }).events, []);
});

test("changing the early-warning percentage takes effect without replaying the hard-floor warning", () => {
  const initial = evaluateFiveHourSample(null, summary(40), { now: 1000, config: { thresholds: [20, 10, 5] } });
  const lower = evaluateFiveHourSample(initial.state, summary(25), { now: 1001, config: { thresholds: [20, 10, 5] } });
  assert.equal(lower.events.length, 0);
  const changed = evaluateFiveHourSample(lower.state, summary(25), { now: 1002, config: { thresholds: [35, 10, 5] } });
  assert.equal(changed.events[0].threshold, 35);
  assert.equal(evaluateFiveHourSample(changed.state, summary(25), { now: 1003, config: { thresholds: [35, 10, 5] } }).events.length, 0);
  const hard = evaluateFiveHourSample(changed.state, summary(9), { now: 1004, config: { thresholds: [35, 10, 5] } });
  assert.equal(hard.events[0].threshold, 10);
  assert.equal(evaluateFiveHourSample(hard.state, summary(9), { now: 1005, config: { thresholds: [50, 10, 5] } }).events.length, 0);
});
