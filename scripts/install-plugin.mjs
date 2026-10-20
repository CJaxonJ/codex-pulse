#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(os.homedir(), "Library", "Application Support", "Codex Pulse");
const marketplaceRoot = path.join(dataDir, "marketplace");
const desktopCodex =
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const marketplaceName = "codex-pulse-local";
const pluginName = "codex-pulse";
const pluginId = `${pluginName}@${marketplaceName}`;
const configPath = path.join(os.homedir(), ".codex", "config.toml");
const CLI_COMMAND_TIMEOUT_MS = 90_000;

if (process.platform !== "darwin") {
  throw new Error("The current Codex Pulse plugin installer supports macOS only.");
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

function runJson(codexPath, args) {
  const output = execFileSync(codexPath, args, {
    encoding: "utf8",
    env: process.env,
    timeout: CLI_COMMAND_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(output);
}

function alreadyInstalled(version) {
  const cachedManifest = path.join(
    os.homedir(),
    ".codex",
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
copyMarketplace();
const manifest = JSON.parse(
  readFileSync(
    path.join(marketplaceRoot, "plugin", ".codex-plugin", "plugin.json"),
    "utf8",
  ),
);
const reusedExistingInstall = alreadyInstalled(manifest.version);

if (!reusedExistingInstall) {
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

  const plugins = runJson(codexPath, ["plugin", "list", "--json"]);
  const installed = plugins.installed?.find((plugin) => plugin.pluginId === pluginId);
  if (installed && installed.version !== manifest.version) {
    runJson(codexPath, ["plugin", "remove", pluginId, "--json"]);
  }
  if (!installed || installed.version !== manifest.version) {
    runJson(codexPath, ["plugin", "add", pluginId, "--json"]);
  }
}

console.log(
  JSON.stringify(
    {
      ok: true,
      pluginId,
      version: manifest.version,
      marketplaceRoot,
      reusedExistingInstall,
      hookTrustRequired: true,
      nextSteps: [
        "Open a fresh Codex CLI, run /hooks, inspect the Codex Pulse commands, and trust them only if the paths stay inside the installed plugin.",
        "After trust is complete, restart the Codex desktop app so it reloads the installed plugin.",
      ],
    },
    null,
    2,
  ),
);
