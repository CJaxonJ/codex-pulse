#!/usr/bin/env node
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pulseDataDirectory, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { openWindowsInstallationLease } from "../src/windows-installation-lease.mjs";
import { WindowsRuntimeService } from "./windows-runtime-service.mjs";
import { WindowsPluginOperation } from "./windows-plugin-operation.mjs";
import { removeWindowsInstallation } from "./windows-uninstallation-transaction.mjs";

export async function uninstallWindows({ sourceRoot = path.resolve(import.meta.dirname, ".."), env = process.env } = {}) {
  if (process.platform !== "win32") throw Error("此卸载入口需要原生 Windows。");
  const dataDir = pulseDataDirectory({ env }), sourceBinary = path.join(sourceRoot, "CodexPulse.exe");
  const childEnv = { ...env, CODEX_BINARY: resolveCodexExecutable({ env }), CODEX_PULSE_DATA_DIR: dataDir };
  const service = new WindowsRuntimeService({ dataDir, sourceBinary, env: childEnv });
  const plugin = new WindowsPluginOperation({ sourceRoot: path.join(dataDir, "app"), dataDir, env: childEnv });
  return removeWindowsInstallation({ dataDir, service, plugin,
    acquireLease: () => openWindowsInstallationLease({ binary: sourceBinary, env: childEnv }) });
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
  try {
    console.log(JSON.stringify({ ...await uninstallWindows(),
      note: "已卸载运行程序、自启和本产品插件；任务计划、额度历史、偏好与用卡记录已保留。现有 Codex 会话可在方便时重开，不会替你中断任务。" }));
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
