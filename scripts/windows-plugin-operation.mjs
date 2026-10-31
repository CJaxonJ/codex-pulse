import { cp, lstat, mkdir, readFile, realpath, rename, rm, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { codexInvocation, resolveCodexExecutable } from "../src/platform-runtime.mjs";
import { ownedWindowsProcessInvocation } from "../src/windows-process-bridge.mjs";
import { runtimeFingerprint } from "./windows-installation-transaction.mjs";

const execute = promisify(execFile);
export const pulsePluginId = "codex-pulse@codex-pulse-local";
const marketName = "codex-pulse-local";
const exists = async file => { try { await lstat(file); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; } };
const localSpelling = value => process.platform === "win32" && /^\\\\\?\\[a-z]:\\/i.test(value) ? value.slice(4) : value;
async function samePath(a, b) {
  a = typeof a === "string" ? localSpelling(a) : a; b = typeof b === "string" ? localSpelling(b) : b;
  if (typeof a !== "string" || typeof b !== "string" || !path.isAbsolute(a) || !path.isAbsolute(b)) return false;
  // Catalog metadata is not authority to touch a network share or probe an
  // unrelated drive. Our owned source is always on this local data volume.
  if (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(a) || !/^[a-z]:[\\/]/i.test(b)
      || a.slice(0, 2).toLowerCase() !== b.slice(0, 2).toLowerCase())) return false;
  const values = await Promise.all([realpath(a), realpath(b)]);
  return process.platform === "win32" ? localSpelling(values[0]).toLowerCase() === localSpelling(values[1]).toLowerCase() : values[0] === values[1];
}

