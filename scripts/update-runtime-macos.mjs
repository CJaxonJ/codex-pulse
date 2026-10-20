#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = os.homedir();
const dataDir = path.join(homeDir, "Library", "Application Support", "Codex Pulse");
const runtimeDir = path.join(dataDir, "app");
const stagedDir = path.join(dataDir, `app-update-${process.pid}`);
const backupDir = path.join(dataDir, `app-backup-${process.pid}`);
const plistPath = path.join(
  homeDir,
  "Library",
  "LaunchAgents",
  "com.cjaxonj.codex-pulse.plist",
);
const uid = process.getuid();

if (process.platform !== "darwin") {
  throw new Error("The current Codex Pulse updater supports macOS only.");
}
if (!existsSync(runtimeDir) || !existsSync(plistPath)) {
  throw new Error("Codex Pulse is not installed. Run node scripts/install-macos.mjs first.");
}

rmSync(stagedDir, { recursive: true, force: true });
rmSync(backupDir, { recursive: true, force: true });
mkdirSync(stagedDir, { recursive: true });
for (const entry of ["bin", "src"]) {
  cpSync(path.join(projectDir, entry), path.join(stagedDir, entry), { recursive: true });
}
cpSync(path.join(projectDir, "package.json"), path.join(stagedDir, "package.json"));

execFileSync(process.execPath, [path.join(projectDir, "scripts", "build-notifier-macos.mjs")], {
  stdio: "inherit",
});

let swapped = false;
try {
  try {
    execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath], {
      stdio: "ignore",
    });
  } catch {
    // The service may already be stopped.
  }
  renameSync(runtimeDir, backupDir);
  renameSync(stagedDir, runtimeDir);
  swapped = true;
  execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  execFileSync("/bin/launchctl", [
    "kickstart",
    "-k",
    `gui/${uid}/com.cjaxonj.codex-pulse`,
  ]);
  rmSync(backupDir, { recursive: true, force: true });
} catch (error) {
  if (swapped) {
    try {
      execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath], {
        stdio: "ignore",
      });
    } catch {
      // Best-effort rollback.
    }
    rmSync(runtimeDir, { recursive: true, force: true });
    renameSync(backupDir, runtimeDir);
    try {
      execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    } catch {
      // Preserve the original runtime even if launchd itself is unavailable.
    }
  }
  rmSync(stagedDir, { recursive: true, force: true });
  throw error;
}

console.log(
  JSON.stringify(
    {
      ok: true,
      runtimeDir,
      pluginChanged: false,
      hookReviewRequired: false,
      note: "Runtime and status app updated without replacing the Codex plugin or changing hook trust.",
    },
    null,
    2,
  ),
);
