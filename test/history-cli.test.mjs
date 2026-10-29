import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UserEventJournal } from "../src/user-event-journal.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("history UI bridge reads saved original posts even without a working Codex binary", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pulse history 中文-"));
  const journal = new UserEventJournal(data);
  await journal.append({ type: "tibo_preview", title: "重置预告", body: "尚未到账", sourceUrl: "https://x.com/thsottiaux/status/123", sourceText: "Original source, not generated", severity: "warning" });
  const result = await execute(process.execPath, [path.join(root, "bin/codex-pulse.mjs"), "history"], {
    env: { ...process.env, CODEX_PULSE_DATA_DIR: data, CODEX_BINARY: "this-codex-does-not-exist.exe" }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  const saved = JSON.parse(result.stdout);
  assert.equal(saved.ok, true);
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].sourceText, "Original source, not generated");
  assert.equal(saved.events[0].sourceUrl, "https://x.com/thsottiaux/status/123");
  assert.equal(result.stderr, "");
  assert.equal((await journal.list()).length, 1, "Reading history never writes new events or contacts an account");
});
