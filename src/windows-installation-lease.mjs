import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { nativeWindowsComponent } from "./windows-process-bridge.mjs";
import { pulseDataDirectory } from "./platform-runtime.mjs";

export async function assertInstallerOutsideRuntime({ dataDir, executable = process.execPath }) {
  if (process.platform !== "win32") return;
  const data = (await realpath(dataDir)).toLowerCase(), owner = (await realpath(executable)).toLowerCase();
  if (owner.startsWith(data + path.sep)) {
    const child = owner.slice(data.length + 1).split(path.sep)[0];
    if (child === "app" || /^app-(?:install|backup|failed)-[a-f0-9]{32}$/.test(child)) throw Error("请从下载的安装包运行升级，不能替换正在执行安装操作的运行时。");
  }
}

export async function openWindowsInstallationLease({ gate = false, binary = nativeWindowsComponent(), env = process.env } = {}) {
  if (process.platform !== "win32") throw Error("A real Windows installation lease is required");
  if (!path.isAbsolute(binary)) throw Error("An absolute bundled Windows component is required");
  if (!gate) await assertInstallerOutsideRuntime({ dataDir: pulseDataDirectory({ env }) });
  const child = spawn(binary, [gate ? "--maintenance-gate" : "--installation-lease"], { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, released = false, pending = null, diagnostic = "";
  child.stderr.on("data", value => { diagnostic = (diagnostic + value).slice(-2000); });
  let closedResult;
  const closed = new Promise(resolve => {
    child.once("error", error => { closedResult = { error }; resolve(closedResult); });
    child.once("exit", (code, signal) => { closedResult = { code, signal }; resolve(closedResult); });
  });
  const error = () => new Error("安装维护锁不可用或运行状态未知，未继续替换文件。", { cause: diagnostic ? new Error(diagnostic) : undefined });
  child.stdin.on("error", () => {
    if (pending) { clearTimeout(pending.timer); pending.reject(error()); pending = null; }
  });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const timeout = setTimeout(() => { readyReject(error()); child.kill(); }, 20000);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const value = JSON.parse(line);
      if (value.status === "maintenance_acquired") { clearTimeout(timeout); readyResolve(); }
      else if (pending && value.id === pending.id) {
        const request = pending; pending = null; clearTimeout(request.timer);
        value.ok === true ? request.resolve() : request.reject(error());
      } else throw Error("Unexpected installation response");
    } catch { readyReject(error()); child.kill(); }
  });
  void closed.then(() => {
    clearTimeout(timeout); readyReject(error());
    if (pending) { clearTimeout(pending.timer); pending.reject(error()); pending = null; }
  });
  try { await ready; }
  catch (cause) { if (!closedResult) child.kill(); await closed; lines.close(); throw cause; }
  const release = async () => {
    if (released) return;
    released = true;
    if (!closedResult) child.stdin.end("release\n");
    const deadline = setTimeout(() => { if (!closedResult) child.kill(); }, 5000);
    try {
      const result = await closed;
      if (result.error || result.signal || result.code !== 0) throw error();
    } finally { clearTimeout(deadline); lines.close(); }
  };
  return {
    // Actual handle exposed for the isolated death test; never used to kill a
    // PID read from disk. Runtime mutations occur only inside this child.
    child, closed, release,
    move(from, to) {
      if (gate || released || closedResult || pending) return Promise.reject(error());
      const valid = name => name === "app" || /^app-(?:install|backup|failed)-[a-f0-9]{32}$/.test(name);
      if (!valid(from) || !valid(to)) return Promise.reject(Error("Invalid owned runtime name"));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { if (pending?.id === id) { pending = null; child.kill(); reject(error()); } }, 20000);
        pending = { id, resolve, reject, timer };
        child.stdin.write(JSON.stringify({ id, op: "move", from, to }) + "\n", failure => {
          if (failure && pending?.id === id) { clearTimeout(timer); pending = null; reject(error()); }
        });
      });
    },
  };
}
