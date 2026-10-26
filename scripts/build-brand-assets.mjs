#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = path.join(projectDir, "brand");
const nativeDir = path.join(projectDir, "native");
const buildDir = path.join(projectDir, "build");
const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "codex-pulse-brand-"));

if (process.platform !== "darwin") {
  throw new Error("Codex Pulse brand raster and ICNS exports currently require macOS.");
}

function renderSvg(svgName, size) {
  const output = path.join(temporaryDir, `${svgName}.png`);
  execFileSync(renderer, ["render", path.join(brandDir, svgName), output,
    String(size), String(svgName === "github-social-preview.svg" ? size / 2 : size)]);
  return output;
}

const renderer = path.join(temporaryDir, "render-brand");
function verifyIcon(source, size) {
  execFileSync(renderer, ["verify-icon", source, String(size)], { stdio: "inherit" });
}

function resize(source, width, height, destination) {
  execFileSync("/usr/bin/sips", [
    "-z",
    String(height),
    String(width),
    source,
    "--out",
    destination,
  ], { stdio: "ignore" });
}

try {
  mkdirSync(brandDir, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  mkdirSync(buildDir, { recursive: true });
  execFileSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path",
    path.join(temporaryDir, "module-cache"),
    path.join(nativeDir, "BrandAssetRenderer.swift"), "-o", renderer], {
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(temporaryDir, "module-cache") },
  });

  const appMaster = renderSvg("codex-pulse-app-icon.svg", 1024);
  verifyIcon(appMaster, 1024);
  copyFileSync(appMaster, path.join(brandDir, "codex-pulse-app-icon.png"));
  resize(appMaster, 64, 64, path.join(brandDir, "codex-pulse-64.png"));
  verifyIcon(path.join(brandDir, "codex-pulse-64.png"), 64);

  const iconset = path.join(buildDir, "CodexPulse.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const [filename, pixels] of [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ]) {
    resize(appMaster, pixels, pixels, path.join(iconset, filename));
    verifyIcon(path.join(iconset, filename), pixels);
  }
  execFileSync("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(nativeDir, "AppIcon.icns"),
  ]);
  for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
    verifyIcon(path.join(nativeDir, "AppIcon.icns"), size);
  }

  const socialPreview = renderSvg("github-social-preview.svg", 1280);
  copyFileSync(socialPreview, path.join(brandDir, "github-social-preview.png"));
  execFileSync(renderer, ["preview", appMaster, path.join(buildDir, "icon-preview.png")]);

  console.log(JSON.stringify({
    ok: true,
    appIcon: path.join(nativeDir, "AppIcon.icns"),
    socialPreview: path.join(brandDir, "github-social-preview.png"),
  }, null, 2));
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
