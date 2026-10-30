import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonSnapshotAtomic } from "../src/atomic-file.mjs";

const manifestName = "bundle-manifest.json";
const version = /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/;
export async function sha256File(file) {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
function safeName(name) {
  return typeof name === "string" && name.length < 1000 && !/[\\:<>"|?*\x00-\x1f]/.test(name)
    && name.split("/").every(part => part && part !== "." && part !== ".." && !/[. ]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
async function inventory(root) {
  const files = [], names = new Set(); let count = 0, bytes = 0;
  async function walk(relative) {
    const full = path.join(root, ...relative.split("/")), stat = await lstat(full);
    if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) throw Error("捆绑包包含链接或特殊文件。");
    if (relative && (!safeName(relative) || names.has(relative.toLowerCase()))) throw Error("捆绑包存在不安全路径或 Windows 大小写冲突。");
    if (++count > 5000) throw Error("捆绑包文件数超过检查上限。");
    names.add(relative.toLowerCase());
    if (stat.isDirectory()) {
      for (const name of (await readdir(full)).sort()) await walk(relative ? relative + "/" + name : name);
    } else if (relative !== manifestName) {
      if ((bytes += stat.size) > 2 * 1024 ** 3) throw Error("捆绑包超过检查大小上限。");
      files.push({ path: relative, bytes: stat.size, sha256: await sha256File(full) });
    }
  }
  await walk(""); return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function writeWindowsBundleManifest(root, { appVersion, nodeVersion }) {
  if (!version.test(appVersion) || !/^v22\.\d+\.\d+$/.test(nodeVersion)) throw Error("捆绑包版本不正确。");
  const value = { schema: 1, name: "codex-pulse", version: appVersion, platform: "win32", arch: "x64", nodeVersion, files: await inventory(root) };
  await writeJsonSnapshotAtomic(path.join(root, manifestName), value); return value;
}
export async function verifyWindowsBundle(root) {
  const file = path.join(root, manifestName), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 ** 2) throw Error("捆绑包清单不正确。");
  const value = JSON.parse(await readFile(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== 1 || value.name !== "codex-pulse" || !version.test(value.version) || value.platform !== "win32" || value.arch !== "x64"
      || !/^v22\.\d+\.\d+$/.test(value.nodeVersion) || !Array.isArray(value.files) || value.files.length > 5000
      || value.files.some(entry => !entry || typeof entry !== "object" || !safeName(entry.path) || entry.path === manifestName || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256))) throw Error("捆绑包清单字段不正确。");
  if (JSON.stringify(await inventory(root)) !== JSON.stringify(value.files)) throw Error("捆绑包内容与清单不一致，未继续。");
  return value;
}
