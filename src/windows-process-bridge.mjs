import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function appServerProcessInvocation(invocation) {
  if (process.platform !== "win32") return invocation;
  if (!path.isAbsolute(invocation.file) || !existsSync(invocation.file)) {
    const error = new Error("ENOENT: Codex App Server executable was not found"); error.code = "ENOENT"; throw error;
  }
  // Resolve relative to this shipped module, never an executable from PATH or
  // the user's working directory. Source checkouts use the built test artifact.
  const root = fileURLToPath(new URL("../", import.meta.url));
  const installed = path.join(root, "CodexPulse.exe");
  const bridge = existsSync(installed) ? installed : path.join(root, "build/windows/CodexPulse.exe");
  if (!existsSync(bridge)) throw new Error("Windows 连接组件未安装完整，请重新安装 Codex Pulse。");
  return { file: bridge, args: ["--app-server-bridge", invocation.file, ...invocation.args] };
}
