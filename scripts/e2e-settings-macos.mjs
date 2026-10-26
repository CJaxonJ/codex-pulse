import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const appearance of ["light", "dark"]) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `pulse-settings-${appearance}-`));
  const now = Math.floor(Date.now() / 1000);
  const consent = { enabled: true, accountBinding: "e".repeat(64), consentedAt: now };
  await writeFile(path.join(dataDir, "preferences.json"), JSON.stringify({ quotaPolicy: "strict_reserve", autoRedeem: consent }));
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ quotaCheckedAt: now,
    lastSummary: { fiveHour: { remainingPercent: 76, resetsAt: now + 3600 }, weekly: { remainingPercent: 96 } } }));
  // A saved continuity record must remain byte-identical after changing settings.
  await mkdir(path.join(dataDir, "chat-continuity"));
  const checkpoint = JSON.stringify({ sessionId: "unchanged", status: "paused_quota", resumeCount: 0 });
  await writeFile(path.join(dataDir, "chat-continuity/test.json"), checkpoint);
  const { stdout } = await promisify(execFile)(path.join(root, "build/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier"), ["--settings-self-test"], {
    timeout: 20_000, env: { ...process.env, CODEX_PULSE_DATA_DIR: dataDir,
      CODEX_PULSE_TEST_NODE: process.execPath, CODEX_PULSE_TEST_CLI: path.join(root, "bin/codex-pulse.mjs"),
      CODEX_PULSE_TEST_CAPTURE_DIR: dataDir, CODEX_PULSE_TEST_APPEARANCE: appearance,
      CODEX_BINARY: "/must-not-invoke-codex-in-settings-tests" },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, true, `Native settings test failed; evidence: ${dataDir}; result: ${stdout.trim()}`);
  assert.equal(result.regularSavePreservedConsent, true);
  assert.equal(result.explicitDisableWorked, true);
  const preferences = JSON.parse(await readFile(path.join(dataDir, "preferences.json"), "utf8"));
  assert.equal(preferences.lowQuotaPercent, 35);
  assert.equal(preferences.soundEnabled, false);
  assert.deepEqual(preferences.autoRedeem, { enabled: false }); // explicit separate native switch action
  assert.equal(await readFile(path.join(dataDir, "chat-continuity/test.json"), "utf8"), checkpoint);
  console.log(JSON.stringify({ ok: true, appearance, nativeControlsPersisted: true, checkpointUnchanged: true,
    realCreditsConsumed: 0, screenshot: path.join(dataDir, "settings.png") }));
}
