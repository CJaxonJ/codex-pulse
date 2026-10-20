import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const QUOTA_POLICIES = ["finish_current", "strict_reserve", "deadline"];
export const TIBO_SOURCES = ["disabled", "auto", "x-api", "codex-reset"];

const DEFAULT_PREFERENCES = {
  quotaPolicy: "strict_reserve",
  tiboSource: "codex-reset",
};

export class PulsePreferencesStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, "preferences.json");
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
      };
    } catch {
      return { ...DEFAULT_PREFERENCES };
    }
  }

  async set(update) {
    const current = await this.get();
    const next = { ...current, ...update };
    if (!QUOTA_POLICIES.includes(next.quotaPolicy)) {
      throw new Error(`quotaPolicy must be one of: ${QUOTA_POLICIES.join(", ")}`);
    }
    if (!TIBO_SOURCES.includes(next.tiboSource)) {
      throw new Error(`tiboSource must be one of: ${TIBO_SOURCES.join(", ")}`);
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
    return next;
  }
}
