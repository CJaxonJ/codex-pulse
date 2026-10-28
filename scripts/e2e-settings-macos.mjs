import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const scenario of [
  { appearance: "light", state: "fresh" },
  { appearance: "dark", state: "fresh" },
  { appearance: "light", state: "low" },
  { appearance: "light", state: "missing", compact: true },
  { appearance: "dark", state: "stale", compact: true },
]) {
  const { appearance } = scenario;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `pulse-settings-${appearance}-${scenario.state}-`));
  const now = Math.floor(Date.now() / 1000);
  const consent = { enabled: true, accountBinding: "e".repeat(64), consentedAt: now };
  await writeFile(path.join(dataDir, "preferences.json"), JSON.stringify({ quotaPolicy: "strict_reserve", autoRedeem: consent }));
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(scenario.state === "missing" ? {} : {
    quotaCheckedAt: scenario.state === "stale" ? now - 3600 : now,
    lastSummary: { fiveHour: { remainingPercent: scenario.state === "low" ? 10 : 76, resetsAt: now + 3600 }, weekly: { remainingPercent: 96 } } }));
  await writeFile(path.join(dataDir, "user-events.json"), JSON.stringify({ events: scenario.state === "missing" ? [] : [
    { id: "legacy", type: "tibo_preview", title: "旧版预告", body: "旧版没有原帖链接", sourceAt: Date.parse("2026-10-27T08:00:00Z") / 1000 },
    { id: "public-first", type: "tibo_preview", title: "Tibo 重置预告｜北京时间 10月28日 15:00 或 16:00 前",
      body: "这是预告，不代表个人额度已到账。原帖时区表述有歧义，两种截止时间解释也可能提前。",
      sourceText: "Lands by midnight PST.", sourceAt: Date.parse("2026-10-28T02:43:38Z") / 1000,
      sourceUrl: "https://x.com/thsottiaux/status/2115273253711409208", parentUrl: "https://x.com/i/status/2115273064481218829" },
    { id: "newer", type: "tibo_confirmed", title: "公共重置确认", sourceText: "Done and dusted", sourceUrl: "https://x.com/i/status/456", sourceAt: Date.parse("2026-10-28T07:00:00Z") / 1000 },
    { id: "quota", type: "reset", title: "Codex 5 小时额度已恢复" },
  ] }));
  // A saved continuity record must remain byte-identical after changing settings.
  await mkdir(path.join(dataDir, "chat-continuity"));
  const checkpoint = JSON.stringify({ sessionId: "unchanged", status: "paused_quota", resumeCount: 0 });
  await writeFile(path.join(dataDir, "chat-continuity/test.json"), checkpoint);
  const { stdout } = await promisify(execFile)(path.join(root, "build/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier"), ["--settings-self-test"], {
    timeout: 20_000, env: { ...process.env, CODEX_PULSE_DATA_DIR: dataDir,
      CODEX_PULSE_TEST_NODE: process.execPath, CODEX_PULSE_TEST_CLI: path.join(root, "bin/codex-pulse.mjs"),
      CODEX_PULSE_TEST_CAPTURE_DIR: dataDir, CODEX_PULSE_TEST_APPEARANCE: appearance,
      CODEX_PULSE_TEST_COMPACT: scenario.compact ? "1" : "0",
      CODEX_PULSE_TEST_TIBO_EMPTY: scenario.state === "missing" ? "1" : "0",
      CODEX_BINARY: "/must-not-invoke-codex-in-settings-tests" },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true, `Native settings test failed; evidence: ${dataDir}; result: ${stdout.trim()}`);
  assert.equal(result.regularSavePreservedConsent, true);
  assert.equal(result.explicitDisableWorked, true);
  assert.equal(result.layoutFits, true);
  assert.equal(result.quotaBarsMatchData, true);
  assert.equal(result.freshnessAndSeverityMatch, true);
  assert.equal(result.alignmentVerified, true);
  assert.equal(result.tiboHistoryVerified, true);
  const preferences = JSON.parse(await readFile(path.join(dataDir, "preferences.json"), "utf8"));
  assert.equal(preferences.lowQuotaPercent, 35);
  assert.equal(preferences.soundEnabled, false);
  assert.deepEqual(preferences.autoRedeem, { enabled: false }); // explicit separate native switch action
  assert.equal(await readFile(path.join(dataDir, "chat-continuity/test.json"), "utf8"), checkpoint);
  console.log(JSON.stringify({ ok: true, ...scenario, alignmentVerified: true, tiboHistoryVerified: true, nativeControlsPersisted: true, checkpointUnchanged: true,
    realCreditsConsumed: 0, screenshot: path.join(dataDir, "settings.png") }));
}
