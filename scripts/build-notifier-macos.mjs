#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  readFileSync,
  mkdirSync,
  rmSync,
  writeFileSync,
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
const buildResources = path.join(buildContents, "Resources");
const buildExecutable = path.join(buildMacOS, "CodexPulseNotifier");
const installDir = path.join(os.homedir(), "Applications");
const installedApp = path.join(installDir, "Codex Pulse.app");
const packageVersion = JSON.parse(
  readFileSync(path.join(projectDir, "package.json"), "utf8"),
).version;

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildMacOS, { recursive: true });
mkdirSync(buildResources, { recursive: true });
copyFileSync(plistSource, path.join(buildContents, "Info.plist"));
copyFileSync(
  path.join(projectDir, "native", "AppIcon.icns"),
  path.join(buildResources, "AppIcon.icns"),
);
const builtPlist = path.join(buildContents, "Info.plist");
writeFileSync(
  builtPlist,
  readFileSync(builtPlist, "utf8")
    .replace(
      /<key>CFBundleShortVersionString<\/key>\s*<string>[^<]+<\/string>/,
      `<key>CFBundleShortVersionString</key>\n  <string>${packageVersion}</string>`,
    )
    .replace(
      /<key>CFBundleVersion<\/key>\s*<string>[^<]+<\/string>/,
      `<key>CFBundleVersion</key>\n  <string>${packageVersion.replaceAll(".", "")}</string>`,
    ),
  "utf8",
);
execFileSync("/usr/bin/xcrun", [
  "clang",
  sourcePath,
  path.join(projectDir, "native", "PulseSettingsWindow.m"),
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

if (process.argv.includes("--no-install")) {
  console.log(JSON.stringify({ ok: true, buildDir, installed: false }, null, 2));
  process.exit(0);
}
mkdirSync(installDir, { recursive: true });
rmSync(installedApp, { recursive: true, force: true });
cpSync(buildDir, installedApp, { recursive: true });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installedApp]);
execFileSync(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", installedApp],
);

console.log(JSON.stringify({ ok: true, installedApp }, null, 2));
