#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
const distDir = path.join(projectDir, "dist");
const bundleName = `Codex-Pulse-${pkg.version}-macOS`;
const stagingDir = path.join(distDir, bundleName);
const zipPath = path.join(distDir, `${bundleName}.zip`);

rmSync(stagingDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(stagingDir, { recursive: true });

for (const entry of [".agents", "bin", "native", "plugin", "scripts", "src"]) {
  cpSync(path.join(projectDir, entry), path.join(stagingDir, entry), {
    recursive: true,
  });
}
for (const entry of [
  "README.md",
  "CHANGELOG.md",
  "PRIVACY.md",
  "SECURITY.md",
  "开始使用.md",
  "安装 Codex Pulse.command",
  "package.json",
]) {
  cpSync(path.join(projectDir, entry), path.join(stagingDir, entry));
}

execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", stagingDir, zipPath]);
rmSync(stagingDir, { recursive: true, force: true });

console.log(JSON.stringify({ ok: true, zipPath }, null, 2));
