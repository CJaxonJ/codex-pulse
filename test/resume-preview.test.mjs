import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { buildResumePreview, readResumePreview } from "../src/resume-preview.mjs";

const now = 1000;
const state = { fiveHour: { lastCheckedAt: now }, lastSummary: { fiveHour: { remainingPercent: 10, resetsAt: 2000 } } };
const chat = { sessionId: "a", initialGoal: { objective: "原目标不能改" }, status: "paused_quota", autoResume: true,
  pausedAt: now, checkpoint: { summary: "Completed:\n做好了一\nRemaining:\n还有二\nNext action:\n先测试\nBlockers:\n当前额度不足" } };
const preview = (record = chat, opts = {}) => buildResumePreview({ chats: [record], state, now, ...opts }).tasks[0];

test("preview separates tasks and preserves exact original Goal, with honest window/duration", () => {
  const result = buildResumePreview({ now, state, chats: [chat, { ...chat, sessionId: "b", initialGoal: null,
    checkpoint: { summary: "Remaining: 另一个任务" } }, { ...chat, sessionId: "c", status: "complete" }] });
  assert.equal(result.tasks.length, 2);
  assert.equal(result.tasks[0].objective, "原目标不能改");
  assert.equal(result.tasks[0].nextAction, "先测试");
  assert.equal(result.tasks[1].remaining, "另一个任务");
  assert.match(result.tasks[1].objective, /未单独设置 Goal/);
  assert.equal(result.tasks[0].restart.earliestAt, 2000);
  assert.equal(result.tasks[0].restart.latestPollAt, 2060);
  assert.equal(result.tasks[0].duration.confidence, "unknown");
});

test("stale / absent Pro window / expired reset cannot fabricate start times", () => {
  assert.equal(preview(chat, { now: now + 181 }).restart.kind, "stale");
  assert.equal(preview(chat, { state: { ...state, lastSummary: { planType: "pro", fiveHour: null } } }).restart.kind, "unknown");
  assert.equal(preview(chat, { state: { ...state, lastSummary: { fiveHour: { remainingPercent: 10, resetsAt: 999 } } } }).restart.kind, "unknown");
  assert.equal(preview({ ...chat, autoResume: false }).restart.kind, "manual");
  assert.equal(preview({ ...chat, autoResume: false, resumeUnavailableReason: "native_goal_required" }).restart.kind, "window");
});

test("eligibility matches core resume floor plus new window or material recovery", () => {
  const record = { ...chat, pausedWindowKey: 2000, pausedRemaining: 9 };
  assert.equal(preview(record, { state: { ...state, lastSummary: { fiveHour: { remainingPercent: 100, resetsAt: 2000 } } } }).restart.kind, "eligible");
  assert.equal(preview(record, { state: { ...state, lastSummary: { fiveHour: { remainingPercent: 35, resetsAt: 2000 } } } }).restart.kind, "window");
  assert.equal(preview({ ...chat, status: "needs_attention", blocker: "workspace_changed" }).restart.kind, "blocked");
  assert.match(preview({ ...chat, status: "needs_attention", blocker: "workspace_changed" }).blockers, /文件已变化/);
  assert.match(preview({ ...chat, status: "native_goal_active" }).statusText, /等待实际启动/);
  assert.match(preview({ ...chat, status: "native_goal_active", executionObservedAt: now }).statusText, /观察到续跑执行/);
});

test("only explicit remaining-duration estimates accepted; whole-task history ignored", () => {
  assert.equal(preview({ ...chat, checkpoint: { summary: "Remaining: 预计剩余耗时：10–20 分钟" } }).duration.maxMinutes, 20);
  assert.equal(preview({ ...chat, checkpoint: { remainingEstimate: { minMinutes: 5, maxMinutes: 10 } } }).duration.minMinutes, 5);
  assert.equal(preview({ ...chat, checkpoint: { remainingEstimate: { minMinutes: -1, maxMinutes: 10 } } }).duration.confidence, "unknown");
  assert.equal(preview({ ...chat, checkpoint: { summary: "Completed: 上次花了 10 分钟" } }).duration.confidence, "unknown");
});

test("managed task plan uses its own checkpoint without mixing another chat", () => {
  const result = buildResumePreview({ now, state, managed: [{ id: "m", status: "paused_quota", objective: "托管目标", checkpoint: {
    completed: [{ step: "完成步骤" }], remaining: [{ step: "剩余步骤" }], currentStep: "当前步骤" } }] });
  assert.equal(result.tasks[0].remaining, "剩余步骤");
  assert.equal(result.tasks[0].nextAction, "当前步骤");
});

test("CLI reads isolated saved records only, no AppServer, no filesystem mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-preview-"));
  assert.deepEqual((await readResumePreview(root)).tasks, []);
  assert.deepEqual(await readdir(root), []);
  await mkdir(path.join(root, "chat-continuity"));
  const file = path.join(root, "chat-continuity", "a.json");
  const before = JSON.stringify(chat);
  await writeFile(file, before);
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve("bin/codex-pulse.mjs"), "preview"], {
    env: { ...process.env, CODEX_PULSE_DATA_DIR: root, CODEX_PULSE_CODEX_BIN: "/must-not-start-codex" },
  });
  assert.equal(JSON.parse(stdout).tasks[0].objective, "原目标不能改");
  assert.equal(await readFile(file, "utf8"), before);
  assert.deepEqual(await readdir(root), ["chat-continuity"]);
});
