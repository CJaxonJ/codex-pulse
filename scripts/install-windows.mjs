#!/usr/bin/env node
import { cp, mkdir, lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pulseDataDirectory, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { ensureWindowsPrivateDirectory } from "../src/private-directory.mjs";
import { ownedWindowsProcessInvocation } from "../src/windows-process-bridge.mjs";
import { assertInstallerOutsideRuntime, openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";
import { replaceWindowsRuntime, runtimeFingerprint } from "./windows-installation-transaction.mjs";
import { WindowsRuntimeService } from "./windows-runtime-service.mjs";
import { WindowsPluginOperation } from "./windows-plugin-operation.mjs";

const execute = promisify(execFile);
// This is the installation entry for an already-extracted, bundled package.
// Packaging, shortcuts and the user-facing setup window are separate gates;
// this source entry must not be advertised as the finished Windows release.
export async function installWindows({ sourceRoot = path.resolve(import.meta.dirname, ".."), env = process.env, startAtLogin = true } = {}) {
  if (process.platform !== "win32") throw Error("此安装入口需要原生 Windows。");
  if (Number(process.versions.node.split(".")[0]) < 20 || !path.isAbsolute(sourceRoot)) throw Error("安装包运行环境不完整。");
  const dataDir = pulseDataDirectory({ env }), sourceBinary = path.join(sourceRoot, "CodexPulse.exe");
  // Validate the package before creating/stopping anything in an old install.
  const entries = ["bin", "src", "scripts", "plugin", ".agents/plugins/marketplace.json", "package.json", "CodexPulse.exe", "CodexPulse.exe.config", "runtime/node.exe"];
  for (const name of entries) await runtimeFingerprint(path.join(sourceRoot, name));
  for (const name of ["CodexPulse.exe", "CodexPulse.exe.config", "runtime/node.exe", "scripts/install-plugin.mjs"]) {
    if (!(await lstat(path.join(sourceRoot, name))).isFile()) throw Error("安装包缺少必要文件。");
  }
  await ensureWindowsPrivateDirectory(dataDir);
  await assertInstallerOutsideRuntime({ dataDir }); await assertInstallerOutsideRuntime({ dataDir, executable: sourceBinary });
  const binary = resolveCodexExecutable({ env });
  if (!path.isAbsolute(binary)) throw Error("无法确认 Codex 的本机安装路径。");
  const childEnv = { ...env, CODEX_BINARY: binary, CODEX_PULSE_DATA_DIR: dataDir };
  const stagedName = "app-install-" + randomUUID().replaceAll("-", ""), staged = path.join(dataDir, stagedName);
  for (const name of entries) {
    const target = path.join(staged, name); await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(sourceRoot, name), target, { recursive: true, errorOnExist: true, force: false });
  }
  const plugin = new WindowsPluginOperation({ sourceRoot, dataDir, env: childEnv });
  const service = new WindowsRuntimeService({ dataDir, sourceBinary, env: childEnv, startAtLogin });
  return replaceWindowsRuntime({ dataDir, stagedName, service,
    acquireLease: () => openWindowsInstallationLease({ binary: sourceBinary, env: childEnv }),
    preflight: async () => {
      // Read fresh account quota through the existing owned App Server bridge;
      // no auth file parsing, token copying, model calls or automatic login.
      const call = ownedWindowsProcessInvocation({ file: path.join(sourceRoot, "runtime", "node.exe"), args: [path.join(sourceRoot, "bin", "codex-pulse.mjs"), "status"] });
      const output = await execute(call.file, call.args,
        { env: childEnv, cwd: dataDir, encoding: "utf8", timeout: 30000, windowsHide: true, maxBuffer: 1024 ** 2 });
      const result = JSON.parse(output.stdout);
      if (result.ok !== true || ![result.summary?.fiveHour, result.summary?.weekly].some(window => Number.isFinite(window?.remainingPercent)
          && window.remainingPercent >= 0 && window.remainingPercent <= 100)) throw Error("尚未读取到 Codex 订阅额度。请先登录支持额度读取的 Codex 账号；现有安装未停止。");
      await plugin.prepare();
    },
    installSideEffects: () => plugin.install(), rollbackSideEffects: () => plugin.rollback(),
  });
}

// Node resolves the module to its real path; argv can still use an 8.3 alias
// or directory link. A lexical URL comparison would silently skip Setup.
const isEntry = process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
if (isEntry) {
  try {
    const result = await installWindows();
    console.log(JSON.stringify({ ...result, hookTrustRequired: true,
      note: "监控已安装。请在 Codex Pulse 的保护授权窗口亲自确认；不会替你授信、重启 Codex 或使用重置卡。" }));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
