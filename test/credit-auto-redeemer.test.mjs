import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, stat, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CreditAutoRedeemer, CreditOperationStore, personalAccountBinding, selectExpiringCredit, evaluateCreditAwareQuota } from "../src/credit-auto-redeemer.mjs";
import { PulsePreferencesStore } from "../src/preferences-store.mjs";
import { summarizeRateLimits } from "../src/quota-monitor-core.mjs";
import { ManagedTaskController } from "../src/managed-task-controller.mjs";
import { MemoryTaskStore } from "../src/managed-task-store.mjs";

test("a credit reset feeds safe single resume and never becomes a Tibo public reset", async () => {
  const f = await fixture();
  const low = summarizeRateLimits(quota(91));
  const initial = evaluateCreditAwareQuota({}, low, {}, { now: 999 });
  const result = await f.make().poll();
  const recovered = summarizeRateLimits(result.raw);
  const evaluated = evaluateCreditAwareQuota({ fiveHour: initial.state }, recovered, result, { now: 1000 });
  assert.equal(evaluated.events.some((e) => e.type === "reset"), false);
  const later = evaluateCreditAwareQuota({ fiveHour: initial.state, creditResetAttributionUntil: evaluated.attributionUntil }, recovered, { status: "disabled" }, { now: 1001 });
  assert.equal(later.events.some((e) => e.type === "reset"), false);
  const store = new MemoryTaskStore([{ id: "paused", status: "paused_quota", objective: "finish only this work", cwd: "/tmp/test-only",
    autoResume: true, resumeFloor: 50, pausedRemaining: 9, pausedWindowKey: 2000, threadId: "test-thread", turnId: "paused-turn",
    checkpoint: { workspaceFingerprint: "baseline" } }]);
  const calls = [];
  const client = { async request(method) {
    calls.push(method);
    if (method === "thread/turns/list") return { data: [{ id: "paused-turn", status: "completed" }] };
    if (method === "turn/start") return { turn: { id: "new-turn" } };
    return {};
  } };
  const controller = new ManagedTaskController({ client, store, workspace: { async exists() { return true; }, async fingerprint() { return "baseline"; } } });
  await controller.reconcile(recovered, { now: 1001 });
  await controller.reconcile(recovered, { now: 1002 });
  assert.equal(calls.filter((method) => method === "turn/start").length, 1);
  assert.equal((await store.list())[0].resumeCount, 1);
});

const account = { account: { type: "chatgpt", email: "personal@example.test", planType: "plus" } };
const binding = personalAccountBinding(account);
const credit = (id = "opaque-one", expiresAt = 1500) => ({ id, status: "available", resetType: "codexRateLimits", expiresAt });
function quota(used = 50, credits = [credit()]) { return {
  planType: "plus", rateLimitsByLimitId: { codex: { primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 2000 },
    secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: 9999 } } },
  rateLimitResetCredits: { availableCount: credits?.length ?? 1, credits },
}; }
async function fixture({ enabled = true } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-credit-"));
  const preferences = new PulsePreferencesStore(dataDir);
  if (enabled) await preferences.set({ autoRedeem: { enabled: true, accountBinding: binding } });
  let now = 1000, raw = quota();
  const calls = [], reads = [];
  let consume = async () => { raw = quota(0, []); return { outcome: "reset" }; };
  const client = {
    async request(method, params) {
      if (method === "account/read") return structuredClone(account);
      calls.push({ method, params: structuredClone(params) });
      return consume(params);
    },
    async readRateLimits() { reads.push(true); return structuredClone(raw); },
  };
  const make = () => new CreditAutoRedeemer({ client, preferences, dataDir, now: () => now });
  return { dataDir, preferences, calls, reads, client, make,
    setRaw: (v) => { raw = v; }, setNow: (v) => { now = v; }, setConsume: (v) => { consume = v; } };
}

test("selector enforces exact <600-second / known-expiry / Codex / used-quota boundaries", () => {
  assert.equal(selectExpiringCredit(quota(), 900), null); // exactly600
  assert.ok(selectExpiringCredit(quota(), 901));
  assert.equal(selectExpiringCredit(quota(), 1500), null);
  assert.equal(selectExpiringCredit(quota(0), 1000), null);
  assert.equal(selectExpiringCredit(quota(50, null), 1000), null);
  for (const invalid of [{ expiresAt: null }, { id: "" }, { resetType: "other" }, { status: "used" }]) {
    assert.equal(selectExpiringCredit(quota(50, [{ ...credit(), ...invalid }]), 1000), null);
  }
  assert.equal(selectExpiringCredit(quota(50, [credit("later", 1599), credit("earlier", 1100)]), 1000).id, "earlier");
  const pro = quota(); pro.planType = "pro"; pro.rateLimitsByLimitId.codex.primary = null;
  assert.ok(selectExpiringCredit(pro, 1000)); // weekly-only Pro is supported
  const unrelated = quota(); unrelated.rateLimitsByLimitId = { another: unrelated.rateLimitsByLimitId.codex };
  assert.equal(selectExpiringCredit(unrelated, 1000), null);
});

