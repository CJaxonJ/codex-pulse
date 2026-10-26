import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, open, rename, chmod } from "node:fs/promises";
import path from "node:path";
import { WorktreeLockManager } from "./worktree-lock-manager.mjs";
import { evaluateFiveHourSample } from "./quota-monitor-core.mjs";

export function evaluateCreditAwareQuota(state, summary, redemption, { now, config }) {
  const evaluated = evaluateFiveHourSample(state.fiveHour, summary, { now, config });
  const possible = ["reset", "alreadyRedeemed", "settled", "uncertain", "refresh_required", "retry_backoff"].includes(redemption.status);
  const attributionUntil = possible ? now + 600 : state.creditResetAttributionUntil;
  if (attributionUntil > now) {
    evaluated.events = evaluated.events.filter((event) => event.type !== "reset");
    // A previous process may have published a raw 100% observation just before
    // crashing. Do not preserve that provisional reset as later Tibo evidence.
    evaluated.state.lastDetectedReset = null;
  }
  return { ...evaluated, attributionUntil };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }

export function personalAccountBinding(result) {
  const account = result?.account;
  // The public account/read response exposes no workspace id. Limit this first
  // version to personal subscriptions; never bind a business workspace by email.
  if (account?.type !== "chatgpt" || !["plus", "pro", "prolite", "promax"].includes(account.planType)
    || typeof account.email !== "string" || !account.email.trim().includes("@")) return null;
  return hash(`codex-pulse-personal-v1\0${account.email.trim().toLowerCase()}`);
}

function codexBucket(raw) {
  return raw?.rateLimitsByLimitId?.codex || (raw?.rateLimits?.limitId === "codex" ? raw.rateLimits : null);
}
function quotaFingerprint(raw) {
  const bucket = codexBucket(raw);
  return hash(JSON.stringify([bucket?.primary || null, bucket?.secondary || null]));
}
function usageWindows(raw) {
  const bucket = codexBucket(raw);
  return [bucket?.primary, bucket?.secondary].filter((w) => Number.isFinite(w?.usedPercent))
    .map(({ usedPercent, resetsAt, windowDurationMins }) => ({ usedPercent, resetsAt, windowDurationMins }));
}
function resetObserved(raw, before = []) {
  const after = usageWindows(raw);
  return after.length > 0 && (after.every((w) => w.usedPercent === 0)
    || before.some((old) => old.usedPercent > 0 && after.some((w) => w.windowDurationMins === old.windowDurationMins
      && w.usedPercent < old.usedPercent)));
}
export function selectExpiringCredit(raw, now, excluded = []) {
  const details = raw?.rateLimitResetCredits;
  if (!(details?.availableCount > 0) || !Array.isArray(details.credits)) return null;
  const bucket = codexBucket(raw);
  const used = [bucket?.primary, bucket?.secondary].filter(Boolean)
    .some((w) => Number.isFinite(w.usedPercent) && w.usedPercent > 0);
  if (!used) return null;
  return details.credits.filter((c) => c.status === "available" && c.resetType === "codexRateLimits"
    && typeof c.id === "string" && c.id.trim() && Number.isFinite(c.expiresAt)
    && c.expiresAt > now && c.expiresAt - now < 600 && !excluded.includes(hash(c.id)))
    .sort((a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id))[0] || null;
}