// Used inside the shared installation lock. Installation reuses compatible
// plugins without rewriting trust; uninstall must separately prove ownership
// against the verified installed runtime before using official removal APIs.
export class WindowsPluginOperation {
  constructor({ sourceRoot, dataDir, env = process.env, runJson, check } = {}) {
    this.sourceRoot = sourceRoot; this.dataDir = dataDir;
    this.env = { ...env, CODEX_PULSE_DATA_DIR: dataDir };
    this.root = path.join(dataDir, "marketplace");
    this.staged = path.join(dataDir, "marketplace-install-" + randomUUID().replaceAll("-", ""));
    // Do not let the folder from which Setup was opened implicitly select a
    // project marketplace. All subprocesses use this private installation scope.
    this.runJson = runJson || (async args => {
      const call = ownedWindowsProcessInvocation(codexInvocation(resolveCodexExecutable({ env: this.env }), args));
      return JSON.parse((await execute(call.file, call.args, { env: this.env, cwd: dataDir, encoding: "utf8", timeout: 90000, windowsHide: true, maxBuffer: 10 * 1024 ** 2 })).stdout);
    });
    this.check = check || (async () => {
      const call = ownedWindowsProcessInvocation({ file: process.execPath, args: [path.join(sourceRoot, "scripts", "install-plugin.mjs"), "--check"] });
      return JSON.parse((await execute(call.file, call.args,
        { env: this.env, cwd: dataDir, encoding: "utf8", timeout: 90000, windowsHide: true, maxBuffer: 1024 ** 2 })).stdout);
    });
  }
  async inventory() {
    const plugins = (await this.runJson(["plugin", "list", "--json"])).installed;
    const catalogs = (await this.runJson(["plugin", "marketplace", "list", "--json"])).marketplaces;
    if (!Array.isArray(plugins) || !Array.isArray(catalogs)) throw Error("无法确认 Codex 插件清单，未改变现有配置。");
    return { plugins, catalogs, plugin: plugins.find(p => p.pluginId === pulsePluginId), catalog: catalogs.find(m => m.name === marketName) };
  }
  async prepare() {
    if (this.prepared) throw Error("插件操作不可重复准备。");
    const result = await this.check(), before = await this.inventory();
    if (result.ok !== true || result.pluginId !== pulsePluginId || typeof result.reusedExistingInstall !== "boolean"
        || Boolean(before.plugin) !== result.reusedExistingInstall) throw Error("插件预检与实际清单不一致。");
    this.reused = result.reusedExistingInstall;
    if (!this.reused) {
      if (before.catalog || before.plugins.some(p => p.marketplaceName === marketName) || await exists(this.root)) throw Error("发现已有本地市场或文件，未覆盖其内容。");
      // Fingerprinting rejects links/special files before copying package data.
      await runtimeFingerprint(path.join(this.sourceRoot, "plugin"));
      await runtimeFingerprint(path.join(this.sourceRoot, ".agents", "plugins"));
      await mkdir(path.join(this.staged, ".agents", "plugins"), { recursive: true });
      await cp(path.join(this.sourceRoot, "plugin"), path.join(this.staged, "plugin"), { recursive: true, errorOnExist: true, force: false });
      await cp(path.join(this.sourceRoot, ".agents", "plugins", "marketplace.json"), path.join(this.staged, ".agents", "plugins", "marketplace.json"), { errorOnExist: true, force: false });
      this.hash = await runtimeFingerprint(this.staged);
      const manifest = JSON.parse(await readFile(path.join(this.staged, "plugin", ".codex-plugin", "plugin.json")));
      const catalog = JSON.parse(await readFile(path.join(this.staged, ".agents", "plugins", "marketplace.json")));
      if (manifest.name !== "codex-pulse" || typeof manifest.version !== "string" || catalog.name !== marketName
          || catalog.plugins?.length !== 1 || catalog.plugins[0].name !== "codex-pulse"
          || catalog.plugins[0].source?.source !== "local" || catalog.plugins[0].source.path !== "./plugin") throw Error("插件安装包身份或本地来源不正确。");
      this.version = manifest.version;
    }
    this.prepared = true;
    return { ok: true, reusedExistingInstall: this.reused };
  }
  async assertOwned({ plugin, catalog, plugins }) {
    if (plugins.some(p => p.pluginId !== pulsePluginId && p.marketplaceName === marketName)) throw Error("本地市场被其他插件使用，未清理。");
    if (!this.ownsDirectory || await runtimeFingerprint(this.root) !== this.hash) throw Error("市场文件归属或内容已改变，已保留现场。");
    // Modern `root` can be a resolved snapshot. The pinned legacy CLI emits
    // only name/root; accept that exact missing-field schema only when its
    // actual local directory is the one we created. Never delete `root`.
    if (catalog) {
      const sourceMatches = Object.hasOwn(catalog, "marketplaceSource")
        ? catalog.marketplaceSource?.sourceType === "local" && await samePath(catalog.marketplaceSource.source, this.root)
        : Object.keys(catalog).every(key => ["name", "root"].includes(key)) && await samePath(catalog.root, this.root);
      if (!sourceMatches) throw Error("市场来源已改变，未移除外部配置。");
    }
    if (plugin && (plugin.version !== this.version || plugin.source?.source !== "local"
        || !await samePath(plugin.source.path, path.join(this.root, "plugin")))) throw Error("插件来源已改变，未移除其他安装。");
  }
  async prepareRemoval() {
    if (this.prepared) throw Error("插件操作不可重复准备。");
    const current = await this.inventory();
    if (current.plugins.some(p => p.pluginId !== pulsePluginId && p.marketplaceName === marketName)) throw Error("本地市场被其他插件使用，未继续卸载。");
    if (!await exists(this.root)) {
      if (current.plugin || current.catalog) throw Error("插件清单与私有安装目录不一致，未继续卸载。");
      this.prepared = true; this.reused = false; return;
    }
    this.hash = await runtimeFingerprint(this.root);
    // Compare against the already fingerprint-verified installed app, not an
    // arbitrary download/version. Unknown extra files must never be deleted.
    if (JSON.stringify((await readdir(this.root)).sort()) !== JSON.stringify([".agents", "plugin"])
        || JSON.stringify(await readdir(path.join(this.root, ".agents"))) !== JSON.stringify(["plugins"])
        || JSON.stringify(await readdir(path.join(this.root, ".agents", "plugins"))) !== JSON.stringify(["marketplace.json"])
        || await runtimeFingerprint(path.join(this.root, "plugin")) !== await runtimeFingerprint(path.join(this.sourceRoot, "plugin"))
        || await runtimeFingerprint(path.join(this.root, ".agents", "plugins", "marketplace.json")) !== await runtimeFingerprint(path.join(this.sourceRoot, ".agents", "plugins", "marketplace.json"))) {
      throw Error("本地市场存在未知文件或与安装记录不符，已保留，未继续卸载。");
    }
    const manifest = JSON.parse(await readFile(path.join(this.root, "plugin", ".codex-plugin", "plugin.json")));
    if (manifest.name !== "codex-pulse" || typeof manifest.version !== "string") throw Error("插件身份不正确。");
    this.version = manifest.version; this.ownsDirectory = true;
    await this.assertOwned(current);
    this.prepared = true; this.reused = false;
  }
  async verifyRemoved() {
    const current = await this.inventory();
    if (current.plugin || current.catalog || current.plugins.some(p => p.marketplaceName === marketName) || await exists(this.root)) throw Error("插件或本地市场仍存在，未继续删除运行程序。");
  }
  rollbackSnapshot() {
    if (!this.prepared) throw Error("插件尚未完成只读预检。");
    return { schema: 1, reused: this.reused, hash: this.hash ?? null, version: this.version ?? null };
  }
  async verifyPresent() {
    const value = await this.check();
    if (value.ok !== true || value.pluginId !== pulsePluginId || value.reusedExistingInstall !== true) throw Error("已提交安装的插件状态无法核实，未放行任务。");
  }
  async prepareRecovery(value) {
    if (this.prepared || value?.schema !== 1 || typeof value.reused !== "boolean"
        || !value.reused && (!/^[a-f0-9]{64}$/.test(value.hash) || typeof value.version !== "string" || value.version.length > 100)) throw Error("缺少可核实的插件恢复记录，已保留现场。");
    this.reused = value.reused; this.hash = value.hash; this.version = value.version;
    if (!this.reused) {
      const current = await this.inventory();
      if (await exists(this.root)) { this.ownsDirectory = true; await this.assertOwned(current); }
      else if (current.plugin || current.catalog || current.plugins.some(p => p.marketplaceName === marketName)) throw Error("插件来源与恢复记录不一致，已保留现场。");
    }
    this.prepared = true;
  }
  async install() {
    if (!this.prepared || this.started) throw Error("插件操作状态不正确。");
    this.started = true;
    if (this.reused) {
      const value = await this.check();
      if (value.ok !== true || value.reusedExistingInstall !== true) throw Error("原插件已改变，未替换已有授权。");
      return;
    }
    const current = await this.inventory();
    if (current.plugin || current.catalog || await exists(this.root)) throw Error("预检后出现新插件或市场，未覆盖。");
    if (await runtimeFingerprint(this.staged) !== this.hash) throw Error("插件暂存文件已改变。");
    await rename(this.staged, this.root); this.ownsDirectory = true;
    await this.runJson(["plugin", "marketplace", "add", this.root, "--json"]);
    await this.assertOwned(await this.inventory());
    await this.runJson(["plugin", "add", pulsePluginId, "--json"]);
    const installed = await this.inventory();
    await this.assertOwned(installed);
    if (!installed.plugin || installed.plugin.enabled !== true || !installed.catalog) throw Error("插件安装未确认生效。");
  }
  async removeAndConfirm(args, absent) {
    let failure;
    try { await this.runJson(args); } catch (error) { failure = error; }
    if (!absent(await this.inventory())) throw new Error("新增插件或市场未确认移除，已保留运行程序。", { cause: failure });
  }
  async rollback() {
    if (!this.prepared || this.reused || !this.ownsDirectory) return;
    let current = await this.inventory(); await this.assertOwned(current);
    if (current.plugin) await this.removeAndConfirm(["plugin", "remove", pulsePluginId, "--json"], value => !value.plugin);
    current = await this.inventory(); await this.assertOwned(current);
    if (current.catalog) await this.removeAndConfirm(["plugin", "marketplace", "remove", marketName, "--json"], value => !value.catalog);
    // Verify contents once more; never restore the user's entire config/trust.
    await this.assertOwned(await this.inventory());
    await rm(this.root, { recursive: true }); this.ownsDirectory = false;
  }
}
