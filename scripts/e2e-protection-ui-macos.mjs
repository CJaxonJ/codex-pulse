import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {protectionFixture} from './test-support/protection-fixture.mjs';
const project=path.resolve(import.meta.dirname,'..');
for(const appearance of ['light','dark']) for(const action of ['cancel','enable']) {
  const f=await protectionFixture(project),before=await f.config();
  const {stdout}=await promisify(execFile)(path.join(project,'build/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier'),['--protection-self-test'],{
    env:{...f.env,CODEX_PULSE_TEST_NODE:process.execPath,CODEX_PULSE_TEST_CLI:path.join(project,'bin/codex-pulse.mjs'),
      CODEX_PULSE_TEST_APPEARANCE:appearance,CODEX_PULSE_TEST_CAPTURE_DIR:f.root,CODEX_PULSE_TEST_CONSENT_ACTION:action},timeout:30000,
  });
  const result=JSON.parse(stdout.trim()); assert.equal(result.ok,true,JSON.stringify({result,evidence:f.root}));
  assert.equal((await f.cli(['protection','status'])).trusted,action==='enable');
  if(action==='cancel') assert.equal(await f.config(),before);
  console.log(JSON.stringify({ok:true,appearance,action,actualNativeButton:true,actualCodexReadback:true,
    productionConfigTouched:false,quotaSpent:0,screenshot:path.join(f.root,'protection.png')}));
}
