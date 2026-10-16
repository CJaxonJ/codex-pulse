import assert from "node:assert/strict";
import test from "node:test";

import { planQuota } from "../src/planner.mjs";

const NOW = 1_800_000_000;

function snapshot({ planType = "plus", fiveUsed = 30, weekUsed = 20, creditHours }) {
  return {
    planType,
    buckets: {
      codex: {
        primary: {
          usedPercent: fiveUsed,
          windowDurationMins: 300,
          resetsAt: NOW + 2 * 60 * 60,
        },
        secondary: {
          usedPercent: weekUsed,
          windowDurationMins: 10_080,
          resetsAt: NOW + 4 * 24 * 60 * 60,
        },
      },
    },
    resetCredits: {
      availableCount: creditHours == null ? 0 : 1,
      credits:
        creditHours == null
          ? []
          : [
              {
                status: "available",
                expiresAt: NOW + creditHours * 60 * 60,
              },
            ],
    },
  };
}

test("Plus warns when the five-hour window is nearly exhausted", () => {
  const result = planQuota(snapshot({ fiveUsed: 94 }), { now: NOW });
  assert.equal(result.state, "at_risk");
  assert.match(result.title, /5 小时/);
});

test("an expiring reset credit overrides a healthy state", () => {
  const result = planQuota(snapshot({ creditHours: 6 }), { now: NOW });
  assert.equal(result.state, "credit_expiring");
  assert.equal(result.priority, 100);
});

test("Pro focuses on weekly capacity and speed choices", () => {
  const result = planQuota(snapshot({ planType: "pro", fiveUsed: 99, weekUsed: 5 }), {
    now: NOW,
  });
  assert.equal(result.state, "healthy");
  assert.match(result.action, /速度档位/);
});
