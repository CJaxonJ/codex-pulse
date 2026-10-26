import {mkdtemp,mkdir,cp,writeFile,readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {resolveCodexBinary} from '../../src/app-server-client.mjs';
export async function protectionFixture(project) {
  const root=await mkdtemp(path.join(os.tmpdir(),'pulse-consent-e2e-'));
  const home=path.join(root,'codex'),dataDir=path.join(root,'data'),market=path.join(root,'market');
  await mkdir(home); await mkdir(dataDir); await mkdir(path.join(market,'.agents/plugins'),{recursive:true});
  await writeFile(path.join(home,'protection-test-fixture'),'isolated');
  await cp(path.join(project,'plugin'),path.join(market,'plugin'),{recursive:true});
  await cp(path.join(project,'.agents/plugins/marketplace.json'),path.join(market,'.agents/plugins/marketplace.json'));
  const env={...process.env,CODEX_HOME:home,CODEX_PULSE_DATA_DIR:dataDir,CODEX_PULSE_APP_ROOT:project};
  const run=async(args)=>JSON.parse((await promisify(execFile)(resolveCodexBinary(),args,{env,timeout:20000})).stdout);
  await run(['plugin','marketplace','add',market,'--json']);
  await run(['plugin','add','codex-pulse@codex-pulse-local','--json']);
  const cli=async(args)=>{
    const {stdout}=await promisify(execFile)(process.execPath,[path.join(project,'bin/codex-pulse.mjs'),...args],{env,timeout:20000});
    return JSON.parse(stdout);
  };
  const config=()=>readFile(path.join(home,'config.toml'),'utf8');
  return {root,home,dataDir,env,cli,config};
}
