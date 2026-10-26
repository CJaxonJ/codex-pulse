#!/usr/bin/env node

// Real-process diagnostic. No current user thread, system network changes,
// Hook trust changes, or reset credits. Only the model may create proof files.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveCodexBinary } from "../src/app-server-client.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { RealRpcPeer as Peer } from "./test-support/real-rpc-peer.mjs";
import { recoveryWakeId, queueNativeWakeup } from "../src/native-wakeup.mjs";

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const binary = resolveCodexBinary();
// The release-facing default exercises the actual installed/trusted handlers.
// Explicitly opt out only for the lower-level missing-Stop diagnostic.
const registeredHooks = process.env.CODEX_PULSE_TEST_REGISTERED_HOOKS !== "0";
const initialNativeGoal = process.env.CODEX_PULSE_TEST_INITIAL_GOAL !== "0";
const project = path.resolve(import.meta.dirname, "..");
const root = await mkdtemp(path.join(os.tmpdir(), "pulse-isolated-native-"));
const workspace = path.join(root, "workspace");
const dataDir = path.join(root, "pulse-data");
const installedRuntime = path.join(os.homedir(), "Library/Application Support/Codex Pulse/app");
const evidencePath = path.join(root, "evidence.json");
const seedPath = path.join(workspace, "phase-one.txt");
const proofPath = path.join(workspace, "actual-resumed-proof.txt");
const evidence = { scope: "isolated_real_app_server_wakeup_diagnostic", phase: "starting",
  root, workspace, syntheticInputs: ["quota samples", "network disconnection of test client"],
  productionThreadTouched: false, events: [], resetCreditsConsumed: 0 };
evidence.registeredHookTest = registeredHooks;
evidence.initialNativeGoal = initialNativeGoal;
const save = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
function observePeer(client) {
  client.on("approval", () => { evidence.approvalRequired = true; });
  client.on("notification", message => {
    if (!message.method?.startsWith("hook/")) return;
    const run = message.params?.run || {};
    evidence.events.push({ method: message.method, eventName: run.eventName,
      status: run.status, durationMs: run.durationMs,
      errors: (run.entries || []).filter(entry => ["error", "warning"].includes(entry.kind))
        .map(entry => entry.text.slice(0, 1000)) });
  });
}

async function runHookProcess(input) {
  const child = spawn(process.execPath, [path.join(project, "plugin/scripts/pulse-hook.mjs")], {
    cwd: workspace, env: { ...process.env, CODEX_PULSE_DATA_DIR: dataDir, CODEX_PULSE_APP_ROOT: project },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("Real Hook process exceeded its deadline")); }, 10000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", code => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) reject(Error(`Hook failed: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
  });
  child.stdin.end(JSON.stringify(input));
  return result;
}

