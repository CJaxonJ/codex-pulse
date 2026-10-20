import assert from "node:assert/strict";
import test from "node:test";

import { adviseTaskStart } from "../src/usage-advisor.mjs";

const NOW = 2_000_000_000;

function summary({ remaining = 70, weekly = 80, resetMinutes = 180, credits = [] } = {}) {
  return {
    planType: "plus",
    fiveHour:
      remaining == null
        ? null
        : {
            remainingPercent: remaining,
            usedPercent: 100 - remaining,
            resetsAt: NOW + resetMinutes * 60,
          },
    weekly:
      weekly == null
        ? null
        : { remainingPercent: weekly, usedPercent: 100 - weekly, resetsAt: NOW + 4 * 86400 },
    resetCredits: { availableCount: credits.length, expiries: credits },
  };
}

test("starts a medium task when conservative headroom is available", () => {
  const advice = adviseTaskStart(
    { summary: summary({ remaining: 35 }), tasks: [], taskSize: "medium" },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_now");
  assert.equal(advice.recommendedStartFloor, 30);
  assert.equal(advice.confidence, "low");
});

test("waits for a nearby reset instead of spending the last headroom", () => {
  const advice = adviseTaskStart(
    {
      summary: summary({ remaining: 22, resetMinutes: 45 }),
      tasks: [],
      taskSize: "medium",
      priority: "normal",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "wait_for_reset");
});

test("learns a start floor from real same-size managed tasks", () => {
  const tasks = [
    {
      taskSize: "small",
      usageSegments: [
        { model: "gpt-6.1-sol", consumedPercent: 4 },
        { model: "gpt-6.1-sol", consumedPercent: 6 },
      ],
    },
  ];
  const advice = adviseTaskStart(
    {
      summary: summary({ remaining: 20 }),
      tasks,
      taskSize: "small",
      model: "gpt-6.1-sol",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_now");
  assert.equal(advice.estimatedCostPercent, 5);
  assert.equal(advice.recommendedStartFloor, 20);
  assert.equal(advice.confidence, "medium");
});

test("learns from ordinary Codex turns captured by trusted hooks", () => {
  const advice = adviseTaskStart(
    {
      summary: summary({ remaining: 24 }),
      tasks: [],
      observations: [
        {
          taskSize: "small",
          model: "gpt-6.1-sol",
          consumedPercent: 3,
        },
        {
          taskSize: "small",
          model: "gpt-6.1-sol",
          consumedPercent: 5,
        },
      ],
      taskSize: "small",
      model: "gpt-6.1-sol",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_now");
  assert.equal(advice.estimatedCostPercent, 4);
  assert.equal(advice.confidence, "medium");
});

test("treats the final weekly capacity as advisory for explicit work", () => {
  const advice = adviseTaskStart(
    {
      summary: summary({ remaining: 90, weekly: 8 }),
      tasks: [],
      taskSize: "small",
      priority: "normal",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_bounded");
  assert.match(advice.action, /不会阻止/);
});

test("Plus warns without pausing when weekly burn is far ahead of pace", () => {
  const advice = adviseTaskStart(
    {
      summary: summary({ remaining: 90, weekly: 40 }),
      tasks: [],
      taskSize: "small",
      priority: "normal",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_bounded");
  assert.equal(advice.weeklyPacing.status, "at_risk");
  assert.match(advice.action, /任务仍会继续/);
});

test("Pro receives a weekly pacing advisory without inventing a short-window stop", () => {
  const advice = adviseTaskStart(
    {
      summary: { ...summary({ remaining: null, weekly: 40 }), planType: "pro" },
      tasks: [],
      taskSize: "large",
      priority: "normal",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_bounded");
  assert.equal(advice.weeklyPacing.status, "at_risk");
});

test("suggests but never automatically consumes an expiring reset credit", () => {
  const advice = adviseTaskStart(
    {
      summary: summary({ remaining: 10, resetMinutes: 180, credits: [NOW + 3600] }),
      tasks: [],
      taskSize: "large",
      priority: "high",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "consider_reset");
  assert.match(advice.action, /手动确认/);
});

test("Pro without a five-hour window can start when weekly capacity is healthy", () => {
  const advice = adviseTaskStart(
    {
      summary: { ...summary({ remaining: null, weekly: 70 }), planType: "pro" },
      tasks: [],
      taskSize: "large",
      priority: "normal",
    },
    { now: NOW },
  );
  assert.equal(advice.verdict, "start_now");
  assert.equal(advice.recommendedStartFloor, 0);
});
