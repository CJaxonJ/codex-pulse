import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { windowsUIFixture } from "../scripts/test-support/windows-ui-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 120000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function until(check) {
  const deadline = Date.now() + 20000;
  while (true) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw Error("Native background state was not observed"); await new Promise(r => setTimeout(r, 100)); }
}
test("installed native Windows background is single-instance, restarts a crashed connection, and stops only its own watcher", windows, async () => {
  const f = await windowsUIFixture({ installed: true });
  const peer = path.join(f.root, "Codex CLI"), entry = path.join(peer, "node_modules/@openai/codex/bin");
  const births = path.join(f.root, "peer-starts.jsonl"), crash = path.join(f.root, "crash-once");
  await mkdir(entry, { recursive: true });
  await writeFile(path.join(peer, "codex.cmd"), "@echo off\r\nrem resolved without a command shell\r\n");
  await writeFile(path.join(entry, "codex.js"), `
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(births)},JSON.stringify({pid:process.pid})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});
setInterval(()=>{if(fs.existsSync(${JSON.stringify(crash)})){fs.unlinkSync(${JSON.stringify(crash)});process.exit(23);}},100);
`);
  const summary = path.join(f.root, "quota.json"), now = Math.floor(Date.now() / 1000);
  await writeFile(summary, JSON.stringify({ planType: "plus", fiveHour: { remainingPercent: 70, usedPercent: 30, resetsAt: now + 3600 }, weekly: { remainingPercent: 90, usedPercent: 10, resetsAt: now + 86400 }, resetCredits: { availableCount: 0, expiries: [] } }));
  Object.assign(f.env, { NODE_ENV: "test", CODEX_PULSE_TEST_MODE: "watcher-restart-e2e", CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH: summary, CODEX_PULSE_DISABLE_NOTIFICATIONS: "1", CODEX_BINARY: path.join(peer, "codex.cmd"), CODEX_PULSE_POLL_SECONDS: "1" });
  await f.cli(["settings", "--update", JSON.stringify({ tiboEnabled: false })]);
  const sentinel = path.join(f.dataDir, "checkpoint-seed.txt"); await writeFile(sentinel, "preserve existing work");
  const health = async () => { try { return JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"), "utf8")); } catch { return {}; } };
  const started = async (session, oldPid = null) => until(async () => {
    if (session.child.exitCode != null) throw Error(session.diagnostic());
    const status = await health();
    if (status.state !== "running" || !status.watcherPid || status.watcherPid === oldPid) return null;
    assert(alive(status.watcherPid)); assert.equal(status.supervisorPid, session.child.pid);
    const sample = JSON.parse(await readFile(path.join(f.dataDir, "state.json"), "utf8"));
    assert.equal(sample.lastSummary.fiveHour.remainingPercent, 70);
    assert(sample.quotaCheckedAt >= now);
    return status;
  });
  const servers = async () => (await readFile(births, "utf8")).trim().split("\n").map(JSON.parse);
  let host = f.start("--background"), duplicate, stop, restarted;
  try {
    const first = await started(host);
    assert.equal((await servers()).length, 1);
    duplicate = f.start("--background");
    assert.equal((await duplicate.closed)[0], 0, duplicate.diagnostic());
    assert.equal((await health()).generation, first.generation);
    assert.equal((await servers()).length, 1, "Opening another background must not open another App Server");
    await writeFile(crash, "one deliberate isolated connection crash");
    const recovered = await started(host, first.watcherPid);
    assert.equal(recovered.restarts, 1);
    assert.equal((await servers()).length, 2);
    assert.equal(alive(first.watcherPid), false);
    stop = f.start("--stop-background");
    assert.equal((await stop.closed)[0], 0, stop.diagnostic());
    assert.equal((await host.closed)[0], 0, host.diagnostic());
    await until(async () => (await servers()).every(server => !alive(server.pid)));
    assert.equal(alive(recovered.watcherPid), false);
    assert.equal((await health()).state, "stopped");
    restarted = f.start("--background");
    const next = await started(restarted);
    assert.notEqual(next.generation, first.generation);
    assert.equal((await servers()).length, 3);
    restarted.child.kill("SIGKILL"); await restarted.closed;
    // The orphan watcher has a closed output pipe and a one-second real poll.
    // Its process-owned lease prevents another watcher until actual OS exit.
    await until(async () => !alive(next.watcherPid) && (await servers()).every(server => !alive(server.pid)));
    assert.equal(await readFile(sentinel, "utf8"), "preserve existing work");
  } finally {
    for (const session of [host, duplicate, stop, restarted]) if (session && session.child.exitCode == null) session.child.kill();
  }
});
