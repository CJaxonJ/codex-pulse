#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { handleHook } from "../plugin/scripts/pulse-hook.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function quotaSummary(remainingPercent, resetsAt) {
  return {
    planType: "plus",
    fiveHour: {
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt,
    },
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-recovery-resilience-"));
const dataDir = path.join(root, "data");
const workspace = path.join(root, "workspace");
const proofPath = path.join(workspace, "resume-proof.txt");
const store = new ChatContinuityStore(dataDir);
const inspector = new WorkspaceInspector();
const sessionId = "sleep-network-recovery-thread";
const turnId = "quota-paused-turn";
const now = 2_100_000_000;
const firstWindow = now + 3_600;
const recoveredWindow = firstWindow + 18_000;
const goalState = { goal: null };
const calls = [];
let succeeded = false;

class OfflineAppServer {
  async request(method, params) {
    calls.push({ watcher: "offline", method, params });
    throw new Error("thread/turns/list timed out after 15000ms while offline");
  }
}

class RecoveredAppServer {
  async request(method, params) {
    calls.push({ watcher: "restarted", method, params });
    if (method === "thread/turns/list") {
      return { data: [{ id: turnId, status: "completed" }] };
    }
    if (method === "thread/goal/get") {
      return { goal: goalState.goal ? { ...goalState.goal } : null };
    }
    if (method === "thread/goal/set") {
      goalState.goal = {
        status: params.status,
        objective: params.objective ?? goalState.goal?.objective,
      };
      return { goal: { ...goalState.goal } };
    }
    if (["thread/resume", "turn/start"].includes(method)) {
      throw new Error(`Desktop recovery must not call ${method}`);
    }
    return {};
  }
}

try {
  await mkdir(workspace, { recursive: true });
  execFileSync("git", ["-C", workspace, "init", "-q"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Codex Pulse Test"]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
  await writeFile(path.join(workspace, "baseline.txt"), "baseline\n", "utf8");
  execFileSync("git", ["-C", workspace, "add", "baseline.txt"]);
  execFileSync("git", ["-C", workspace, "commit", "-q", "-m", "baseline"]);
  const fingerprint = await inspector.fingerprint(workspace);
  assert(fingerprint, "workspace fingerprint was not created");

  await store.put({
    id: `chat:${sessionId}`,
    sessionId,
    status: "paused_quota",
    cwd: workspace,
    turnId,
    autoResume: false,
    resumeMode: "manual",
    goalWasActive: false,
    workspaceValidationMode: "pre_tool_hook_v1",
    resumeUnavailableReason: "native_goal_required",
    resumeFloor: 50,
    pausedWindowKey: firstWindow,
    pausedRemaining: 10,
    pausedAt: now,
    checkpoint: {
      summary: [
        "Completed: saved the quota checkpoint.",
        "Verification: the pre-pause work passed.",
        "Remaining: prove recovery after network loss and watcher restart.",
        "Next action: create resume-proof.txt.",
        "Blockers: the App Server is temporarily unreachable.",
      ].join("\n"),
      workspaceFingerprint: fingerprint,
    },
  });
  await writeFile(
    path.join(dataDir, "state.json"),
    `${JSON.stringify({
      fiveHour: { lastCheckedAt: now + 31 },
      lastSummary: quotaSummary(80, recoveredWindow),
    })}\n`,
    "utf8",
  );

  const offlineController = new ChatContinuityController({
    client: new OfflineAppServer(),
    store,
    workspace: inspector,
    lockManager: new WorktreeLockManager(dataDir, {
      holderId: "offline-watcher",
      pid: 11111,
      isProcessAlive: () => true,
    }),
  });
  const recovered = quotaSummary(80, recoveredWindow);
  const offlineEvents = await offlineController.reconcile(recovered, { now: now + 1 });
  let record = await store.get(sessionId);
  assert(offlineEvents.length === 0, "a transient outage emitted a terminal alert");
  assert(record.status === "paused_quota", "a transient outage became terminal");
  assert(record.retryNotBefore === now + 31, "retry backoff was not persisted");
  assert(record.worktreeLock?.holderId === "offline-watcher", "offline state lost its lock");
  assert(!(await exists(proofPath)), "work resumed while the App Server was offline");

  const restartController = new ChatContinuityController({
    client: new RecoveredAppServer(),
    store,
    workspace: inspector,
    lockManager: new WorktreeLockManager(dataDir, {
      holderId: "restarted-watcher",
      pid: 22222,
      isProcessAlive: () => false,
    }),
  });
  const events = await restartController.reconcile(recovered, { now: now + 31 });
  record = await store.get(sessionId);
  assert(events.some((event) => event.type === "chat_continuity_resumed"), "restart did not resume");
  assert(record.status === "native_goal_active", "restarted watcher did not activate a Goal");
  assert(record.resumeCount === 1, "recovery was not exactly once");
  assert(record.worktreeLock?.holderId === "restarted-watcher", "restart did not reclaim the lock");
  assert(record.workspaceValidationRequired === true, "recovery skipped pre-tool validation");
  assert(!(await exists(proofPath)), "resumed work ran before trusted-hook validation");
  const validation = await handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      turn_id: "recovered-turn",
      cwd: workspace,
      tool_name: "apply_patch",
      tool_input: { file_path: proofPath },
    },
    {
      dataDir,
      appRoot: path.resolve(import.meta.dirname, ".."),
      now: now + 31,
      goalCoordinator: { async pauseIfActive() { return { paused: false }; } },
    },
  );
  assert(validation == null, "trusted hook rejected the unchanged workspace");
  await writeFile(proofPath, "RESUMED_AFTER_RESTART\n", "utf8");
  assert(await exists(proofPath), "resumed work did not create its proof");
  assert(
    (await readFile(proofPath, "utf8")) === "RESUMED_AFTER_RESTART\n",
    "resume proof is incorrect",
  );
  assert(
    calls.filter((call) => call.method === "thread/goal/set" && call.params.status === "active")
      .length === 1,
    "recovery activated the Goal more than once",
  );
  assert(
    calls.every((call) => !["thread/resume", "turn/start"].includes(call.method)),
    "recovery used an unsupported external writer path",
  );

  await restartController.reconcile(recovered, { now: now + 32 });
  assert(
    calls.filter((call) => call.method === "thread/goal/set" && call.params.status === "active")
      .length === 1,
    "a later poll activated the Goal twice",
  );

  goalState.goal.status = "complete";
  await restartController.reconcile(recovered, { now: now + 33 });
  record = await store.get(sessionId);
  assert(record.status === "complete", "Goal completion was not persisted");
  assert(record.worktreeLock == null, "worktree lock was not released after completion");
  assert((await readdir(path.join(dataDir, "worktree-locks"))).length === 0, "lock directory is not empty");

  succeeded = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "offline_then_watcher_restart_then_goal_bootstrap",
        quotaSpent: 0,
        retryCountBeforeRecovery: 1,
        resumeCount: record.resumeCount,
        proof: (await readFile(proofPath, "utf8")).trim(),
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
