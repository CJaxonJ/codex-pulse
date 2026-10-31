#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { scanPublicDirectory } from "./public-content-policy.mjs";
import { sha256File, writeWindowsBundleManifest, verifyWindowsBundle } from "./windows-bundle-manifest.mjs";

const project = path.resolve(import.meta.dirname, "..");
export async function packageWindows() {
  if (process.platform !== "win32" || process.arch !== "x64" || Number(process.versions.node.split(".")[0]) !== 22) throw Error("Windows 验收包需要原生 Windows x64 与已测试的 Node 22。");
  // The official CI toolcache comes from Node's release archive. Preserve its
  // upstream licence, never ship a runtime whose licence could not be read.
  const nodeLicense = await readFile(path.join(path.dirname(process.execPath), "LICENSE"));
  if (!nodeLicense.toString("utf8").includes("Node.js") || !nodeLicense.toString("utf8").includes("Permission is hereby granted")) throw Error("Node 许可证不完整，未生成分发包。");
  const pkg = JSON.parse(await readFile(path.join(project, "package.json"), "utf8"));
  if (pkg.name !== "codex-pulse" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw Error("产品版本不正确。");
  const dist = path.join(project, "dist"); await mkdir(dist, { recursive: true });
  const output = await mkdtemp(path.join(dist, "windows-")), bundleName = `Codex-Pulse-${pkg.version}-Windows-x64-dev`;
  const staging = path.join(output, "staging"), bundle = path.join(staging, bundleName);
  await mkdir(bundle, { recursive: true });
  try {
    for (const name of ["bin", "src", "plugin", "package.json", "LICENSE", "PRIVACY.md", "SECURITY.md"]) await cp(path.join(project, name), path.join(bundle, name), { recursive: true, force: false, errorOnExist: true });
    await mkdir(path.join(bundle, ".agents", "plugins"), { recursive: true });
    await cp(path.join(project, ".agents", "plugins", "marketplace.json"), path.join(bundle, ".agents", "plugins", "marketplace.json"));
    await mkdir(path.join(bundle, "scripts"));
    for (const name of ["install-windows.mjs", "uninstall-windows.mjs", "install-plugin.mjs", "installation-transaction.mjs",
      "windows-installation-transaction.mjs", "windows-uninstallation-transaction.mjs", "windows-maintenance-recovery.mjs", "windows-runtime-service.mjs", "windows-plugin-operation.mjs", "windows-bundle-manifest.mjs"]) await cp(path.join(project, "scripts", name), path.join(bundle, "scripts", name));
    for (const name of ["CodexPulse.exe", "CodexPulse.exe.config"]) await cp(path.join(project, "build", "windows", name), path.join(bundle, name));
    await cp(path.join(project, "docs", "windows-dev-bundle.md"), path.join(bundle, "README.md"));
    const privacy = scanPublicDirectory(bundle);
    if (privacy.findings.length) throw Error("产品源文件未通过公开内容检查：" + JSON.stringify(privacy.findings));
    // Upstream licence text can contain its authors' public addresses. It is
    // preserved verbatim, separately from the first-party privacy scan.
    await mkdir(path.join(bundle, "runtime")); await mkdir(path.join(bundle, "licenses"));
    await cp(process.execPath, path.join(bundle, "runtime", "node.exe"));
    await writeFile(path.join(bundle, "licenses", "node-LICENSE.txt"), nodeLicense, { flag: "wx" });
    await writeWindowsBundleManifest(bundle, { appVersion: pkg.version, nodeVersion: process.version });
    await verifyWindowsBundle(bundle);
    const archive = path.join(output, bundleName + ".zip"), extracted = path.join(output, "verified-extraction");
    // .NET ZIP includes dot-prefixed .agents/.codex-plugin files. No shell
    // interpolation, current working directory or user configuration input.
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($env:PULSE_ZIP_SOURCE,$env:PULSE_ZIP_OUTPUT);[IO.Compression.ZipFile]::ExtractToDirectory($env:PULSE_ZIP_OUTPUT,$env:PULSE_ZIP_EXTRACT)"],
    { env: { ...process.env, PULSE_ZIP_SOURCE: staging, PULSE_ZIP_OUTPUT: archive, PULSE_ZIP_EXTRACT: extracted }, windowsHide: true, encoding: "utf8", timeout: 90000 });
    const value = await verifyWindowsBundle(path.join(extracted, bundleName));
    const checksum = await sha256File(archive);
    await writeFile(path.join(output, "SHA256SUMS.txt"), checksum + "  " + path.basename(archive) + "\n", { flag: "wx" });
    await rm(extracted, { recursive: true });
    return { ok: true, archive, checksum, files: value.files.length, nodeVersion: value.nodeVersion, devOnly: true, guiInstallerVerified: false };
  } finally { await rm(staging, { recursive: true }); } // Exact directory created by this operation only.
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) console.log(JSON.stringify(await packageWindows()));
