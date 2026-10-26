import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

export async function queueNativeWakeup(binary, record, executeCommand = execute) {
  // Official queue routes to the owning session through the local daemon.
  // It does not claim the thread's writer lock or start another writer.
  await executeCommand(binary, ["queue", "--thread", record.sessionId, "--message", recoveryWakeMessage(record)], {
    cwd: record.cwd, timeout: 20000, maxBuffer: 1024 * 1024,
  });
}
