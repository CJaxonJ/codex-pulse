import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContinuationGoal,
  buildRecoveryGoal,
  parseQuotaHandoff,
} from "../src/goal-continuation.mjs";

test("parses the required quota handoff sections", () => {
  const handoff = parseQuotaHandoff(`
**Completed**: implemented pause support
and preserved current edits
Verification: unit tests pass
Remaining: add recovery coverage
Next action: write the recovery test
Blockers: none
`);

  assert.deepEqual(handoff, {
    completed: "implemented pause support\nand preserved current edits",
    verification: "unit tests pass",
    remaining: "add recovery coverage",
    nextAction: "write the recovery test",
    blockers: "none",
  });
});

test("continuation Goal preserves the original objective verbatim and adds current work", () => {
  const original = "完成发布前终审；不要扩大范围，也不要自动消耗重置卡。";
  const goal = buildContinuationGoal({
    originalObjective: original,
    checkpointSummary: [
      "Completed: pause flow implemented",
      "Verification: hook tests pass",
      "Remaining: prove resume exactly once",
      "Next action: run the recovery test",
      "Blockers: none",
    ].join("\n"),
  });

  assert.equal(goal.originalObjective, original);
  assert.match(goal.objective, new RegExp(original));
  assert.match(goal.objective, /prove resume exactly once/);
  assert.match(goal.objective, /run the recovery test/);
  assert.match(goal.objective, /original user-approved goal remains the source of truth/);
});

test("does not invent a continuation Goal without a user-approved original Goal", () => {
  assert.equal(
    buildContinuationGoal({ originalObjective: "", checkpointSummary: "Remaining: work" }),
    null,
  );
});

test("recovery Goal uses thread context and checkpoint without storing a prompt", () => {
  const goal = buildRecoveryGoal({
    checkpointSummary: [
      "Completed: implemented phase one",
      "Verification: unit tests pass",
      "Remaining: finish recovery",
      "Next action: run the offline restart test",
      "Blockers: network unavailable",
    ].join("\n"),
  });

  assert.match(goal.objective, /existing thread context as the source of truth/);
  assert.match(goal.objective, /finish recovery/);
  assert.match(goal.objective, /run the offline restart test/);
  assert.equal(Object.hasOwn(goal, "originalObjective"), false);
});
