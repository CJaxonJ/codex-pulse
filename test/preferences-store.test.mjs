import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PulsePreferencesStore, userSettings, validateSettingsPatch } from "../src/preferences-store.mjs";

test("visual settings validate user fields without exposing or modifying account consent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pulse-visual-settings-"));
  const store = new PulsePreferencesStore(dir);
  assert.deepEqual(userSettings(await store.get()), { quotaPolicy: "strict_reserve", quotaAlertsEnabled: true,
    lowQuotaPercent: 20, tiboEnabled: true, creditAlertsEnabled: true, persistentAlertsEnabled: true, soundEnabled: true });
  await store.set({ autoRedeem: { enabled: true, accountBinding: "b".repeat(64), consentedAt: 100 } });
  await store.setUserSettings({ lowQuotaPercent: 35, tiboEnabled: false, soundEnabled: false });
  const saved = await store.get();
  assert.equal(saved.autoRedeem.enabled, true);
  assert.equal(saved.tiboSource, "disabled");
  assert.equal(userSettings(saved).lowQuotaPercent, 35);
  assert.doesNotMatch(JSON.stringify(userSettings(saved)), /accountBinding|bbbbbbbb|consentedAt/);
  // POSIX mode bits do not represent Windows ACLs. Windows root ACLs must be
  // verified by the native installer acceptance, not by asserting fake 0600.
  if(process.platform!=="win32") assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  const before = await readFile(store.filePath, "utf8");
  for (const patch of [{ lowQuotaPercent: 10 }, { lowQuotaPercent: 81 }, { lowQuotaPercent: 25.5 },
    { quotaAlertsEnabled: "false" }, { autoRedeem: { enabled: true } }, { resumeFloor: 10 }, { quotaPolicy: "unknown" }]) {
    await assert.rejects(store.setUserSettings(patch));
    assert.equal(await readFile(store.filePath, "utf8"), before);
  }
  for (const invalid of [null, false, [], "wrong"]) assert.throws(() => validateSettingsPatch(invalid));
});

test("enabling public monitoring preserves an existing advanced source", async () => {
  const store = new PulsePreferencesStore(await mkdtemp(path.join(os.tmpdir(), "pulse-source-settings-")));
  await store.set({ tiboSource: "x-api" });
  assert.equal((await store.setUserSettings({ tiboEnabled: true })).tiboSource, "x-api");
  await store.setUserSettings({ tiboEnabled: false });
  assert.equal((await store.setUserSettings({ tiboEnabled: true })).tiboSource, "codex-reset");
});

test("parallel windows cannot lose a concurrent revocation of auto-redemption consent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pulse-settings-lock-"));
  const a = new PulsePreferencesStore(dir), b = new PulsePreferencesStore(dir);
  await a.set({ autoRedeem: { enabled: true, accountBinding: "b".repeat(64) } });
  await Promise.all([a.setUserSettings({ soundEnabled: false }), b.set({ autoRedeem: { enabled: false } }),
    a.setUserSettings({ lowQuotaPercent: 30 }), b.setUserSettings({ persistentAlertsEnabled: false })]);
  const result = await a.get();
  assert.equal(result.autoRedeem.enabled, false);
  assert.equal(result.soundEnabled, false);
  assert.equal(result.lowQuotaPercent, 30);
  assert.equal(result.persistentAlertsEnabled, false);
});

test("two CLI processes serialize settings merges without invoking Codex", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pulse-settings-cli-"));
  const run = (patch) => promisify(execFile)(process.execPath, [path.resolve("bin/codex-pulse.mjs"), "settings", "--update", JSON.stringify(patch)],
    { env: { ...process.env, CODEX_PULSE_DATA_DIR: dir, CODEX_BINARY: "/must-not-call-codex" } });
  await Promise.all([run({ soundEnabled: false }), run({ lowQuotaPercent: 40 })]);
  const preferences = await new PulsePreferencesStore(dir).get();
  assert.equal(preferences.soundEnabled, false); assert.equal(preferences.lowQuotaPercent, 40);
});

test("damaged optional settings fall back to safe defaults", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pulse-invalid-settings-"));
  const store = new PulsePreferencesStore(dir);
  await writeFile(store.filePath, JSON.stringify({ soundEnabled: "false", lowQuotaPercent: 2, quotaPolicy: "unknown", autoRedeem: { enabled: true } }));
  assert.equal((await store.get()).soundEnabled, true);
  assert.equal((await store.get()).lowQuotaPercent, 20);
  assert.equal((await store.get()).autoRedeem.enabled, false);
});

test("quota policy defaults to strict reserve and persists an explicit choice", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-preferences-"));
  const store = new PulsePreferencesStore(dataDir);
  assert.equal((await store.get()).quotaPolicy, "strict_reserve");
  assert.equal((await store.get()).tiboSource, "codex-reset");
  assert.equal((await store.set({ quotaPolicy: "deadline" })).quotaPolicy, "deadline");
  assert.equal((await store.get()).quotaPolicy, "deadline");
  await assert.rejects(store.set({ quotaPolicy: "invented" }), /must be one of/);
  assert.equal((await store.set({ tiboSource: "x-api" })).tiboSource, "x-api");
  await assert.rejects(store.set({ tiboSource: "invented" }), /must be one of/);
});
