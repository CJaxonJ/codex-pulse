import test from 'node:test';
import assert from 'node:assert/strict';
import {openProtectionOnboarding} from '../src/protection-onboarding.mjs';
test('installer opens a native review, never CLI, trust mutation or automatic restart',()=>{
  const calls=[];const result=openProtectionOnboarding({interactive:true,env:{},executable:'/fixture/Pulse',run:(...args)=>{calls.push(args);return {status:0};}});
  assert.equal(result.opened,true);assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,2),['/fixture/Pulse',['--protection']]);
});
test('deferred or noninteractive installation does not launch a review or grant consent',()=>{
  for(const options of [{interactive:false,env:{}},{interactive:true,env:{CODEX_PULSE_SKIP_HOOK_REVIEW:'1'}}]) {
    assert.equal(openProtectionOnboarding({...options,run:()=>{throw Error('must not launch');}}).opened,false);
  }
});
