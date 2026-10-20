#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args) {
  execFileSync(process.execPath, args, {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
}

console.log("Release gate 1/6: full automated test suite");
run(["--test"]);

console.log("Release gate 2/6: build the native macOS notifier");
run([path.join(projectDir, "scripts", "build-notifier-macos.mjs")]);

console.log("Release gate 3/6: persistent native alert E2E");
run([path.join(projectDir, "scripts", "e2e-notifier-persistent-macos.mjs")]);

console.log("Release gate 4/6: direct X API contract and classifier E2E (local fixture)");
run([path.join(projectDir, "scripts", "e2e-tibo-feed.mjs")]);

console.log("Release gate 5/6: offline 10% pause, checkpoint, recovery, and resume E2E");
run([path.join(projectDir, "scripts", "e2e-chat-continuity-simulated.mjs")]);

console.log("Release gate 6/6: create and verify the macOS artifact");
run([path.join(projectDir, "scripts", "package-macos.mjs")]);

if (process.env.CODEX_PULSE_RUN_LIVE_E2E === "1") {
  console.log("Optional live gate 1/3: live zero-configuration Tibo source");
  run([path.join(projectDir, "scripts", "e2e-tibo-live.mjs")]);

  console.log("Optional live gate 2/3: real Codex App Server managed-task E2E");
  run([path.join(projectDir, "scripts", "e2e-managed-task.mjs")]);

  console.log("Optional live gate 3/3: real ordinary-chat checkpoint and resume E2E");
  run([path.join(projectDir, "scripts", "e2e-chat-continuity.mjs")]);
}
