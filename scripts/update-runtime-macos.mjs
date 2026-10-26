#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lockInstallation, replaceInstallation } from "./installation-transaction.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = os.homedir();
const dataDir = path.join(homeDir, "Library", "Application Support", "Codex Pulse");
const runtimeDir = path.join(dataDir, "app");
const stagedDir = path.join(dataDir, `app-update-${process.pid}`);
const appPath = path.join(homeDir, "Applications", "Codex Pulse.app");
const stagedApp = path.join(homeDir, "Applications", `Codex Pulse.update-${process.pid}.app`);
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

const release = await lockInstallation(dataDir);
try {
mkdirSync(stagedDir, { recursive: true });
for (const entry of ["bin", "src"]) {
  cpSync(path.join(projectDir, entry), path.join(stagedDir, entry), { recursive: true });
}
cpSync(path.join(projectDir, "package.json"), path.join(stagedDir, "package.json"));

execFileSync(process.execPath, [path.join(projectDir, "scripts", "build-notifier-macos.mjs"), "--no-install"], {
  stdio: "inherit",
});
cpSync(path.join(projectDir, "build", "Codex Pulse.app"), stagedApp, { recursive: true });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);
replaceInstallation({ components: [[runtimeDir, stagedDir], [appPath, stagedApp]],
  service: `gui/${uid}/com.cjaxonj.codex-pulse`, plistPath,
  activate() {
    execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", appPath]);
  },
  verify() {
    execFileSync(process.execPath, [path.join(runtimeDir, "bin/codex-pulse.mjs"), "doctor"], { stdio: "inherit", timeout: 30_000 });
  },
});

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
} finally {
  rmSync(stagedDir, { recursive: true, force: true });
  rmSync(stagedApp, { recursive: true, force: true });
  await release();
}
