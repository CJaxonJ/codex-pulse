import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("rounded tile keeps the selected mark and palette", () => {
  const app = readFileSync(path.join(root, "brand/codex-pulse-app-icon.svg"), "utf8");
  const mark = readFileSync(path.join(root, "brand/codex-pulse-mark.svg"), "utf8");
  const paths = (svg) => [...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(paths(app), paths(mark));
  assert.match(app, /width="896" height="896" rx="208"/);
  for (const color of ["#171D1C", "#29312F", "#2E8477", "#67B7A8", "#F3F5F2"]) {
    assert.ok(app.includes(color), color);
  }
});

test("shipped PNG and ICNS have real transparent rounded corners at small and large sizes", {
  skip: process.platform !== "darwin",
}, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pulse-brand-test-"));
  try {
    const executable = path.join(dir, "verify-brand");
    execFileSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(dir, "cache"),
      path.join(root, "native/BrandAssetRenderer.swift"), "-o", executable], {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: path.join(dir, "cache") },
    });
    for (const [file, sizes] of [
      ["brand/codex-pulse-app-icon.png", [1024]],
      ["brand/codex-pulse-64.png", [64]],
      ["native/AppIcon.icns", [16, 32, 64, 128, 256, 512, 1024]],
    ]) for (const size of sizes) {
      execFileSync(executable, ["verify-icon", path.join(root, file), String(size)]);
    }
    // A white-matted square must fail, even though its file still has an alpha channel.
    // Use the existing opaque social preview as a negative fixture, without writing files.
    assert.throws(() => execFileSync(executable,
      ["verify-icon", path.join(root, "brand/github-social-preview.png"), "64"], { stdio: "pipe" }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
