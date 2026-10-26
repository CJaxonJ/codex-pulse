#!/usr/bin/env node
// Isolated protocol substitute. Never contacts OpenAI or reads real credentials.
import readline from "node:readline";
import { readFile, writeFile, rename } from "node:fs/promises";
const file = process.env.CODEX_PULSE_TEST_CREDIT_STATE;
if (!file) throw new Error("test credit state is required");
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id == null) continue;
  const state = JSON.parse(await readFile(file, "utf8"));
  let result = {};
  if (method === "account/read") result = { account: { type: "chatgpt", email: "protocol@example.test", planType: "plus" } };
  if (method === "account/rateLimits/read") result = state.raw;
  if (method === "account/rateLimitResetCredit/consume") {
    state.calls.push(params);
    if (state.usedKeys.includes(params.idempotencyKey)) result = { outcome: "alreadyRedeemed" };
    else {
      state.usedKeys.push(params.idempotencyKey);
      state.consumed += 1;
      state.raw.rateLimitsByLimitId.codex.primary.usedPercent = 0;
      state.raw.rateLimitsByLimitId.codex.secondary.usedPercent = 0;
      state.raw.rateLimitResetCredits = { availableCount: 0, credits: [] };
      result = { outcome: "reset" };
    }
    const drop = state.dropReply;
    state.dropReply = false;
    await writeFile(`${file}.${process.pid}.tmp`, JSON.stringify(state));
    await rename(`${file}.${process.pid}.tmp`, file);
    if (drop) continue; // server consumed successfully, reply lost
  }
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
