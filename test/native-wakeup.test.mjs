import test from "node:test";
import assert from "node:assert/strict";
import { recoveryWakeId, recoveryWakeMessage, trustedRecoveryHooks, queueNativeWakeup } from "../src/native-wakeup.mjs";

test("retries use the same pause-cycle wake key and a new pause gets a different key", () => {
  assert.equal(recoveryWakeId("thread", "turn"), recoveryWakeId("thread", "turn"));
  assert.notEqual(recoveryWakeId("thread", "turn"), recoveryWakeId("thread", "next-turn"));
  assert.match(recoveryWakeMessage({ sessionId: "thread", turnId: "turn", initialGoal: { objective: "Original scope" } }), /Original scope/);
});

test("official queue receives arguments directly without a shell or a second writer", async () => {
  const calls = [];
  const record = { sessionId: "thread", turnId: "turn", cwd: "/tmp/test-workspace",
    initialGoal: { objective: "Keep literal $(do-not-run) and `text`" } };
  await queueNativeWakeup("codex", record, async (...args) => calls.push(args));
  assert.deepEqual(calls[0][1].slice(0, 4), ["queue", "--thread", "thread", "--message"]);
  assert.match(calls[0][1][4], /\$\(do-not-run\)/);
  assert.equal(calls[0][2].cwd, record.cwd);
  assert.equal(calls[0][2].shell, undefined);
});

test("both recovery hooks must be enabled and currently trusted", () => {
  const hooks = ["preToolUse", "userPromptSubmit"].map(eventName => ({ eventName,
    enabled: true, trustStatus: "trusted", pluginId: "codex-pulse@codex-pulse-local" }));
  assert.equal(trustedRecoveryHooks({ data: [{ hooks }] }), true);
  assert.equal(trustedRecoveryHooks({ data: [{ hooks: [hooks[0]] }] }), false);
  assert.equal(trustedRecoveryHooks({ data: [{ hooks: hooks.map(h => ({ ...h, trustStatus: "modified" })) }] }), false);
  assert.equal(trustedRecoveryHooks({ data: [{ hooks, errors: [{ message: "cannot load" }] }] }), false);
});
