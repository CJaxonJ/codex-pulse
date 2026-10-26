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

function newestFile(directory, suffix = "") {
  if (!existsSync(directory)) return null;
  const candidates = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => path.join(directory, entry.name));
  if (candidates.length === 0) return null;
  return candidates.sort(
    (left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
  )[0];
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

function installedPluginVersions(codexHome) {
  const root = path.join(
    codexHome,
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

function packageVersion(packagePath) {
  try {
    return JSON.parse(readFileSync(packagePath, "utf8")).version || null;
  } catch {
    return null;
  }
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
  codexHome = path.join(homeDir, ".codex"),
  uid,
  expectedVersion = null,
  compatiblePluginVersions = expectedVersion ? [expectedVersion] : [],
  now = Date.now(),
  run = execFileSync,
} = {}) {
  const dataDir = path.join(homeDir, "Library", "Application Support", "Codex Pulse");
  const runtimePath = path.join(dataDir, "app", "bin", "codex-pulse.mjs");
  const runtimeVersion = packageVersion(path.join(dataDir, "app", "package.json"));
  const plistPath = path.join(
    homeDir,
    "Library",
    "LaunchAgents",
    `${SERVICE_LABEL}.plist`,
  );
  const notifierPath = path.join(homeDir, "Applications", "Codex Pulse.app");
  const configPath = path.join(codexHome, "config.toml");
  const statePath = path.join(dataDir, "state.json");
  const logPath = path.join(dataDir, "monitor.log");
  const latestHookDecisionPath = newestFile(
    path.join(dataDir, "hook-decisions"),
    ".json",
  );

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
  const pluginVersions = installedPluginVersions(codexHome);
  const pluginEnabled = enabledPlugin(configPath);
  const newestPluginVersion = pluginVersions.at(-1) || null;
  const pluginVersionCompatible = Boolean(
    newestPluginVersion &&
      (compatiblePluginVersions.length === 0 ||
        compatiblePluginVersions.includes(newestPluginVersion)),
  );
  const newestPluginPath = newestPluginVersion
    ? path.join(
        codexHome,
        "plugins",
        "cache",
        "codex-pulse-local",
        "codex-pulse",
        newestPluginVersion,
      )
    : null;
  const hookDecisionAgeSeconds = latestHookDecisionPath
    ? fileAgeSeconds(latestHookDecisionPath, now)
    : null;
  const hookObservedForInstalledPlugin = Boolean(
    latestHookDecisionPath &&
      newestPluginPath &&
      statSync(latestHookDecisionPath).mtimeMs >= statSync(newestPluginPath).mtimeMs,
  );
  const runtimeStatus = !existsSync(runtimePath)
    ? "fail"
    : expectedVersion && runtimeVersion !== expectedVersion
      ? "fail"
      : "pass";
  const pluginStatus =
    !pluginEnabled || !newestPluginVersion
      ? "warn"
      : !pluginVersionCompatible
        ? "fail"
        : "pass";

  const checks = [
    check(
      "runtime",
      runtimeStatus,
      !existsSync(runtimePath)
        ? "没有找到后台运行文件"
        : expectedVersion && runtimeVersion !== expectedVersion
          ? `后台版本不一致（已安装 ${runtimeVersion || "未知"}，期望 ${expectedVersion}）`
          : `后台运行文件已安装（${runtimeVersion || "版本未知"}）`,
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
      pluginStatus,
      pluginEnabled
        ? !pluginVersionCompatible
          ? `Codex 插件版本不兼容（已安装 ${newestPluginVersion || "未知"}，兼容 ${compatiblePluginVersions.join("、") || "未知"}）`
          : `Codex 插件已启用（${newestPluginVersion || "版本未知"}）`
        : "Codex 插件尚未启用",
    ),
    check(
      "hook-trust",
      hookObservedForInstalledPlugin ? "pass" : "manual",
      hookObservedForInstalledPlugin
        ? `最近观察到 Codex Pulse Hook 已执行（距今 ${hookDecisionAgeSeconds} 秒）`
        : "尚未观察到当前版本的 Hook 执行记录。打开 Codex Pulse → 保护授权，核对并确认后，在方便时重开 Codex；对新会话生效。",
    ),
  ];

  return {
    ok: checks.every((item) => !["fail"].includes(item.status)),
    checks,
    support: {
      stateAgeSeconds,
      logAgeSeconds,
      pluginVersions,
      runtimeVersion,
      expectedVersion,
      compatiblePluginVersions,
      hookDecisionAgeSeconds,
      hookObservedForInstalledPlugin,
    },
  };
}
