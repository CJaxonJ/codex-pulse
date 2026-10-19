#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  `${bundleName}/LICENSE`,
  `${bundleName}/package.json`,
  `${bundleName}/Install Codex Pulse.command`,
  `${bundleName}/bin/codex-pulse.mjs`,
  `${bundleName}/src/chat-continuity-controller.mjs`,
  `${bundleName}/src/chat-continuity-store.mjs`,
  `${bundleName}/src/tibo-classifier.mjs`,
  `${bundleName}/src/tibo-credentials.mjs`,
  `${bundleName}/src/tibo-x-api-client.mjs`,
  `${bundleName}/scripts/install-macos.mjs`,
  `${bundleName}/scripts/uninstall-macos.mjs`,
];

for (const entry of entries) {
  if (!entry.startsWith(`${bundleName}/`)) {
    failures.push(`entry escaped the top-level product folder: ${entry}`);
  }
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

console.log(
  JSON.stringify(
    { ok: true, zipPath, entries: entries.length, sha256: actualHash },
    null,
    2,
  ),
);
