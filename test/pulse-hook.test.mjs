import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleHook as handleHookImpl } from "../plugin/scripts/pulse-hook.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";

const NOW = 2_000_000_000;
const APP_ROOT = path.resolve(import.meta.dirname, "..");
const noGoalCoordinator = {
  async pauseIfActive() {
    return { paused: false, status: null };
  },
};

function handleHook(input, options = {}) {
  return handleHookImpl(input, {
    goalCoordinator: noGoalCoordinator,
    ...options,
  });
}

async function createDataDir(remaining) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-hook-"));
  await writeFile(
    path.join(dataDir, "state.json"),
    JSON.stringify({
      fiveHour: { lastCheckedAt: NOW },
      lastSummary: {
        planType: "plus",
        fiveHour: {
          remainingPercent: remaining,
          usedPercent: 100 - remaining,
          resetsAt: NOW + 3 * 3600,
        },
        weekly: { remainingPercent: 70, usedPercent: 30 },
        resetCredits: { availableCount: 0, expiries: [] },
      },
    }),
  );
  return dataDir;
}

test("ordinary prompt gets bounded guidance at low quota without storing its text", async () => {
  const dataDir = await createDataDir(12);
  const output = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      model: "gpt-6.1-sol",
      prompt: "请完整重构这个模块，并补齐端到端测试",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );

  assert.match(output.systemMessage, /Codex Pulse/);
  assert.match(output.hookSpecificOutput.additionalContext, /bounded/);
  const saved = JSON.parse(
    await readFile(
      path.join(dataDir, "usage-observations", "session-1-turn-1.json"),
      "utf8",
    ),
  );
  assert.equal(saved.taskSize, "large");
  assert.equal("prompt" in saved, false);
});

test("the same low-quota decision stays model-visible without nagging the user twice", async () => {
  const dataDir = await createDataDir(12);
  const first = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-dedupe",
      turn_id: "turn-a",
      model: "gpt-6.1-sol",
      prompt: "请完整重构这个模块",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );
  const second = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-dedupe",
      turn_id: "turn-b",
      model: "gpt-6.1-sol",
      prompt: "继续完成刚才的任务",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 1 },
  );

  assert.match(first.systemMessage, /Codex Pulse/);
  assert.equal(second.systemMessage, undefined);
  assert.match(second.hookSpecificOutput.additionalContext, /bounded/);
});

test("a recovered start-now decision is surfaced once", async () => {
  const dataDir = await createDataDir(12);
  const base = {
    hook_event_name: "UserPromptSubmit",
    session_id: "session-recovery",
    model: "gpt-6.1-sol",
    prompt: "完成这个中等任务",
  };
  await handleHook(
    { ...base, turn_id: "turn-low" },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );
  const statePath = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.fiveHour.lastCheckedAt = NOW + 60;
  state.lastSummary.fiveHour.remainingPercent = 80;
  state.lastSummary.fiveHour.usedPercent = 20;
  await writeFile(statePath, JSON.stringify(state));

  const recovered = await handleHook(
    { ...base, turn_id: "turn-recovered" },
    { dataDir, appRoot: APP_ROOT, now: NOW + 60 },
  );
  const quiet = await handleHook(
    { ...base, turn_id: "turn-still-healthy" },
    { dataDir, appRoot: APP_ROOT, now: NOW + 61 },
  );

  assert.match(recovered.systemMessage, /现在可以开工/);
  assert.equal(quiet, null);
});

test("healthy quota records a turn but does not add model context", async () => {
  const dataDir = await createDataDir(80);
  const output = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-2",
      turn_id: "turn-2",
      model: "gpt-6.1-sol",
      prompt: "解释这个函数",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );
  assert.equal(output, null);
  assert.equal(await new ChatContinuityStore(dataDir).get("session-2"), null);
});

