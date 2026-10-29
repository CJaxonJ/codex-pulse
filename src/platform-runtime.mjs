import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

export function pulseDataDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.CODEX_PULSE_DATA_DIR) return paths.resolve(env.CODEX_PULSE_DATA_DIR);
  if (platform === "win32") return paths.join(env.LOCALAPPDATA || paths.join(home, "AppData", "Local"), "Codex Pulse");
  return paths.join(home, "Library", "Application Support", "Codex Pulse");
}

export function resolveCodexExecutable({ platform = process.platform, env = process.env, home = os.homedir(), exists = existsSync, find = execFileSync } = {}) {
  if (env.CODEX_BINARY) return env.CODEX_BINARY;
  if (platform === "win32") {
    const p = path.win32;
    const local = env.LOCALAPPDATA || p.join(home, "AppData", "Local");
    const candidates = [p.join(local, "OpenAI", "Codex", "bin", "codex.exe"),
      p.join(env.CODEX_HOME || p.join(home, ".codex"), "packages", "standalone", "current", "bin", "codex.exe")];
    for (const candidate of candidates) if (exists(candidate)) return candidate;
    for (const name of ["codex.exe", "codex.cmd"]) {
      try {
        const matches = find("where.exe", [name], { encoding: "utf8", windowsHide: true, timeout: 5000 })
          .trim().split(/\r?\n/).filter(Boolean);
        const found = matches.find(candidate => p.isAbsolute(candidate) && exists(candidate));
        if (found) return found;
      } catch { /* Try the other documented install route. */ }
    }
    throw Error("未找到 Windows Codex。请先安装并登录 Codex，再重新打开 Codex Pulse。");
  }
  const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  return exists(desktop) ? desktop : "codex";
}

// npm's Windows shim is a batch file, not an executable. Never concatenate
// prompts, paths or recovery text into cmd.exe /c or enable shell:true.
export function codexInvocation(binary, args, { platform = process.platform, exists = existsSync, node = process.execPath } = {}) {
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(binary)) {
    if (!path.win32.isAbsolute(binary)) throw Error("Codex Windows shim must have an absolute path");
    const entry = path.win32.join(path.win32.dirname(binary), "node_modules", "@openai", "codex", "bin", "codex.js");
    if (!exists(entry)) throw Error("无法安全解析 Codex npm 启动入口；请使用 codex.exe 或重新安装官方 Codex CLI。");
    return { file: node, args: [entry, ...args] };
  }
  return { file: binary, args: [...args] };
}
