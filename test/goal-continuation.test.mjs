import assert from "node:assert/strict";
import test from "node:test";

import {
  buildContinuationGoal,
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