test("account binding is personal-only, normalized, and contains no email", () => {
  assert.match(binding, /^[a-f0-9]{64}$/);
  assert.equal(personalAccountBinding({ account: { ...account.account, email: " PERSONAL@EXAMPLE.TEST " } }), binding);
  assert.equal(personalAccountBinding({ account: { ...account.account, planType: "business" } }), null);
  assert.equal(personalAccountBinding({ account: { ...account.account, email: null } }), null);
});

test("default off does no account reads or consume; account switches and revoked consent fail closed", async () => {
  const f = await fixture({ enabled: false });
  f.client.request = () => { throw new Error("must not read account"); };
  assert.equal((await f.make().poll()).status, "disabled");
  assert.equal(f.reads.length, 0);
  await f.preferences.set({ autoRedeem: { enabled: true, accountBinding: "a".repeat(64) } });
  f.client.request = async () => account;
  assert.equal((await f.make().poll()).status, "account_mismatch");
  assert.equal(f.reads.length, 0);
});

test("same-instance and separate watchers cannot consume two cards; re-read full quota and survive restart", async () => {
  const f = await fixture();
  f.setRaw(quota(60, [credit("earlier", 1200), credit("later", 1300)]));
  const a = f.make(), b = f.make();
  const result = await Promise.all([a.poll(), a.poll(), b.poll()]);
  assert.ok(result.some((v) => v.status === "reset"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].params.creditId, "earlier");
  assert.equal((await f.make().poll()).status, "not_eligible");
  const metadata = path.join(f.dataDir, "credit-operations", `${binding}.json`);
  assert.equal((await stat(metadata)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(metadata))).mode & 0o777, 0o700);
  assert.doesNotMatch(await readFile(metadata, "utf8"), /personal@example|opaque-one|earlier/);
});

test("lost reply after actual consume retries exact key+card after process replacement, no second card", async () => {
  const f = await fixture(); let count = 0;
  f.setConsume(async () => {
    if (++count === 1) { f.setRaw(quota(0, [])); throw new Error("timeout containing opaque-one"); }
    return { outcome: "alreadyRedeemed" };
  });
  const first = await f.make().poll();
  assert.equal(first.status, "uncertain");
  assert.doesNotMatch(JSON.stringify(first.events), /opaque-one/);
  assert.equal((await f.make().poll()).status, "retry_backoff");
  f.setNow(1061);
  const retried = await f.make().poll();
  assert.equal(retried.status, "alreadyRedeemed");
  assert.deepEqual(f.calls[0].params, f.calls[1].params);
  assert.equal(summarizeRateLimits(retried.raw).fiveHour.remainingPercent, 100);
  assert.equal((await f.make().poll()).status, "not_eligible");
});

test("success followed by failed refresh waits for read only, without resending consume", async () => {
  const f = await fixture(); const read = f.client.readRateLimits;
  let n = 0;
  f.client.readRateLimits = async () => { if (++n === 2) throw new Error("offline"); return read(); };
  assert.equal((await f.make().poll()).status, "refresh_required");
  const result = await f.make().poll();
  assert.equal(result.status, "settled");
  assert.equal(f.calls.length, 1);
  assert.equal(result.events[0].type, "credit_auto_used");
});

test("explicit nothingToReset/noCredit never consume another card or hammer unchanged quota", async () => {
  for (const outcome of ["nothingToReset", "noCredit"]) {
    const f = await fixture();
    f.setConsume(async () => ({ outcome }));
    assert.equal((await f.make().poll()).status, outcome);
    assert.equal((await f.make().poll()).status, "previously_skipped");
    assert.equal(f.calls.length, 1);
  }
});

test("expired uncertain operations and corrupt journals never select another card", async () => {
  const f = await fixture();
  f.setConsume(async () => { throw new Error("offline"); });
  await f.make().poll();
  f.setNow(1600); f.setRaw(quota(50, [credit("new", 1700)]));
  assert.equal((await f.make().poll()).status, "uncertain");
  assert.equal(f.calls.length, 1);
  const store = new CreditOperationStore(f.dataDir);
  await writeFile(store.file(binding), "broken");
  assert.equal((await f.make().poll()).status, "journal_unavailable");
  assert.equal(f.calls.length, 1);
});

test("consent/account changing while limits read prevents consume", async () => {
  const f = await fixture();
  f.client.readRateLimits = async () => {
    await f.preferences.set({ autoRedeem: { enabled: false } });
    return quota();
  };
  assert.equal((await f.make().poll()).status, "authorization_changed");
  assert.equal(f.calls.length, 0);
});

test("stale post-reset card details cannot replay a completed card under a new key", async () => {
  const f = await fixture(); f.setConsume(async () => ({ outcome: "reset" }));
  f.setRaw(quota(50, [credit("first", 1400), credit("second", 1500)]));
  await f.make().poll();
  assert.equal((await f.make().poll()).status, "refresh_required");
  assert.equal(f.calls.length, 1);
  f.setRaw(quota(0, [credit("second", 1500)]));
  assert.equal((await f.make().poll()).status, "settled");
  assert.equal(f.calls.length, 1);
});
