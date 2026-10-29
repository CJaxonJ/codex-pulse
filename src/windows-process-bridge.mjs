import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export function nativeWindowsComponent() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const installed = path.join(root, "CodexPulse.exe");
  const bridge = existsSync(installed) ? installed : path.join(root, "build/windows/CodexPulse.exe");
  if (!existsSync(bridge)) throw new Error("Windows 连接组件未安装完整，请重新安装 Codex Pulse。");
  return bridge;
}

export function ownedWindowsProcessInvocation(invocation) {
  if (process.platform !== "win32") return invocation;
  if (!path.isAbsolute(invocation.file) || !existsSync(invocation.file)) {
    const error = new Error("ENOENT: Codex App Server executable was not found"); error.code = "ENOENT"; throw error;
  }
  // Resolve relative to this shipped module, never an executable from PATH or
  // the user's working directory. Source checkouts use the built test artifact.
  return { file: nativeWindowsComponent(), args: ["--app-server-bridge", invocation.file, ...invocation.args] };
}

export function readWindowsProcessIdentity(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) throw Error("A real Windows process identifier is required");
  const raw = execFileSync(nativeWindowsComponent(), ["--process-identity", String(pid)], { encoding: "utf8", windowsHide: true, timeout: 3000, maxBuffer: 4096 });
  const result = JSON.parse(raw.replace(/^\uFEFF/, ""));
  if (result.exists === false) return result;
  if (result.exists !== true || !/^\d{1,20}$/.test(result.creationTimeFileTime)) throw Error("Unverifiable Windows process identity");
  return result;
}

let currentIdentity;
export function currentWindowsProcessIdentity() {
  if (process.platform !== "win32") return null;
  if (currentIdentity === undefined) {
    try {
      const value = readWindowsProcessIdentity(process.pid);
      currentIdentity = value.exists ? Object.freeze({ platform: "win32", creationTimeFileTime: value.creationTimeFileTime }) : null;
    } catch { currentIdentity = null; } // Optional identity failure must not disable the quota Hook's hard floor.
  }
  return currentIdentity;
}
