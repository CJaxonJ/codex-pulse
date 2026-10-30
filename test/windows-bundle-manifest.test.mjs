import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { writeWindowsBundleManifest, verifyWindowsBundle } from "../scripts/windows-bundle-manifest.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-bundle-manifest-"));
  await mkdir(path.join(root, ".agents")); await writeFile(path.join(root, ".agents", "catalog.json"), "public product metadata");
  await writeFile(path.join(root, "program.txt"), "test filesystem port, not a real Windows binary");
  await writeWindowsBundleManifest(root, { appVersion: "0.9.21", nodeVersion: "v22.23.4" }); return root;
}
test("Windows manifest covers dot-prefixed product files and detects changed or unexpected files", async () => {
  const root = await fixture(), value = await verifyWindowsBundle(root);
  assert(value.files.some(file => file.path === ".agents/catalog.json"));
  await writeFile(path.join(root, "program.txt"), "changed"); await assert.rejects(verifyWindowsBundle(root), /内容与清单不一致/);
  const other = await fixture(); await writeFile(path.join(other, "unexpected.txt"), "not in bundle");
  await assert.rejects(verifyWindowsBundle(other), /内容与清单不一致/);
});
test("Windows manifests reject traversal, ADS, case collisions and unsupported platform metadata", async () => {
  for (const bad of [{ path: "../outside" }, { path: "program.txt:stream" }, { platform: "darwin" }, { arch: "arm64" }, { nodeVersion: "v20.0.0" }]) {
    const root = await fixture(), file = path.join(root, "bundle-manifest.json"), value = JSON.parse(await readFile(file, "utf8"));
    if (bad.path) value.files[0].path = bad.path; else Object.assign(value, bad);
    await writeFile(file, JSON.stringify(value)); await assert.rejects(verifyWindowsBundle(root));
  }
  const root = await fixture(), value = JSON.parse(await readFile(path.join(root, "bundle-manifest.json"), "utf8"));
  value.files.push({ ...value.files[0], path: ".AGENTS/catalog.json" });
  await writeFile(path.join(root, "bundle-manifest.json"), JSON.stringify(value)); await assert.rejects(verifyWindowsBundle(root));
});
test("Windows manifest traversal never follows a directory link into outside data", async () => {
  const root = await fixture(), outside = await mkdtemp(path.join(os.tmpdir(), "pulse-outside-bundle-"));
  await writeFile(path.join(outside, "keep.txt"), "outside unchanged");
  await symlink(outside, path.join(root, "external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(verifyWindowsBundle(root), /链接/);
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "outside unchanged");
});
