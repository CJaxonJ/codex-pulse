#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(projectDir, "native", "CodexPulseNotifier.m");
const plistSource = path.join(projectDir, "native", "Info.plist");
const buildDir = path.join(projectDir, "build", "Codex Pulse.app");
const buildContents = path.join(buildDir, "Contents");
const buildMacOS = path.join(buildContents, "MacOS");
const buildExecutable = path.join(buildMacOS, "CodexPulseNotifier");
const installDir = path.join(os.homedir(), "Applications");
const installedApp = path.join(installDir, "Codex Pulse.app");

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildMacOS, { recursive: true });
copyFileSync(plistSource, path.join(buildContents, "Info.plist"));
execFileSync("/usr/bin/xcrun", [
  "clang",
  sourcePath,
  "-fobjc-arc",
  "-o",
  buildExecutable,
  "-framework",
  "AppKit",
  "-framework",
  "UserNotifications",
], {
  env: {
    ...process.env,
    CLANG_MODULE_CACHE_PATH: path.join(projectDir, "build", "module-cache"),
  },
});
execFileSync("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", buildDir]);

mkdirSync(installDir, { recursive: true });
rmSync(installedApp, { recursive: true, force: true });
cpSync(buildDir, installedApp, { recursive: true });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installedApp]);
execFileSync(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", installedApp],
);

console.log(JSON.stringify({ ok: true, installedApp }, null, 2));
