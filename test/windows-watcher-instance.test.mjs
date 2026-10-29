import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PulsePreferencesStore } from "../src/preferences-store.mjs";

const windows = { skip: process.platform !== "win32", timeout: 90000 };
const project = path.resolve(import.meta.dirname, "..");
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!(await check())) { if (Date.now() > deadline) throw Error("Real watcher state did not arrive"); await new Promise(r => setTimeout(r, 100)); }
}
test("real Windows CLI watchers exclude a live owner and recover only after its actual death", windows, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse watcher 中文-")), data = path.join(root, "data");
  const npm = path.join(root, "Codex CLI"), entry = path.join(npm, "node_modules/@openai/codex/bin");
  await mkdir(entry, { recursive: true }); await mkdir(data);
  await writeFile(path.join(npm, "codex.cmd"), "@echo off\r\nrem Resolved safely by Node, not a shell\r\n");
  await writeFile(path.join(entry, "codex.js"), `require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`);
  await new PulsePreferencesStore(data).set({ tiboSource: "disabled" });
  const summary = path.join(root, "quota.json"), now = Math.floor(Date.now() / 1000);
  await writeFile(summary, JSON.stringify({ planType: "plus", fiveHour: { remainingPercent: 70, usedPercent: 30, resetsAt: now + 3600 }, weekly: { remainingPercent: 90, usedPercent: 10, resetsAt: now + 86400 }, resetCredits: { availableCount: 0, expiries: [] } }));
  const env = { ...process.env, NODE_ENV: "test", CODEX_PULSE_TEST_MODE: "watcher-restart-e2e", CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH: summary, CODEX_PULSE_DISABLE_NOTIFICATIONS: "1", CODEX_PULSE_DATA_DIR: data, CODEX_BINARY: path.join(npm, "codex.cmd"), CODEX_PULSE_POLL_SECONDS: "1" };
  const start = extra => {
    const child = spawn(process.execPath, [path.join(project, "bin/codex-pulse.mjs"), "watch", ...extra], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit"); let output = "", errors = "";
    child.stdout.on("data", b => output += b); child.stderr.on("data", b => errors += b);
    return { child, exit, output: () => output, errors: () => errors };
  };
  const owner = start([]); let contender, replacement, afterOnce;
  try {
    await until(() => { if (owner.child.exitCode != null) throw Error(owner.errors()); return owner.output().includes("watcher started"); });
    const state = JSON.parse(await readFile(path.join(data, "state.json"), "utf8"));
    assert.equal(state.lastSummary.fiveHour.remainingPercent, 70);
    contender = start(["--once"]);
    assert.equal((await contender.exit)[0], 73, contender.errors());
    assert.match(contender.errors(), /未重复启动/);
    assert.equal(owner.child.exitCode, null, "Contender must not terminate the original watcher");
    const exit = owner.exit; owner.child.kill("SIGKILL"); await exit;
    replacement = start(["--once"]);
    assert.equal((await replacement.exit)[0], 0, replacement.errors());
    assert.match(replacement.output(), /quota checked/);
    afterOnce = start(["--once"]);
    assert.equal((await afterOnce.exit)[0], 0, "A completed --once must release its lease");
  } finally { for (const session of [owner, contender, replacement, afterOnce]) if (session && session.child.exitCode == null) session.child.kill(); }
});
