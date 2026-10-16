import assert from "node:assert/strict";
import test from "node:test";

import { evaluateWeeklyPacing } from "../src/weekly-pacing.mjs";

const NOW = 2_000_000_000;

function summary({ used, daysRemaining }) {
  return {
    weekly: {
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt: NOW + daysRemaining * 24 * 60 * 60,
    },
  };
}

test("weekly pacing exposes an actionable daily allowance", () => {
  const pacing = evaluateWeeklyPacing(summary({ used: 20, daysRemaining: 4 }), {
    now: NOW,
  });
  assert.equal(pacing.status, "on_track");
  assert.equal(pacing.dailyBudgetPercent, 20);
  assert.equal(pacing.confidence, "high");
});

test("weekly pacing flags usage that will exhaust the window early", () => {
  const pacing = evaluateWeeklyPacing(summary({ used: 60, daysRemaining: 5 }), {
    now: NOW,
  });
  assert.equal(pacing.status, "at_risk");
  assert.ok(pacing.projectedUsedPercent > 100);
  assert.equal(pacing.dailyBudgetPercent, 8);
});
