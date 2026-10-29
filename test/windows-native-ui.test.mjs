import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendWindowsNotification } from "../src/windows-notifier.mjs";

const execute = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const windows = { skip: process.platform !== "win32", timeout: 90000 };
const app = path.join(root, "build/windows/CodexPulse.exe");
const inspector = path.join(root, "scripts/test-support/windows-ui-inspect.ps1");

async function inspect(child, ...args) {
  const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", inspector, "-TargetProcess", String(child.pid), ...args], { encoding: "utf8", windowsHide: true, timeout: 15000 });
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
}
async function until(check) {
  const deadline = Date.now() + 20000;
  while (true) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw Error("Native UI did not reach the expected state");
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

test("actual Windows native alert renders Unicode as plain text, remains open, and can be dismissed by its real button", windows, async () => {
  assert((await stat(app)).isFile(), "Build the native Windows application before running this acceptance test");
  let child, closed, diagnostics = "";
  try {
    const delivery = await sendWindowsNotification({ title: "【测试】额度恢复，并非真实通知", body: "保留原目标。<b>不是 HTML</b> & $(不是命令)", sourceUrl: "https://x.com/thsottiaux/status/123", sourceText: "测试原文，不连接 X", persistent: true, severity: "critical", sound: false }, {
      env: { ...process.env, CODEX_PULSE_NOTIFIER_APP: app, CODEX_PULSE_DISABLE_NOTIFICATIONS: "0" },
      spawn: (...args) => { child = spawn(...args); child.stderr.on("data", b => diagnostics += b); closed = once(child, "exit"); return child; },
    });
    assert.deepEqual(delivery, { deliveryStatus: "window_shown" });
    const screenshot = path.join(root, "build/windows/persistent-alert.png");
    const ui = await inspect(child, "-Screenshot", screenshot);
    assert.equal(ui.visible, true);
    assert(ui.buttons.some(b => b.name === "查看原帖" && b.enabled && !b.offscreen));
    assert(ui.buttons.some(b => b.name === "知道了" && b.enabled && !b.offscreen));
    assert.match(ui.content.join("\n"), /<b>不是 HTML<\/b> & \$\(不是命令\)/);
    const visible = ui.buttons.filter(b => !b.offscreen && ["知道了", "查看消息历史", "查看原帖"].includes(b.name));
    assert.equal(new Set(visible.map(b => Math.round(b.y))).size, 1, "Alert action buttons must share a baseline");
    assert((await stat(screenshot)).size > 1000);
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(child.exitCode, null, "Persistent notice must not immediately dismiss itself");
    await inspect(child, "-Click", "知道了");
    assert.equal((await closed)[0], 0);
  } catch (error) { throw new Error(error.message + (diagnostics ? " · " + diagnostics.trim() : "")); }
  finally { if (child && child.exitCode == null) child.kill(); }
});

test("actual native Windows history and plan views read isolated CLI records without an account or model", windows, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pulse UI 中文-"));
  const runtime = path.join(directory, "app 空格"), data = path.join(directory, "数据");
  await mkdir(path.join(runtime, "runtime"), { recursive: true }); await mkdir(data);
  for (const entry of ["bin", "src", "package.json"]) await cp(path.join(root, entry), path.join(runtime, entry), { recursive: true });
  await cp(process.execPath, path.join(runtime, "runtime/node.exe"));
  await writeFile(path.join(data, "user-events.json"), JSON.stringify({ events: [{ title: "预告测试", body: "并非重置到账", sourceText: "保留的原帖全文", sourceUrl: "https://x.com/thsottiaux/status/123" }] }));
  await mkdir(path.join(data, "chat-continuity"));
  await writeFile(path.join(data, "chat-continuity/task.json"), JSON.stringify({ sessionId: "isolated", status: "paused_quota", initialGoal: { objective: "保留最开始的用户目标" }, checkpoint: { summary: "Completed: 保留修改\nRemaining: 继续测试\nNext action: 检查真实工作区\nBlockers: quota" } }));
  for (const [mode, expected] of [["--history", /保留的原帖全文/], ["--preview", /保留最开始的用户目标[\s\S]*检查真实工作区/]]) {
    const child = spawn(app, [mode], { env: { ...process.env, CODEX_PULSE_APP_ROOT: runtime, CODEX_PULSE_DATA_DIR: data, CODEX_BINARY: "nonexistent-no-account.exe" }, windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = ""; child.stderr.on("data", b => diagnostics += b);
    const closed = once(child, "exit");
    try {
      const ui = await until(async () => { const value = await inspect(child); return expected.test(value.content.join("\n")) ? value : null; });
      assert.equal(ui.visible, true);
      if (mode === "--history") assert(ui.buttons.some(b => b.name === "查看原帖" && b.enabled));
      await inspect(child, "-Click", "关闭");
      assert.equal((await closed)[0], 0);
    } catch (error) { throw new Error(error.message + (diagnostics ? " · " + diagnostics.trim() : "")); }
    finally { if (child.exitCode == null) child.kill(); }
  }
});
