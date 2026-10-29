import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WorktreeLockManager } from './worktree-lock-manager.mjs';

const PLUGIN = 'codex-pulse@codex-pulse-local';
const COMMAND = '/usr/bin/env node "$PLUGIN_ROOT/scripts/pulse-hook.mjs"';
export const WINDOWS_HOOK_COMMAND = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& ([IO.Path]::Combine([Environment]::GetEnvironmentVariable('PLUGIN_ROOT'), 'scripts', 'pulse-hook-windows.ps1'))"`;
const EVENTS = ['preToolUse','postToolUse','sessionStart','userPromptSubmit','stop','interrupt'];
const LABELS = { preToolUse:'执行前检查额度',postToolUse:'执行后记录进度',sessionStart:'会话开始时检查保护',
  userPromptSubmit:'开始任务前评估额度',stop:'暂停时保存进度',interrupt:'保留中断状态' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class ProtectionConsent {
  constructor({client,dataDir,codexHome = process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),now=()=>Date.now(),platform=process.platform}) {
    Object.assign(this,{client,dataDir,codexHome,now,platform});
    this.directory=path.join(dataDir,'protection-review');
    this.locks=new WorktreeLockManager(this.directory);
  }
  async inspect() {
    const response=await this.client.request('hooks/list',{cwds:[this.codexHome]});
    const hooks=new Map();
    for(const h of (response.data || []).flatMap(d=>d.hooks || []).filter(h=>h.pluginId===PLUGIN)) {
      if(hooks.has(h.key) && digest(hooks.get(h.key))!==digest(h)) throw Error('保护组件状态不一致，请重新打开窗口');
      hooks.set(h.key,h);
    }
    const list=[...hooks.values()].sort((a,b)=>a.eventName.localeCompare(b.eventName));
    if(list.length!==EVENTS.length || new Set(list.map(h=>h.eventName)).size!==EVENTS.length ||
      list.some(h=>!EVENTS.includes(h.eventName) || h.handlerType!=='command' || h.command!==COMMAND ||
        (h.commandWindows != null && h.commandWindows!==WINDOWS_HOOK_COMMAND) ||
        (this.platform==='win32' && h.commandWindows!==WINDOWS_HOOK_COMMAND) ||
        h.source!=='plugin' || h.isManaged || h.async || !h.key.startsWith(PLUGIN+':') ||
        !/^sha256:[a-f0-9]{64}$/.test(h.currentHash) || !Number.isFinite(h.timeoutSec) || h.timeoutSec>15)) {
      throw Error('保护组件缺失或发生了无法确认的变化，请重新安装官方发布包');
    }
    const cache=await realpath(path.join(this.codexHome,'plugins/cache/codex-pulse-local/codex-pulse'));
    const sources=new Set();
    const definitions=[];
    for(const h of list) {
      const source=await realpath(h.sourcePath);
      const relative=path.relative(cache,source).split(path.sep);
      if(relative.length!==3 || relative[0]==='..' || relative[1]!=='.codex-plugin' || relative[2]!=='plugin.json') {
        throw Error('保护组件来源无法确认，请重新安装');
      }
      sources.add(source);
      definitions.push({key:h.key,event:h.eventName,command:h.command,commandWindows:h.commandWindows,hash:h.currentHash,source,
        enabled:h.enabled,trust:h.trustStatus,matcher:h.matcher,timeout:h.timeoutSec,
        contextLimit:h.additionalContextLimit,statusMessage:h.statusMessage});
    }
    if(sources.size!==1) throw Error('检测到多份保护组件，请先完成安装');
    const source=[...sources][0];
    const script=path.resolve(path.dirname(source),'../scripts/pulse-hook.mjs');
    const files={manifest:digest(await readFile(source,'utf8')),script:digest(await readFile(script,'utf8'))};
    if(this.platform==='win32') files.windowsLauncher=digest(await readFile(path.join(path.dirname(script),'pulse-hook-windows.ps1'),'utf8'));
    return {definitions,files,ready:list.every(h=>h.enabled && h.trustStatus==='trusted'),
      details:list.map(h=>({purpose:LABELS[h.eventName],command:this.platform==='win32'?h.commandWindows:h.command,source:h.sourcePath,hash:h.currentHash})),
      fingerprint:digest({definitions,files})};
  }
  async status() {
    const current=await this.inspect();
    return {ok:true,trusted:current.ready,requiresReview:!current.ready};
  }
  async prepare() {
    const current=await this.inspect();
    if(current.ready) return {ok:true,trusted:true,requiresReview:false,details:current.details};
    const reviewId=randomUUID();
    await mkdir(this.directory,{recursive:true,mode:0o700});
    await writeFile(path.join(this.directory,reviewId+'.json'),JSON.stringify({
      createdAt:this.now(),fingerprint:current.fingerprint,consumed:false,
    }),{flag:'wx',mode:0o600});
    return {ok:true,trusted:false,requiresReview:true,reviewId,details:current.details};
  }
  async enable(reviewId,{confirmed=false}={}) {
    if(!confirmed || !/^[a-f0-9-]{36}$/.test(reviewId || '')) throw Error('请在窗口中确认开启自动保护');
    if(this.enabling) throw Error('正在确认，请稍后');
    this.enabling=true;
    let lock;
    try {
      lock=await this.locks.acquire(this.directory,'protection-consent');
      if(!lock.acquired) throw Error('另一窗口正在确认，请稍后重试');
      const file=path.join(this.directory,reviewId+'.json');
      const review=JSON.parse(await readFile(file,'utf8'));
      if(review.consumed) throw Error('这次确认已经处理，请重新打开窗口核对状态');
      if(!Number.isFinite(review.createdAt) || this.now()-review.createdAt<0 || this.now()-review.createdAt>15*60*1000) {
        throw Error('确认页面已过期，请重新打开');
      }
      const config=await this.client.request('config/read',{includeLayers:true});
      const layer=config.layers?.find(l=>l.name?.type==='user' && !l.name.profile);
      if(!layer?.version || !layer.name.file) throw Error('无法安全读取 Codex 配置版本，请重试');
      const current=await this.inspect();
      if(current.fingerprint!==review.fingerprint) throw Error('确认期间保护组件已变化，请重新审查');
      const edits=current.definitions.flatMap(h=>[
        {keyPath:'hooks.state.'+JSON.stringify(h.key)+'.trusted_hash',value:h.hash,mergeStrategy:'upsert'},
        {keyPath:'hooks.state.'+JSON.stringify(h.key)+'.enabled',value:true,mergeStrategy:'upsert'},
      ]);
      // Consume this exact review before requesting a write. A timeout is not a
      // reason to silently replay consent against a changed definition.
      await writeFile(file,JSON.stringify({...review,consumed:true}),{mode:0o600});
      const written=await this.client.request('config/batchWrite',{edits,filePath:layer.name.file,
        expectedVersion:layer.version,reloadUserConfig:true});
      if(written.status!=='ok') throw Error('Codex 未确认授权生效，请重新检查');
      const verified=await this.inspect();
      if(!verified.ready || digest(verified.files)!==digest(current.files) ||
        verified.definitions.some((h,i)=>h.hash!==current.definitions[i].hash)) throw Error('授权后状态未确认，请重新检查');
      return {ok:true,trusted:true,requiresReview:false,activation:'new_sessions',
        message:'授权已确认；重新打开 Codex 后使用自动保护，当前任务不会被中断。'};
    } finally {this.enabling=false; if(lock?.acquired) await this.locks.release(lock.handle);}
  }
}
