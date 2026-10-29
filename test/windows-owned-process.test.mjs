import test from "node:test";
import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AppServerClient } from "../src/app-server-client.mjs";
import { inspectWindowsUI } from "../scripts/test-support/windows-ui-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 60000 };
const project = path.resolve(import.meta.dirname, "..");
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Owned Windows processes did not reach the expected real OS state");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function peer() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse 子进程 归属-"));
  const file = path.join(root, "RPC peer.cjs");
  await writeFile(file, `
const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
const r=require('node:readline').createInterface({input:process.stdin});
r.on('line',line=>{const m=JSON.parse(line);if(m.id==null)return;process.stdout.write(JSON.stringify({id:m.id,result:m.method==='proof'?{pid:process.pid,descendant:child.pid,echo:m.params}:{}})+'\\n');});
setInterval(()=>{},1000); // Intentionally does NOT exit on stdin EOF.
`);
  return { root, file };
}
const uiSession = pid => ({ child: { pid }, diagnostic: () => "" });

for (const ending of ["stdin-eof", "bridge-killed"]) test(`actual Windows Job cleans only its App Server tree after ${ending}`, windows, async () => {
  const f = await peer();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const client = new AppServerClient({ binary: process.execPath, binaryArgs: [f.file] });
  let tree;
  try {
    await client.start();
    tree = await client.request("proof", { text: '中文 & | %PATH% $(noop) "quote"\\tail\n下一步' });
    assert.equal(tree.echo.text, '中文 & | %PATH% $(noop) "quote"\\tail\n下一步');
    assert(alive(tree.pid) && alive(tree.descendant) && alive(unrelated.pid), "The processes must actually exist before cleanup");
    const bridge = client.child, exit = once(bridge, "exit");
    if (ending === "stdin-eof") bridge.stdin.end(); else bridge.kill("SIGKILL");
    await exit;
    await until(() => !alive(tree.pid) && !alive(tree.descendant));
    assert(alive(unrelated.pid), "An unrelated user process must never be killed");
  } finally { client.stop(); unrelated.kill(); }
});

test("killing the actual owning Node process cleans its connection tree but preserves its persistent notification", windows, async () => {
  const f = await peer();
  const owner = fork(path.join(project, "scripts/test-support/windows-process-owner.mjs"), [f.file], {
    windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, CODEX_PULSE_NOTIFIER_APP: path.join(project, "build/windows/CodexPulse.exe") },
  });
  let proof;
  try {
    proof = await new Promise((resolve, reject) => {
      const finish = (error, message) => { clearTimeout(timer); owner.off("message", onMessage); owner.off("exit", onExit); owner.off("error", onError); if (error) reject(error); else resolve(message); };
      const onMessage = message => finish(null, message);
      const onExit = code => finish(Error("Isolated owner exited before proof: " + code));
      const onError = error => finish(error);
      const timer = setTimeout(() => finish(Error("Isolated owner did not return real process proof")), 30000);
      owner.once("message", onMessage); owner.once("exit", onExit); owner.once("error", onError);
    });
    assert.equal(proof.ok, true, proof.error);
    const pids = [proof.tree.pid, proof.tree.descendant, proof.bridgePid, proof.noticePid];
    assert(pids.every(alive), "All tested processes must be alive, including the real notice");
    const exit = once(owner, "exit"); owner.kill("SIGKILL"); await exit;
    await until(() => [proof.tree.pid, proof.tree.descendant, proof.bridgePid].every(pid => !alive(pid)));
    assert(alive(proof.noticePid), "Persistent notice is outside the connection Job and must survive watcher death");
    const session = uiSession(proof.noticePid);
    const ui = await inspectWindowsUI(session);
    assert.equal(ui.visible, true);
    assert.match(ui.content.join("\n"), /这是测试窗口/);
    await inspectWindowsUI(session, { click: "知道了" });
    await until(() => !alive(proof.noticePid));
  } finally {
    if (owner.exitCode == null) owner.kill();
    // Never kill a recorded PID: Windows can reuse it for a concurrent test.
    // The bridge Job handles its own tree; dismiss only our UUID-marked UI.
    if (proof?.noticePid && alive(proof.noticePid)) {
      try {
        const session = uiSession(proof.noticePid), ui = await inspectWindowsUI(session);
        if (ui.content.join("\n").includes(proof.noticeToken)) await inspectWindowsUI(session, { click: "知道了" });
      } catch { /* A gone UI is not permission to terminate another process. */ }
    }
  }
});

test("an initialization timeout really terminates the Windows connection process and its descendants", windows, async () => {
  const f = await peer();
  const marker = path.join(f.root, "started.json");
  await writeFile(f.file, `const fs=require('node:fs'),{spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,child:c.pid}));setInterval(()=>{},1000);`);
  const client = new AppServerClient({ binary: process.execPath, binaryArgs: [f.file], requestTimeoutMs: 4000 });
  const start = client.start();
  let tree;
  // Attach rejection handling immediately; waiting for the marker must not turn
  // a deliberately rejected initialize into an unhandled rejection.
  const rejected = assert.rejects(start, /initialize timed out/);
  try {
    await until(async () => { try { tree = JSON.parse(await readFile(marker, "utf8")); return true; } catch { return false; } });
    assert(alive(tree.pid) && alive(tree.child));
    await rejected;
    await until(() => !alive(tree.pid) && !alive(tree.child));
  } finally { client.stop(); }
});
