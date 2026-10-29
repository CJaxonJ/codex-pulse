import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { pulseDataDirectory, resolveCodexExecutable, codexInvocation } from "../src/platform-runtime.mjs";
import { AppServerClient } from "../src/app-server-client.mjs";

test("Windows local data path supports non-ASCII and spaces, without using the macOS or roaming directory", () => {
  assert.equal(pulseDataDirectory({platform:"win32",home:"C:\\Users\\小陈",env:{LOCALAPPDATA:"D:\\Local Data"}}),"D:\\Local Data\\Codex Pulse");
  assert.equal(pulseDataDirectory({platform:"win32",home:"C:\\Users\\小陈",env:{}}),"C:\\Users\\小陈\\AppData\\Local\\Codex Pulse");
  assert.equal(pulseDataDirectory({platform:"darwin",home:"/Users/test",env:{}}),"/Users/test/Library/Application Support/Codex Pulse");
});
test("explicit account/install paths take priority; Windows searches actual executable and npm routes", () => {
  assert.equal(resolveCodexExecutable({env:{CODEX_BINARY:"D:\\Tools\\codex.exe"}}),"D:\\Tools\\codex.exe");
  const found=[];
  const binary=resolveCodexExecutable({platform:"win32",home:"C:\\Users\\User",env:{LOCALAPPDATA:"D:\\Local"},exists:p=>p.endsWith("codex.cmd"),
    find:(file,args,options)=>{found.push({file,args,options});if(args[0]==="codex.exe")throw Error("not installed");return "C:\\Tools With Spaces\\codex.cmd\r\n";}});
  assert.equal(binary,"C:\\Tools With Spaces\\codex.cmd"); assert.equal(found[0].options.windowsHide,true);
  assert.throws(()=>resolveCodexExecutable({platform:"win32",env:{},home:"C:\\Users\\Test",exists:()=>false,find:()=>{throw Error("not found");}}),/未找到/);
});
test("npm launch forwards shell metacharacters as literal arguments, never through a command shell", () => {
  const args=["queue","--message",'literal & | %PATH% $(noop) `text` "quote"\n下一步'];
  const call=codexInvocation("C:\\Users\\User\\AppData\\Roaming\\npm\\codex.cmd",args,{platform:"win32",exists:()=>true,node:"C:\\Pulse\\node.exe"});
  assert.equal(call.file,"C:\\Pulse\\node.exe"); assert.deepEqual(call.args.slice(1),args);
  assert.match(call.args[0],/node_modules\\@openai\\codex\\bin\\codex\.js$/);
  assert.throws(()=>codexInvocation("codex.cmd",args,{platform:"win32"}),/absolute/);
  assert.throws(()=>codexInvocation("C:\\bad.cmd",args,{platform:"win32",exists:()=>false}),/npm/);
});
test("Windows discovery uses the documented per-user command directory even before PATH refresh", () => {
  const expected = "D:\\Local Data\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  const found = resolveCodexExecutable({ platform: "win32", home: "C:\\Users\\Test", env: { LOCALAPPDATA: "D:\\Local Data" }, exists: p => p === expected, find: () => { throw Error("PATH must not be required"); } });
  assert.equal(found, expected);
  const custom = "E:\\Tools 中文\\codex.exe";
  assert.equal(resolveCodexExecutable({ platform: "win32", env: { LOCALAPPDATA: "D:\\Local", CODEX_INSTALL_DIR: "E:\\Tools 中文" }, exists: p => p === custom || p.endsWith("bin\\codex.exe"), find: () => { throw Error("PATH must not be required"); } }), custom);
  assert.throws(() => resolveCodexExecutable({ platform: "win32", env: { CODEX_INSTALL_DIR: "relative-bin" } }), /绝对路径/);
});
test("App Server start reports a missing executable promptly without uncaught process errors", async () => {
  const client=new AppServerClient({binary:path.join(os.tmpdir(),"pulse-no-such-binary-"+process.pid),requestTimeoutMs:10000});
  const start=Date.now(); await assert.rejects(client.start(),/ENOENT/); assert(Date.now()-start<5000);client.stop();
});
test("App Server protocol really crosses a process boundary on the host OS, including Unicode and spaces", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"pulse-rpc 研发-"));
  const file=path.join(root,"rpc peer.cjs");
  await writeFile(file,`const r=require('node:readline').createInterface({input:process.stdin});r.on('line',l=>{const m=JSON.parse(l);if(m.id!=null)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='account/rateLimits/read'?{rateLimits:{primary:{usedPercent:90,windowDurationMins:300,resetsAt:2000000000}}}:{}})+'\\n');});`);
  const client=new AppServerClient({binary:process.execPath,binaryArgs:[file]});
  try {await client.start(); const quota=await client.readRateLimits();assert.equal(quota.rateLimits.primary.usedPercent,90);}
  finally {client.stop();}
});