export class CreditOperationStore {
  constructor(dataDir) { this.root = path.join(dataDir, "credit-operations"); }
  file(binding) {
    if (!/^[a-f0-9]{64}$/.test(binding)) throw new Error("invalid account binding");
    return path.join(this.root, `${binding}.json`);
  }
  async get(binding) {
    try {
      const value = JSON.parse(await readFile(this.file(binding), "utf8"));
      if (value.version !== 1 || !Array.isArray(value.closed) || !Array.isArray(value.attempts)) throw new Error("invalid journal");
      if (value.pending && (typeof value.pending.creditId !== "string" || !value.pending.creditId.trim()
        || typeof value.pending.idempotencyKey !== "string" || !value.pending.idempotencyKey.trim()
        || !Number.isFinite(value.pending.expiresAt) || !Number.isInteger(value.pending.attempts)
        || !["prepared", "sent", "refresh_required"].includes(value.pending.phase))) throw new Error("invalid pending identity");
      return value;
    } catch (error) {
      if (error.code === "ENOENT") return { version: 1, pending: null, closed: [], attempts: [] };
      // Corruption is not an empty history. Creating a new identity here could
      // double-consume after an uncertain previous request.
      throw new Error("兑换记录不可读取，已停止自动用卡；请检查本机数据");
    }
  }
  async put(binding, value) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const file = this.file(binding), temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, file);
    const directory = await open(this.root, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export class CreditAutoRedeemer {
  constructor({ client, preferences, dataDir, store = new CreditOperationStore(dataDir),
    lockManager = new WorktreeLockManager(path.join(dataDir, "credit-operations")),
    now = () => Math.floor(Date.now() / 1000) }) {
    Object.assign(this, { client, preferences, dataDir, store, lockManager, now });
    this.inFlight = null;
  }
  poll() {
    // WorktreeLockManager permits same-holder reentry; prevent that reentry for
    // concurrent server-event/timer calls in this instance as well.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().then((result) => {
      const now = this.now();
      result.events = result.events.filter((event) => {
        if (!["credit_auto_failed", "credit_auto_uncertain"].includes(event.type)) return true;
        const key = `${event.type}:${event.reason || "unknown"}`;
        this.lastWarnings ||= new Map();
        if (now - (this.lastWarnings.get(key) ?? -Infinity) < 900) return false;
        this.lastWarnings.set(key, now);
        return true;
      });
      return result;
    }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async run() {
    const policy = (await this.preferences.get()).autoRedeem;
    if (policy?.enabled !== true) return { status: "disabled", events: [] };
    let binding;
    try { binding = personalAccountBinding(await this.client.request("account/read", { refreshToken: false })); }
    catch { return { status: "account_unavailable", events: [] }; }
    if (!binding || binding !== policy.accountBinding) return { status: "account_mismatch", events: [] };
    const lock = await this.lockManager.acquire(path.join(this.dataDir, "credit-account", binding), "credit-redemption");
    if (!lock.acquired) return { status: "busy", events: [] };
    try { return await this.redeem(binding); }
    finally { await this.lockManager.release(lock.handle); }
  }
  async redeem(binding) {
    const now = this.now(), events = [];
    let journal;
    try { journal = await this.store.get(binding); }
    catch { return { status: "journal_unavailable", events: [{ type: "credit_auto_failed", reason: "journal_unavailable" }] }; }
    let raw;
    try { raw = await this.client.readRateLimits(); }
    catch { return { status: "offline", events }; }
    // A confirmed consume whose post-read failed must settle before another card.
    if (journal.pending?.phase === "refresh_required") {
      if (!resetObserved(raw, journal.pending.beforeWindows)) return { status: "refresh_required", raw,
        events: [{ type: "credit_auto_uncertain", reason: "refresh_required" }] };
      journal.closed.push(hash(journal.pending.creditId));
      journal.attempts = [...journal.attempts, { at: now, outcome: journal.pending.outcome }].slice(-50);
      journal.pending = null;
      await this.store.put(binding, journal);
      return { status: "settled", raw, events: [{ type: "credit_auto_used" }] };
    }
    if (!journal.pending) {
      const credit = selectExpiringCredit(raw, now, journal.closed);
      if (!credit) return { status: "not_eligible", raw, events };
      const fingerprint = quotaFingerprint(raw);
      if (journal.lastSkipped?.creditHash === hash(credit.id) && journal.lastSkipped.quota === fingerprint) {
        return { status: "previously_skipped", raw, events };
      }
      journal.pending = { creditId: credit.id, expiresAt: credit.expiresAt, idempotencyKey: randomUUID(),
        phase: "prepared", createdAt: now, attempts: 0, quota: fingerprint, beforeWindows: usageWindows(raw) };
      await this.store.put(binding, journal); // persist identity BEFORE sending
    }
    const pending = journal.pending;
    if (pending.nextRetryAt > now) return { status: "retry_backoff", raw, events };
    if (pending.expiresAt <= now || pending.attempts >= 5) {
      if (!pending.alerted) {
        pending.alerted = true;
        await this.store.put(binding, journal);
        events.push({ type: "credit_auto_uncertain" });
      }
      return { status: "uncertain", raw, events }; // never choose another credit
    }
    // Account and consent are rechecked after reads/lock waits. Explicit creditId
    // also prevents the service selecting a card from a newly switched account.
    const freshPolicy = (await this.preferences.get()).autoRedeem;
    let current;
    try { current = personalAccountBinding(await this.client.request("account/read", { refreshToken: false })); }
    catch { return { status: "account_unavailable", raw, events }; }
    if (current !== binding || freshPolicy?.enabled !== true || freshPolicy.accountBinding !== binding) {
      return { status: "authorization_changed", raw, events };
    }
    pending.attempts += 1;
    pending.phase = "sent";
    pending.nextRetryAt = now + 60;
    await this.store.put(binding, journal);
    let outcome;
    try {
      ({ outcome } = await this.client.request("account/rateLimitResetCredit/consume", {
        creditId: pending.creditId, idempotencyKey: pending.idempotencyKey,
      }));
    } catch {
      // Even a transport error may be a successful consume with a lost reply.
      // Do not log the server's raw message (it can contain an opaque card id).
      if (!pending.alerted) { pending.alerted = true; events.push({ type: "credit_auto_uncertain" }); }
      await this.store.put(binding, journal);
      return { status: "uncertain", raw, events };
    }
    if (["reset", "alreadyRedeemed"].includes(outcome)) {
      pending.phase = "refresh_required";
      pending.outcome = outcome;
      await this.store.put(binding, journal);
      try { raw = await this.client.readRateLimits(); }
      catch { return { status: "refresh_required", events: [{ type: "credit_auto_uncertain", reason: "refresh_required" }] }; }
      if (!resetObserved(raw, pending.beforeWindows)) return { status: "refresh_required", raw,
        events: [{ type: "credit_auto_uncertain", reason: "refresh_required" }] };
      journal.closed.push(hash(pending.creditId));
      events.push({ type: "credit_auto_used" });
    } else if (["nothingToReset", "noCredit"].includes(outcome)) {
      journal.lastSkipped = { creditHash: hash(pending.creditId), quota: pending.quota, outcome };
      // Explicit non-consumption is safe to close, but never try another in the
      // same poll. A subsequent poll must re-read all eligibility conditions.
      try { raw = await this.client.readRateLimits(); } catch { raw = null; }
      events.push({ type: "credit_auto_skipped", reason: outcome });
    } else {
      if (!pending.alerted) { pending.alerted = true; events.push({ type: "credit_auto_uncertain" }); }
      await this.store.put(binding, journal);
      return { status: "uncertain", raw, events };
    }
    journal.attempts = [...journal.attempts, { at: now, outcome }].slice(-50);
    journal.pending = null;
    // Preserve redeemed card hashes until their server expiry to tolerate stale
    // reads. These tiny hashes are not copied to public diagnostics.
    await this.store.put(binding, journal);
    return { status: outcome, raw, events };
  }
}
