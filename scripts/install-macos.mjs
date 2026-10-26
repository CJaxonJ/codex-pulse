#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {openProtectionOnboarding} from "../src/protection-onboarding.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const homeDir = os.homedir();
const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
const dataDir = path.join(homeDir, "Library", "Application Support", "Codex Pulse");
const runtimeDir = path.join(dataDir, "app");
const plistPath = path.join(launchAgentsDir, "com.cjaxonj.codex-pulse.plist");
const monitorPath = path.join(runtimeDir, "bin", "codex-pulse.mjs");
const nodePath = process.execPath;
const desktopCodex =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const uid = process.getuid();
const service = `gui/${uid}/com.cjaxonj.codex-pulse`;

if (process.platform !== "darwin") {
  throw new Error("The current Codex Pulse installer supports macOS only.");
}
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  throw new Error(`Node.js 20 or newer is required; found ${process.version}.`);
}

function resolveCodexPath() {
  if (process.env.CODEX_BINARY) return process.env.CODEX_BINARY;
  if (existsSync(desktopCodex)) return desktopCodex;
  try {
    return execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "Codex was not found. Install/sign in to the ChatGPT desktop app or Codex CLI first.",
    );
  }
}

const codexPath = resolveCodexPath();

console.log("\nCodex Pulse 测试版安装");
console.log("1/5 检查并构建系统通知组件");

execFileSync(process.execPath, [path.join(projectDir, "scripts", "build-notifier-macos.mjs")], {
  stdio: "inherit",
});

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });
rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
for (const entry of ["bin", "src"]) {
  cpSync(path.join(projectDir, entry), path.join(runtimeDir, entry), { recursive: true });
}
cpSync(path.join(projectDir, "package.json"), path.join(runtimeDir, "package.json"));

console.log("2/5 检查 Codex 登录状态和额度读取权限");
execFileSync(nodePath, [monitorPath, "status"], {
  env: { ...process.env, CODEX_BINARY: codexPath },
  stdio: "inherit",
});

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cjaxonj.codex-pulse</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(monitorPath)}</string>
    <string>watch</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CODEX_BINARY</key>
    <string>${xml(codexPath)}</string>
    <key>CODEX_PULSE_POLL_SECONDS</key>
    <string>60</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${xml(runtimeDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(dataDir, "monitor.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(dataDir, "monitor-error.log"))}</string>
</dict>
</plist>
`;

writeFileSync(plistPath, plist, "utf8");

console.log("3/5 安装并启动后台监控");
try {
  execFileSync("/bin/launchctl", ["bootout", `gui/${uid}`, plistPath], {
    stdio: "ignore",
  });
} catch {
  // The service may not have been installed before.
}
execFileSync("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
execFileSync("/bin/launchctl", ["kickstart", "-k", service]);
console.log("4/5 申请系统通知权限并发送测试通知");
execFileSync(process.execPath, [path.join(projectDir, "scripts", "setup-notifications-macos.mjs")], {
  stdio: "inherit",
});
console.log("5/5 安装 Codex Pulse 本地插件");
execFileSync(process.execPath, [path.join(projectDir, "scripts", "install-plugin.mjs")], {
  env: { ...process.env, CODEX_BINARY: codexPath },
  stdio: "inherit",
});

console.log("\n安装完成，正在做最后自检……");
execFileSync(nodePath, [monitorPath, "doctor"], {
  env: { ...process.env, CODEX_BINARY: codexPath },
  stdio: "inherit",
});

const onboarding=openProtectionOnboarding({env:{...process.env,CODEX_BINARY:codexPath}});
if(!onboarding.opened) console.log("\n提醒已安装。方便时打开 Codex Pulse → 保护授权 → 开启自动保护。\n");
else console.log("\n可在 Codex Pulse → 保护授权中核对状态；新授权在重新打开 Codex 后使用。\n");
