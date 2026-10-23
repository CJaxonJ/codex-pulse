#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { AppServerClient } from "../src/app-server-client.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { NativeGoalCoordinator } from "../src/native-goal-coordinator.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = process.env.CODEX_PULSE_DESKTOP_THREAD_ID;
const workspace = path.resolve(process.env.CODEX_PULSE_DESKTOP_CWD || process.cwd());
const installedPlugin = path.join(
  os.homedir(),
  ".codex",
  "plugins",
  "cache",
  "codex-pulse-local",
  "codex-pulse",
  "0.9.16",
  "scripts",
  "pulse-hook.mjs",
);
const installedRuntime = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Codex Pulse",
  "app",
);
const evidencePath = path.join(os.tmpdir(), "codex-pulse-desktop-goal-canary.json");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-desktop-goal-"));
const dataDir = path.join(tempRoot, "data");
const client = new AppServerClient({ requestTimeoutMs: 30_000 });
const calls = [];

if (!threadId) {
  throw new Error("CODEX_PULSE_DESKTOP_THREAD_ID is required");
}

const recordedClient = {
  async request(method, params) {
    calls.push({ method, params });
    if (["thread/resume", "turn/start"].includes(method)) {
      throw new Error(`Desktop Goal acceptance forbids ${method}`);
    }
    return client.request(method, params);
  },
};

function quotaSummary(remainingPercent, resetsAt) {
  return {
    planType: "plus",
    fiveHour: {
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt,
    },
    weekly: { remainingPercent: 50, usedPercent: 50, resetsAt: resetsAt + 500_000 },
    resetCredits: { availableCount: 2, expiries: [] },
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

let succeeded = false;
try {
  const { handleHook } = await import(pathToFileURL(installedPlugin).href);
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    path.join(dataDir, "preferences.json"),
    `${JSON.stringify({ quotaPolicy: "strict_reserve" })}\n`,
    "utf8",
  );
  await client.start();

  const history = await client.request("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: "notLoaded",
  });
  const turnId = history.data?.[0]?.id;
  if (!turnId) throw new Error("current Desktop turn was not found");

  const before = await client.request("thread/goal/get", { threadId });
  if (before.goal?.status !== "active") {
    throw new Error(`expected an active Goal, found ${before.goal?.status || "none"}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const oldWindow = now + 3_600;
  const recoveredWindow = oldWindow + 18_000;
  const hookInput = {
    session_id: threadId,
    turn_id: turnId,
    cwd: workspace,
    model: "gpt-6.1-sol",
    permission_mode: "default",
  };
  const goalCoordinator = new NativeGoalCoordinator();

  await writeHookState(quotaSummary(70, oldWindow), now);
  await handleHook(
    {
      ...hookInput,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { file_path: path.join(workspace, "README.md") },
    },
    { dataDir, appRoot: installedRuntime, now, goalCoordinator },
  );

  const checkpoint = [
    "Completed: installed Hook observed work before the synthetic quota boundary.",
    "Verification: the test uses the real Desktop thread and forbids external turn creation.",
    "Remaining: prove Desktop starts the next turn after Goal reactivation.",
    "Next action: after this turn becomes idle, inspect the canary and finish the acceptance.",
    "Blockers: none.",
  ].join("\n");
  await writeHookState(quotaSummary(9, oldWindow), now + 1);
  const saved = await handleHook(
    {
      ...hookInput,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: checkpoint,
    },
    { dataDir, appRoot: installedRuntime, now: now + 1, goalCoordinator },
  );
  if (saved?.continue !== false) {
    throw new Error("installed Stop hook missed the late 10% crossing");
  }

  const pausedGoal = await client.request("thread/goal/get", { threadId });
  if (pausedGoal.goal?.status !== "paused") {
    throw new Error(`Goal did not pause; found ${pausedGoal.goal?.status || "none"}`);
  }

  await writeHookState(quotaSummary(80, recoveredWindow), now + 2);
  const store = new ChatContinuityStore(dataDir);
  const events = await new ChatContinuityController({
    client: recordedClient,
    store,
    workspace: new WorkspaceInspector(),
  }).reconcile(quotaSummary(80, recoveredWindow), { now: now + 2 });
  if (events[0]?.type !== "chat_continuity_resumed") {
    throw new Error(`Goal did not reactivate: ${JSON.stringify(events)}`);
  }

  const after = await client.request("thread/goal/get", { threadId });
  if (after.goal?.status !== "active") {
    throw new Error(`Goal did not become active; found ${after.goal?.status || "none"}`);
  }
  if (calls.some((call) => ["thread/resume", "turn/start"].includes(call.method))) {
    throw new Error("an external writer method was attempted");
  }

  await client.request("thread/goal/set", {
    threadId,
    objective: before.goal.objective,
    ...(before.goal.tokenBudget != null ? { tokenBudget: before.goal.tokenBudget } : {}),
    status: "active",
    origin: "automatic",
  });
  const restored = await client.request("thread/goal/get", { threadId });
  if (
    restored.goal?.status !== "active" ||
    restored.goal?.objective !== before.goal.objective
  ) {
    throw new Error("the acceptance canary did not restore the original active Goal");
  }

  const record = await store.get(threadId);
  const evidence = {
    ok: true,
    phase: "reactivated_waiting_for_desktop_continuation",
    threadId,
    pausedTurnId: turnId,
    resumeMode: record?.resumeMode,
    resumeCount: record?.resumeCount,
    goalStatus: restored.goal.status,
    originalGoalRestored: true,
    externalWriterCalls: calls.filter((call) =>
      ["thread/resume", "turn/start"].includes(call.method),
    ).length,
    reactivatedAt: now + 2,
  };
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  succeeded = true;
  console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
} finally {
  client.stop();
  if (succeeded) await rm(tempRoot, { recursive: true, force: true });
}
