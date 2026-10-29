import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { windowsUIFixture, inspectWindowsUI, waitForWindowsUI } from "../scripts/test-support/windows-ui-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 180000 };
const title = "Codex Pulse · 设置";
const button = (ui, name) => ui.buttons.find(b => b.name === name && !b.offscreen);
const close = async session => {
  if (session.child.exitCode != null) return;
  await inspectWindowsUI(session, { title, click: "关闭" });
  assert.equal((await session.closed)[0], 0);
};

test("native Windows settings save only changed fields, preserve concurrent changes, and survive reopen", windows, async () => {
  const f = await windowsUIFixture();
  const initial = await f.cli(["settings"]);
  assert.equal(initial.settings.quotaAlertsEnabled, true);
  const session = f.start("--settings");
  try {
    await waitForWindowsUI(session, ui => button(ui, "保存修改")?.enabled && button(ui, "提前额度提醒")?.enabled, { title });
    await inspectWindowsUI(session, { title, click: "提前额度提醒" });
    const edited = await waitForWindowsUI(session, ui => button(ui, "提前额度提醒")?.checked === false, { title });
    assert.equal((await f.cli(["settings"])).settings.quotaAlertsEnabled, true, "Toggling is not an implicit save");
    // Another real process edits an unrelated setting after the UI loaded.
    await f.cli(["settings", "--update", JSON.stringify({ lowQuotaPercent: 35 })]);
    await inspectWindowsUI(session, { title, click: "保存修改" });
    await waitForWindowsUI(session, ui => /已保存/.test(ui.content.join("\n")), { title });
    const saved = await f.cli(["settings"]);
    assert.equal(saved.settings.quotaAlertsEnabled, false);
    assert.equal(saved.settings.lowQuotaPercent, 35, "Saving a stale UI must not overwrite another process's change");
    assert.equal(saved.autoRedeemEnabled, false);
    assert.equal(edited.visible, true);
    await inspectWindowsUI(session, { title, screenshot: path.join(path.resolve(import.meta.dirname, ".."), "build/windows/settings.png") });
    await close(session);
  } finally { if (session.child.exitCode == null) session.child.kill(); }
  const reopened = f.start("--settings");
  try {
    await waitForWindowsUI(reopened, ui => button(ui, "保存修改")?.enabled && button(ui, "提前额度提醒")?.checked === false, { title });
    await inspectWindowsUI(reopened, { title, click: "声音提醒" });
    await close(reopened);
    assert.equal((await f.cli(["settings"])).settings.soundEnabled, true, "Closing without Save must discard the edit");
  } finally { if (reopened.child.exitCode == null) reopened.child.kill(); }
});

test("native Windows card consent is separate, cancellation writes nothing, and only explicit confirmation binds the account", windows, async () => {
  const f = await windowsUIFixture();
  const peer = path.join(f.root, "fake CLI"), log = path.join(f.root, "rpc-methods.jsonl");
  await mkdir(path.join(peer, "node_modules/@openai/codex/bin"), { recursive: true });
  const binary = path.join(peer, "codex.cmd");
  await writeFile(binary, "@echo off\r\nrem Resolved without cmd.exe\r\n");
  await writeFile(path.join(peer, "node_modules/@openai/codex/bin/codex.js"), `
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 fs.appendFileSync(process.env.PULSE_UI_RPC_LOG,JSON.stringify(m.method)+'\\n');
 if(m.method==='initialize')return process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');
 if(m.method==='account/read')return process.stdout.write(JSON.stringify({id:m.id,result:{account:{type:'chatgpt',planType:'plus',email:'windows-ui@example.invalid'}}})+'\\n');
 process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:'This isolated peer forbids model, trust and credit-consumption calls'}})+'\\n');
});`);
  f.env.CODEX_BINARY = binary; f.env.PULSE_UI_RPC_LOG = log;
  await f.cli(["settings", "--update", "{}"]);
  const before = await readFile(path.join(f.dataDir, "preferences.json"), "utf8");
  const session = f.start("--settings");
  try {
    await waitForWindowsUI(session, ui => button(ui, "保存修改")?.enabled, { title });
    await inspectWindowsUI(session, { title, tab: 1 });
    await waitForWindowsUI(session, ui => button(ui, "开启临期自动用卡")?.enabled, { title });
    await inspectWindowsUI(session, { title, click: "开启临期自动用卡" });
    const consentTitle = "Codex Pulse · 自动用卡授权";
    await waitForWindowsUI(session, ui => /不会购买重置卡/.test(ui.content.join("\n")), { title: consentTitle });
    await inspectWindowsUI(session, { title: consentTitle, click: "暂不开启" });
    await waitForWindowsUI(session, ui => /用卡设置未更改/.test(ui.content.join("\n")), { title });
    assert.equal(await readFile(path.join(f.dataDir, "preferences.json"), "utf8"), before);
    await assert.rejects(readFile(log), { code: "ENOENT" }, "Cancel must not even start an account request");
    await inspectWindowsUI(session, { title, click: "开启临期自动用卡" });
    await waitForWindowsUI(session, ui => button(ui, "确认开启自动用卡")?.enabled, { title: consentTitle });
    await inspectWindowsUI(session, { title: consentTitle, click: "确认开启自动用卡" });
    await waitForWindowsUI(session, ui => button(ui, "关闭临期自动用卡")?.enabled, { title });
    const enabled = JSON.parse(await readFile(path.join(f.dataDir, "preferences.json"), "utf8"));
    assert.equal(enabled.autoRedeem.enabled, true);
    assert.match(enabled.autoRedeem.accountBinding, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(enabled).includes("windows-ui@example.invalid"));
    await inspectWindowsUI(session, { title, click: "关闭临期自动用卡" });
    await waitForWindowsUI(session, ui => button(ui, "开启临期自动用卡")?.enabled, { title });
    assert.equal((await f.cli(["settings"])).autoRedeemEnabled, false);
    const methods = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(methods, ["initialize", "account/read"]);
    await close(session);
  } finally { if (session.child.exitCode == null) session.child.kill(); }
});
