import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";
import { currentWindowsProcessIdentity, readWindowsProcessIdentity } from "../src/windows-process-bridge.mjs";
import { writeJsonSnapshotAtomic } from "../src/atomic-file.mjs";

const windows = { skip: process.platform !== "win32", timeout: 30000 };
test("Windows lock ownership includes real creation time and distinguishes a reused live PID without terminating it", windows, async () => {
  const identity = currentWindowsProcessIdentity(); assert(identity);
  const actual = readWindowsProcessIdentity(process.pid);
  assert.equal(actual.exists, true); assert.equal(actual.creationTimeFileTime, identity.creationTimeFileTime);
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse PID identity-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const first = new WorktreeLockManager(root, { processIdentity: identity });
  const owner = await first.acquire(workspace, "original"); assert.equal(owner.acquired, true);
  const next = new WorktreeLockManager(root, { processIdentity: identity });
  assert.equal((await next.acquire(workspace, "replacement")).acquired, false, "The exact live process identity must remain exclusive");
  const file = path.join(first.rootDir, `${owner.handle.key}.lock`, "owner.json");
  const old = JSON.parse(await readFile(file, "utf8"));
  // Simulate an old persisted creation time while the same PID is genuinely
  // alive. The production liveness reader must distinguish the two identities.
  old.processIdentity.creationTimeFileTime = String(BigInt(identity.creationTimeFileTime) - 1n);
  await writeJsonSnapshotAtomic(file, old);
  const reclaimed = await next.acquire(workspace, "replacement");
  assert.equal(reclaimed.acquired, true);
  assert.equal(reclaimed.handle.processIdentity.creationTimeFileTime, identity.creationTimeFileTime);
  assert.equal(readWindowsProcessIdentity(process.pid).exists, true, "Reclaiming metadata must never terminate the process that reused a PID");
  await next.release(reclaimed.handle);
});

test("legacy Windows PID-only records remain conservative when their PID is alive", windows, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse legacy PID-")), workspace = path.join(root, "workspace"); await mkdir(workspace);
  const first = new WorktreeLockManager(root), owner = await first.acquire(workspace, "legacy");
  assert.equal(owner.handle.processIdentity, undefined);
  const next = new WorktreeLockManager(root, { processIdentity: currentWindowsProcessIdentity() });
  assert.equal((await next.acquire(workspace, "replacement")).acquired, false);
  await first.release(owner.handle);
});
