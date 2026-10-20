import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PulsePreferencesStore } from "../src/preferences-store.mjs";

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
