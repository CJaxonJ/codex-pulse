import { spawnSync } from "node:child_process";

export const HOOK_REVIEW_STEPS = [
  "在 Codex CLI 中输入 /hooks，然后按回车。",
  "确认 Codex Pulse 的命令路径位于 ~/.codex/plugins/cache/codex-pulse-local/。",
  "按 t 信任全部 Codex Pulse hooks；不会再弹出确认框。",
  "看到 Active 变为 1 后按 Esc 返回，再按 Ctrl+C 退出 CLI。",
];

export function hookReviewMessage() {
  return [
    "Codex 出于安全原因，必须由你本人完成一次 Hook 信任。",
    "安装程序会直接打开 Codex CLI，你不需要自己找终端。",
    "",
    ...HOOK_REVIEW_STEPS.map((step, index) => `${index + 1}. ${step}`),
    "",
    "完成后退出 CLI，安装程序会再弹窗询问是否立即重启 Codex。",
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
    buttons = ["稍后", "打开 Codex CLI"],
    defaultButton = buttons.at(-1),
    cancelButton = buttons[0],
  } = {},
) {
  const escaped = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const escapedTitle = title.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const quotedButtons = buttons
    .map((button) => `"${button.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
    .join(", ");
  return `display dialog "${escaped}" with title "${escapedTitle}" buttons {${quotedButtons}} default button "${defaultButton}" cancel button "${cancelButton}"`;
}

function restartCodexScript() {
  return [
    'tell application "ChatGPT" to quit',
    "delay 2",
    'tell application "ChatGPT" to activate',
  ].join("\n");
}

export function openHookReview({
  codexPath,
  env = process.env,
  interactive = Boolean(
    env.CODEX_PULSE_INTERACTIVE_INSTALL === "1" ||
      (process.stdin.isTTY && process.stdout.isTTY),
  ),
  run = spawnSync,
} = {}) {
  const message = hookReviewMessage();
  if (!interactive || env.CODEX_PULSE_SKIP_HOOK_REVIEW === "1") {
    return { launched: false, reason: "non_interactive", message };
  }

  const dialog = run("/usr/bin/osascript", ["-e", appleScriptDialog(message)], {
    encoding: "utf8",
  });
  if (dialog.status !== 0 || !String(dialog.stdout || "").includes("打开 Codex CLI")) {
    return { launched: false, reason: "deferred", message };
  }

  const cli = run(codexPath, [], {
    env,
    stdio: "inherit",
  });
  return {
    launched: true,
    reason: "opened",
    message,
    cliStatus: cli.status,
    cliSignal: cli.signal || null,
  };
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
