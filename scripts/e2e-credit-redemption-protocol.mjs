import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { personalAccountBinding } from "../src/credit-auto-redeemer.mjs";
import { PulsePreferencesStore } from "../src/preferences-store.mjs";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-credit-protocol-"));
const fixture = path.join(dataDir, "protocol-state.json");
const binary = path.join(root, "scripts/test-support/credit-rpc-peer.mjs");
await chmod(binary, 0o755);
await new PulsePreferencesStore(dataDir).set({ autoRedeem: { enabled: true, accountBinding:
  personalAccountBinding({ account: { type: "chatgpt", email: "protocol@example.test", planType: "plus" } }) } });
await writeFile(fixture, JSON.stringify({ consumed: 0, calls: [], usedKeys: [], dropReply: true, raw: {
  rateLimitsByLimitId: { codex: { primary: { usedPercent: 91, windowDurationMins: 300, resetsAt: 2000 },
    secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 9000 } } },
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: "protocol-test-credit", resetType: "codexRateLimits", status: "available", expiresAt: 1500 }] },
} }));
async function worker(now) {
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, "scripts/test-support/credit-worker.mjs"), dataDir, String(now)], {
    timeout: 10_000, env: { ...process.env, CODEX_PULSE_TEST_CREDIT_STATE: fixture, CODEX_PULSE_TEST_CREDIT_BINARY: binary },
  });
  return JSON.parse(stdout.trim());
}
const first = await worker(1000);
assert.equal(first.status, "uncertain");
const second = await worker(1061); // independent OS process and independent STDIO server
assert.equal(second.status, "alreadyRedeemed");
const concurrent = await Promise.all([worker(1062), worker(1062)]);
assert.ok(concurrent.every((r) => ["not_eligible", "busy"].includes(r.status)));
const result = JSON.parse(await readFile(fixture, "utf8"));
assert.equal(result.consumed, 1);
assert.equal(result.calls.length, 2);
assert.deepEqual(result.calls[0], result.calls[1]);
console.log(JSON.stringify({ ok: true, mode: "isolated_stdio_protocol_not_live_redemption", independentProcesses: 4,
  lostReply: true, identicalRetryIdentity: true, fixtureCreditsConsumed: 1, realCreditsConsumed: 0 }));