test("weekly pacing is advisory and never hard-stops an explicit prompt", async () => {
  const dataDir = await createDataDir(90);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "strict_reserve" }),
  );
  const statePath = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.lastSummary.weekly = {
    remainingPercent: 8,
    usedPercent: 92,
    resetsAt: NOW + 4 * 86400,
  };
  await writeFile(statePath, JSON.stringify(state));

  const output = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "weekly-advisory-session",
      turn_id: "weekly-advisory-turn",
      model: "gpt-6.1-sol",
      prompt: "继续完成这个明确指定的任务",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );

  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /可以继续/);
  assert.match(output.hookSpecificOutput.additionalContext, /continue it/);
  assert.match(output.hookSpecificOutput.additionalContext, /Only the configured five-hour/);

  const toolCheck = await handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "weekly-advisory-session",
      turn_id: "weekly-advisory-turn",
      model: "gpt-6.1-sol",
      tool_name: "apply_patch",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 1 },
  );
  assert.equal(toolCheck, null);
});

test("Stop closes the local observation with real percentage consumption", async () => {
  const dataDir = await createDataDir(30);
  const base = {
    session_id: "session-3",
    turn_id: "turn-3",
    model: "gpt-6.1-sol",
  };
  await handleHook(
    {
      ...base,
      hook_event_name: "UserPromptSubmit",
      prompt: "检查并修一个问题",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );
  const statePath = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.fiveHour.lastCheckedAt = NOW + 60;
  state.lastSummary.fiveHour.remainingPercent = 24;
  state.lastSummary.fiveHour.usedPercent = 76;
  await writeFile(statePath, JSON.stringify(state));

  const output = await handleHook(
    { ...base, hook_event_name: "Stop", last_assistant_message: "done" },
    { dataDir, appRoot: APP_ROOT, now: NOW + 60 },
  );
  assert.deepEqual(output, {});
  const saved = JSON.parse(
    await readFile(
      path.join(dataDir, "usage-observations", "session-3-turn-3.json"),
      "utf8",
    ),
  );
  assert.equal(saved.consumedPercent, 6);
  assert.equal(saved.outcome, "completed");
  assert.equal(saved.durationSeconds, 60);
});

test("in-turn low-quota guidance is emitted once per threshold band", async () => {
  const dataDir = await createDataDir(14);
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "session-4",
    turn_id: "turn-4",
    model: "gpt-6.1-sol",
    tool_name: "Bash",
  };
  const first = await handleHook(input, { dataDir, appRoot: APP_ROOT, now: NOW });
  const duplicate = await handleHook(input, {
    dataDir,
    appRoot: APP_ROOT,
    now: NOW + 1,
  });
  assert.match(first.systemMessage, /停止扩展范围/);
  assert.equal(duplicate, null);
});

test("strict-reserve mode blocks new turns and stops at the hard floor", async () => {
  const dataDir = await createDataDir(9);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "strict_reserve" }),
  );
  const blocked = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "strict-session",
      turn_id: "strict-turn",
      model: "gpt-6.1-sol",
      prompt: "继续实现",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );
  const stopped = await handleHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "strict-session",
      turn_id: "active-turn",
      model: "gpt-6.1-sol",
      tool_name: "Bash",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );

  assert.equal(blocked.decision, "block");
  assert.match(blocked.reason, /严格保余额/);
  assert.equal(stopped.decision, "block");
  assert.match(stopped.reason, /hard floor/);
});

