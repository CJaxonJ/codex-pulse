import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "test-helpers",
  "worktree-lock-process.mjs",
);

function waitForMessage(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("lock helper timed out"));
    }, timeoutMs);
    child.once("message", (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

test("two OS processes cannot own the same worktree lock", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-lock-process-"));
  const dataDir = path.join(root, "data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const owner = fork(fixture, [dataDir, workspace, "owner-task", "hold"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(async () => {
    if (owner.exitCode == null) owner.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  });

  const first = await waitForMessage(owner);
  assert.equal(first.ok, true);
  assert.equal(first.result.acquired, true);

  const contender = fork(
    fixture,
    [dataDir, workspace, "contender-task", "attempt"],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const second = await waitForMessage(contender);
  assert.equal(second.ok, true);
  assert.equal(second.result.acquired, false);
  assert.equal(second.result.reason, "worktree_busy");
  assert.equal(second.result.owner.taskId, "owner-task");
});
