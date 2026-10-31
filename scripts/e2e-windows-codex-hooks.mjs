import assert from "node:assert/strict";
import path from "node:path";
import { protectionFixture } from "./test-support/protection-fixture.mjs";
import { AppServerClient } from "../src/app-server-client.mjs";
import { resolveCodexBinary } from "../src/app-server-client.mjs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { windowsUIFixture, inspectWindowsUI, waitForWindowsUI } from "./test-support/windows-ui-fixture.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexInvocation } from "../src/platform-runtime.mjs";
import { randomUUID } from "node:crypto";

if(process.platform!=="win32")throw Error("This acceptance requires native Windows, not a platform mock");
const project=path.resolve(import.meta.dirname,"..");
const versionCall=codexInvocation(resolveCodexBinary(),["--version"]);
const actualCodexVersion=(await promisify(execFile)(versionCall.file,versionCall.args,{encoding:"utf8",timeout:15000,windowsHide:true})).stdout.trim().split(/\s+/).at(-1);
assert.equal(actualCodexVersion,"0.163.0-alpha.11.1","Acceptance must use the actually pinned official CLI, not another installation found first");
const fixture=await protectionFixture(project);
// Parse the exact production argument shape, but terminate in help before any
// enqueue. Hidden flags need not appear in help text. No real thread is used.
const queueHelp=codexInvocation(resolveCodexBinary(),["queue","--thread",randomUUID(),"--message","Codex Pulse isolated parser probe","--help"]);
const queueUsage=(await promisify(execFile)(queueHelp.file,queueHelp.args,{env:{...process.env,CODEX_HOME:fixture.home},encoding:"utf8",timeout:15000,windowsHide:true})).stdout;
assert.match(queueUsage,/usage:/i,"Official Windows CLI must parse the queued-message flags without enqueueing");
const originalHome=process.env.CODEX_HOME;
process.env.CODEX_HOME=fixture.home;
const client=new AppServerClient();
try{
  await client.start();
  const result=await client.request("hooks/list",{cwds:[fixture.home]});
  const hooks=(result.data||[]).flatMap(e=>e.hooks||[]).filter(h=>h.pluginId==="codex-pulse@codex-pulse-local");
  assert.equal(hooks.length,6);
  console.error(JSON.stringify({actualCodexWindowsHookMetadata:{fields:Object.keys(hooks[0]),command:hooks[0].command,commandWindows:hooks[0].commandWindows}}));
}finally{client.stop();if(originalHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalHome;}
const before=await fixture.config();
const review=await fixture.cli(["protection","prepare"]);
assert.equal(review.trusted,false);assert.equal(await fixture.config(),before);
const confirmation=await fixture.cli(["protection","enable","--review",review.reviewId,"--yes"]);
assert.equal(confirmation.trusted,true);
assert.equal((await fixture.cli(["protection","status"])).trusted,true);

// The GUI uses the same public path as a user's click, with a separate
// temporary CODEX_HOME. No production consent or model call is involved.
const uiBase=await protectionFixture(project);
const ui=await windowsUIFixture({root:uiBase.root,dataDir:uiBase.dataDir,env:{...uiBase.env,CODEX_BINARY:resolveCodexBinary()}});
const title="Codex Pulse · 保护授权";
const ready=value=>value.buttons.some(b=>b.name==="开启自动保护" && b.enabled && !b.offscreen);
const baseline=await uiBase.config();
const checkInstall=()=>promisify(execFile)(process.execPath,[path.join(project,"scripts/install-plugin.mjs"),"--check"],{env:ui.env,timeout:30000,windowsHide:true});
assert.equal(JSON.parse((await checkInstall()).stdout).reusedExistingInstall,true);
let session=ui.start("--protection");
try{
  await waitForWindowsUI(session,ready,{title});
  assert.equal(await uiBase.config(),baseline,"Opening the GUI must not write trust");
  await inspectWindowsUI(session,{title,click:"查看权限详情"});
  const details=await waitForWindowsUI(session,value=>/pulse-hook-windows\.ps1/.test(value.content.join("\n")),{title:"Codex Pulse · 权限详情"});
  const owner=details.nativeWindows.find(window=>window.title===title);
  assert.equal(details.visible,true);
  assert.equal(details.owner,owner.handle,"Permission details must be owned by the review window");
  assert.equal(owner.enabled,false,"Review must wait for the real detail modal to close");
  assert.match(details.content.join("\n"),/sha256:/);
  await inspectWindowsUI(session,{title:"Codex Pulse · 权限详情",click:"返回"});
  await inspectWindowsUI(session,{title,click:"稍后开启"});
  assert.equal((await session.closed)[0],0);
  assert.equal(await uiBase.config(),baseline,"Cancel is not approval");
}finally{if(session.child.exitCode==null)session.child.kill();}

session=ui.start("--protection");
try{
  await waitForWindowsUI(session,ready,{title});
  const cache=path.join(uiBase.home,"plugins/cache/codex-pulse-local/codex-pulse");
  const versions=await readdir(cache);assert.equal(versions.length,1);
  const launcher=path.join(cache,versions[0],"scripts/pulse-hook-windows.ps1");
  const original=await readFile(launcher,"utf8");
  await writeFile(launcher,original+"\n# Changed after review in this isolated UI test\n");
  await assert.rejects(checkInstall(),error=>/现有插件与授权未更改/.test(error.stderr),"Upgrade must not silently reuse a changed Windows launcher");
  assert.equal(await uiBase.config(),baseline,"Failed preflight must not change existing config or trust");
  await inspectWindowsUI(session,{title,click:"开启自动保护"});
  await waitForWindowsUI(session,value=>/尚未确认授权生效/.test(value.content.join("\n")),{title});
  assert.equal(await uiBase.config(),baseline,"A changed launcher must fail before writing trust");
  await writeFile(launcher,original);
  assert.equal(JSON.parse((await checkInstall()).stdout).reusedExistingInstall,true);
  await inspectWindowsUI(session,{title,click:"重新核对"});
  await waitForWindowsUI(session,ready,{title});
  await inspectWindowsUI(session,{title,click:"开启自动保护"});
  await waitForWindowsUI(session,value=>/保护授权已确认/.test(value.content.join("\n")),{title});
  await inspectWindowsUI(session,{title,screenshot:path.join(project,"build/windows/protection.png")});
  assert.equal((await uiBase.cli(["protection","status"])).trusted,true);
  await inspectWindowsUI(session,{title,click:"完成"});
  assert.equal((await session.closed)[0],0);
}finally{if(session.child.exitCode==null)session.child.kill();}
console.log(JSON.stringify({ok:true,nativeWindows:true,actualCodex:true,actualCodexVersion,actualUserInterface:true,cancelNoTrustWrite:true,changedDefinitionRejected:true,isolatedConsentOnly:true,productionConfigTouched:false,quotaSpent:0}));
