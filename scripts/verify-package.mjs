#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanPublicDirectory } from "./public-content-policy.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
const bundleName = `Codex-Pulse-${pkg.version}-macOS`;
const distDir = path.join(projectDir, "dist");
const zipName = `${bundleName}.zip`;
const zipPath = path.join(distDir, zipName);
const checksumPath = path.join(distDir, "SHA256SUMS.txt");

const entries = execFileSync("/usr/bin/unzip", ["-Z1", zipPath], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const failures = [];
const required = [
  `${bundleName}/README.md`,
  `${bundleName}/docs/technical-guide.md`,
  `${bundleName}/PRIVACY.md`,
  `${bundleName}/docs/releases/v${pkg.version}.md`,
  `${bundleName}/LICENSE`,
  `${bundleName}/package.json`,
  `${bundleName}/Install Codex Pulse.command`,
  `${bundleName}/bin/codex-pulse.mjs`,
  `${bundleName}/src/chat-continuity-controller.mjs`,
  `${bundleName}/src/chat-continuity-store.mjs`,
  `${bundleName}/src/native-goal-coordinator.mjs`,
  `${bundleName}/src/native-wakeup.mjs`,
  `${bundleName}/src/thread-lifecycle.mjs`,
  `${bundleName}/src/workspace-snapshot-worker.mjs`,
  `${bundleName}/src/hook-trust-query.mjs`,
  `${bundleName}/src/resume-preview.mjs`,
  `${bundleName}/src/credit-auto-redeemer.mjs`,
  `${bundleName}/src/tibo-classifier.mjs`,
  `${bundleName}/src/tibo-post-source.mjs`,
  `${bundleName}/src/tibo-reset-window.mjs`,
  `${bundleName}/src/tibo-credentials.mjs`,
  `${bundleName}/src/tibo-x-api-client.mjs`,
  `${bundleName}/brand/codex-pulse-mark.svg`,
  `${bundleName}/brand/screenshots/settings.png`,
  `${bundleName}/brand/codex-pulse-app-icon.png`,
  `${bundleName}/native/AppIcon.icns`,
  `${bundleName}/native/BrandAssetRenderer.swift`,
  `${bundleName}/native/PulseSettingsWindow.h`,
  `${bundleName}/native/PulsePostLink.h`,
  `${bundleName}/native/PulseSettingsWindow.m`,
  `${bundleName}/native/PulseProtectionWindow.m`,
  `${bundleName}/src/protection-consent.mjs`,
  `${bundleName}/src/protection-onboarding.mjs`,
  `${bundleName}/plugin/assets/logo.svg`,
  `${bundleName}/plugin/assets/composer-icon.svg`,
  `${bundleName}/scripts/build-brand-assets.mjs`,
  `${bundleName}/scripts/install-macos.mjs`,
  `${bundleName}/scripts/installation-transaction.mjs`,
  `${bundleName}/scripts/update-runtime-macos.mjs`,
  `${bundleName}/scripts/uninstall-macos.mjs`,
];

for (const entry of entries) {
  if (!entry.startsWith(`${bundleName}/`)) {
    failures.push(`entry escaped the top-level product folder: ${entry}`);
  }
  if (entry.split("/").includes("..")) failures.push(`unsafe archive path: ${entry}`);
  if (entry.startsWith("__MACOSX/") || entry.includes("/.DS_Store")) {
    failures.push(`macOS metadata leaked into the archive: ${entry}`);
  }
  if (
    /\/scripts\/(?:e2e-|release-macos|package-macos|verify-package|test-helpers)/.test(
      entry,
    )
  ) {
    failures.push(`development-only script leaked into the archive: ${entry}`);
  }
}

for (const entry of required) {
  if (!entries.includes(entry)) failures.push(`required entry is missing: ${entry}`);
}

const expectedLine = readFileSync(checksumPath, "utf8").trim();
const [expectedHash, expectedName] = expectedLine.split(/\s+/, 2);
const actualHash = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
if (expectedName !== zipName) failures.push(`checksum names ${expectedName}, expected ${zipName}`);
if (expectedHash !== actualHash) failures.push("SHA-256 checksum does not match the archive");

if (failures.length) {
  throw new Error(`Package verification failed:\n- ${failures.join("\n- ")}`);
}

// macOS's old zipinfo can garble UTF-8 filenames written by ditto. Verify the
// actual native extraction, including the Chinese first-run entry points,
// rather than treating display encoding as a missing file (or skipping them).
const extracted = mkdtempSync(path.join(os.tmpdir(), "pulse-package-verify-"));
try {
  execFileSync("/usr/bin/ditto", ["-x", "-k", zipPath, extracted]);
  const privacy = scanPublicDirectory(extracted);
  if (privacy.findings.length) {
    throw new Error(`Archive public-content check failed: ${JSON.stringify(privacy.findings)}`);
  }
  for (const name of ["开始使用.md", "安装 Codex Pulse.command"]) {
    const actual = readFileSync(path.join(extracted, bundleName, name));
    if (!actual.equals(readFileSync(path.join(projectDir, name)))) {
      throw new Error(`Extracted file does not match source: ${name}`);
    }
  }
} finally {
  rmSync(extracted, { recursive: true, force: true });
}

console.log(
  JSON.stringify(
    { ok: true, zipPath, entries: entries.length, sha256: actualHash },
    null,
    2,
  ),
);
