#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const appPath = path.join(os.homedir(), "Applications", "Codex Pulse.app");

execFileSync("/usr/bin/open", ["-W", "-g", "-n", appPath, "--args", "--setup"], {
  stdio: "inherit",
});

console.log(JSON.stringify({ ok: true, appPath }, null, 2));
