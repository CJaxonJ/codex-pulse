import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { xPostUrl, tiboPostSource } from "../src/tibo-post-source.mjs";
import { UserEventJournal } from "../src/user-event-journal.mjs";
import { normalizeTiboSnapshot, evaluateTiboSnapshot } from "../src/tibo-monitor-core.mjs";
import { notificationForEvent, nativeNotificationArgs } from "../src/macos-notifier.mjs";
import { TiboResetClient } from "../src/tibo-client.mjs";

const source = "https://x.com/thsottiaux/status/2115273253711409208";
const parent = "https://x.com/i/status/2115273064481218829";
const now = Date.parse("2026-10-28T03:00:00Z") / 1000;
function raw() {
  return { source: "codex-reset", forecast: { official_signal: {
    tweet_id: "2115273253711409208", summary: "Public reset soon", at: "2026-10-28T02:43:38Z", url: source,
  } }, feed: { fetched_at: "2026-10-28T03:00:00Z", tweets: [{ id: "2115273253711409208", kind: "signal",
    text: "Lands by midnight PST.", at: "2026-10-28T02:43:38Z", is_reply: true, in_reply_to_tweet_id: "2115273064481218829" }] } };
}

test("only safe exact X post URLs are accepted and tracking parameters are removed", () => {
  assert.equal(xPostUrl(`${source}?s=20#fragment`), source);
  assert.equal(xPostUrl("https://twitter.com/i/web/status/123"), "https://x.com/i/web/status/123");
  for (const url of ["javascript:alert(1)", "file:///tmp/payload", "http://x.com/a/status/123", "https://x.com.evil.org/a/status/123",
    "https://user:secret@x.com/a/status/123", "https://x.com:8443/a/status/123", "https://x.com/thsottiaux",
    "https://x.com/a/status/not-id", "https://x.com/a/status/123/extra", "https://x.com/%61/status/123"]) assert.equal(xPostUrl(url), null);
});

test("aggregator reply flows through normalization, notice, durable journal and native launch arguments", async () => {
  const baseline = evaluateTiboSnapshot(null, normalizeTiboSnapshot({ forecast: {}, feed: {} }, { now: now - 3600 }));
  const normalized = normalizeTiboSnapshot(raw(), { now });
  const event = evaluateTiboSnapshot(baseline.state, normalized).events[0];
  const notice = notificationForEvent(event);
  assert.equal(notice.sourceUrl, source);
  assert.equal(notice.parentUrl, parent);
  assert.equal(notice.sourceText, "Lands by midnight PST.");
  assert.equal(notice.sourceTextKind, "original");
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-source-test-"));
  const journal = new UserEventJournal(directory);
  const entry = await journal.append({ type: event.type, ...notice, occurredAt: now });
  await journal.updateDeliveryStatus(entry.id, "muted_by_preferences");
  const saved = (await new UserEventJournal(directory).list())[0];
  assert.equal(saved.sourceUrl, source);
  assert.equal(saved.parentUrl, parent);
  assert.equal(saved.sourceAt, Date.parse("2026-10-28T02:43:38Z") / 1000);
  const args = nativeNotificationArgs({ ...notice, nativeApp: "/Applications/Codex Pulse.app", eventId: saved.id });
  assert.equal(args[args.indexOf("--source-url") + 1], source);
  assert.equal(args[args.indexOf("--event-id") + 1], saved.id);
  assert.ok(args.includes("--tibo-post"));
});

test("direct X reply retains its parent even when forecast wins candidate selection", async () => {
  const client = new TiboResetClient({ source: "x-api", tokenProvider: async () => "fake-test-token", fetchImpl: async (input) => {
    const body = String(input).includes("/by/username/") ? { data: { id: "42", username: "thsottiaux" } }
      : { data: [{ id: "2115273253711409208", text: "Landing within the next 2 hours", created_at: "2026-10-28T02:43:38Z",
        referenced_posts: [{ id: "2115273064481218829", type: "replied_to" }] }],
      includes: { posts: [{ id: "2115273064481218829", text: "Today is a Codex reset" }] } };
    return new Response(JSON.stringify(body));
  } });
  const normalized = normalizeTiboSnapshot(await client.readSnapshot(), { now });
  assert.equal(normalized.preview.parentUrl, parent);
  assert.equal(tiboPostSource({ type: "tibo_preview", ...normalized.preview }).sourceUrl, source);
});

test("confirmed post references survive partial forecast failures and personal correlation event types", () => {
  const value = raw();
  value.forecast = { last_reset_at: "2026-10-28T02:43:38Z", latest_alert: { id: "public-confirmed", summary: "Public reset confirmed" } };
  value.feed.tweets[0].kind = "reset";
  value.feed.tweets[0].reset_verification_status = "confirmed";
  const confirmed = normalizeTiboSnapshot(value, { now }).confirmed;
  for (const type of ["tibo_confirmed", "public_reset_landed"]) {
    assert.equal(tiboPostSource({ type, ...confirmed }).sourceUrl, "https://x.com/i/status/2115273253711409208");
    assert.equal(tiboPostSource({ type, ...confirmed }).parentUrl, parent);
  }
});

test("missing links are honest, invalid IDs cannot fabricate one, and summaries are not labeled original", () => {
  const event = { type: "tibo_preview", id: "official:unknown", text: "Reset soon", sourceTextKind: "summary" };
  assert.equal(tiboPostSource(event).sourceUrl, null);
  assert.equal(tiboPostSource(event).sourceTextKind, "summary");
  const args = nativeNotificationArgs({ nativeApp: "/Applications/Codex Pulse.app", ...tiboPostSource(event) });
  assert.equal(args.includes("--source-url"), false);
  assert.equal(tiboPostSource({ ...event, id: "123" }).sourceUrl, "https://x.com/i/status/123");
  assert.equal(tiboPostSource({ ...event, sourceAt: null, occurredAt: now }).sourceAt, null);
});

test("quota events never gain public-source fields or persist prompt text", async () => {
  const event = { type: "threshold", text: "private task prompt", url: source, sourceText: "private task prompt" };
  assert.deepEqual(tiboPostSource(event), {});
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-private-test-"));
  const journal = new UserEventJournal(directory);
  const saved = await journal.append(event);
  assert.equal(saved.sourceText, undefined);
  assert.equal(saved.sourceUrl, undefined);
});

test("last ten public notices survive quota chatter with bounded storage and stable ordering", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse-history-test-"));
  const journal = new UserEventJournal(directory, { limit: 3 });
  for (let index = 0; index < 14; index++) await journal.append({ id: `post-${index}`, type: "tibo_preview", sourceUrl: source });
  for (let index = 0; index < 20; index++) await journal.append({ id: `quota-${index}`, type: "threshold" });
  const entries = await new UserEventJournal(directory).list();
  assert.equal(entries.length, 13);
  assert.deepEqual(entries.slice(0, 10).map((entry) => entry.id), Array.from({ length: 10 }, (_, index) => `post-${index + 4}`));
  assert.equal((await journal.latest()).id, "quota-19");
});
