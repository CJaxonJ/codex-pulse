#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(args, env = {}) {
  execFileSync(process.execPath, args, {
    cwd: projectDir,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
}

console.log("Release gate 1/7: public-content guard and full automated test suite");
run([path.join(projectDir, "scripts", "check-public-content.mjs")]);
run(["--test"]);

console.log("Release gate 2/7: build the native macOS notifier");
run([path.join(projectDir, "scripts", "build-notifier-macos.mjs"), "--no-install"]);

console.log("Release gate 3/7: persistent native alert E2E");
run([path.join(projectDir, "scripts", "e2e-notifier-persistent-macos.mjs"), "--build"]);
run([path.join(projectDir, "scripts", "e2e-resume-preview-macos.mjs")]);
run([path.join(projectDir, "scripts", "e2e-settings-macos.mjs")]);
run([path.join(projectDir, "scripts", "e2e-protection-consent.mjs")]);
run([path.join(projectDir, "scripts", "e2e-protection-ui-macos.mjs")]);

console.log("Release gate 4/7: direct X API contract and classifier E2E (local fixture)");
run([path.join(projectDir, "scripts", "e2e-tibo-feed.mjs")]);

console.log("Release gate 5/7: offline 10% pause, checkpoint, recovery, and resume E2E");
run([path.join(projectDir, "scripts", "e2e-chat-continuity-simulated.mjs")]);

console.log("Release gate 6/7: network loss, watcher restart, and Goal bootstrap E2E");
run([path.join(projectDir, "scripts", "e2e-chat-recovery-resilience.mjs")]);
run([path.join(projectDir, "scripts", "e2e-credit-redemption-protocol.mjs")]);

console.log("Release gate 7/7: create and verify the macOS artifact");
run([path.join(projectDir, "scripts", "package-macos.mjs")]);
run([path.join(projectDir, "scripts", "package-plugin-submission.mjs")]);

if (process.env.CODEX_PULSE_RUN_LIVE_E2E === "1") {
  console.log("Optional live gate 1/4: live zero-configuration Tibo source");
  run([path.join(projectDir, "scripts", "e2e-tibo-live.mjs")]);

  console.log("Optional live gate 2/4: real Codex App Server managed-task E2E");
  run([path.join(projectDir, "scripts", "e2e-managed-task.mjs")]);

  console.log("Optional live gate 3/4: installed Hooks and recovery preserving an initial Goal");
  run([path.join(projectDir, "scripts", "e2e-isolated-native-wakeup.mjs")], {
    CODEX_PULSE_TEST_REGISTERED_HOOKS: "1",
    CODEX_PULSE_TEST_INITIAL_GOAL: "1",
  });

  console.log("Optional live gate 4/4: installed Hooks and ordinary-chat recovery without an initial Goal");
  run([path.join(projectDir, "scripts", "e2e-isolated-native-wakeup.mjs")], {
    CODEX_PULSE_TEST_REGISTERED_HOOKS: "1",
    CODEX_PULSE_TEST_INITIAL_GOAL: "0",
  });
}
