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
    "完成后，请彻底退出并重新打开 Codex 桌面端。",
  ].join("\n");
}

function appleScriptDialog(message) {
  const escaped = message.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `display dialog "${escaped}" with title "Codex Pulse 最后一步" buttons {"稍后", "打开 Codex CLI"} default button "打开 Codex CLI" cancel button "稍后"`;
}

export function openHookReview({
  codexPath,
  env = process.env,
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
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
