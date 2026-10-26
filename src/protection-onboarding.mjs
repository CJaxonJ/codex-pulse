import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

export function openProtectionOnboarding({env=process.env,run=spawnSync,
  interactive=env.CODEX_PULSE_INTERACTIVE_INSTALL==='1' || Boolean(process.stdin.isTTY && process.stdout.isTTY),
  executable=path.join(os.homedir(),'Applications/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier')}={}) {
  if(!interactive || env.CODEX_PULSE_SKIP_HOOK_REVIEW==='1') return {opened:false,reason:'deferred'};
  // Merely opens the review. Only the native user button may submit consent.
  // No CLI keystrokes, silent trust writes, or automatic Desktop restart.
  const result=run(executable,['--protection'],{env,stdio:'inherit'});
  return result.status===0 ? {opened:true,reason:'window_closed'} : {opened:false,reason:'window_unavailable'};
}
