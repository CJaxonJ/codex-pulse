import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { windowsUIFixture } from "../scripts/test-support/windows-ui-fixture.mjs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";

const windows = { skip: process.platform !== "win32", timeout: 120000 };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function until(check) {
  const deadline = Date.now() + 20000;
  while (true) { const value = await check(); if (value) return value; if (Date.now() > deadline) throw Error("Native background state was not observed"); await new Promise(r => setTimeout(r, 100)); }
}
async function delayedOwner() {
  const f = await windowsUIFixture({ installed: true });
  await f.cli(["background-prepare"]);
  const binary = path.join(f.root, "delayed-owner.exe"), control = path.join(f.root, "owner-control");
  await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$c=Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'; & $c /nologo /target:exe /reference:System.Web.Extensions.dll ('/out:'+$env:PULSE_TEST_OUTPUT) $env:PULSE_TEST_SOURCE; if($LASTEXITCODE -ne 0){exit 1}"], {
    env: { ...f.env, PULSE_TEST_OUTPUT: binary, PULSE_TEST_SOURCE: path.resolve(import.meta.dirname, "../scripts/test-support/windows-delayed-background-owner.cs") }, windowsHide: true, timeout: 20000,
  });
  await writeFile(binary + ".config", await readFile(path.join(f.appRoot, "CodexPulse.exe.config")));
  const child = spawn(binary, [f.dataDir, control], { env: f.env, cwd: f.appRoot, windowsHide: true, stdio: "ignore" });
  const closed = once(child, "exit");
  try {
    await until(async () => { if (child.exitCode != null) throw Error("Isolated owner exited before readiness"); try { return await readFile(control + ".ready"); } catch { return false; } });
    const inspect = f.start("--background-info");
    assert.equal((await inspect.closed)[0], 0, "The isolated peer must first pass real native ownership/event inspection: " + inspect.diagnostic());
  } catch (error) { if (child.exitCode == null) child.kill(); await closed; throw error; }
  return { ...f, child, closed, control, released: () => until(async () => { try { return await readFile(control + ".guard-released"); } catch { return false; } }) };
}
for (const alreadyReleased of [false, true]) test(`native stop waits for the actual owner process after guard release (released before request: ${alreadyReleased})`, windows, async () => {
  const f = await delayedOwner(); let stop;
  try {
    if (alreadyReleased) { await writeFile(f.control + ".release-guard", "release ownership only"); await f.released(); }
    stop = f.start("--stop-background");
    await until(async () => {
      if (stop.child.exitCode != null) throw Error("Stop returned before guard release: " + stop.diagnostic());
      if (f.child.exitCode != null) throw Error("Isolated owner exited before guard release");
      try { return await readFile(f.control + ".guard-released"); } catch { return false; }
    });
    const observed = await Promise.race([stop.closed.then(() => "returned-before-exit"), new Promise(resolve => setTimeout(() => resolve("waiting-for-owner"), 1000))]);
    assert.equal(observed, "waiting-for-owner", stop.diagnostic());
    assert.equal(f.child.exitCode, null, "The old process must actually still be alive in this interval");
    await writeFile(f.control + ".exit", "allow OS process exit");
    assert.equal((await f.closed)[0], 0);
    assert.equal((await stop.closed)[0], 0, stop.diagnostic());
  } finally {
    await writeFile(f.control + ".exit", "cleanup"); await writeFile(f.control + ".release-guard", "cleanup");
    for (const session of [f, stop]) if (session && session.child.exitCode == null) session.child.kill();
    await f.closed;
  }
});
test("native stop refuses a mismatched owner creation time without signalling or killing that process", windows, async () => {
  const f = await delayedOwner(); let stop;
  try {
    const file = path.join(f.dataDir, "background-status.json"), status = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...status, supervisorCreationTime: "0" }));
    stop = f.start("--stop-background");
    assert.notEqual((await stop.closed)[0], 0);
    assert.equal(f.child.exitCode, null);
    await assert.rejects(readFile(f.control + ".guard-released"), { code: "ENOENT" });
  } finally {
    await writeFile(f.control + ".exit", "cleanup"); await writeFile(f.control + ".release-guard", "cleanup");
    if (f.child.exitCode == null) f.child.kill(); await f.closed;
  }
});
test("native stop during watcher owner publication finishes safely without an ownerless lock", windows, async () => {
  const f = await windowsUIFixture({ installed: true });
  await f.cli(["background-prepare"]);
  const modulePath = path.join(f.appRoot, "src", "worktree-lock-manager.mjs");
  const original = await readFile(modulePath, "utf8"), needle = "await mkdirExclusive(lockDir);";
  assert.equal(original.split(needle).length, 2);
  const marker = path.join(f.root, "publishing-watcher.json");
  await writeFile(modulePath, original.replace(needle, `${needle}
        if (process.argv[2] === "watch") {
          const continuePublication = new Promise(resolve => process.stdin.once("data", resolve));
          await writeFile(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, lockDir }));
          await continuePublication;
        }`));
  const host = f.start("--background"); let stop;
  try {
    const pending = await until(async () => {
      if (host.child.exitCode != null) throw Error(host.diagnostic());
      try { return JSON.parse(await readFile(marker, "utf8")); } catch { return null; }
    });
    assert(alive(pending.pid));
    assert.deepEqual(await readdir(pending.lockDir), [], "The actual watcher lock must exist before its owner record is published");
    await assert.rejects(readFile(path.join(pending.lockDir, "owner.json")), { code: "ENOENT" });
    stop = f.start("--stop-background");
    assert.equal((await stop.closed)[0], 0, stop.diagnostic());
    assert.equal((await host.closed)[0], 0, host.diagnostic());
    assert.equal(alive(pending.pid), false);
    await assert.rejects(readdir(pending.lockDir), { code: "ENOENT" });
    assert.deepEqual(await readdir(path.dirname(pending.lockDir)), []);
    await assert.rejects(readFile(path.join(f.dataDir, "state.json")), { code: "ENOENT" });
    assert.equal((await f.cli(["background-probe"])).watcherStopped, true);
  } finally {
    for (const session of [host, stop]) if (session && session.child.exitCode == null) session.child.kill();
  }
});
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

