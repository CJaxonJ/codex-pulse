import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const local = JSON.parse(readFileSync(path.join(root, "plugin/.codex-plugin/plugin.json"), "utf8"));
const stage = mkdtempSync(path.join(os.tmpdir(), "pulse-directory-package-"));
const dist = path.join(root, "dist");
mkdirSync(dist, { recursive: true });
const zip = path.join(dist, `Codex-Pulse-${local.version}-Directory-Guide.zip`);
const checksum = path.join(dist, "PLUGIN-SHA256SUMS.txt");
try {
  // The public directory disallows lifecycle Hooks. This is deliberately a
  // distinct helper identity, not an overwrite of the trusted local plugin.
  const manifest = {
    name: "codex-pulse-guide", version: local.version,
    description: "Desktop setup and local status checks for the separately installed macOS Codex Pulse utility.",
    author: local.author, homepage: local.homepage, repository: local.repository,
    license: "MIT", requires_local_executor: true, skills: "./skills/",
    interface: {
      ...local.interface, displayName: "Codex Pulse Guide", shortDescription: "Setup and local quota checks",
      longDescription: "A desktop-only guide to the separately installed, independent macOS Codex Pulse utility. Helps check signed-in Codex quota, inspect saved continuation plans, and explain alerts and optional personal-account credit settings. Installing this guide does not install the local runtime, enable lifecycle Hooks, bypass personal Hook review, or provide web/mobile background monitoring. The full utility requires Node.js 20+, Apple Command Line Tools and a separate macOS installation. Expiring-credit redemption defaults off and requires explicit account-bound consent; this guide never consumes a real credit as a test. Not affiliated with or endorsed by OpenAI.",
      websiteURL: local.homepage, supportURL: `${local.repository}/issues`,
      privacyPolicyURL: `${local.repository}/blob/main/PRIVACY.md`,
      defaultPrompt: ["Help me set up Codex Pulse on my Mac.", "Show my saved Codex Pulse continuation plan."],
    },
    extensions: { "com.openai": { onboardingSkill: "./skills/setup/SKILL.md" } },
  };
  assert.ok(manifest.interface.shortDescription.length <= 30);
  assert.ok(manifest.interface.displayName.length <= 30);
  assert.ok(manifest.interface.longDescription.length <= 4000);
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, undefined);
  mkdirSync(path.join(stage, ".codex-plugin"));
  writeFileSync(path.join(stage, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2));
  for (const entry of ["skills", "assets"]) cpSync(path.join(root, "plugin", entry), path.join(stage, entry), { recursive: true });
  for (const entry of ["LICENSE", "PRIVACY.md"]) cpSync(path.join(root, entry), path.join(stage, entry));
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--norsrc", stage, zip]);
  const entries = execFileSync("/usr/bin/unzip", ["-Z1", zip], { encoding: "utf8" }).trim().split("\n");
  for (const required of [".codex-plugin/plugin.json", "skills/setup/SKILL.md", "assets/logo.svg", "PRIVACY.md"]) assert.ok(entries.includes(required));
  for (const entry of entries) assert.ok(!/(^|\/)(hooks|scripts|bin|src|node_modules|\.git|credit-operations)(\/|$)/.test(entry)
    && !entry.includes("..") && !entry.startsWith("/"), `Unexpected directory-package entry: ${entry}`);
  const sha256 = createHash("sha256").update(readFileSync(zip)).digest("hex");
  writeFileSync(checksum, `${sha256}  ${path.basename(zip)}\n`);
  console.log(JSON.stringify({ ok: true, zip, checksum, sha256, containsHooks: false, publicSubmission: "not_submitted", identityVerification: "required" }, null, 2));
} finally { rmSync(stage, { recursive: true, force: true }); }
