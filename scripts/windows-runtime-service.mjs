import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);
export class WindowsRuntimeService {
  constructor({ dataDir, sourceBinary, env, startAtLogin = true }) {
    if (process.platform !== "win32") throw Error("Native Windows service is required");
    this.dataDir = dataDir; this.sourceBinary = sourceBinary; this.env = { ...env, CODEX_PULSE_DATA_DIR: dataDir }; this.startAtLogin = startAtLogin;
  }
  target() { return path.join(this.dataDir, "app", "CodexPulse.exe"); }
  async call(binary, args) {
    try { return JSON.parse((await execute(binary, args, { env: this.env, encoding: "utf8", windowsHide: true, timeout: 45000 })).stdout.replace(/^\uFEFF/, "")); }
    catch (cause) { throw new Error("Windows 服务操作未确认：" + args[0] + (args[0] === "--startup" ? "/" + args[1] : ""), { cause }); }
  }
  async capture(hadOld) {
    const binary = hadOld ? this.target() : this.sourceBinary;
    const startup = await this.call(binary, ["--startup", "status"]), background = await this.call(binary, ["--background-info"]);
    if (typeof startup.installed !== "boolean" || typeof startup.enabled !== "boolean" || typeof background.running !== "boolean") throw Error("Unknown original startup state");
    return { startup: { installed: startup.installed, enabled: startup.enabled }, running: background.running };
  }
  async quiesce() {
    // During a partially completed move there may be no app. The source
    // component can stop only the exact data-directory generation; it cannot
    // silently edit a task belonging to a different executable location.
    let binary = this.target(), hasTarget = true;
    try { await readFile(path.join(this.dataDir, "app", "package.json")); }
    catch (e) { if (e.code !== "ENOENT") throw e; binary = this.sourceBinary; hasTarget = false; }
    if (hasTarget) {
      const startup = await this.call(binary, ["--startup", "status"]);
      if (startup.installed) await this.call(binary, ["--startup", "disable"]);
    }
    await this.call(binary, ["--stop-background"]);
  }
  async undoActivation(original) {
    const startup = await this.call(this.target(), ["--startup", "status"]);
    if (!original.startup.installed && startup.installed) {
      await this.call(this.target(), ["--startup", "disable"]);
      await this.call(this.target(), ["--startup", "remove"]);
    }
  }
  async health() {
    try { return JSON.parse(await readFile(path.join(this.dataDir, "background-status.json"), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  }
  async quota() {
    try { return JSON.parse(await readFile(path.join(this.dataDir, "state.json"), "utf8")); }
    catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  }
  async start(enabled, hasContext = true, requireQuota = true) {
    const before = await this.health();
    const beforeQuota = await this.quota();
    if (enabled) await this.call(this.target(), ["--startup", "start"]);
    else {
      const child = spawn(this.target(), hasContext ? ["--startup-background", this.dataDir] : ["--background"], { env: this.env, detached: true, windowsHide: true, stdio: "ignore" });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); }); child.unref();
    }
    const deadline = Date.now() + 45000;
    do {
      const health = await this.health();
      const quota = await this.quota();
      const freshQuota = typeof quota.quotaSampleId === "string" && quota.quotaSampleId !== beforeQuota.quotaSampleId
        && [quota.lastSummary?.fiveHour, quota.lastSummary?.weekly].some(window => Number.isFinite(window?.remainingPercent));
      if (health.generation !== before.generation && health.state === "running" && (!requireQuota || freshQuota)
          && (await this.call(this.target(), ["--background-info"])).running) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    throw Error("新后台未确认就绪，安装验证失败。");
  }
  async activate(original, fresh) {
    await this.call(this.target(), ["--startup", "configure"]);
    const enabled = original.startup.installed ? original.startup.enabled : fresh && this.startAtLogin;
    if (enabled) await this.call(this.target(), ["--startup", "enable"]);
    if (fresh || original.running) await this.start(enabled);
  }
  async restore(original, { hadOld, restoreFiles, hasContext }) {
    if (!hadOld) { await restoreFiles(); return; }
    if (original.startup.installed) await this.call(this.target(), ["--startup", original.startup.enabled ? "enable" : "disable"]);
    await restoreFiles(); // Restore the exact original context AFTER enable writes its capture.
    if (original.running) await this.start(original.startup.enabled, hasContext, false);
  }
  async verify(original, fresh) {
    const startup = await this.call(this.target(), ["--startup", "status"]);
    const expected = original.startup.installed ? original.startup.enabled : fresh && this.startAtLogin;
    if (startup.enabled !== expected) throw Error("自启状态验证失败。");
    const info = await this.call(this.target(), ["--background-info"]);
    if (info.running !== (fresh || original.running)) throw Error("后台状态验证失败。");
  }
  async verifyRestored(original, hadOld) {
    const current = await this.capture(hadOld);
    if (JSON.stringify(current) !== JSON.stringify(original)) throw Error("原启动状态未完整恢复。");
  }
}
