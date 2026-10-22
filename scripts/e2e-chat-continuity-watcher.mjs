#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
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

import { AppServerClient, resolveCodexBinary } from "../src/app-server-client.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binPath = path.join(projectDir, "bin", "codex-pulse.mjs");
const timeoutMs = Number(process.env.CODEX_PULSE_E2E_TIMEOUT_MS || 120_000);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-watcher-e2e-"));
const dataDir = path.join(tempRoot, "data");
const workspace = path.join(tempRoot, "workspace");
const quotaPath = path.join(tempRoot, "quota-summary.json");
const proofPath = path.join(workspace, "watcher-resume-proof.txt");
const store = new ChatContinuityStore(dataDir);
const client = new AppServerClient({ requestTimeoutMs: 30_000 });
const completions = new Map();
const watchers = new Set();
let succeeded = false;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check, label, customTimeoutMs = timeoutMs) {
  const deadline = Date.now() + customTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
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

function quotaSummary(remainingPercent, resetsAt) {
  return {
    planType: "plus",
    fiveHour: {
      remainingPercent,
      usedPercent: 100 - remainingPercent,
      resetsAt,
    },
    weekly: {
      remainingPercent: 80,
      usedPercent: 20,
      resetsAt: resetsAt + 500_000,
    },
    resetCredits: { availableCount: 0, expiries: [] },
  };
}

async function writeQuota(summary) {
  await writeFile(quotaPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

function startWatcher(label) {
  const child = spawn(process.execPath, [binPath, "watch"], {
    cwd: projectDir,
    env: {
      ...process.env,
      NODE_ENV: "test",
      CODEX_PULSE_TEST_MODE: "watcher-restart-e2e",
      CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH: quotaPath,
      CODEX_PULSE_DATA_DIR: dataDir,
      CODEX_PULSE_POLL_SECONDS: "1",
      CODEX_PULSE_DISABLE_NOTIFICATIONS: "1",
      CODEX_BINARY: resolveCodexBinary(),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const watcher = { label, child, stdout: "", stderr: "", exited: false };
  watchers.add(watcher);
  child.stdout.on("data", (chunk) => {
    watcher.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    watcher.stderr += chunk.toString();
  });
  child.on("exit", () => {
    watcher.exited = true;
  });
  return watcher;
}

async function stopWatcher(watcher) {
  if (watcher.exited) return;
  watcher.child.kill("SIGTERM");
  await Promise.race([once(watcher.child, "exit"), delay(5_000)]);
  if (!watcher.exited) watcher.child.kill("SIGKILL");
}

try {
  await mkdir(workspace, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(workspace, ".gitkeep"), "", "utf8");
  await writeFile(
    path.join(dataDir, "preferences.json"),
    `${JSON.stringify({ quotaPolicy: "strict_reserve", tiboSource: "disabled" })}\n`,
    "utf8",
  );

  client.on("notification", (message) => {
    if (message.method !== "turn/completed") return;
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    if (turnId) completions.set(turnId, params.turn?.status || "unknown");
  });
  await client.start();
  const started = await client.request("thread/start", {
    model: "gpt-6-luna",
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    serviceName: "codex_pulse_watcher_restart_e2e",
  });
  const sessionId = started.thread.id;
  const initial = await client.request("turn/start", {
    threadId: sessionId,
    input: [{ type: "text", text: "Reply exactly READY. Do not use tools." }],
  });
  const initialTurnId = initial.turn.id;
  await waitFor(() => completions.has(initialTurnId), "the initial turn to stop", 45_000);
  if (completions.get(initialTurnId) !== "completed") {
    throw new Error(`initial turn ended as ${completions.get(initialTurnId)}`);
  }
  client.stop();
  await delay(500);

  const inspector = new WorkspaceInspector();
  const fingerprint = await inspector.fingerprint(workspace);
  if (!fingerprint) {
    throw new Error(`workspace fingerprint failed: ${JSON.stringify(inspector.failureDiagnostic())}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const oldWindow = now + 3_600;
  const recoveredWindow = oldWindow + 18_000;
  await store.put({
    id: `chat:${sessionId}`,
    sessionId,
    status: "paused_quota",
    cwd: workspace,
    turnId: initialTurnId,
    model: "gpt-6-luna",
    autoResume: true,
    resumeFloor: 50,
    pausedWindowKey: oldWindow,
    pausedRemaining: 9,
    pausedAt: now,
    checkpoint: {
      summary: [
        "Completed: the original chat turn ended normally.",
        "Verification: the assistant replied READY.",
        "Remaining: create watcher-resume-proof.txt containing exactly WATCHER_RESUME_OK followed by one newline.",
        "Next action: create the file, read it back, then finish without modifying anything else.",
        "Blockers: none.",
      ].join("\n"),
      workspaceFingerprint: fingerprint,
    },
  });

  await writeQuota(quotaSummary(9, oldWindow));
  const watcherA = startWatcher("paused-watcher");
  await waitFor(
    () => watcherA.stdout.includes("quota checked"),
    "the first watcher to observe paused quota",
    30_000,
  );
  if ((await store.get(sessionId))?.status !== "paused_quota") {
    throw new Error("the first watcher changed the paused record before recovery");
  }
  if (await fileExists(proofPath)) {
    throw new Error("the first watcher resumed work while quota was still low");
  }
  await stopWatcher(watcherA);

  await writeQuota(quotaSummary(85, recoveredWindow));
  const watcherB = startWatcher("recovered-watcher");
  await waitFor(async () => {
    const record = await store.get(sessionId);
    return record?.status === "complete" && (await fileExists(proofPath));
  }, "the restarted watcher to resume and complete the original chat");
  await stopWatcher(watcherB);

  const completed = await store.get(sessionId);
  const proof = await readFile(proofPath, "utf8");
  const lockDir = path.join(dataDir, "worktree-locks");
  const remainingLocks = (await fileExists(lockDir)) ? await readdir(lockDir) : [];
  const resumedEvents = watcherB.stdout.match(/chat_continuity_resumed/g) || [];
  if (proof !== "WATCHER_RESUME_OK\n") throw new Error("resume proof is incorrect");
  if (completed.resumeCount !== 1) {
    throw new Error(`chat resumed ${completed.resumeCount} times`);
  }
  if (resumedEvents.length !== 1) {
    throw new Error(`restarted watcher emitted ${resumedEvents.length} resume events`);
  }
  if (remainingLocks.length) {
    throw new Error(`worktree locks remain: ${remainingLocks.join(",")}`);
  }

  succeeded = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "real_app_server_with_two_independent_watcher_processes",
        sessionId,
        initialTurnId,
        resumedTurnId: completed.turnId,
        firstWatcherObservedLowQuota: true,
        firstWatcherStoppedBeforeRecovery: true,
        secondWatcherObservedRecoveredQuota: true,
        resumeCount: completed.resumeCount,
        proof: proof.trim(),
        worktreeLocksAfterCompletion: remainingLocks,
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
        watchers: [...watchers].map((watcher) => ({
          label: watcher.label,
          stdout: watcher.stdout.slice(-8_000),
          stderr: watcher.stderr.slice(-8_000),
        })),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  client.stop();
  for (const watcher of watchers) await stopWatcher(watcher);
  if (succeeded) await rm(tempRoot, { recursive: true, force: true });
}
