#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pulseDataDirectory, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";
import { WindowsRuntimeService } from "./windows-runtime-service.mjs";
import { WindowsPluginOperation } from "./windows-plugin-operation.mjs";
import { removeWindowsInstallation } from "./windows-uninstallation-transaction.mjs";
import { verifyWindowsBundle } from "./windows-bundle-manifest.mjs";
import { recoverWindowsMaintenance } from "./windows-maintenance-recovery.mjs";

export async function uninstallWindows({ sourceRoot = path.resolve(import.meta.dirname, ".."), env = process.env } = {}) {
  if (process.platform !== "win32") throw Error("此卸载入口需要原生 Windows。");
  await verifyWindowsBundle(sourceRoot);
  const dataDir = pulseDataDirectory({ env }), sourceBinary = path.join(sourceRoot, "CodexPulse.exe");
  const childEnv = { ...env, CODEX_BINARY: resolveCodexExecutable({ env }), CODEX_PULSE_DATA_DIR: dataDir };
  const service = new WindowsRuntimeService({ dataDir, sourceBinary, env: childEnv });
  const recovered = await recoverWindowsMaintenance({ dataDir, service,
    pluginFor: root => new WindowsPluginOperation({ sourceRoot: root, dataDir, env: childEnv }),
    acquireLease: () => openWindowsInstallationLease({ binary: sourceBinary, env: childEnv }) });
  if (recovered.operation === "uninstall") return { ok: true, ...recovered };
  const plugin = new WindowsPluginOperation({ sourceRoot: path.join(dataDir, "app"), dataDir, env: childEnv });
  return removeWindowsInstallation({ dataDir, service, plugin,
    acquireLease: () => openWindowsInstallationLease({ binary: sourceBinary, env: childEnv }) });
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify({ ...await uninstallWindows(),
      note: "已停止 Codex Pulse 后台并卸载运行程序、自启和本产品插件；任务计划、额度历史、偏好与用卡记录已保留。现有 Codex 会话可在方便时重开以卸载 Hook。" }));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