test("ordinary chat blocks further tools and saves one local checkpoint without storing the prompt", async () => {
  const dataDir = await createDataDir(80);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "strict_reserve" }),
  );
  const store = new ChatContinuityStore(dataDir);
  const base = {
    session_id: "ordinary-thread",
    model: "gpt-6.1-sol",
    cwd: process.cwd(),
    permission_mode: "default",
  };
  const originalPrompt = "实现内部机密功能 ALPHA-PRIVATE-DO-NOT-STORE";
  await handleHook(
    {
      ...base,
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-work",
      prompt: originalPrompt,
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );

  const statePath = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.fiveHour.lastCheckedAt = NOW + 60;
  state.lastSummary.fiveHour.remainingPercent = 9;
  state.lastSummary.fiveHour.usedPercent = 91;
  await writeFile(statePath, JSON.stringify(state));

  const stopped = await handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      turn_id: "turn-work",
      tool_name: "Bash",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 60 },
  );
  assert.equal(stopped.decision, "block");
  assert.match(stopped.reason, /Do not call another tool/);
  assert.equal((await store.get(base.session_id)).status, "checkpoint_requested");

  const deniedTool = await handleHook(
    {
      ...base,
      hook_event_name: "PreToolUse",
      turn_id: "turn-work",
      tool_name: "apply_patch",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 61 },
  );
  assert.equal(deniedTool.decision, "block");
  assert.match(deniedTool.reason, /Do not call another tool/);

  const checkpointSummary =
    "Completed: phase one. Remaining: phase two. Verification: unit tests pass. Blockers: none.";
  const saved = await handleHook(
    {
      ...base,
      hook_event_name: "Stop",
      turn_id: "turn-work",
      stop_hook_active: false,
      last_assistant_message: checkpointSummary,
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 62 },
  );
  const record = await store.get(base.session_id);
  assert.equal(saved.continue, false);
  assert.equal(record.status, "paused_quota");
  assert.equal(record.turnId, "turn-work");
  assert.equal(record.checkpoint.summary, checkpointSummary);
  assert.equal(record.resumeMode, "manual");
  assert.equal(record.goalWasActive, false);
  assert.equal(record.autoResume, false);
  assert.equal(record.resumeUnavailableReason, "native_goal_required");
  assert.equal(JSON.stringify(record).includes(originalPrompt), false);
});

test("ordinary chat with an active native Goal is paused and prepared for Goal recovery", async () => {
  const dataDir = await createDataDir(9);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "strict_reserve" }),
  );
  const calls = [];
  const goalCoordinator = {
    async pauseIfActive(threadId) {
      calls.push(threadId);
      return { paused: true, status: "paused" };
    },
  };
  const base = {
    session_id: "goal-thread",
    turn_id: "goal-turn",
    model: "gpt-6.1-sol",
    cwd: process.cwd(),
    permission_mode: "default",
  };

  const stopped = await handleHookImpl(
    { ...base, hook_event_name: "PostToolUse", tool_name: "Bash" },
    { dataDir, appRoot: APP_ROOT, now: NOW, goalCoordinator },
  );
  assert.equal(stopped.decision, "block");

  const checkpoint = await handleHookImpl(
    {
      ...base,
      hook_event_name: "Stop",
      last_assistant_message: "Completed: one. Remaining: two.",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 1, goalCoordinator },
  );
  const record = await new ChatContinuityStore(dataDir).get(base.session_id);
  assert.deepEqual(calls, ["goal-thread"]);
  assert.equal(record.status, "paused_quota");
  assert.equal(record.resumeMode, "native_goal");
  assert.equal(record.goalWasActive, true);
  assert.equal(record.autoResume, true);
  assert.match(checkpoint.systemMessage, /原生 Goal/);
  assert.match(checkpoint.systemMessage, /当前聊天续跑/);
});

