import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const dataDir = await mkdtemp(path.join(os.tmpdir(), "pulse-native-preview-"));
const now = Math.floor(Date.now() / 1000);
await mkdir(path.join(dataDir, "chat-continuity"));
for (const id of ["a", "b"]) await writeFile(path.join(dataDir, "chat-continuity", `${id}.json`), JSON.stringify({
  sessionId: id, status: "paused_quota", autoResume: true, pausedAt: now,
  initialGoal: { objective: `预览隔离任务 ${id}：完善产品，不影响真实聊天` },
  checkpoint: { summary: "Completed:\n已完成依赖检查\nRemaining:\n补充测试。预计剩余耗时：10–20 分钟\nNext action:\n先运行离线回归\nBlockers:\n等待个人额度恢复" },
}));
await writeFile(path.join(dataDir, "state.json"), JSON.stringify({ quotaCheckedAt: now,
  lastSummary: { fiveHour: { remainingPercent: 10, resetsAt: now + 1800 } } }));
const file = path.join(dataDir, "chat-continuity", "a.json");
const before = await readFile(file, "utf8");
const { stdout } = await promisify(execFile)(path.join(root, "build/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier"), ["--preview-self-test"], {
  timeout: 15_000, env: { ...process.env, CODEX_PULSE_DATA_DIR: dataDir,
    CODEX_PULSE_TEST_NODE: process.execPath, CODEX_PULSE_TEST_CLI: path.join(root, "bin/codex-pulse.mjs"),
    CODEX_PULSE_TEST_CAPTURE: path.join(dataDir, "preview.png") },
});
assert.equal(JSON.parse(stdout.trim()).ok, true);
assert.equal(await readFile(file, "utf8"), before);
console.log(JSON.stringify({ ok: true, tasks: 2, readOnly: true, quotaSpent: 0, screenshot: path.join(dataDir, "preview.png") }));
