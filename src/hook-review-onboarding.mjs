import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOOK_REVIEW_STEPS = [
  "在 Codex CLI 中输入 /hooks，然后按回车。",
  "确认 Codex Pulse 的命令路径位于 ~/.codex/plugins/cache/codex-pulse-local/。",
  "按 t 信任全部 Codex Pulse hooks；不会再弹出确认框。",
  "看到 Active 变为 1 后无需再操作，安装程序会自动关闭这个 CLI。",
];

const PULSE_HOOK_EVENTS = [
  "pre_tool_use",
  "post_tool_use",
  "session_start",
  "user_prompt_submit",
  "stop",
  "interrupt",
];

export function hookReviewMessage() {
  return [
    "Codex 出于安全原因，必须由你本人完成一次 Hook 信任。",
    "点击“打开 CLI 并继续信任”后，安装程序会把 Codex CLI 带到前台。",
    "看到 Active 变为 1 后，安装程序会自动关闭这个 CLI 并重启 Codex。正在运行的 Codex 任务会停止。",
    "",
    ...HOOK_REVIEW_STEPS.map((step, index) => `${index + 1}. ${step}`),
    "",
    "按完 t 后无需退出或再点按钮。",
  ].join("\n");
}

export function restartPromptMessage() {
  return [
    "如果刚才已经看到 Active 变为 1，Hook 信任就完成了。",
    "",
    "Codex 需要重启一次才能在桌面端加载新 Hook。点击“立即重启 Codex”会退出并重新打开 ChatGPT；正在运行的 Codex 任务会停止。",
    "",
    "如果还有任务在运行，请选择“稍后重启”。",
  ].join("\n");
}