async function waitFor(fn, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (evidence.approvalRequired) throw Error("Isolated test requires approval; none was auto-accepted");
    const value = await fn();
    if (value) return value;
    await sleep(500);
  }
  throw Error(`Timed out: ${label}`);
}
async function exactFile(file, text) {
  try { return (await readFile(file, "utf8")).trim() === text; }
  catch (e) { if (e.code === "ENOENT") return false; throw e; }
}
const portProbe = createServer();
await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise(resolve => portProbe.close(resolve));
const url = `ws://127.0.0.1:${port}`;
const server = spawn(binary, [...(registeredHooks ? ["-c", "features.code_mode_host=true"] : []), "app-server", "--listen", url], {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env,
    CODEX_PULSE_DATA_DIR: registeredHooks ? dataDir : path.join(root, "ambient-hook-data"),
    CODEX_PULSE_APP_ROOT: registeredHooks ? installedRuntime : project },
});
let stderr = "";
server.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-3000); });
let peer;
let threadId;
let validationSampler;
try {
  await mkdir(workspace); await mkdir(dataDir); await save();
  if (registeredHooks) {
    const pkg = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
    const installed = path.join(os.homedir(), ".codex/plugins/cache/codex-pulse-local/codex-pulse", pkg.version, "scripts/pulse-hook.mjs");
    const digest = data => createHash("sha256").update(data).digest("hex");
    evidence.installedHookVersion = pkg.version;
    evidence.installedHookMatchesCandidate = digest(await readFile(installed)) === digest(await readFile(path.join(project, "plugin/scripts/pulse-hook.mjs")));
    if (!evidence.installedHookMatchesCandidate) throw Error("Installed Hook does not match the candidate source");
    const sampledAt = Math.floor(Date.now() / 1000);
    await writeFile(path.join(dataDir, "preferences.json"), JSON.stringify({ quotaPolicy: "strict_reserve" }));
    await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ fiveHour: { lastCheckedAt: sampledAt },
      lastSummary: { planType: "plus", fiveHour: { remainingPercent: 70, resetsAt: sampledAt + 3600 } } }));
  }
  await waitFor(async () => {
    if (server.exitCode != null) throw Error(`Test server exited: ${stderr}`);
    try { return (await fetch(url.replace("ws:", "http:") + "/readyz")).ok; } catch { return false; }
  }, "isolated server readiness", 20000);
  peer = new Peer(url); observePeer(peer); await peer.start();
  if (registeredHooks) {
    const listed = await peer.request("hooks/list", { cwds: [workspace] });
    evidence.registeredHooks = (listed.data || []).flatMap(item => item.hooks || [])
      .filter(hook => hook.pluginId === "codex-pulse@codex-pulse-local")
      .map(({ eventName, enabled, trustStatus }) => ({ eventName, enabled, trustStatus }));
    if (evidence.registeredHooks.length !== 6 || evidence.registeredHooks.some(hook =>
      !hook.enabled || !["trusted", "managed"].includes(hook.trustStatus))) {
      throw Error("Installed candidate Hooks are not all enabled and officially trusted");
    }
  }
  const started = await peer.request("thread/start", { cwd: workspace,
    approvalPolicy: "on-request", sandbox: "workspace-write", historyMode: "paginated",
    serviceName: "codex_pulse_sandbox" });
  threadId = started.thread.id; evidence.threadId = threadId;
  const turn = await peer.request("turn/start", { threadId, input: [{ type: "text", text:
    "This is an isolated product test. Use apply_patch to create phase-one.txt containing PHASE_ONE_OK and a newline. Read it back. Then run the shell command sleep 10 exactly once so the external test can pause this turn while it is still live. " +
    (initialNativeGoal ? "Finally finish. Do not create other files or perform any other task." :
      "After that, preserve phase-one.txt and use apply_patch to create actual-resumed-proof.txt containing REAL_NATIVE_WAKEUP_OK and one newline. Read it back, then finish. If quota protection stops you, save these unfinished steps for recovery. Do not modify other files.") }] });
  evidence.initialTurnId = turn.turn.id;
  await waitFor(() => exactFile(seedPath, "PHASE_ONE_OK"), "real first phase file");
  if (!(await exactFile(seedPath, "PHASE_ONE_OK"))) throw Error("Real first turn did not create its file");
  evidence.initialProofVerified = true;
  const objective = "In this isolated test workspace, preserve phase-one.txt. Use apply_patch to create actual-resumed-proof.txt containing REAL_NATIVE_WAKEUP_OK and one newline, read it back, then finish. Do not modify other files.";
  if (initialNativeGoal) {
    await peer.request("thread/goal/set", { threadId, objective, status: "active", origin: "automatic" });
  } else {
    evidence.noNativeGoalBeforePause = !(await peer.request("thread/goal/get", { threadId })).goal;
    if (!evidence.noNativeGoalBeforePause) throw Error("No-Goal fixture unexpectedly already has a Goal");
  }
  const now = Math.floor(Date.now() / 1000);
  const low = { planType: "plus", fiveHour: { remainingPercent: 9, resetsAt: now + 3600 } };
  await writeFile(path.join(dataDir, "preferences.json"), JSON.stringify({ quotaPolicy: "strict_reserve" }));
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
    fiveHour: { lastCheckedAt: now }, lastSummary: low,
  }));
  const store = new ChatContinuityStore(dataDir);
  if (registeredHooks) {
    // Do not call the handler ourselves. The real next tool must cross the
    // registered native Hook boundary after the synthetic quota sample falls.
    await waitFor(async () => {
      const current = await store.get(threadId);
      return ["checkpoint_requested", "paused_quota"].includes(current?.status) &&
        (current.autoResume === true || (!initialNativeGoal &&
          current.resumeUnavailableReason === "native_goal_required")) &&
        current.goalCheckedTurnId === turn.turn.id;
    }, "installed Hook to pause and capture the live task", 30000);
    evidence.pauseBoundary = "registered_native_hook_not_manually_invoked";
  } else {
    const paused = await runHookProcess({ hook_event_name: "PreToolUse", session_id: threadId,
      turn_id: turn.turn.id, cwd: workspace, tool_name: "Bash" });
    if (paused?.decision !== "block") throw Error("Real Goal did not pause");
    evidence.pauseBoundary = "direct_real_hook_command_diagnostic";
  }
  evidence.pauseStatus = (await store.get(threadId)).status;
  evidence.stopHookDeliberatelyOmitted = !registeredHooks;
  // Physically disconnect this test transport, leaving system networking alone.
  peer.close(); await sleep(100);
  const recovered = { planType: "plus", fiveHour: { remainingPercent: 100, resetsAt: now + 21600 } };
  await new ChatContinuityController({ client: peer, store }).reconcile(recovered, { now: now + 1 });
  evidence.offlineRetryPersisted = (await store.get(threadId)).retryNotBefore != null;
  peer = new Peer(url); observePeer(peer); await peer.start();
  await waitFor(async () => {
    const current = await peer.readLatestTurn(threadId);
    if (current?.status === "failed") throw Error(`First real turn failed: ${JSON.stringify(current.error)}`);
    return current?.id === turn.turn.id && current.status === "completed";
  }, "real paused first turn to finish");
  evidence.proofAbsentBeforeRecovery = !(await exactFile(proofPath, "REAL_NATIVE_WAKEUP_OK"));
  if (!evidence.proofAbsentBeforeRecovery) throw Error("Proof appeared before recovery; cannot accept this test");
  if (registeredHooks) {
    // A completed turn can be visible in persisted history before its Stop
    // handler has finished. Await the real handler, not that unrelated write.
    await waitFor(async () => {
      const current = await store.get(threadId);
      return current?.status === "paused_quota" && Boolean(current.checkpoint?.summary);
    }, "registered Stop Hook to persist its checkpoint", 20000);
    const pending = await store.get(threadId);
    evidence.realStopHookSavedCheckpoint = pending.status === "paused_quota" && Boolean(pending.checkpoint?.summary);
    if (!evidence.realStopHookSavedCheckpoint) throw Error("Registered Stop Hook did not persist its checkpoint");
    evidence.initialGoalPreserved = initialNativeGoal ? pending.initialGoal?.objective === objective :
      pending.initialGoal == null;
    if (!evidence.initialGoalPreserved) throw Error("The pause changed or invented an initial Goal");
    // Resubscribe this observer on the SAME fixture-owned server after its
    // transport interruption. The replacement watcher still uses a separate
    // STDIO server, and only production queue dispatch may start a turn.
    await peer.request("thread/resume", { threadId, excludeTurns: true });
    await writeFile(path.join(dataDir, "state.json"), JSON.stringify({
      fiveHour: { lastCheckedAt: Math.floor(Date.now() / 1000) }, lastSummary: recovered,
    }));
    validationSampler = setInterval(async () => {
      const current = await store.get(threadId);
      if (current?.workspaceValidatedAt && !evidence.validatedRecoveryTurnId) {
        evidence.validatedRecoveryTurnId = current.turnId;
        evidence.workspaceValidatedAt = current.workspaceValidatedAt;
      }
    }, 100);
  }
  const worker = await run(process.execPath, [path.join(project, "scripts/test-support/recovery-worker.mjs"),
    "stdio", dataDir, threadId, String(now + 32), String(now + 21600),
    ...(registeredHooks ? ["after-first-hook"] : [])], {
    cwd: project, timeout: 45000, maxBuffer: 1024 * 1024,
  });
  const workerResult = JSON.parse(worker.stdout);
  evidence.replacementWatcherPid = workerResult.pid;
  evidence.separateRecoveryProcess = workerResult.pid !== process.pid;
  evidence.recoveryTransport = "independent_stdio_app_server_like_installed_watcher";
  evidence.hookBoundary = "real_command_process_with_default_native_goal_coordinator";
  evidence.events.push(...workerResult.events);
  evidence.repairedStatus = workerResult.status;
  evidence.productWakeSubmitted = workerResult.wakeSubmittedAt != null;
  evidence.productWakeAttempts = workerResult.wakeAttempts;
  evidence.productWakeError = workerResult.lastWakeError || null;
  evidence.independentWatcherObservedStarted = workerResult.executionObservedAt != null;
  if (registeredHooks && !evidence.independentWatcherObservedStarted) {
    throw Error("Replacement watcher never confirmed actual execution after Hook validation");
  }
  evidence.goalStatus = (await peer.request("thread/goal/get", { threadId })).goal.status;
  if (evidence.repairedStatus !== "native_goal_active" || evidence.goalStatus !== "active") {
    throw Error(`Candidate recovery did not activate: ${evidence.repairedStatus}`);
  }
  const dispatchDeadline = Date.now() + 45000;
  while (Date.now() < dispatchDeadline) {
    const afterGoal = await peer.readLatestTurn(threadId);
    if (afterGoal?.id !== turn.turn.id && afterGoal?.status === "failed") {
      throw Error(`Real resumed turn failed: ${JSON.stringify(afterGoal.error)}`);
    }
    evidence.productionWakeStartedTurn = afterGoal?.id !== turn.turn.id;
    if (evidence.productionWakeStartedTurn && afterGoal.status === "completed") break;
    await sleep(500);
  }
  evidence.productionWakeCreatedProof = await exactFile(proofPath, "REAL_NATIVE_WAKEUP_OK");
  evidence.candidateCreatedProof = evidence.productionWakeCreatedProof;
  await save();
  if (!evidence.productionWakeCreatedProof) {
    // Diagnostic of an official alternative, not part of candidate controller.
    evidence.queueDiagnosticUsed = true;
    const remoteArgs = process.env.CODEX_PULSE_TEST_QUEUE_ROUTE === "default" ? [] : ["--remote", url];
    evidence.queueTransport = remoteArgs.length ? "explicit_owner_endpoint" : "default_official_daemon";
    await run(binary, ["queue", ...remoteArgs, "--thread", threadId, "--message", objective], {
      cwd: workspace, timeout: 20000, maxBuffer: 1024 * 1024,
    });
    await waitFor(() => exactFile(proofPath, "REAL_NATIVE_WAKEUP_OK"), "official queue to execute in the real test thread");
  }
  const final = await waitFor(async () => {
    const current = await peer.readLatestTurn(threadId);
    return current?.id !== turn.turn.id && current.status === "completed" ? current : null;
  }, "real resumed turn completion");
  evidence.resumedTurnId = final.id;
  evidence.actualModelProofVerified = true;
  if (registeredHooks) {
    const record = await store.get(threadId);
    const admission = JSON.parse(await readFile(path.join(dataDir, "wake-admissions",
      recoveryWakeId(threadId, turn.turn.id), "admission.json"), "utf8"));
    evidence.registeredPromptHookAdmittedTurn = admission.turnId;
    // A native Goal may have a later verification/completion turn. Validate
    // the admitted recovery turn, not whichever turn happens to be latest.
    evidence.registeredPreToolHookValidatedWorkspace = Boolean(evidence.workspaceValidatedAt);
    if (admission.turnId !== evidence.validatedRecoveryTurnId || !evidence.registeredPreToolHookValidatedWorkspace) {
      throw Error("Actual registered Hook admission/workspace validation was not proven");
    }
    const before = (await stat(proofPath)).mtimeMs;
    const eventOffset = evidence.events.length;
    await queueNativeWakeup(binary, { ...record, pausedTurnId: turn.turn.id });
    await waitFor(() => evidence.events.slice(eventOffset).some(event =>
      event.method === "hook/completed" && event.eventName === "userPromptSubmit" &&
      event.status === "blocked"), "duplicate recovery to be rejected before execution", 30000);
    evidence.registeredHookRejectedDuplicate = true;
    evidence.duplicateWakeLeftProofUnchanged = (await stat(proofPath)).mtimeMs === before;
    if (!evidence.duplicateWakeLeftProofUnchanged) throw Error("Duplicate wake executed a second file modification");
  }
  evidence.phase = "diagnostic_complete";
  evidence.productAcceptance = evidence.productionWakeCreatedProof &&
    evidence.events.some(e => e.activationPhase === "requested")
    ? "isolated_native_goal_candidate_executed" : "not_passed_queue_is_not_integrated";
  if (evidence.productAcceptance !== "isolated_native_goal_candidate_executed") process.exitCode = 1;
} catch (error) {
  evidence.phase = "failed"; evidence.failure = error.message;
  process.exitCode = 1;
} finally {
  clearInterval(validationSampler);
  // Preserve this isolated case for review. Stop only the server created here.
  if (threadId && peer?.socket?.readyState === WebSocket.OPEN) {
    await peer.request("thread/goal/set", { threadId, status: "paused", origin: "automatic" }).catch(() => {});
  }
  await save(); peer?.close(); server.kill("SIGTERM");
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
}
