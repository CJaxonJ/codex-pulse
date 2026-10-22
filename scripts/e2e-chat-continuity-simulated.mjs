#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleHook as handleHookImpl } from "../plugin/scripts/pulse-hook.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-simulated-continuity-"));
const dataDir = path.join(root, "data");
const workspace = path.join(root, "workspace");
const projectWorkspace = path.join(workspace, "product", "app");
const unrelatedWorkspace = path.join(workspace, "output");
const proofPath = path.join(projectWorkspace, "resume-proof.txt");
const store = new ChatContinuityStore(dataDir);
const inspector = new WorkspaceInspector();
const timeline = [];
let succeeded = false;
const originalGoalObjective =
  "Deliver the requested feature with proof, without expanding scope or consuming reset cards.";
const goalState = { status: "active", objective: originalGoalObjective };
const threadState = {
  latestTurnId: "simulated-initial-turn",
  latestTurnStatus: "completed",
};
const goalCoordinator = {
  async pauseIfActive() {
    if (goalState.status !== "active") {
      return { paused: false, status: goalState.status, goalSnapshot: { ...goalState } };
    }
    const goalSnapshot = { ...goalState };
    goalState.status = "paused";
    return { paused: true, status: "paused", goalSnapshot };
  },
};

function handleHook(input, options = {}) {
  return handleHookImpl(input, { goalCoordinator, ...options });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function git(args) {
  execFileSync("git", ["-C", projectWorkspace, ...args], { stdio: "ignore" });
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
    threadState.latestTurnId = initialTurnId;
    this.calls = [];
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/turns/list") {
      return {
        data: [{ id: threadState.latestTurnId, status: threadState.latestTurnStatus }],
      };
    }
    if (method === "thread/goal/get") {
      return { goal: goalState.status ? { ...goalState } : null };
    }
    if (method === "thread/goal/set") {
      Object.assign(goalState, params);
      if (params.status === "active") {
        threadState.latestTurnId = "simulated-native-goal-turn";
        threadState.latestTurnStatus = "inProgress";
        await writeFile(proofPath, "RESUME_OK\n", "utf8");
      }
      return { goal: { ...goalState } };
    }
    if (["thread/resume", "turn/start"].includes(method)) {
      throw new Error(`ordinary Desktop chat must not call ${method}`);
    }
    return {};
  }
}

try {
  await mkdir(projectWorkspace, { recursive: true });
  await mkdir(unrelatedWorkspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(projectWorkspace, ".gitkeep"), "", "utf8");
  await writeFile(path.join(unrelatedWorkspace, "unrelated.txt"), "first\n", "utf8");
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
  await handleHook(
    {
      ...baseHook,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { file_path: path.join(projectWorkspace, ".gitkeep") },
    },
    { dataDir, appRoot: projectDir, now: now + 1 },
  );

  await writeHookState(quotaSummary(10, firstWindow), now + 60);
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
    { dataDir, appRoot: projectDir, now: now + 60 },
  );
  assert(
    stopped?.continue === false,
    "Stop hook did not checkpoint a turn whose quota crossed after the last tool",
  );
  let record = await store.get(sessionId);
  assert(record?.status === "paused_quota", "checkpoint was not persisted as paused");
  assert(record.checkpoint?.summary === checkpointText, "checkpoint plan was not preserved");
  assert(
    record.initialGoal?.objective === originalGoalObjective,
    "the original user-approved Goal was not preserved exactly",
  );
  assert(
    record.checkpoint?.continuationGoal?.objective?.includes(originalGoalObjective),
    "the continuation Goal lost the original objective",
  );
  assert(
    record.checkpoint?.continuationGoal?.objective?.includes(
      "create resume-proof.txt with RESUME_OK",
    ),
    "the continuation Goal lost the checkpoint next action",
  );
  assert(
    record.checkpoint?.workspaceSnapshot?.scopes?.[0]?.root === path.join("product", "app"),
    "checkpoint did not scope verification to the touched nested repository",
  );
  assert(!JSON.stringify(record).includes(privateMarker), "private prompt leaked into checkpoint state");
  assert(!(await exists(proofPath)), "remaining work ran before quota recovery");
  timeline.push("10% after the last tool: Stop still paused the Goal and persisted the checkpoint");

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

  await writeFile(
    path.join(unrelatedWorkspace, "unrelated.txt"),
    "changed while the task was paused\n",
    "utf8",
  );
  timeline.push("pause: unrelated sibling workspace changed without invalidating the task checkpoint");

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

  const activationsA = clientA.calls.filter(
    (call) => call.method === "thread/goal/set" && call.params.status === "active",
  );
  const activationsB = clientB.calls.filter(
    (call) => call.method === "thread/goal/set" && call.params.status === "active",
  );
  assert(
    activationsA.length + activationsB.length === 1,
    "concurrent watchers activated the native Goal more than once",
  );
  const activation = activationsA[0] || activationsB[0];
  assert(
    activation.params.objective === record.checkpoint.continuationGoal.objective,
    "recovery did not activate the composed continuation Goal",
  );
  assert(
    [...clientA.calls, ...clientB.calls].every(
      (call) => !["thread/resume", "turn/start"].includes(call.method),
    ),
    "ordinary Desktop chat used the external writer path",
  );
  record = await store.get(sessionId);
  assert(record?.status === "native_goal_active", "recovered chat did not enter native Goal state");
  assert(record.resumeCount === 1, "resume count was not exactly one");
  assert(await exists(proofPath), "simulated resumed task did not execute the next action");
  timeline.push("80%: concurrent watchers detected recovery and exactly one reactivated the native Goal");

  await Promise.all([
    controllerA.reconcile(recovered, { now: now + 121 }),
    controllerB.reconcile(recovered, { now: now + 121 }),
  ]);
  assert(
    clientA.calls.filter(
      (call) => call.method === "thread/goal/set" && call.params.status === "active",
    ).length +
      clientB.calls.filter(
        (call) => call.method === "thread/goal/set" && call.params.status === "active",
      ).length ===
      1,
    "a later watcher poll activated the native Goal twice",
  );

  const ownerController = activationsA.length ? controllerA : controllerB;
  goalState.status = "complete";
  threadState.latestTurnStatus = "completed";
  await ownerController.reconcile(recovered, { now: now + 122 });
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
        mode: "offline_full_chain_with_synthetic_quota_and_native_goal_protocol",
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
