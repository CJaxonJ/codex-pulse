import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceInspector } from "../src/workspace-inspector.mjs";

function git(cwd, args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

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
