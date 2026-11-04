import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexInvocation } from "./platform-runtime.mjs";

const execute = promisify(execFile);

export function recoveryWakeId(sessionId, pausedTurnId) {
  return createHash("sha256").update(`${sessionId}\0${pausedTurnId}`).digest("hex");
}

export function recoveryWakeMessage(record) {
  const id = recoveryWakeId(record.sessionId, record.pausedTurnId || record.turnId);
  const objective = record.checkpoint?.continuationGoal?.objective || record.initialGoal?.objective ||
    "Continue only the unfinished user-approved task in this thread after inspecting its saved checkpoint.";
  return `[Codex Pulse recovery ${id}]\n${objective}\n\nInspect the saved workspace and checkpoint before changing files. Preserve the original user objective. This is the already-authorized quota recovery, not a new task.`;
}

export function trustedRecoveryHooks(result) {
  const hooks = (result?.data || []).flatMap(entry => entry.errors?.length ? [] : entry.hooks || []);
  return ["preToolUse", "userPromptSubmit"].every(event => hooks.some(hook =>
    hook.eventName === event && hook.enabled && ["trusted", "managed"].includes(hook.trustStatus) &&
    (hook.pluginId?.startsWith("codex-pulse@") || /[/\\]codex-pulse[/\\]/.test(hook.sourcePath || ""))));
}

export async function assertQueueResumeSupported(binary, cwd, executeCommand = execute) {
  // Parse the real flags without enqueueing a message or loading a real chat.
  // Version strings are insufficient: bundled and standalone CLIs can differ.
  const call = codexInvocation(binary, ["queue", "--thread", "00000000-0000-4000-8000-000000000000",
    "--message", "Codex Pulse capability probe", "--resume", "--help"]);
  let result;
  try {
    result = await executeCommand(call.file, call.args, { cwd, timeout: 15000,
      maxBuffer: 64 * 1024, windowsHide: true });
  } catch (error) {
    const diagnostic = String(error.stderr || "");
    if (error.code !== 2 || !/(unexpected argument|unrecognized subcommand|unknown option)/i.test(diagnostic) ||
      !/(--resume|queue)/i.test(diagnostic)) throw error;
    const unavailable = new Error("当前 Codex CLI 不支持恢复已保存的聊天，请更新 Codex 后再开启自动续跑；原计划已保留。");
    unavailable.code = "PULSE_QUEUE_RESUME_UNAVAILABLE";
    throw unavailable;
  }
  if (!/usage:[\s\S]*codex[^\n]*queue/i.test(String(result?.stdout || ""))) {
    throw new Error("Unable to verify Codex queue resume capability; no recovery message was submitted.");
  }
}

export async function queueNativeWakeup(binary, record, executeCommand = execute) {
  await assertQueueResumeSupported(binary, record.cwd, executeCommand);
  // Official queue routes to the owning session through the local daemon.
  // It does not claim the thread's writer lock or start another writer.
  // Queue alone can succeed while leaving a stored/unloaded thread idle.
  // Let the official owning daemon reload it; execution still needs a new
  // observed turn, not this command's exit status, before reporting success.
  const invocation = codexInvocation(binary, ["queue", "--thread", record.sessionId, "--message", recoveryWakeMessage(record), "--resume"]);
  await executeCommand(invocation.file, invocation.args, {
    cwd: record.cwd, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
}
