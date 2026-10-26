import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { WorktreeLockManager } from "./worktree-lock-manager.mjs";

export const QUOTA_POLICIES = ["finish_current", "strict_reserve", "deadline"];
export const TIBO_SOURCES = ["disabled", "auto", "x-api", "codex-reset"];

export const USER_SETTING_DEFAULTS = Object.freeze({
  quotaPolicy: "strict_reserve", quotaAlertsEnabled: true, lowQuotaPercent: 20,
  tiboEnabled: true, creditAlertsEnabled: true, persistentAlertsEnabled: true, soundEnabled: true,
});
const BOOLEAN_SETTINGS = ["quotaAlertsEnabled", "tiboEnabled", "creditAlertsEnabled", "persistentAlertsEnabled", "soundEnabled"];
const DEFAULT_PREFERENCES = {
  quotaPolicy: "strict_reserve",
  tiboSource: "codex-reset",
  autoRedeem: { enabled: false },
  quotaAlertsEnabled: true, lowQuotaPercent: 20, creditAlertsEnabled: true,
  persistentAlertsEnabled: true, soundEnabled: true,
};

export function userSettings(preferences = {}) {
  return Object.fromEntries(Object.keys(USER_SETTING_DEFAULTS).map((key) => [key,
    key === "tiboEnabled" ? preferences.tiboSource !== "disabled" : preferences[key] ?? USER_SETTING_DEFAULTS[key],
  ]));
}

export function validateSettingsPatch(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置必须是对象");
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(USER_SETTING_DEFAULTS, key)) throw new Error(`不能修改设置：${key}`);
    if (BOOLEAN_SETTINGS.includes(key) && typeof value !== "boolean") throw new Error(`${key} 必须是开关值`);
    if (key === "quotaPolicy" && !QUOTA_POLICIES.includes(value)) throw new Error("无效的额度保护策略");
    if (key === "lowQuotaPercent" && (!Number.isInteger(value) || value < 15 || value > 80)) throw new Error("提前提醒比例须为 15–80 的整数；10% 保护线固定不变");
  }
  return patch;
}

export class PulsePreferencesStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, "preferences.json");
    this.lockManager = new WorktreeLockManager(dataDir);
    this.serial = Promise.resolve();
  }

  async get() {
    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      return {
        ...DEFAULT_PREFERENCES,
        ...stored,
        quotaPolicy: QUOTA_POLICIES.includes(stored.quotaPolicy)
          ? stored.quotaPolicy
          : DEFAULT_PREFERENCES.quotaPolicy,
        tiboSource: TIBO_SOURCES.includes(stored.tiboSource)
          ? stored.tiboSource
          : DEFAULT_PREFERENCES.tiboSource,
        autoRedeem: stored.autoRedeem?.enabled === true && /^[a-f0-9]{64}$/.test(stored.autoRedeem.accountBinding)
          ? stored.autoRedeem : { enabled: false },
        ...Object.fromEntries(BOOLEAN_SETTINGS.filter((k) => k !== "tiboEnabled")
          .map((k) => [k, typeof stored[k] === "boolean" ? stored[k] : DEFAULT_PREFERENCES[k]])),
        lowQuotaPercent: Number.isInteger(stored.lowQuotaPercent) && stored.lowQuotaPercent >= 15 && stored.lowQuotaPercent <= 80
          ? stored.lowQuotaPercent : 20,
      };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  set(update) {
    const result = this.serial.then(() => this.#set(update));
    this.serial = result.catch(() => {});
    return result;
  }

  async setUserSettings(patch) {
    validateSettingsPatch(patch);
    // Resolve source changes under the same write lock as merging preferences.
    return this.set((current) => {
      const { tiboEnabled, ...direct } = patch;
      return { ...direct, ...(tiboEnabled == null ? {} : {
        tiboSource: tiboEnabled ? (current.tiboSource === "disabled" ? "codex-reset" : current.tiboSource) : "disabled",
      }) };
    });
  }

  async #set(update) {
    let lock;
    for (let attempt = 0; attempt < 80; attempt++) {
      lock = await this.lockManager.acquire(`${this.filePath}.write`, "preferences");
      if (lock.acquired) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!lock?.acquired) throw new Error("另一窗口正在保存设置，请稍后重试");
    try { return await this.#write(update); }
    finally { await this.lockManager.release(lock.handle); }
  }

  async #write(update) {
    const current = await this.get();
    const next = { ...current, ...(typeof update === "function" ? update(current) : update) };
    if (!QUOTA_POLICIES.includes(next.quotaPolicy)) {
      throw new Error(`quotaPolicy must be one of: ${QUOTA_POLICIES.join(", ")}`);
    }
    if (!TIBO_SOURCES.includes(next.tiboSource)) {
      throw new Error(`tiboSource must be one of: ${TIBO_SOURCES.join(", ")}`);
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.filePath);
    return next;
  }
}
