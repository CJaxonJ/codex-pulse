#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleHook } from "../plugin/scripts/pulse-hook.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-simulated-continuity-"));
const dataDir = path.join(root, "data");
const workspace = path.join(root, "workspace");
const proofPath = path.join(workspace, "resume-proof.txt");
const store = new ChatContinuityStore(dataDir);
const inspector = new WorkspaceInspector();
const timeline = [];
let succeeded = false;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(args) {
  execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
}

function quotaSummary(remainingPercent, resetsAt) {
  return {
    planType: "plus",
    fiveHour: {
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt,
    },
    weekly: { remainingPercent: 80, usedPercent: 20, resetsAt: resetsAt + 500_000 },
    resetCredits: { availableCount: 0, expiries: [] },
  };
}

async function writeHookState(summary, checkedAt) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "state.json"),
    `${JSON.stringify({ fiveHour: { lastCheckedAt: checkedAt }, lastSummary: summary })}\n`,
    "utf8",
  );
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

class SimulatedAppServer {
  constructor(name, initialTurnId) {
    this.name = name;
    this.latestTurnId = initialTurnId;
    this.calls = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: this.latestTurnId, status: "completed" }] };
    }
    if (method === "thread/resume") return { thread: { id: params.threadId } };
    if (method === "turn/start") {
      const prompt = params.input?.[0]?.text || "";
      for (const label of ["Completed", "Verification", "Remaining", "Next action", "Blockers"]) {
        assert(prompt.includes(label), `resume prompt lost checkpoint section: ${label}`);
      }
      this.latestTurnId = `${this.name}-resumed-turn`;
      await writeFile(proofPath, "RESUME_OK\n", "utf8");
      return { turn: { id: this.latestTurnId, status: "inProgress" } };
    }
    return {};
  }
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(workspace, ".gitkeep"), "", "utf8");
  git(["init", "-q"]);
  git(["config", "user.name", "Codex Pulse Simulation"]);
  git(["config", "user.email", "codex-pulse-simulation@example.invalid"]);
  git(["add", ".gitkeep"]);
  git(["commit", "-q", "-m", "baseline"]);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    `${JSON.stringify({ quotaPolicy: "strict_reserve" })}\n`,
    "utf8",
  );

  const now = 2_000_000_000;
  const firstWindow = now + 3_600;
  const recoveredWindow = firstWindow + 18_000;
  const sessionId = "simulated-thread";
  const initialTurnId = "simulated-initial-turn";
  const baseHook = {
    session_id: sessionId,
    turn_id: initialTurnId,
    cwd: workspace,
    model: "gpt-6.1-sol",
    permission_mode: "default",
  };
  const privateMarker = "PRIVATE-PROMPT-MUST-NOT-BE-STORED";

  await writeHookState(quotaSummary(70, firstWindow), now);
  await handleHook(
    {
      ...baseHook,
      hook_event_name: "UserPromptSubmit",
      prompt: `Implement the remaining task. ${privateMarker}`,
    },
    { dataDir, appRoot: projectDir, now },
  );

  await writeHookState(quotaSummary(10, firstWindow), now + 60);
  const hardFloor = await handleHook(
    { ...baseHook, hook_event_name: "PostToolUse", tool_name: "Bash" },
    { dataDir, appRoot: projectDir, now: now + 60 },
  );
  assert(hardFloor?.decision === "block", "10% did not stop the active turn");

  const extraTool = await handleHook(
    { ...baseHook, hook_event_name: "PreToolUse", tool_name: "apply_patch" },
    { dataDir, appRoot: projectDir, now: now + 61 },
  );
  assert(extraTool?.decision === "block", "a new tool escaped the 10% guard");

  const checkpointText = [
    "Completed: implemented phase one.",
    "Verification: phase-one checks passed.",
    "Remaining: create the resume proof and verify it.",
    "Next action: create resume-proof.txt with RESUME_OK.",
    "Blockers: none.",
  ].join("\n");
  const stopped = await handleHook(
    {
      ...baseHook,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: checkpointText,
    },
    { dataDir, appRoot: projectDir, now: now + 62 },
  );
  assert(stopped?.continue === false, "Stop hook did not end the guarded turn");
  let record = await store.get(sessionId);
  assert(record?.status === "paused_quota", "checkpoint was not persisted as paused");
  assert(record.checkpoint?.summary === checkpointText, "checkpoint plan was not preserved");
  assert(!JSON.stringify(record).includes(privateMarker), "private prompt leaked into checkpoint state");
  assert(!(await exists(proofPath)), "remaining work ran before quota recovery");
  timeline.push("10%: tool blocked, turn stopped, structured checkpoint persisted");

  const pausedEvents = [];
  const pausedController = new ChatContinuityController({
    client: new SimulatedAppServer("paused", initialTurnId),
    store,
    workspace: inspector,
    lockManager: new WorktreeLockManager(dataDir, { holderId: "paused-watcher" }),
    onEvent: async (event) => pausedEvents.push(event),
  });
  await pausedController.reconcile(quotaSummary(10, firstWindow), { now: now + 63 });
  await pausedController.reconcile(quotaSummary(49, recoveredWindow), { now: now + 64 });
  const pauseNotifications = pausedEvents.filter(
    (event) => event.type === "chat_continuity_paused",
  );
  assert(pauseNotifications.length === 1, "pause notification was not deduplicated");
  assert(
    pauseNotifications[0].resumePrepared === true,
    "pause notification promised recovery without a workspace fingerprint",
  );
  assert(!(await exists(proofPath)), "task resumed below the 50% recovery floor");
  timeline.push("10%-49%: stayed paused; no duplicate notification and no early resume");

  const clientA = new SimulatedAppServer("watcher-a", initialTurnId);
  const clientB = new SimulatedAppServer("watcher-b", initialTurnId);
  const eventsA = [];
  const eventsB = [];
  const controllerA = new ChatContinuityController({
    client: clientA,
    store,
    workspace: inspector,
    lockManager: new WorktreeLockManager(dataDir, { holderId: "watcher-a" }),
    onEvent: async (event) => eventsA.push(event.type),
  });
  const controllerB = new ChatContinuityController({
    client: clientB,
    store,
    workspace: inspector,
    lockManager: new WorktreeLockManager(dataDir, { holderId: "watcher-b" }),
    onEvent: async (event) => eventsB.push(event.type),
  });
  const recovered = quotaSummary(80, recoveredWindow);
  await Promise.all([
    controllerA.reconcile(recovered, { now: now + 120 }),
    controllerB.reconcile(recovered, { now: now + 120 }),
  ]);

  const startsA = clientA.calls.filter((call) => call.method === "turn/start");
  const startsB = clientB.calls.filter((call) => call.method === "turn/start");
  assert(startsA.length + startsB.length === 1, "concurrent watchers started the chat more than once");
  record = await store.get(sessionId);
  assert(record?.status === "running", "recovered chat did not enter running state");
  assert(record.resumeCount === 1, "resume count was not exactly one");
  assert(await exists(proofPath), "simulated resumed task did not execute the next action");
  timeline.push("80%: concurrent watchers detected recovery and exactly one resumed the same chat");

  await Promise.all([
    controllerA.reconcile(recovered, { now: now + 121 }),
    controllerB.reconcile(recovered, { now: now + 121 }),
  ]);
  assert(
    clientA.calls.filter((call) => call.method === "turn/start").length +
      clientB.calls.filter((call) => call.method === "turn/start").length ===
      1,
    "a later watcher poll started a duplicate turn",
  );

  const ownerController = startsA.length ? controllerA : controllerB;
  await ownerController.handleNotification({
    method: "turn/completed",
    params: {
      threadId: sessionId,
      turnId: record.turnId,
      turn: { id: record.turnId, status: "completed" },
    },
  });
  record = await store.get(sessionId);
  assert(record?.status === "complete", "resumed task completion was not persisted");
  assert(record.worktreeLock == null, "worktree lock was not released after completion");
  assert((await readFile(proofPath, "utf8")) === "RESUME_OK\n", "resume proof is incorrect");
  const locks = await readdir(path.join(dataDir, "worktree-locks"));
  assert(locks.length === 0, "worktree lock directory was not empty after completion");
  timeline.push("completion: result persisted, lock released, later polls remained idempotent");

  succeeded = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "offline_full_chain_with_synthetic_quota_and_simulated_app_server",
        quotaSpent: 0,
        timeline,
        checkpoint: checkpointText,
        resumeCount: record.resumeCount,
        proof: (await readFile(proofPath, "utf8")).trim(),
        remainingLocks: locks,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message, evidence: root }, null, 2));
  process.exitCode = 1;
} finally {
  if (succeeded) await rm(root, { recursive: true, force: true });
}
