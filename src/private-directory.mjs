import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// chmod(0700) does not establish a Windows DACL. Never silently treat it as
// privacy protection, or continue the watcher after a failed ACL check.
export async function ensureWindowsPrivateDirectory(directory) {
  if (process.platform !== "win32") return { ok: true, applicable: false };
  const script = fileURLToPath(new URL("./private-directory-windows.ps1", import.meta.url));
  try {
    const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Directory", directory], { windowsHide: true, encoding: "utf8", timeout: 60000, maxBuffer: 65536 });
    const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
    if (value.ok !== true || value.applicable !== true) throw Error("Invalid ACL acknowledgement");
    return value;
  } catch (cause) {
    // Raw PowerShell errors can contain private local paths.
    throw new Error("无法确认 Codex Pulse 数据目录的私有权限，后台尚未启动。未扩大权限，请检查目录位置或重新安装。", { cause });
  }
}
