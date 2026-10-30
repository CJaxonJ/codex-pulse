import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execute = promisify(execFile);
const project = path.resolve(import.meta.dirname, "../..");
export async function windowsUIFixture({ root, dataDir, env = {}, installed = false, sourceBundle } = {}) {
  if (process.platform !== "win32") throw Error("A real Windows runtime is required");
  root ||= await mkdtemp(path.join(os.tmpdir(), "pulse 设置 中文-"));
  dataDir ||= path.join(root, "数据");
  const appRoot = installed ? path.join(dataDir, "app") : path.join(root, "app 空格"), home = path.join(root, "codex");
  await mkdir(path.join(appRoot, "runtime"), { recursive: true });
  await mkdir(dataDir, { recursive: true }); await mkdir(home, { recursive: true });
  if (sourceBundle) {
    if (!path.isAbsolute(sourceBundle)) throw Error("An absolute isolated bundle source is required");
    // Populate before any bundled process starts; do not overwrite a runtime
    // executable which an earlier fixture command might still have mapped.
    await cp(sourceBundle, appRoot, { recursive: true, force: false, errorOnExist: true });
  } else {
    for (const entry of ["bin", "src", "package.json"]) await cp(path.join(project, entry), path.join(appRoot, entry), { recursive: true });
    await cp(process.execPath, path.join(appRoot, "runtime/node.exe"));
    for (const entry of ["CodexPulse.exe", "CodexPulse.exe.config"]) await cp(path.join(project, "build/windows", entry), path.join(appRoot, entry));
  }
  const childEnv = { ...process.env, CODEX_HOME: home, CODEX_BINARY: "missing-isolated-codex.exe", ...env, CODEX_PULSE_DATA_DIR: dataDir, CODEX_PULSE_APP_ROOT: "" };
  const start = mode => {
    const child = spawn(path.join(appRoot, "CodexPulse.exe"), [mode], { env: childEnv, windowsHide: false, stdio: ["ignore", "ignore", "pipe"] });
    const closed = once(child, "exit"); let diagnostic = ""; child.stderr.on("data", b => diagnostic += b);
    return { child, closed, diagnostic: () => diagnostic };
  };
  const cli = async args => JSON.parse((await execute(path.join(appRoot, "runtime/node.exe"), [path.join(appRoot, "bin/codex-pulse.mjs"), ...args], { env: childEnv, windowsHide: true, encoding: "utf8", timeout: 25000 })).stdout);
  return { root, dataDir, appRoot, env: childEnv, start, cli };
}

export async function inspectWindowsUI(session, { title, click, screenshot, tab } = {}) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(project, "scripts/test-support/windows-ui-inspect.ps1"), "-TargetProcess", String(session.child.pid)];
  if (title) args.push("-WindowTitle", title);
  if (click) args.push("-Click", click);
  if (screenshot) args.push("-Screenshot", screenshot);
  if (tab != null) args.push("-SelectTabIndex", String(tab));
  try {
    return JSON.parse((await execute("powershell.exe", args, { encoding: "utf8", windowsHide: true, timeout: 20000 })).stdout.replace(/^\uFEFF/, ""));
  } catch (error) { throw Error(error.message + " " + session.diagnostic()); }
}

export async function waitForWindowsUI(session, predicate, options = {}) {
  const deadline = Date.now() + 30000;
  let last;
  do {
    if (session.child.exitCode != null) throw Error("Native UI exited: " + session.diagnostic());
    last = await inspectWindowsUI(session, options);
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw Error("Native UI state was not observed: " + JSON.stringify(last));
}