test("a preparing Windows background must not be reported stopped before its event exists", windows, async () => {
  const f = await windowsUIFixture({ installed: true });
  await f.cli(["background-prepare"]); // Actual ACL setup, before controlling the preparation response.
  const bin = path.join(f.appRoot, "bin", "codex-pulse.mjs"), original = await readFile(bin, "utf8");
  const backup = path.join(f.appRoot, "bin", "real-cli.mjs"); await writeFile(backup, original);
  const marker = path.join(f.root, "preparing"), release = path.join(f.root, "release-prepare");
  const delayed = `import fs from 'node:fs';
if(process.argv[2]==='background-prepare'){
 fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid}));
 const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(JSON.stringify({ok:true,applicable:true})+'\\n');}},50);
}else await import(${JSON.stringify(pathToFileURL(backup).href)});
`;
  await writeFile(bin, delayed);
  const host = f.start("--background"); let during, stop, preparing;
  try {
    await until(async () => { if (host.child.exitCode != null) throw Error(host.diagnostic()); try { return await readFile(marker, "utf8"); } catch { return false; } });
    during = f.start("--stop-background");
    assert.notEqual((await during.closed)[0], 0, "Preparing without an event is unknown, not safe-to-replace");
    assert.equal(host.child.exitCode, null);
    await writeFile(bin, original); await writeFile(release, "resume real startup");
    await until(async () => { try { return JSON.parse(await readFile(path.join(f.dataDir, "background-status.json"), "utf8")).generation; } catch { return false; } });
    stop = f.start("--stop-background");
    assert.equal((await stop.closed)[0], 0, stop.diagnostic());
    assert.equal((await host.closed)[0], 0, host.diagnostic());
    await unlink(marker); await unlink(release); await writeFile(bin, delayed);
    preparing = f.start("--background");
    const pending = await until(async () => { try { return JSON.parse(await readFile(marker, "utf8")); } catch { return null; } });
    assert(alive(pending.pid), "The preparation subprocess must actually be running");
    preparing.child.kill("SIGKILL"); await preparing.closed;
    await until(() => !alive(pending.pid));
  } finally {
    await writeFile(bin, original); await writeFile(release, "cleanup");
    for (const session of [host, during, stop, preparing]) if (session && session.child.exitCode == null) session.child.kill();
  }
});
