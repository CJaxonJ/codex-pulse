import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WINDOWS_HOOK_COMMAND } from "../src/protection-consent.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { AppServerClient } from "../src/app-server-client.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";

const execute=promisify(execFile);
const root=path.resolve(import.meta.dirname,"..");
const windows={skip:process.platform!=="win32",timeout:60000};

async function fixture(){
  const directory=await mkdtemp(path.join(os.tmpdir(),"pulse Windows 研发-"));
  const local=path.join(directory,"Local App Data"), data=path.join(local,"Codex Pulse"), workspace=path.join(directory,"工作 项目");
  const plugin=path.join(directory,"插件 with spaces");
  await mkdir(data,{recursive:true});await mkdir(workspace);
  await cp(path.join(root,"plugin"),plugin,{recursive:true});
  await writeFile(path.join(workspace,"work.txt"),"preserve existing work");
  const now=Math.floor(Date.now()/1000);
  const summary=percent=>({planType:"plus",fiveHour:{remainingPercent:percent,usedPercent:100-percent,resetsAt:now+3600},weekly:{remainingPercent:75,usedPercent:25,resetsAt:now+86400},resetCredits:{availableCount:0,expiries:[]}});
  const setQuota=async percent=>writeFile(path.join(data,"state.json"),JSON.stringify({fiveHour:{lastCheckedAt:now},lastSummary:summary(percent)}));
  const peer=path.join(directory,"Codex CLI");
  await mkdir(path.join(peer,"node_modules/@openai/codex/bin"),{recursive:true});
  const binary=path.join(peer,"codex.cmd"),peerState=path.join(directory,"rpc-state.json");
  await writeFile(binary,"@echo off\r\nrem fixture is resolved without a shell\r\n");
  await writeFile(peerState,JSON.stringify({goal:{status:"active",objective:"完成原目标，保留已有修改，不扩大范围。",createdAt:1,updatedAt:1},turn:{id:"paused-turn",status:"completed"},wakes:[]}));
  await writeFile(path.join(peer,"node_modules/@openai/codex/bin/codex.js"),`
const fs=require('node:fs');const file=process.env.PULSE_WINDOWS_RPC_STATE;
if(!file)throw Error('Missing isolated RPC state');
if(process.argv[2]==='queue'){const s=JSON.parse(fs.readFileSync(file));s.wakes.push(process.argv.slice(2));s.turn={id:'resumed-turn',status:'inProgress'};fs.writeFileSync(file,JSON.stringify(s));process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id==null)return;const s=JSON.parse(fs.readFileSync(file));let result={};
 if(m.method==='thread/goal/get')result={goal:s.goal};
 if(m.method==='thread/goal/set'){Object.assign(s.goal,m.params);fs.writeFileSync(file,JSON.stringify(s));result={goal:s.goal};}
 if(m.method==='thread/turns/list')result={data:[s.turn]};
 if(m.method==='hooks/list')result={data:[{hooks:['preToolUse','userPromptSubmit'].map(eventName=>({eventName,enabled:true,trustStatus:'trusted',pluginId:'codex-pulse@codex-pulse-local'}))}]};
 process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
});`);
  const env={...process.env,LOCALAPPDATA:local,CODEX_PULSE_DATA_DIR:"",CODEX_PULSE_APP_ROOT:root,PLUGIN_ROOT:plugin,
    PATH:[path.join(process.env.SystemRoot,"System32"),path.join(process.env.SystemRoot,"System32/WindowsPowerShell/v1.0")].join(";"),
    CODEX_BINARY:binary,PULSE_WINDOWS_RPC_STATE:peerState};
  // Test the actual bundled runtime route, not just a Node installed on PATH.
  await mkdir(path.join(data,"app/runtime"),{recursive:true});
  await cp(process.execPath,path.join(data,"app/runtime/node.exe"));
  const invoke=async(event,shell="powershell")=>{
    const command=shell==="cmd"?"cmd.exe":"powershell.exe";
    const args=shell==="cmd"?["/d","/s","/c",WINDOWS_HOOK_COMMAND]:["-NoProfile","-NonInteractive","-Command",WINDOWS_HOOK_COMMAND];
    const child=execFile(command,args,{env,cwd:workspace,windowsHide:true,maxBuffer:2*1024*1024,timeout:25000});
    child.stdin.end(JSON.stringify({session_id:"windows-thread",turn_id:"paused-turn",cwd:workspace,...event}));
    const output=await new Promise((resolve,reject)=>{let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);child.on("error",reject);child.on("close",code=>code===0?resolve(stdout):reject(Error(`${code}: ${stderr}`)));});
    return output.trim()?JSON.parse(output):null;
  };
  return {directory,data,workspace,env,now,summary,setQuota,invoke,binary,peerState};
}

test("actual Windows hook command reads bundled Node, Unicode stdin and default LocalAppData under both shell routes",windows,async()=>{
  const manifest=JSON.parse(await readFile(path.join(root,"plugin/.codex-plugin/plugin.json"),"utf8"));
  for(const groups of Object.values(manifest.hooks.hooks))for(const group of groups)for(const hook of group.hooks)assert.equal(hook.commandWindows,WINDOWS_HOOK_COMMAND);
  const f=await fixture();await f.setQuota(9);
  for(const shell of ["powershell","cmd"]){
    const result=await f.invoke({hook_event_name:"PreToolUse",tool_name:"apply_patch"},shell);
    assert.equal(result.decision,"block",shell);
  }
  const saved=await new ChatContinuityStore(f.data).get("windows-thread");
  assert.equal(saved.status,"checkpoint_requested");assert.equal(saved.initialGoal.objective,"完成原目标，保留已有修改，不扩大范围。");
  assert(saved.checkpoint.workspaceFingerprint);
});

test("Windows process chain pauses at 10%, saves plan, recovers through CLI queue once across controller replacement",windows,async()=>{
  const f=await fixture();await f.setQuota(10);
  await f.invoke({hook_event_name:"PreToolUse",tool_name:"apply_patch"});
  const plan="Completed: kept original changes.\nVerification: no real model used.\nRemaining: finish original task.\nNext action: inspect saved work.\nBlockers: quota.";
  await f.invoke({hook_event_name:"Stop",last_assistant_message:plan});
  const store=new ChatContinuityStore(f.data),saved=await store.get("windows-thread");
  assert.equal(saved.status,"paused_quota");assert.match(saved.checkpoint.summary,/Next action/);
  const previous=process.env.PULSE_WINDOWS_RPC_STATE;
  process.env.PULSE_WINDOWS_RPC_STATE=f.peerState;
  const client=new AppServerClient({binary:f.binary});
  try{
    await client.start();await f.setQuota(100);
    const make=()=>new ChatContinuityController({client,store,lockManager:new WorktreeLockManager(f.data)});
    await make().reconcile(f.summary(100),{now:f.now+60,workspace:new WorkspaceInspector()});
    await make().reconcile(f.summary(100),{now:f.now+120,workspace:new WorkspaceInspector()});
    const state=JSON.parse(await readFile(f.peerState,"utf8"));assert.equal(state.wakes.length,1);
    assert.deepEqual(state.wakes[0].slice(0,4),["queue","--thread","windows-thread","--message"]);
    assert.match(state.wakes[0][4],/完成原目标/);
    assert.match(state.wakes[0][4],/Next action/);
  } finally {client.stop();if(previous===undefined)delete process.env.PULSE_WINDOWS_RPC_STATE;else process.env.PULSE_WINDOWS_RPC_STATE=previous;}
});
