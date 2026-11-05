// Actual Codex runtime/queue acceptance, with an isolated profile and a local
// rejecting provider. Proves routing and reload, NOT successful model execution.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer as tcpServer } from "node:net";
import { createServer as httpServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { resolveCodexBinary } from "../src/app-server-client.mjs";
import { codexInvocation } from "../src/platform-runtime.mjs";
import { ownedWindowsProcessInvocation } from "../src/windows-process-bridge.mjs";
import { queueNativeWakeup } from "../src/native-wakeup.mjs";
import { RealRpcPeer } from "./test-support/real-rpc-peer.mjs";

if (process.platform !== "win32" && process.env.CODEX_PULSE_TEST_QUEUE_HOST_PROBE !== "1") throw Error("Native Windows acceptance is required");
const execute = promisify(execFile), binary = resolveCodexBinary();
const versionCall=codexInvocation(binary,["--version"]);
const actualCodexVersion=(await execute(versionCall.file,versionCall.args,{encoding:"utf8",timeout:15000,windowsHide:true})).stdout.trim().split(/\s+/).at(-1);
assert.equal(actualCodexVersion,process.env.PULSE_TEST_EXPECTED_CODEX_VERSION || "0.166.0-alpha.5.1");
const root = await mkdtemp(path.join(os.tmpdir(), "pulse-queue-runtime-"));
const home = path.join(root, "isolated-codex"), workspace = path.join(root, "workspace");
await mkdir(home); await mkdir(workspace);
const env = { ...process.env, CODEX_HOME: home };
for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CHATGPT_ACCESS_TOKEN", "AZURE_OPENAI_API_KEY"]) delete env[name];
let localProviderRequests = 0;
const rejectProvider = httpServer((request, response) => {
  localProviderRequests++; request.resume();
  response.writeHead(400, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { message: "Isolated protocol probe deliberately rejects inference", type: "invalid_request_error" } }));
});
await new Promise(resolve => rejectProvider.listen(0, "127.0.0.1", resolve));
await writeFile(path.join(home, "config.toml"), `model = "pulse-queue-probe"
model_provider = "pulse_queue_probe"
[model_providers.pulse_queue_probe]
name = "Isolated rejecting provider"
base_url = "http://127.0.0.1:${rejectProvider.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
`);

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, peer, approval = false;
async function waitFor(check, description, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (approval) throw Error("An unexpected approval was requested; none was accepted");
    const result = await check(); if (result) return result;
    await pause(100);
  }
  throw Error("Timed out: " + description);
}
async function stopServer() {
  peer?.close(); peer = null;
  if (!server) return;
  const current = server; server = null;
  current.child.stdin.end(); current.child.kill();
  const timer = setTimeout(() => current.child.kill("SIGKILL"), 3000);
  try { await current.closed; } finally { clearTimeout(timer); }
}
async function startServer() {
  const probe = tcpServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${probe.address().port}`;
  await new Promise(resolve => probe.close(resolve));
  const call = ownedWindowsProcessInvocation(codexInvocation(binary, ["app-server", "--listen", url]));
  const child = spawn(call.file, call.args, { env, cwd: workspace, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "exit"); let diagnostic = "";
  child.stdout.resume(); child.stderr.on("data", data => { diagnostic = (diagnostic + data).slice(-2000); });
  child.stdin.on("error", () => {}); server = { child, closed, url };
  await waitFor(async () => {
    if (child.exitCode != null) throw Error("Isolated App Server exited: " + diagnostic);
    try { return (await fetch(url.replace("ws:", "http:") + "/readyz")).ok; } catch { return false; }
  }, "real server readiness");
  peer = new RealRpcPeer(url); peer.on("approval", () => approval = true); await peer.start();
}
async function queueCall(file, args, options) {
  // Production builds use the default daemon. The fixture selects its exact
  // isolated owner endpoint, preserving all production queue flags/message.
  const index = args.indexOf("queue"); assert(index >= 0);
  const routed = [...args.slice(0, index + 1), "--remote", server.url, ...args.slice(index + 1)];
  const call = ownedWindowsProcessInvocation({ file, args: routed });
  return execute(call.file, call.args, { ...options, env, encoding: "utf8" });
}
try {
  await startServer();
  const ids = [], seedTurns = [];
  for (let index = 0; index < 2; index++) {
    const created = await peer.request("thread/start", { cwd: workspace, model: "pulse-queue-probe", sandbox: "read-only", approvalPolicy: "on-request" });
    const id = created.thread.id; ids.push(id);
    const seeded = await peer.request("turn/start", { threadId: id, input: [{ type: "text", text: "Isolated routing probe; no tools or external services." }] });
    seedTurns.push(seeded.turn.id);
    await waitFor(async () => (await peer.readLatestTurn(id))?.status === "failed", "deliberately rejected seed turn");
  }
  assert(localProviderRequests >= 2, "Both seed failures must reach the local rejecting provider, not fail for an unrelated setup problem");
  await stopServer(); await startServer();
  const loaded = async () => (await peer.request("thread/loaded/list", {})).data;
  for (const id of ids) {
    assert(!(await loaded()).includes(id), "The restarted server must not already own a live thread");
    await peer.request("thread/read", { threadId: id, includeTurns: false });
    assert(!(await loaded()).includes(id), "Metadata inspection must not accidentally load the fixture");
  }
  const oldCall = codexInvocation(binary, ["queue", "--thread", ids[0], "--message", "Isolated negative control"]);
  await queueCall(oldCall.file, oldCall.args, { cwd: workspace, timeout: 20000, windowsHide: true });
  assert(!(await loaded()).includes(ids[0]), "Enqueue-only must reproduce the unloaded-thread gap");
  console.error(JSON.stringify({ phase: "negative_control_verified", serverRestarted: true, plainQueueLeftThreadUnloaded: true }));
  await queueNativeWakeup(binary, { sessionId: ids[1], turnId: "isolated-pause", cwd: workspace, initialGoal: { objective: "Isolated queue reload probe; no tools requested." } }, queueCall);
  await waitFor(async () => (await loaded()).includes(ids[1]), "production wake to load the stored thread");
  await waitFor(async () => {
    const turn = await peer.readLatestTurn(ids[1]);
    return turn && turn.id !== seedTurns[1] && turn.status === "failed";
  }, "a genuinely new turn to reach the deliberate local provider rejection");
  assert(localProviderRequests >= 3, "Reload alone must not be reported as actual new-turn dispatch");
  console.log(JSON.stringify({ ok: true, platform: process.platform, actualCodexVersion, actualServerRestarted: true,
    plainQueueLeavesThreadUnloaded: true, productionWakeLoadsStoredThread: true, productionWakeStartsNewTurn: true,
    localRejectProviderRequests: localProviderRequests, successfulModelCalls: 0,
    realAccountOrQuotaTested: false, productionProfileTouched: false }));
} finally {
  await stopServer(); await new Promise(resolve => rejectProvider.close(resolve));
}
