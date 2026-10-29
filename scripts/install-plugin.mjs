#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexInvocation, pulseDataDirectory, resolveCodexExecutable } from "../src/platform-runtime.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = pulseDataDirectory();
const marketplaceRoot = path.join(dataDir, "marketplace");
const marketplaceName = "codex-pulse-local";
const pluginName = "codex-pulse";
const pluginId = `${pluginName}@${marketplaceName}`;
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const configPath = path.join(codexHome, "config.toml");
const CLI_COMMAND_TIMEOUT_MS = 90_000;

if (!["darwin", "win32"].includes(process.platform)) {
  throw new Error("The Codex Pulse plugin installer supports macOS and native Windows only.");
}

function resolveCodexPath() {
  return resolveCodexExecutable();
}

function runJson(codexPath, args) {
  const invocation = codexInvocation(codexPath, args);
  const output = execFileSync(invocation.file, invocation.args, {
    encoding: "utf8",
    env: process.env,
    timeout: CLI_COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
  return JSON.parse(output);
}

function alreadyInstalled(version) {
  const cachedManifest = path.join(
    codexHome,
    "plugins",
    "cache",
    marketplaceName,
    pluginName,
    version,
    ".codex-plugin",
    "plugin.json",
  );
  if (!existsSync(cachedManifest) || !existsSync(configPath)) return false;
  const config = readFileSync(configPath, "utf8");
  const header = `[plugins."${pluginId}"]`;
  const start = config.indexOf(header);
  if (start < 0) return false;
  const nextSection = config.indexOf("\n[", start + header.length);
  const section = config.slice(start, nextSection < 0 ? config.length : nextSection);
  return /^enabled\s*=\s*true\s*$/m.test(section);
}

function copyMarketplace() {
  rmSync(marketplaceRoot, { recursive: true, force: true });
  mkdirSync(path.join(marketplaceRoot, ".agents", "plugins"), { recursive: true });
  cpSync(path.join(projectDir, "plugin"), path.join(marketplaceRoot, "plugin"), {
    recursive: true,
  });
  cpSync(
    path.join(projectDir, ".agents", "plugins", "marketplace.json"),
    path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
  );
}

const codexPath = resolveCodexPath();
const manifest = JSON.parse(
  readFileSync(
    path.join(projectDir, "plugin", ".codex-plugin", "plugin.json"),
    "utf8",
  ),
);
const plugins = runJson(codexPath, ["plugin", "list", "--json"]);
const installed = plugins.installed?.find((plugin) => plugin.pluginId === pluginId);
const packageManifest = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
let reusedExistingInstall = false;
if (installed && packageManifest.codexPulse?.compatiblePluginVersions?.includes(installed.version) && alreadyInstalled(installed.version)) {
  const cached = path.join(codexHome, "plugins/cache", marketplaceName, pluginName, installed.version);
  try {
    const cachedManifest = JSON.parse(readFileSync(path.join(cached, ".codex-plugin/plugin.json"), "utf8"));
    reusedExistingInstall = JSON.stringify(cachedManifest.hooks) === JSON.stringify(manifest.hooks) &&
      readFileSync(path.join(cached, "scripts/pulse-hook.mjs"), "utf8") === readFileSync(path.join(projectDir, "plugin/scripts/pulse-hook.mjs"), "utf8");
  } catch { /* A missing or different installed definition needs explicit replacement/review. */ }
}

// This runtime-only release has no safe reason to remove an existing reviewed
// definition. Refuse incompatible/different definitions before changing either
// cache or catalog, rather than risking trust loss on a later rollback.
if (installed && !reusedExistingInstall) {
  throw Error("已安装插件与此版本不兼容、已关闭或定义不同。现有插件与授权未更改；请先核对版本，不要重复安装。");
}
if (!reusedExistingInstall && plugins.installed?.some(p => p.pluginId !== pluginId && p.marketplaceName === marketplaceName)) {
  throw Error("该本地市场还被其他插件使用，未覆盖市场文件。请先核对安装来源。");
}
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ok:true,reusedExistingInstall,pluginId}));
  process.exit(0);
}

if (!reusedExistingInstall) {
  copyMarketplace();
  const marketplaces = runJson(codexPath, ["plugin", "marketplace", "list", "--json"]);
  const configured = marketplaces.marketplaces?.some(
    (marketplace) => marketplace.name === marketplaceName,
  );
  if (!configured) {
    runJson(codexPath, [
      "plugin",
      "marketplace",
      "add",
      marketplaceRoot,
      "--json",
    ]);
  }

  runJson(codexPath, ["plugin", "add", pluginId, "--json"]);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      pluginId,
      version: reusedExistingInstall ? installed.version : manifest.version,
      marketplaceRoot,
      reusedExistingInstall,
      hookTrustRequired: true,
      nextSteps: [
        "Open Codex Pulse → 保护授权 and personally confirm 开启自动保护 in the native window.",
        "After Codex confirms trust, reopen Codex when convenient so new sessions load it. Restarting stops active tasks; Pulse does not do it automatically.",
      ],
    },
    null,
    2,
  ),
);
