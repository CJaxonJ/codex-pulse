import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsUIFixture, inspectWindowsUI, waitForWindowsUI } from "../scripts/test-support/windows-ui-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 120000 }, title = "Codex Pulse · 安装";
const button = (ui, name) => ui.buttons.find(b => b.name === name && !b.offscreen);
test("the installed app opens settings by default even though it retains its bundle manifest", windows, async () => {
  const f = await windowsUIFixture({ installed: true }); await writeFile(path.join(f.appRoot, "bundle-manifest.json"), '{}');
  const session = f.start(), settingsTitle = "Codex Pulse · 设置";
  try {
    await waitForWindowsUI(session, ui => button(ui, "保存修改")?.enabled, { title: settingsTitle });
    await inspectWindowsUI(session, { title: settingsTitle, click: "关闭" }); assert.equal((await session.closed)[0], 0);
  } finally { if (session.child.exitCode == null) session.child.kill(); }
});
test("double-click source entry shows aligned setup controls; a pending child blocks duplicate starts and closing, and failure is retryable", windows, async () => {
  const f = await windowsUIFixture(), release = path.join(f.root, "release-ui-probe");
  await writeFile(path.join(f.appRoot, "bundle-manifest.json"), '{}'); // Route only; NOT a valid product bundle.
  await mkdir(path.join(f.appRoot, "scripts"));
  // Deliberately failing child tests UI lifecycle only. Real installation is
  // exercised separately by the actual bundled source-entry E2E.
  await writeFile(path.join(f.appRoot, "scripts", "install-windows.mjs"), `import fs from 'node:fs';
    const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.error(JSON.stringify({ok:false,error:'后台正在处理任务，未请求停机。请稍后重试。'}));process.exit(1)}},50);
    setTimeout(()=>process.exit(2),90000).unref();`);
  const session = f.start();
  try {
    const initial = await waitForWindowsUI(session, ui => button(ui, "安装")?.enabled, { title });
    assert.equal(button(initial, "安装").y, button(initial, "关闭").y);
    assert.equal(button(initial, "安装").height, button(initial, "关闭").height);
    assert(button(initial, "安装").width >= 112);
    await inspectWindowsUI(session, { title, screenshot: path.join(path.resolve(import.meta.dirname, ".."), "build/windows/setup.png") });
    await inspectWindowsUI(session, { title, click: "安装" });
    const busy = await waitForWindowsUI(session, ui => button(ui, "关闭")?.enabled === false, { title });
    assert.equal(button(busy, "安装").enabled, false); assert.equal(button(busy, "登录 Windows 时启动").enabled, false);
    await inspectWindowsUI(session, { title, closeWindow: true });
    assert.equal((await inspectWindowsUI(session, { title })).visible, true, "Window-close must not abandon a real pending installer child");
    assert.equal(session.child.exitCode, null);
    await writeFile(release, "finish probe");
    const failed = await waitForWindowsUI(session, ui => button(ui, "重试安装")?.enabled, { title });
    assert.match(failed.content.join("\n"), /后台正在处理任务/);
    assert.doesNotMatch(failed.content.join("\n"), /node\.exe|install-windows\.mjs|powershell/i);
    await inspectWindowsUI(session, { title, click: "关闭" }); assert.equal((await session.closed)[0], 0);
  } finally {
    await writeFile(release, "finish probe");
    if (session.child.exitCode == null) {
      await waitForWindowsUI(session, ui => button(ui, "关闭")?.enabled, { title });
      await inspectWindowsUI(session, { title, click: "关闭" }); await session.closed;
    }
  }
});

test("native shortcuts are profile-scoped, tolerate long/short path spellings, and never replace a foreign entry", windows, async () => {
  const f = await windowsUIFixture({ installed: true });
  await writeFile(path.join(f.dataDir, "windows-installation.json"), JSON.stringify({ name: "codex-pulse" }));
  const execute = promisify(execFile), binary = path.join(f.appRoot, "CodexPulse.exe");
  const call = (command, env = f.env) => execute(binary, ["--shortcut", command], { env, windowsHide: true, encoding: "utf8", timeout: 15000 });
  await call("create"); const file = path.join(f.dataDir, "shortcuts", "Codex Pulse.lnk");
  assert((await readFile(file)).length > 100);
  await assert.rejects(call("remove-if-uninstalled"));
  assert((await readFile(file)).length > 100, "A stale uninstaller must not erase a newly installed entry");
  const longEnv = { ...f.env, CODEX_PULSE_DATA_DIR: await realpath(f.dataDir) };
  await call("create", longEnv); await call("remove", longEnv);
  await assert.rejects(readFile(file), { code: "ENOENT" }); await call("remove");
  await writeFile(file, "unrelated user shortcut, preserve exactly"); const original = await readFile(file);
  await assert.rejects(call("create")); await assert.rejects(call("remove"));
  assert.deepEqual(await readFile(file), original);
});
test("a final interrupted uninstall still offers removal even after its installation marker disappeared", windows, async () => {
  const f = await windowsUIFixture();
  const journal = path.join(f.dataDir, "uninstallation-in-progress.json"), bytes = '{"phase":"cleaning_context"}';
  await writeFile(journal, bytes);
  const session = f.start("--setup");
  try {
    await waitForWindowsUI(session, ui => button(ui, "卸载")?.enabled, { title });
    await inspectWindowsUI(session, { title, click: "卸载" });
    await waitForWindowsUI(session, ui => button(ui, "确认卸载")?.enabled, { title });
    await inspectWindowsUI(session, { title, click: "返回" });
    assert.equal(await readFile(journal, "utf8"), bytes, "Entering/backing out of confirmation must not repair or remove anything");
    await inspectWindowsUI(session, { title, click: "关闭" }); await session.closed;
  } finally { if (session.child.exitCode == null) session.child.kill(); }
});