test("ordinary chat checkpoint scopes workspace verification to the repo touched by the turn", async () => {
  const dataDir = await createDataDir(80);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "strict_reserve" }),
  );
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-hook-scope-"));
  const repo = path.join(cwd, "product", "app");
  const sibling = path.join(cwd, "output");
  await mkdir(repo, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(repo, "work.txt"), "baseline\n");
  await writeFile(path.join(sibling, "unrelated.txt"), "first\n");
  execFileSync("git", ["-C", repo, "init", "-q"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Codex Pulse Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "codex-pulse@example.invalid"]);
  execFileSync("git", ["-C", repo, "add", "work.txt"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "baseline"]);

  const base = {
    session_id: "scoped-thread",
    turn_id: "scoped-turn",
    model: "gpt-6.1-sol",
    cwd,
    permission_mode: "default",
  };
  await handleHook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { file_path: path.join(repo, "work.txt") },
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );

  const statePath = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.fiveHour.lastCheckedAt = NOW + 60;
  state.lastSummary.fiveHour.remainingPercent = 9;
  state.lastSummary.fiveHour.usedPercent = 91;
  await writeFile(statePath, JSON.stringify(state));
  await handleHook(
    { ...base, hook_event_name: "PostToolUse", tool_name: "Bash" },
    { dataDir, appRoot: APP_ROOT, now: NOW + 60 },
  );
  await handleHook(
    {
      ...base,
      hook_event_name: "Stop",
      last_assistant_message: "Completed: scoped checkpoint. Remaining: continue.",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 61 },
  );

  const record = await new ChatContinuityStore(dataDir).get(base.session_id);
  assert.deepEqual(record.checkpoint.workspaceSnapshot.scopes.map((scope) => scope.root), [
    path.join("product", "app"),
  ]);
  await writeFile(path.join(sibling, "unrelated.txt"), "changed elsewhere\n");
  const comparison = await new WorkspaceInspector().compareSnapshot(
    cwd,
    record.checkpoint.workspaceSnapshot,
  );
  assert.equal(comparison.same, true);
});

test("deadline mode stays quiet at fifteen percent and drains at five", async () => {
  const dataDir = await createDataDir(14);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "deadline" }),
  );
  const input = {
    hook_event_name: "PostToolUse",
    session_id: "deadline-session",
    turn_id: "deadline-turn",
    model: "gpt-6.1-sol",
    tool_name: "Bash",
  };
  const healthyForDeadline = await handleHook(input, {
    dataDir,
    appRoot: APP_ROOT,
    now: NOW,
  });
  const statePath = path.join(dataDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  state.fiveHour.lastCheckedAt = NOW + 1;
  state.lastSummary.fiveHour.remainingPercent = 5;
  state.lastSummary.fiveHour.usedPercent = 95;
  await writeFile(statePath, JSON.stringify(state));
  const draining = await handleHook(input, {
    dataDir,
    appRoot: APP_ROOT,
    now: NOW + 1,
  });

  assert.equal(healthyForDeadline, null);
  assert.match(draining.systemMessage, /截止日期模式/);
  assert.equal(draining.continue, undefined);
});

test("stale monitor data never changes a Codex turn", async () => {
  const dataDir = await createDataDir(5);
  const output = await handleHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-5",
      turn_id: "turn-5",
      model: "gpt-6.1-sol",
      prompt: "做一个任务",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 181 },
  );
  assert.equal(output, null);
});

test("stale low-quota data remains protective in strict-reserve mode", async () => {
  const dataDir = await createDataDir(9);
  await writeFile(
    path.join(dataDir, "preferences.json"),
    JSON.stringify({ quotaPolicy: "strict_reserve" }),
  );
  const output = await handleHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "stale-strict-session",
      turn_id: "stale-strict-turn",
      model: "gpt-6.1-sol",
      tool_name: "Bash",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW + 181 },
  );

  assert.equal(output.decision, "block");
  assert.match(output.reason, /hard floor/);
});

test("a late Stop from an older turn cannot complete a newer tracked turn", async () => {
  const dataDir = await createDataDir(80);
  const store = new ChatContinuityStore(dataDir);
  await store.put({
    sessionId: "turn-race-session",
    status: "running",
    cwd: process.cwd(),
    turnId: "new-turn",
    autoResume: true,
  });

  await handleHook(
    {
      hook_event_name: "Stop",
      session_id: "turn-race-session",
      turn_id: "old-turn",
      cwd: process.cwd(),
      last_assistant_message: "old turn finished late",
    },
    { dataDir, appRoot: APP_ROOT, now: NOW },
  );

  const record = await store.get("turn-race-session");
  assert.equal(record.status, "running");
  assert.equal(record.turnId, "new-turn");
});
