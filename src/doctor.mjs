import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

const SERVICE_LABEL = "com.cjaxonj.codex-pulse";
const PLUGIN_ID = "codex-pulse@codex-pulse-local";

function fileAgeSeconds(filePath, now) {
  if (!existsSync(filePath)) return null;
  return Math.max(0, Math.round((now - statSync(filePath).mtimeMs) / 1000));
}

function enabledPlugin(configPath) {
  if (!existsSync(configPath)) return false;
  const config = readFileSync(configPath, "utf8");
  const header = `[plugins."${PLUGIN_ID}"]`;
  const start = config.indexOf(header);
  if (start < 0) return false;
  const nextSection = config.indexOf("\n[", start + header.length);
  const section = config.slice(start, nextSection < 0 ? config.length : nextSection);
  return /^enabled\s*=\s*true\s*$/m.test(section);
}

function installedPluginVersions(homeDir) {
  const root = path.join(
    homeDir,
    ".codex",
    "plugins",
    "cache",
    "codex-pulse-local",
    "codex-pulse",
  );
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function check(id, status, detail) {
  return { id, status, detail };
}

export function redactDiagnosticText(value, homeDir) {
  if (value == null) return value;
  return String(value)
    .replaceAll(homeDir, "<HOME>")
    .replaceAll(/(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[^\s]+)/gi, "<REDACTED>");
}

export function inspectLocalInstallation({
  homeDir,
  uid,
  now = Date.now(),
  run = execFileSync,
} = {}) {
  const dataDir = path.join(homeDir, "Library", "Application Support", "Codex Pulse");
  const runtimePath = path.join(dataDir, "app", "bin", "codex-pulse.mjs");
  const plistPath = path.join(
    homeDir,
    "Library",
    "LaunchAgents",
    `${SERVICE_LABEL}.plist`,
  );
  const notifierPath = path.join(homeDir, "Applications", "Codex Pulse.app");
  const configPath = path.join(homeDir, ".codex", "config.toml");
  const statePath = path.join(dataDir, "state.json");
  const logPath = path.join(dataDir, "monitor.log");

  let serviceLoaded = false;
  try {
    run("/bin/launchctl", ["print", `gui/${uid}/${SERVICE_LABEL}`], {
      stdio: "ignore",
    });
    serviceLoaded = true;
  } catch {
    serviceLoaded = false;
  }

  const stateAgeSeconds = fileAgeSeconds(statePath, now);
  const logAgeSeconds = fileAgeSeconds(logPath, now);
  const pluginVersions = installedPluginVersions(homeDir);
  const pluginEnabled = enabledPlugin(configPath);

  const checks = [
    check(
      "runtime",
      existsSync(runtimePath) ? "pass" : "fail",
      existsSync(runtimePath) ? "后台运行文件已安装" : "没有找到后台运行文件",
    ),
    check(
      "launch-agent",
      existsSync(plistPath) && serviceLoaded ? "pass" : "fail",
      serviceLoaded ? "后台监控正在运行" : "后台监控没有运行",
    ),
    check(
      "quota-state",
      stateAgeSeconds != null && stateAgeSeconds <= 180 ? "pass" : "warn",
      stateAgeSeconds == null
        ? "还没有生成额度状态"
        : `最近一次额度状态写入距今 ${stateAgeSeconds} 秒`,
    ),
    check(
      "monitor-log",
      logAgeSeconds != null && logAgeSeconds <= 180 ? "pass" : "warn",
      logAgeSeconds == null
        ? "还没有生成监控日志"
        : `最近一次监控日志写入距今 ${logAgeSeconds} 秒`,
    ),
    check(
      "notifications",
      existsSync(notifierPath) ? "pass" : "fail",
      existsSync(notifierPath) ? "通知应用已安装" : "通知应用没有安装",
    ),
    check(
      "plugin",
      pluginEnabled && pluginVersions.length > 0 ? "pass" : "warn",
      pluginEnabled
        ? `Codex 插件已启用（${pluginVersions.at(-1) || "版本未知"}）`
        : "Codex 插件尚未启用",
    ),
    check(
      "hook-trust",
      "manual",
      "请在重启 Codex 后打开 /hooks，人工检查并信任 Codex Pulse hooks",
    ),
  ];

  return {
    ok: checks.every((item) => !["fail"].includes(item.status)),
    checks,
    support: {
      stateAgeSeconds,
      logAgeSeconds,
      pluginVersions,
    },
  };
}
