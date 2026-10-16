#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const plistPath = path.join(
  os.homedir(),
  "Library",
  "LaunchAgents",
  "com.cjaxonj.codex-pulse.plist",
);
const uid = process.getuid();
const runtimeDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Codex Pulse",
  "app",
);

if (existsSync(plistPath)) {
  try {
    execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath]);
  } catch {
    // It may already be stopped.
  }
  unlinkSync(plistPath);
}

rmSync(runtimeDir, { recursive: true, force: true });

console.log(
  JSON.stringify(
    {
      ok: true,
      removed: plistPath,
      note: "Installed runtime was removed; quota history under Library/Application Support/Codex Pulse was preserved.",
    },
    null,
    2,
  ),
);
