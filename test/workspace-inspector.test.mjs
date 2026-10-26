import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { WorkspaceInspector } from "../src/workspace-inspector.mjs";

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

async function writeFiles(cwd, count) {
  const batchSize = 200;
  for (let start = 0; start < count; start += batchSize) {
    const end = Math.min(count, start + batchSize);
    await Promise.all(
      Array.from({ length: end - start }, (_, offset) => {
        const index = start + offset;
        return writeFile(path.join(cwd, `untracked-${String(index).padStart(4, "0")}.txt`), "x\n");
      }),
    );
  }
}

test("snapshot and recovery verification enforce a total subprocess time budget", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pulse-bounded-scan-"));
  await writeFile(path.join(cwd, "work.txt"), "unchanged");
  const inspector = new WorkspaceInspector();
  const snapshot = await inspector.snapshot(cwd, { timeoutMs: 2000 });
  assert.ok(snapshot?.digest);
  assert.equal((await inspector.compareSnapshot(cwd, snapshot, { timeoutMs: 2000 })).same, true);
  const started = Date.now();
  assert.equal(await inspector.snapshot(cwd, { timeoutMs: 1 }), null);
  assert.ok(Date.now() - started < 1500, "worker exceeded the total deadline");
  assert.equal(inspector.failureDiagnostic().failures[0].reason, "fingerprint_timeout");
  const comparison = await inspector.compareSnapshot(cwd, snapshot, { timeoutMs: 1 });
  assert.equal(comparison.verifiable, false);
  assert.equal(comparison.same, false);
});

test("workspace fingerprint changes when untracked file content changes", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-workspace-"));
  await writeFile(path.join(cwd, "tracked.txt"), "baseline\n");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Codex Pulse Test"]);
  git(cwd, ["config", "user.email", "codex-pulse@example.invalid"]);
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-q", "-m", "baseline"]);

  const inspector = new WorkspaceInspector();
  await writeFile(path.join(cwd, "untracked.txt"), "first\n");
  const first = await inspector.fingerprint(cwd);
  await writeFile(path.join(cwd, "untracked.txt"), "second\n");
  const second = await inspector.fingerprint(cwd);

  assert.notEqual(first, null);
  assert.notEqual(second, null);
  assert.notEqual(first, second);
});

test("git fingerprint supports more than 2100 untracked files", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-large-workspace-"));
  await writeFile(path.join(cwd, "tracked.txt"), "baseline\n");
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.name", "Codex Pulse Test"]);
  git(cwd, ["config", "user.email", "codex-pulse@example.invalid"]);
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-q", "-m", "baseline"]);
  await writeFiles(cwd, 2_101);

  const inspector = new WorkspaceInspector();
  const fingerprint = await inspector.fingerprint(cwd);

  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(inspector.failureDiagnostic(), null);
});

test("filesystem fingerprint retries when the workspace appears during a transient scan failure", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-retry-"));
  const cwd = path.join(parent, "workspace");
  const inspector = new WorkspaceInspector();
  const pendingFingerprint = inspector.fingerprint(cwd, { strategy: "filesystem" });

  await delay(10);
  await mkdir(cwd);
  await writeFile(path.join(cwd, "work.txt"), "ready\n");

  assert.match(await pendingFingerprint, /^fs:[a-f0-9]{64}$/);
  assert.equal(inspector.failureDiagnostic(), null);
});

test("fingerprint failure diagnostics contain reason codes but no workspace paths", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-redacted-"));
  const cwd = path.join(parent, "private-workspace-name");
  const inspector = new WorkspaceInspector();

  assert.equal(await inspector.fingerprint(cwd, { strategy: "filesystem" }), null);
  const diagnostic = inspector.failureDiagnostic();
  assert.deepEqual(diagnostic, {
    type: "workspace_fingerprint_failed",
    failures: [
      {
        strategy: "filesystem",
        reason: "workspace_changed_during_scan",
        attempts: 2,
      },
    ],
  });
  assert.equal(JSON.stringify(diagnostic).includes(parent), false);
  assert.equal(JSON.stringify(diagnostic).includes("private-workspace-name"), false);
});

test("non-git workspaces use a stable filesystem fallback that detects edits", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-non-git-"));
  const filePath = path.join(cwd, "work.txt");
  await writeFile(filePath, "first\n");
  const inspector = new WorkspaceInspector();
  const first = await inspector.fingerprint(cwd);
  const repeat = await inspector.fingerprint(cwd, { strategy: "filesystem" });
  await writeFile(filePath, "second\n");
  const second = await inspector.fingerprint(cwd, { strategy: "filesystem" });

  assert.match(first, /^fs:/);
  assert.equal(repeat, first);
  assert.notEqual(second, first);
});

test("scoped snapshots ignore unrelated sibling changes but detect changes in the touched repo", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-scoped-workspace-"));
  const repo = path.join(cwd, "product", "app");
  const sibling = path.join(cwd, "output");
  await mkdir(repo, { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(path.join(repo, "work.txt"), "baseline\n");
  await writeFile(path.join(sibling, "unrelated.txt"), "first\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "Codex Pulse Test"]);
  git(repo, ["config", "user.email", "codex-pulse@example.invalid"]);
  git(repo, ["add", "work.txt"]);
  git(repo, ["commit", "-q", "-m", "baseline"]);

  const inspector = new WorkspaceInspector();
  const snapshot = await inspector.snapshot(cwd, {
    hints: [path.join("product", "app", "work.txt")],
  });
  assert.deepEqual(snapshot.scopes.map((scope) => scope.root), [path.join("product", "app")]);

  await writeFile(path.join(sibling, "unrelated.txt"), "second\n");
  assert.equal((await inspector.compareSnapshot(cwd, snapshot)).same, true);

  await writeFile(path.join(repo, "work.txt"), "changed\n");
  const changed = await inspector.compareSnapshot(cwd, snapshot);
  assert.equal(changed.same, false);
  assert.deepEqual(changed.changedScopes, [path.join("product", "app")]);
});
