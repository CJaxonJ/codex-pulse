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

console.log("Release gate 2/6: live codex-reset.com contract and freshness");
run([path.join(projectDir, "scripts", "e2e-tibo-feed.mjs")]);

console.log("Release gate 3/6: real Codex App Server managed-task E2E");
run([path.join(projectDir, "scripts", "e2e-managed-task.mjs")]);

console.log("Release gate 4/6: real ordinary-chat checkpoint and resume E2E");
run([path.join(projectDir, "scripts", "e2e-chat-continuity.mjs")]);

console.log("Release gate 5/6: create macOS artifact");
run([path.join(projectDir, "scripts", "package-macos.mjs")]);

console.log("Release gate 6/6: verify archive layout and checksum");
run([path.join(projectDir, "scripts", "verify-package.mjs")]);