function appleScriptDialog(
  message,
  {
    title = "Codex Pulse 最后一步",
    buttons = ["稍后", "打开 CLI 并继续信任"],
    defaultButton = buttons.at(-1),
    cancelButton = buttons[0],
  } = {},
) {
  const escaped = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const escapedTitle = title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const quotedButtons = buttons
    .map((button) => `"${button.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(", ");
  return `tell application "Terminal" to activate\ndisplay dialog "${escaped}" with title "${escapedTitle}" buttons {${quotedButtons}} default button "${defaultButton}" cancel button "${cancelButton}"`;
}

function restartCodexScript() {
  return [
    'tell application "ChatGPT" to quit',
    "delay 2",
    'tell application "ChatGPT" to activate',
  ].join("\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function terminalReviewScript(codexPath, pidPath) {
  const command = [
    "/usr/bin/printf '\\033]0;Codex Pulse Hook Review\\007'",
    `/usr/bin/printf '%s' $$ > ${shellQuote(pidPath)}`,
    `exec ${shellQuote(codexPath)}`,
  ].join("; ");
  const escapedCommand = command
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return [
    'tell application "Terminal"',
    "activate",
    `do script "${escapedCommand}"`,
    "end tell",
  ].join("\n");
}

export function areCodexPulseHooksTrusted(configPath) {
  try {
    const config = readFileSync(configPath, "utf8");
    return PULSE_HOOK_EVENTS.every((event) => {
      const section = new RegExp(
        `\\[hooks\\.state\\."codex-pulse@codex-pulse-local:[^"\\n]*:${event}:[^"\\n]*"\\]([\\s\\S]*?)(?=\\n\\[|$)`,
      ).exec(config)?.[1];
      return Boolean(section && /^trusted_hash\s*=\s*"sha256:[a-f0-9]{64}"\s*$/m.test(section));
    });
  } catch {
    return false;
  }
}

export function waitForTrust({ configPath, pidPath, timeoutMs = 10 * 60 * 1_000 }) {
  const startedAt = Date.now();
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() - startedAt < timeoutMs) {
    if (areCodexPulseHooksTrusted(configPath)) {
      if (existsSync(pidPath)) {
        const pid = Number(readFileSync(pidPath, "utf8").trim());
        if (Number.isSafeInteger(pid) && pid > 1) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // The review CLI may already have closed.
          }
        }
      }
      return "trusted";
    }
    Atomics.wait(sleeper, 0, 0, 250);
  }
  return "timeout";
}

export function openHookReview({
  codexPath,
  env = process.env,
  interactive = Boolean(
    env.CODEX_PULSE_INTERACTIVE_INSTALL === "1" ||
      (process.stdin.isTTY && process.stdout.isTTY),
  ),
  run = spawnSync,
  configPath = path.join(os.homedir(), ".codex", "config.toml"),
  pidPath = path.join(
    os.tmpdir(),
    `codex-pulse-hook-review-${process.pid}-${Date.now()}.pid`,
  ),
  waitForReview = waitForTrust,
  trustCheck = areCodexPulseHooksTrusted,
} = {}) {
  const message = hookReviewMessage();
  if (!interactive || env.CODEX_PULSE_SKIP_HOOK_REVIEW === "1") {
    return { launched: false, reason: "non_interactive", message };
  }
  if (trustCheck(configPath)) {
    return { launched: false, reason: "already_trusted", message };
  }

  const dialog = run("/usr/bin/osascript", ["-e", appleScriptDialog(message)], {
    encoding: "utf8",
  });
  if (
    dialog.status !== 0 ||
    !String(dialog.stdout || "").includes("打开 CLI 并继续信任")
  ) {
    return { launched: false, reason: "deferred", message };
  }

  rmSync(pidPath, { force: true });
  const cli = run("/usr/bin/osascript", ["-e", terminalReviewScript(codexPath, pidPath)], {
    encoding: "utf8",
  });
  if (cli.status !== 0) {
    return {
      launched: false,
      reason: "cli_launch_failed",
      message,
      error: String(cli.stderr || "").trim() || null,
    };
  }
  const reviewResult = waitForReview({ configPath, pidPath });
  rmSync(pidPath, { force: true });
  return {
    launched: true,
    reason: reviewResult === "trusted" ? "completed" : "cli_timeout",
    message,
    cliStatus: reviewResult === "trusted" ? 0 : null,
    cliSignal: null,
    terminalActivated: true,
  };
}

export function restartCodex({ chatgptInstalled = true, run = spawnSync } = {}) {
  if (!chatgptInstalled) {
    return { restarted: false, reason: "desktop_unavailable" };
  }
  const restart = run("/usr/bin/osascript", ["-e", restartCodexScript()], {
    encoding: "utf8",
  });
  if (restart.status !== 0) {
    return {
      restarted: false,
      reason: "restart_failed",
      error: String(restart.stderr || "").trim() || null,
    };
  }
  return { restarted: true, reason: "restarted" };
}

export function offerCodexRestart({
  env = process.env,
  interactive = Boolean(
    env.CODEX_PULSE_INTERACTIVE_INSTALL === "1" ||
      (process.stdin.isTTY && process.stdout.isTTY),
  ),
  chatgptInstalled = true,
  run = spawnSync,
} = {}) {
  const message = restartPromptMessage();
  if (!interactive || env.CODEX_PULSE_SKIP_HOOK_REVIEW === "1") {
    return { restarted: false, reason: "non_interactive", message };
  }
  if (!chatgptInstalled) {
    return { restarted: false, reason: "desktop_unavailable", message };
  }

  const dialog = run(
    "/usr/bin/osascript",
    [
      "-e",
      appleScriptDialog(message, {
        title: "Codex Pulse 已安装",
        buttons: ["稍后重启", "立即重启 Codex"],
        defaultButton: "立即重启 Codex",
        cancelButton: "稍后重启",
      }),
    ],
    { encoding: "utf8" },
  );
  if (
    dialog.status !== 0 ||
    !String(dialog.stdout || "").includes("立即重启 Codex")
  ) {
    return { restarted: false, reason: "deferred", message };
  }

  const restart = run("/usr/bin/osascript", ["-e", restartCodexScript()], {
    encoding: "utf8",
  });
  if (restart.status !== 0) {
    return {
      restarted: false,
      reason: "restart_failed",
      message,
      error: String(restart.stderr || "").trim() || null,
    };
  }
  return { restarted: true, reason: "restarted", message };
}
