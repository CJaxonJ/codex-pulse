#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCodexBinary } from "../src/app-server-client.mjs";
import { lockInstallation, stopService, serviceLoaded } from "./installation-transaction.mjs";

const dataDir = path.join(os.homedir(), "Library/Application Support/Codex Pulse");
const release = await lockInstallation(dataDir);
const plistPath = path.join(os.homedir(), "Library/LaunchAgents/com.cjaxonj.codex-pulse.plist");
const service = `gui/${process.getuid()}/com.cjaxonj.codex-pulse`;
const wasRunning = serviceLoaded(service);
let stopped = false;
try {
if (wasRunning) { stopService(service, plistPath); stopped = true; }

const codexPath = resolveCodexBinary();
const pluginId = "codex-pulse@codex-pulse-local";
const runJson = args => JSON.parse(execFileSync(codexPath, args, {
  encoding: "utf8", timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
}));
// Remove only our plugin through Codex, never edit the user's config or trust
// hashes directly. If this fails, leave the installed program in place.
const installed = runJson(["plugin", "list", "--json"]).installed || [];
if (installed.some(plugin => plugin.pluginId === pluginId)) {
  runJson(["plugin", "remove", pluginId, "--json"]);
  if (runJson(["plugin", "list", "--json"]).installed?.some(plugin => plugin.pluginId === pluginId)) {
    throw Error("Codex Pulse 插件仍存在，未继续删除运行程序。请重试卸载。");
  }
}
const remaining = runJson(["plugin", "list", "--json"]).installed || [];
if (!remaining.some(plugin => plugin.pluginId?.endsWith("@codex-pulse-local"))) {
  const marketplaces = runJson(["plugin", "marketplace", "list", "--json"]).marketplaces || [];
  if (marketplaces.some(marketplace => marketplace.name === "codex-pulse-local"))
    runJson(["plugin", "marketplace", "remove", "codex-pulse-local", "--json"]);
}

const runtimeDir = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "Codex Pulse",
  "app",
);
if (existsSync(plistPath)) {
  unlinkSync(plistPath);
}

rmSync(runtimeDir, { recursive: true, force: true });
const appPath = path.join(os.homedir(), "Applications", "Codex Pulse.app");
rmSync(appPath, { recursive: true, force: true });
if (!remaining.some(plugin => plugin.pluginId?.endsWith("@codex-pulse-local"))) {
  rmSync(path.join(os.homedir(), "Library/Application Support/Codex Pulse/marketplace"), {recursive:true,force:true});
}

console.log(
  JSON.stringify(
    {
      ok: true,
      removed: plistPath,
      appRemoved: appPath,
      pluginRemoved: pluginId,
      note: "Runtime, notification app and own plugin were removed. Preferences, checkpoints, quota history and uncertain credit operations were preserved. Reopen Codex when convenient to unload hooks in existing sessions; active tasks were not interrupted.",
    },
    null,
    2,
  ),
);
} catch (error) {
  if (stopped && existsSync(plistPath)) {
    try { execFileSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistPath], {timeout:15_000}); }
    catch { console.error("卸载失败，原程序仍保留，但后台服务需要重新启动。"); }
  }
  throw error;
} finally { await release(); }
