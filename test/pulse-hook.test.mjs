import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { handleHook } from "../plugin/scripts/pulse-hook.mjs";

const NOW = 2_000_000_000;
const APP_ROOT = path.resolve(import.meta.dirname, "..");

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
  assert.equal(stopped.continue, false);
  assert.match(stopped.stopReason, /hard floor/);
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
