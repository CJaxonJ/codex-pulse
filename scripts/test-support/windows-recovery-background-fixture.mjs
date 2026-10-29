import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { windowsUIFixture } from "./windows-ui-fixture.mjs";
import { writeJsonSnapshotAtomic } from "../../src/atomic-file.mjs";
import { ChatContinuityStore } from "../../src/chat-continuity-store.mjs";
import { WINDOWS_HOOK_COMMAND } from "../../src/protection-consent.mjs";

const project = path.resolve(import.meta.dirname, "../..");
export async function windowsRecoveryBackgroundFixture({ gatePause = false, installed = true, nativeRateReads = false } = {}) {
  const f = await windowsUIFixture({ installed });
  const workspace = path.join(f.root, "工作 项目"), plugin = path.join(f.root, "plugin 空格");
  await mkdir(workspace); await cp(path.join(project, "plugin"), plugin, { recursive: true });
  await writeFile(path.join(workspace, "existing.txt"), "preserve the user's existing work");
  const objective = "完成 Windows 兼容；保留先前成果，不扩大用户批准的范围。";
  const plan = "Completed:\n已完成设置。\nVerification:\n已跑隔离测试，未调用模型。\nRemaining:\n完成 Windows 安装与卸载。\nNext action:\n先检查原有文件，再继续剩余工作。\nBlockers:\n当前额度到达保护线。";
  const peer = path.join(f.root, "Codex CLI"), entry = path.join(peer, "node_modules/@openai/codex/bin");
  const binary = path.join(peer, "codex.cmd"), peerState = path.join(f.root, "rpc-state.json"), trace = peerState + ".jsonl", wakes = path.join(f.root, "actual-queues.jsonl");
  const pauseMarker = path.join(f.root, "pause-rpc-pending"), releasePause = path.join(f.root, "release-pause-rpc");
  const input = path.join(f.root, "quota-input.json");
  await mkdir(entry, { recursive: true });
  await writeFile(binary, "@echo off\r\nrem safely resolved without a shell\r\n");
  await writeJsonSnapshotAtomic(peerState, { goal: { status: "active", objective, createdAt: 1, updatedAt: 1 }, turn: { id: "paused-turn", status: "inProgress" } });
  await writeFile(trace, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "paused-turn" } }) + "\n");
  await writeFile(path.join(entry, "codex.js"), `
const fs=require('node:fs'),file=${JSON.stringify(peerState)},trace=${JSON.stringify(trace)},wakes=${JSON.stringify(wakes)},pending=${JSON.stringify(pauseMarker)},release=${JSON.stringify(releasePause)};
const read=()=>JSON.parse(fs.readFileSync(file,'utf8'));
const save=s=>{const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,file);};
if(process.argv[2]==='queue'){
 const s=read();fs.appendFileSync(wakes,JSON.stringify({args:process.argv.slice(2),pid:process.pid})+'\\n');
 s.turn={id:'resumed-turn',status:'inProgress'};save(s);
 fs.appendFileSync(trace,JSON.stringify({type:'event_msg',payload:{type:'task_started',turn_id:'resumed-turn'}})+'\\n');process.exit(0);
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const m=JSON.parse(line);if(m.id==null)return;
 try{
  const s=read();let result;
  if(m.method==='initialize')result={};
  else if(${JSON.stringify(nativeRateReads)} && m.method==='account/rateLimits/read'){
   const q=JSON.parse(fs.readFileSync(${JSON.stringify(input)},'utf8'));
   result={planType:q.planType,rateLimitsByLimitId:{codex:{limitId:'codex',planType:q.planType,primary:{usedPercent:q.fiveHour.usedPercent,windowDurationMins:300,resetsAt:q.fiveHour.resetsAt},secondary:{usedPercent:q.weekly.usedPercent,windowDurationMins:10080,resetsAt:q.weekly.resetsAt}}},rateLimitResetCredits:{availableCount:0,credits:[]}};
  }
  else if(m.method==='thread/goal/get')result={goal:s.goal};
  else if(m.method==='thread/goal/set'){
   Object.assign(s.goal,m.params);save(s);result={goal:s.goal};
   if(${JSON.stringify(gatePause)} && m.params.status==='paused' && !fs.existsSync(pending)){
    fs.writeFileSync(pending,'response deliberately held');
    await new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(release)){clearInterval(t);resolve();}},20);});
   }
  }
  else if(m.method==='thread/turns/list')result={data:[s.turn]};
  else if(m.method==='thread/read')result={thread:{path:trace}};
  else if(m.method==='hooks/list')result={data:[{hooks:['preToolUse','userPromptSubmit'].map(eventName=>({eventName,enabled:true,trustStatus:'trusted',pluginId:'codex-pulse@codex-pulse-local'}))}]};
  else throw Error('Forbidden by isolated RPC fixture: '+m.method);
  process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
 }catch(error){process.stdout.write(JSON.stringify({id:m.id,error:{code:-32601,message:error.message}})+'\\n');}
});`);
  const now = Math.floor(Date.now() / 1000);
  const setQuota = percent => writeJsonSnapshotAtomic(input, { planType: "plus", fiveHour: { remainingPercent: percent, usedPercent: 100 - percent, resetsAt: now + 3600 }, weekly: { remainingPercent: 75, usedPercent: 25, resetsAt: now + 86400 }, resetCredits: { availableCount: 0, expiries: [] } });
  await setQuota(70);
  Object.assign(f.env, { NODE_ENV: "test", CODEX_PULSE_TEST_MODE: "watcher-restart-e2e", CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH: input, CODEX_PULSE_DISABLE_NOTIFICATIONS: "1", CODEX_PULSE_POLL_SECONDS: "1", CODEX_PULSE_APP_ROOT: f.appRoot, CODEX_BINARY: binary, PLUGIN_ROOT: plugin });
  await f.cli(["settings", "--update", JSON.stringify({ tiboEnabled: false })]);
  const setTurn = async (status, id = "paused-turn") => {
    const state = JSON.parse(await readFile(peerState, "utf8")); state.turn = { id, status: status || "completed" }; await writeJsonSnapshotAtomic(peerState, state);
    const event = status === "inProgress" ? "task_started" : "task_complete";
    await writeFile(trace, status ? JSON.stringify({ type: "event_msg", payload: { type: event, turn_id: id } }) + "\n" : "");
  };
  const invoke = event => new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_HOOK_COMMAND], { env: f.env, cwd: workspace, windowsHide: true, timeout: 25000, maxBuffer: 2 * 1024 * 1024 });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
    child.once("error", reject);
    child.once("close", (code, signal) => { if (code !== 0) return reject(Error(`Isolated native recovery Hook exit=${code} signal=${signal}: ${stderr} ${stdout}`)); try { resolve(stdout.trim() ? JSON.parse(stdout) : null); } catch (error) { reject(error); } });
    child.stdin.end(JSON.stringify({ session_id: "native-windows-thread", turn_id: "paused-turn", cwd: workspace, ...event }));
  });
  const queueLog = async () => { try { return (await readFile(wakes, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
  return { ...f, workspace, objective, plan, invoke, setQuota, setTurn, queueLog, gatePause, pauseMarker, releasePause: () => writeFile(releasePause, "release"), store: new ChatContinuityStore(f.dataDir) };
}
