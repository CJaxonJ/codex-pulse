#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { handleHook } from "../plugin/scripts/pulse-hook.mjs";
import { AppServerClient } from "../src/app-server-client.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = Number(process.env.CODEX_PULSE_E2E_TIMEOUT_MS || 180_000);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-chat-e2e-"));
const dataDir = path.join(tempRoot, "data");
const workspace = path.join(tempRoot, "workspace");
const phasePath = path.join(workspace, "phase-one.txt");
const proofPath = path.join(workspace, "resume-proof.txt");
const store = new ChatContinuityStore(dataDir);
const client = new AppServerClient({ requestTimeoutMs: 30_000 });
const controller = new ChatContinuityController({
  client,
  store,
  workspace: new WorkspaceInspector(),
  lockManager: new WorktreeLockManager(dataDir),
});
const completions = new Map();
const assistantText = new Map();
const asynchronousErrors = [];
let succeeded = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, customTimeoutMs = timeoutMs) {
  const deadline = Date.now() + customTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (asynchronousErrors.length) throw asynchronousErrors[0];
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
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

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(workspace, ".gitkeep"), "", "utf8");
  git(["init", "-q"]);
  git(["config", "user.name", "Codex Pulse E2E"]);
  git(["config", "user.email", "codex-pulse-e2e@example.invalid"]);
  git(["add", ".gitkeep"]);
  git(["commit", "-q", "-m", "baseline"]);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    `${JSON.stringify({ quotaPolicy: "strict_reserve" })}\n`,
    "utf8",
  );

  const now = Math.floor(Date.now() / 1000);
  const windowOne = now + 3_600;
  const windowTwo = windowOne + 18_000;
  await writeHookState(quotaSummary(80, windowOne), now);

  client.on("notification", (message) => {
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id || params.item?.turnId;
    if (message.method === "item/agentMessage/delta" && turnId) {
      const delta = params.delta || params.text || params.item?.text || "";
      assistantText.set(turnId, `${assistantText.get(turnId) || ""}${delta}`);
    }
    if (message.method === "turn/completed" && turnId) {
      completions.set(turnId, params.turn?.status || "unknown");
    }
    controller.handleNotification(message).catch((error) => asynchronousErrors.push(error));
  });
  client.on("serverRequest", (message) => {
    controller.handleServerRequest(message).catch((error) => asynchronousErrors.push(error));
  });
  await client.start();

  const started = await client.request("thread/start", {
    model: "gpt-6.1-sol",
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "codex_pulse_chat_e2e",
  });
  const sessionId = started.thread.id;
  const objective = [
    "Create phase-one.txt containing exactly PHASE_ONE followed by one newline.",
    "Then run sleep 45 as an intentional interruption barrier.",
    "After the barrier create resume-proof.txt containing exactly RESUME_OK followed by one newline.",
    "Read both files back and finish. Do not create or modify any other files.",
  ].join(" ");
  const firstTurn = await client.request("turn/start", {
    threadId: sessionId,
    input: [{ type: "text", text: objective }],
  });
  const firstTurnId = firstTurn.turn.id;
  await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      turn_id: firstTurnId,
      cwd: workspace,
      model: "gpt-6.1-sol",
      permission_mode: "default",
      prompt: objective,
    },
    { dataDir, appRoot: projectDir, now },
  );

  await waitFor(() => fileExists(phasePath), "phase one output", 45_000);
  if (await fileExists(proofPath)) throw new Error("resume proof existed before quota pause");

  await writeHookState(quotaSummary(9, windowOne), now + 60);
  const postTool = await handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: firstTurnId,
      cwd: workspace,
      model: "gpt-6.1-sol",
      permission_mode: "default",
      tool_name: "Bash",
    },
    { dataDir, appRoot: projectDir, now: now + 60 },
  );
  if (postTool?.decision !== "block" || !postTool.reason) {
    throw new Error("hard-floor hook did not block further tool work");
  }
  await client.request("turn/steer", {
    threadId: sessionId,
    expectedTurnId: firstTurnId,
    input: [{ type: "text", text: postTool.reason }],
  });
  await waitFor(() => completions.has(firstTurnId), "the guarded turn to stop", 90_000);
  if (completions.get(firstTurnId) !== "completed") {
    throw new Error(`guarded turn ended as ${completions.get(firstTurnId)}`);
  }
  if (await fileExists(proofPath)) {
    throw new Error("guarded turn crossed the interruption barrier before recovery");
  }

  const generatedCheckpoint = String(assistantText.get(firstTurnId) || "").trim();
  if (!generatedCheckpoint) throw new Error("guarded turn produced no assistant checkpoint");
  const savedCheckpoint = await handleHook(
    {
      hook_event_name: "Stop",
      session_id: sessionId,
      turn_id: firstTurnId,
      cwd: workspace,
      model: "gpt-6.1-sol",
      permission_mode: "default",
      stop_hook_active: false,
      last_assistant_message: generatedCheckpoint,
    },
    { dataDir, appRoot: projectDir, now: now + 61 },
  );
  if (savedCheckpoint?.continue !== false) {
    throw new Error("Stop hook did not persist the guarded turn checkpoint");
  }
  const paused = await store.get(sessionId);
  if (paused?.status !== "paused_quota") {
    throw new Error(`chat was not checkpointed: ${JSON.stringify(paused)}`);
  }
  if (await fileExists(proofPath)) throw new Error("resume proof existed before recovery");

  await writeHookState(quotaSummary(85, windowTwo), now + 120);
  const events = await controller.reconcile(quotaSummary(85, windowTwo), {
    now: now + 120,
  });
  if (events[0]?.type !== "chat_continuity_resumed") {
    throw new Error(`chat did not resume: ${JSON.stringify(events)}`);
  }
  const resumedTurnId = events[0].turnId;
  await waitFor(async () => {
    const record = await store.get(sessionId);
    return record?.status === "complete" && (await fileExists(proofPath));
  }, "resumed chat completion");

  if ((await readFile(phasePath, "utf8")) !== "PHASE_ONE\n") {
    throw new Error("phase one output changed after resume");
  }
  if ((await readFile(proofPath, "utf8")) !== "RESUME_OK\n") {
    throw new Error("resume proof is incorrect");
  }
  await controller.reconcile(quotaSummary(85, windowTwo), { now: now + 121 });
  const completed = await store.get(sessionId);
  if (completed.resumeCount !== 1) {
    throw new Error(`chat resumed ${completed.resumeCount} times`);
  }
  const lockNames = await readdir(path.join(dataDir, "worktree-locks"));
  if (lockNames.length) throw new Error(`worktree locks remain: ${lockNames.join(",")}`);

  succeeded = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode:
          "real_app_server_with_simulated_trusted_hook_feedback_and_synthetic_quota_edges",
        sessionId,
        guardedTurnId: firstTurnId,
        resumedTurnId,
        checkpointCharacters: generatedCheckpoint.length,
        resumeCount: completed.resumeCount,
        proof: (await readFile(proofPath, "utf8")).trim(),
        worktreeLocksAfterCompletion: lockNames,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error.message,
        preservedEvidence: tempRoot,
        completions: Object.fromEntries(completions),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  client.stop();
  if (succeeded) await rm(tempRoot, { recursive: true, force: true });
}
