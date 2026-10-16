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

console.log("Release gate 1/4: full automated test suite");
run(["--test"]);

console.log("Release gate 2/4: live codex-reset.com contract and freshness");
run([path.join(projectDir, "scripts", "e2e-tibo-feed.mjs")]);

console.log("Release gate 3/4: real Codex App Server managed-task E2E");
run([path.join(projectDir, "scripts", "e2e-managed-task.mjs")]);

console.log("Release gate 4/4: create macOS artifact");
run([path.join(projectDir, "scripts", "package-macos.mjs")]);
