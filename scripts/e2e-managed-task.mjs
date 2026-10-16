#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(projectDir, "bin", "codex-pulse.mjs");
const timeoutMs = Number(process.env.CODEX_PULSE_E2E_TIMEOUT_MS || 180_000);
const proofName = "pulse-e2e-proof.txt";
const proofText = "CODEX_PULSE_REAL_E2E_OK\n";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FatalE2EError extends Error {}

function captureProcess(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = { child, stdout: "", stderr: "", exit: null };
  child.stdout.on("data", (chunk) => {
    state.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
  });
  state.exit = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  return state;
}

async function runProcess(args, env, label) {
  const state = captureProcess(args, env);
  const result = await state.exit;
  if (result.code !== 0) {
    throw new Error(
      `${label} failed (${result.code ?? result.signal})\nstdout:\n${state.stdout}\nstderr:\n${state.stderr}`,
    );
  }
  return state;
}

async function waitFor(predicate, label, deadline = Date.now() + timeoutMs) {
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error instanceof FatalE2EError) throw error;
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function listLockNames(lockDir) {
  try {
    return await readdir(lockDir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-real-e2e-"));
const dataDir = path.join(tempRoot, "data");
const workspace = path.join(tempRoot, "workspace");
const proofPath = path.join(workspace, proofName);
await mkdir(workspace, { recursive: true });

const env = {
  ...process.env,
  CODEX_PULSE_DATA_DIR: dataDir,
  CODEX_PULSE_POLL_SECONDS: "2",
  CODEX_PULSE_DISABLE_NOTIFICATIONS: "1",
};

let watcher = null;
let succeeded = false;
const startedAt = Date.now();

try {
  watcher = captureProcess([cliPath, "watch"], env);
  await waitFor(
    () => {
      if (watcher.stdout.includes("watcher started")) return true;
      if (watcher.stderr || watcher.child.exitCode != null) {
        throw new Error(
          `watcher exited before startup\nstdout:\n${watcher.stdout}\nstderr:\n${watcher.stderr}`,
        );
      }
      return false;
    },
    "the real watcher to start",
    Date.now() + 45_000,
  );

  const objective = [
    `Create a file named ${proofName} in the current workspace.`,
    `Its contents must be exactly ${proofText.trim()} followed by one newline.`,
    "Do not create or modify any other file.",
    "Read the file back to verify the exact contents, then finish.",
  ].join(" ");
  const queued = await runProcess(
    [
      cliPath,
      "managed-run",
      "--cwd",
      workspace,
      "--size",
      "small",
      "--priority",
      "high",
      "--quota-policy",
      "deadline",
      "--start-floor",
      "0",
      "--resume-floor",
      "1",
      "--objective",
      objective,
    ],
    env,
    "managed-run",
  );
  const queuedResult = JSON.parse(queued.stdout);
  const taskId = queuedResult.task.id;
  const taskPath = path.join(dataDir, "managed-tasks", `${taskId}.json`);

  const task = await waitFor(async () => {
    const current = await readJson(taskPath);
    if (current.status === "needs_attention") {
      throw new FatalE2EError(
        `task needs attention: ${current.blocker || "unknown"}`,
      );
    }
    if (current.lastStartError) {
      throw new FatalE2EError(
        `App Server start failed: ${current.lastStartError}`,
      );
    }
    if (current.status !== "complete") return false;
    return current;
  }, "the real managed turn to complete");

  await access(proofPath);
  const actualProof = await readFile(proofPath, "utf8");
  if (actualProof !== proofText) {
    throw new Error(`proof mismatch: ${JSON.stringify(actualProof)}`);
  }
  const workspaceNames = await readdir(workspace);
  if (workspaceNames.length !== 1 || workspaceNames[0] !== proofName) {
    throw new Error(`unexpected workspace output: ${workspaceNames.join(", ")}`);
  }
  const lockNames = await listLockNames(path.join(dataDir, "worktree-locks"));
  if (lockNames.length !== 0) {
    throw new Error(`worktree lock was not released: ${lockNames.join(", ")}`);
  }

  succeeded = true;
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: "real_app_server",
        taskId,
        threadId: task.threadId,
        turnId: task.turnId,
        proof: actualProof.trim(),
        worktreeLocksAfterCompletion: lockNames,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
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
        watcherStdout: watcher?.stdout || "",
        watcherStderr: watcher?.stderr || "",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (watcher && watcher.child.exitCode == null) {
    watcher.child.kill("SIGTERM");
    await Promise.race([watcher.exit, delay(5_000)]);
    if (watcher.child.exitCode == null) watcher.child.kill("SIGKILL");
  }
  if (succeeded) await rm(tempRoot, { recursive: true, force: true });
}
