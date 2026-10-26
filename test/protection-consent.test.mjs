import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ProtectionConsent} from '../src/protection-consent.mjs';

async function fixture() {
  const root=await mkdtemp(path.join(os.tmpdir(),'pulse-consent-unit-'));
  const codexHome=path.join(root,'codex');
  const plugin=path.join(codexHome,'plugins/cache/codex-pulse-local/codex-pulse/1.0.0');
  await mkdir(path.join(plugin,'.codex-plugin'),{recursive:true}); await mkdir(path.join(plugin,'scripts'));
  await writeFile(path.join(plugin,'.codex-plugin/plugin.json'),'{}');
  await writeFile(path.join(plugin,'scripts/pulse-hook.mjs'),'fixture');
  const hooks=['preToolUse','postToolUse','sessionStart','userPromptSubmit','stop','interrupt'].map((eventName,i)=>({
    key:`codex-pulse@codex-pulse-local:${eventName}`,eventName,handlerType:'command',
    command:'/usr/bin/env node "$PLUGIN_ROOT/scripts/pulse-hook.mjs"',source:'plugin',isManaged:false,async:false,
    timeoutSec:3,sourcePath:path.join(plugin,'.codex-plugin/plugin.json'),pluginId:'codex-pulse@codex-pulse-local',
    currentHash:'sha256:'+String(i).repeat(64),enabled:true,trustStatus:'untrusted',
  }));
  const writes=[]; let now=1000000;
  const client={request:async(method,params)=>{
    if(method==='hooks/list') return {data:[{hooks:structuredClone(hooks)}]};
    if(method==='config/read') return {layers:[{name:{type:'user',file:path.join(codexHome,'config.toml')},version:'v1'}]};
    if(method==='config/batchWrite') {writes.push(params); for(const h of hooks) h.trustStatus='trusted';return {status:'ok'};}
    throw Error('Unexpected '+method);
  }};
  const controller=new ProtectionConsent({client,dataDir:path.join(root,'data'),codexHome,now:()=>now});
  return {controller,hooks,writes,client,plugin,advance:()=>{now+=16*60*1000;}};
}
test('preparing/cancelling review never writes trust; explicit confirmation scopes exact definitions',async()=>{
  const f=await fixture(),review=await f.controller.prepare(); assert.equal(f.writes.length,0);
  await assert.rejects(f.controller.enable(review.reviewId),/确认/); assert.equal(f.writes.length,0);
  const result=await f.controller.enable(review.reviewId,{confirmed:true}); assert.equal(result.trusted,true);
  assert.equal(result.activation,'new_sessions'); assert.equal(f.writes.length,1);
  assert.equal(f.writes[0].expectedVersion,'v1'); assert.equal(f.writes[0].edits.length,12);
  assert(f.writes[0].edits.every(e=>e.keyPath.startsWith('hooks.state."codex-pulse@codex-pulse-local:')));
  await assert.rejects(f.controller.enable(review.reviewId,{confirmed:true}),/已经处理/);
});
test('changed definition, changed script, expiry, unexpected command and missing hook fail before write',async()=>{
  for(const kind of ['hash','script','expiry','command','missing']) {
    const f=await fixture(),review=await f.controller.prepare();
    if(kind==='hash') f.hooks[0].currentHash='sha256:'+'a'.repeat(64);
    if(kind==='script') await writeFile(path.join(f.plugin,'scripts/pulse-hook.mjs'),'changed');
    if(kind==='expiry') f.advance();
    if(kind==='command') f.hooks[0].command='/usr/bin/false';
    if(kind==='missing') f.hooks.pop();
    await assert.rejects(f.controller.enable(review.reviewId,{confirmed:true})); assert.equal(f.writes.length,0,kind);
  }
});
test('a configuration race or failed verification cannot become an enabled UI result',async()=>{
  for(const fail of ['write','readback']) {
    const f=await fixture(),review=await f.controller.prepare(),original=f.client.request;
    f.client.request=async(m,p)=>{
      if(m==='config/batchWrite') {
        if(fail==='write') throw Error('configuration version conflict');
        return {status:'ok'}; // server still reports untrusted afterward
      }
      return original(m,p);
    };
    await assert.rejects(f.controller.enable(review.reviewId,{confirmed:true}));
  }
});
test('ready state needs no new consent and inspecting ignores other plugin permissions',async()=>{
  const f=await fixture(); for(const h of f.hooks) h.trustStatus='trusted';
  f.hooks.push({...f.hooks[0],key:'other',pluginId:'someone-else',command:'other'});
  const result=await f.controller.prepare(); assert.equal(result.trusted,true); assert.equal(result.reviewId,undefined);
  assert.equal(f.writes.length,0);
});
test('concurrent confirmation cannot submit the same review twice',async()=>{
  const f=await fixture(),review=await f.controller.prepare();
  const results=await Promise.allSettled([
    f.controller.enable(review.reviewId,{confirmed:true}),f.controller.enable(review.reviewId,{confirmed:true}),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1); assert.equal(f.writes.length,1);
});
