#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  cpSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { scanPublicDirectory } from "./public-content-policy.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
const distDir = path.join(projectDir, "dist");
const bundleName = `Codex-Pulse-${pkg.version}-macOS`;
const stagingDir = path.join(distDir, bundleName);
const zipPath = path.join(distDir, `${bundleName}.zip`);
const checksumPath = path.join(distDir, "SHA256SUMS.txt");

rmSync(stagingDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
rmSync(checksumPath, { force: true });
mkdirSync(stagingDir, { recursive: true });

for (const entry of [".agents", "bin", "brand", "native", "plugin", "src"]) {
  cpSync(path.join(projectDir, entry), path.join(stagingDir, entry), {
    recursive: true,
  });
}
mkdirSync(path.join(stagingDir, "scripts"), { recursive: true });
for (const entry of [
  "build-brand-assets.mjs",
  "build-notifier-macos.mjs",
  "install-macos.mjs",
  "install-plugin.mjs",
  "installation-transaction.mjs",
  "setup-notifications-macos.mjs",
  "update-runtime-macos.mjs",
  "uninstall-macos.mjs",
]) {
  cpSync(
    path.join(projectDir, "scripts", entry),
    path.join(stagingDir, "scripts", entry),
  );
}
for (const entry of [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "PRIVACY.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "开始使用.md",
  "安装 Codex Pulse.command",
  "package.json",
]) {
  cpSync(path.join(projectDir, entry), path.join(stagingDir, entry));
}
cpSync(
  path.join(projectDir, "安装 Codex Pulse.command"),
  path.join(stagingDir, "Install Codex Pulse.command"),
);
mkdirSync(path.join(stagingDir, "docs", "releases"), { recursive: true });
cpSync(
  path.join(projectDir, "docs", "technical-guide.md"),
  path.join(stagingDir, "docs", "technical-guide.md"),
);
cpSync(
  path.join(projectDir, "docs", "public-disclosure.md"),
  path.join(stagingDir, "docs", "public-disclosure.md"),
);
cpSync(
  path.join(projectDir, "docs", "releases", `v${pkg.version}.md`),
  path.join(stagingDir, "docs", "releases", `v${pkg.version}.md`),
);

const privacy = scanPublicDirectory(stagingDir);
if (privacy.findings.length) throw new Error(`Staged archive public-content check failed: ${JSON.stringify(privacy.findings)}`);

execFileSync("/usr/bin/ditto", [
  "-c",
  "-k",
  "--norsrc",
  "--keepParent",
  stagingDir,
  zipPath,
]);
rmSync(stagingDir, { recursive: true, force: true });

const hash = createHash("sha256");
await pipeline(createReadStream(zipPath), hash);
await pipeline(
  async function* checksum() {
    yield `${hash.digest("hex")}  ${path.basename(zipPath)}\n`;
  },
  createWriteStream(checksumPath),
);

execFileSync(process.execPath, [path.join(projectDir, "scripts", "verify-package.mjs")], {
  cwd: projectDir,
  env: process.env,
  stdio: "inherit",
});

console.log(JSON.stringify({ ok: true, zipPath, checksumPath }, null, 2));
