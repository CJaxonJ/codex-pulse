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
import { lockInstallation, replaceInstallation } from "./installation-transaction.mjs";

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

const release = await lockInstallation(dataDir);
const stagedRuntime = path.join(dataDir, `app-install-${process.pid}`);
const appPath = path.join(homeDir, "Applications", "Codex Pulse.app");
const stagedApp = path.join(homeDir, "Applications", `Codex Pulse.install-${process.pid}.app`);
const stagedPlist = path.join(dataDir, `launch-agent-install-${process.pid}.plist`);
try {
const codexPath = resolveCodexPath();

console.log("\nCodex Pulse 测试版安装");
console.log("1/5 检查登录状态和构建依赖（尚未改动现有安装）");
execFileSync(nodePath, [path.join(projectDir, "bin", "codex-pulse.mjs"), "status"], {
  env: { ...process.env, CODEX_BINARY: codexPath }, stdio: "inherit", timeout: 30_000,
});
execFileSync("/usr/bin/xcrun", ["--find", "clang"], { stdio: "ignore", timeout: 15_000 });
execFileSync(process.execPath, [path.join(projectDir, "scripts/install-plugin.mjs"), "--check"], {
  env: {...process.env, CODEX_BINARY:codexPath}, stdio:"inherit", timeout:30_000,
});

execFileSync(process.execPath, [path.join(projectDir, "scripts", "build-notifier-macos.mjs"), "--no-install"], {
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
mkdirSync(stagedRuntime, { recursive: true });
mkdirSync(path.dirname(appPath), { recursive: true });
for (const entry of ["bin", "src"]) {
  cpSync(path.join(projectDir, entry), path.join(stagedRuntime, entry), { recursive: true });
}
cpSync(path.join(projectDir, "package.json"), path.join(stagedRuntime, "package.json"));
cpSync(path.join(projectDir, "build", "Codex Pulse.app"), stagedApp, { recursive: true });
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedApp]);

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
    ${process.env.CODEX_HOME ? `<key>CODEX_HOME</key><string>${xml(process.env.CODEX_HOME)}</string>` : ""}
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

writeFileSync(stagedPlist, plist, "utf8");

const previousPlugin = JSON.parse(execFileSync(codexPath, ["plugin", "list", "--json"], {encoding:"utf8",timeout:30_000}))
  .installed?.some(p => p.pluginId === "codex-pulse@codex-pulse-local");
const marketplaceRoot = path.join(dataDir, "marketplace");
const previousMarketplaces = JSON.parse(execFileSync(codexPath, ["plugin", "marketplace", "list", "--json"], {encoding:"utf8",timeout:30_000}));
const hadMarketplace = previousMarketplaces.marketplaces?.some(m => m.name === "codex-pulse-local");
replaceInstallation({
  components: [[runtimeDir, stagedRuntime], [appPath, stagedApp], [plistPath, stagedPlist],
    ...(!previousPlugin ? [[marketplaceRoot, null]] : [])], service, plistPath,
  activate() {
  console.log("2/5 切换已验证的组件（失败时恢复旧安装）");
  execFileSync("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", ["-f", appPath]);
  console.log("3/5 安装本地插件并启动后台监控");
  execFileSync(process.execPath, [path.join(projectDir, "scripts", "install-plugin.mjs")], {
    env: { ...process.env, CODEX_BINARY: codexPath }, stdio: "inherit",
  });
  },
  verify() {
  execFileSync(nodePath, [monitorPath, "doctor"], {
    env: { ...process.env, CODEX_BINARY: codexPath }, stdio: "inherit", timeout:30_000,
  });
  },
  rollback() {
  if (!previousPlugin) {
      const current=JSON.parse(execFileSync(codexPath,["plugin","list","--json"],{encoding:"utf8",timeout:30_000}));
      if(current.installed?.some(p=>p.pluginId==="codex-pulse@codex-pulse-local"))
        execFileSync(codexPath,["plugin","remove","codex-pulse@codex-pulse-local","--json"],{stdio:"ignore",timeout:30_000});
      if (!hadMarketplace) {
        const catalogs=JSON.parse(execFileSync(codexPath,["plugin","marketplace","list","--json"],{encoding:"utf8",timeout:30_000}));
        if(catalogs.marketplaces?.some(m=>m.name==="codex-pulse-local"))
          execFileSync(codexPath,["plugin","marketplace","remove","codex-pulse-local","--json"],{stdio:"ignore",timeout:30_000});
      }
  }
  },
});
console.log("4/5 申请系统通知权限并发送测试通知");
try {execFileSync(process.execPath,[path.join(projectDir,"scripts/setup-notifications-macos.mjs")],{stdio:"inherit"});}
catch {console.warn("程序已安装，通知设置未完成。可打开 Codex Pulse 后再设置通知，不需要重装。");}

console.log("5/5 打开本人保护授权窗口（不会自动确认或重启 Codex）");
const onboarding=openProtectionOnboarding({env:{...process.env,CODEX_BINARY:codexPath}});
if(!onboarding.opened) console.log("\n提醒已安装。方便时打开 Codex Pulse → 保护授权 → 开启自动保护。\n");
else console.log("\n可在 Codex Pulse → 保护授权中核对状态；新授权在重新打开 Codex 后使用。\n");
} finally {
  for (const staged of [stagedRuntime, stagedApp, stagedPlist]) rmSync(staged, {recursive:true,force:true});
  await release();
}
