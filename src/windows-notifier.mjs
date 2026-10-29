import { spawn } from "node:child_process";
import path from "node:path";
import { pulseDataDirectory } from "./platform-runtime.mjs";
import { xPostUrl } from "./tibo-post-source.mjs";

export function windowsNotificationPayload(notice) {
  return {
    title: String(notice.title || "Codex Pulse").slice(0, 180),
    body: String(notice.body || "").slice(0, 2000),
    severity: ["critical", "warning", "info"].includes(notice.severity) ? notice.severity : "info",
    persistent: notice.persistent === true,
    sound: notice.sound !== false,
    action: notice.action === "preview" ? "preview" : "history",
    sourceUrl: xPostUrl(notice.sourceUrl),
    sourceText: String(notice.sourceText || "").slice(0, 20000),
    eventId: typeof notice.eventId === "string" && /^[\w:-]{1,180}$/.test(notice.eventId) ? notice.eventId : null,
  };
}

// No shell and no notification text in the command line. The native process
// acknowledges only after creating its UI; process creation is not delivery.
export function sendWindowsNotification(notice, options = {}) {
  const env = options.env || process.env;
  if (env.CODEX_PULSE_DISABLE_NOTIFICATIONS === "1") return Promise.resolve({ deliveryStatus: "disabled" });
  const nativeApp = env.CODEX_PULSE_NOTIFIER_APP || path.join(pulseDataDirectory({ env }), "app", "CodexPulse.exe");
  const start = options.spawn || spawn;
  const timeoutMs = options.timeoutMs ?? 10000;
  const payload = windowsNotificationPayload(notice);
  return new Promise((resolve, reject) => {
    // This is a WinExe, so it has no console to hide. windowsHide also sets
    // SW_HIDE for GUI windows and would make a successful alert invisible.
    const child = start(nativeApp, ["--notify"], { windowsHide: false, detached: true, stdio: ["pipe", "pipe", "pipe"], env });
    let settled = false, output = "";
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.destroy(); child.stderr.destroy();
      if (error) {
        child.kill();
        reject(error);
      } else { child.unref(); resolve(result); }
    };
    const timer = setTimeout(() => finish(new Error("Windows 提醒未确认展示；消息已保留在本机历史中")), timeoutMs);
    child.on("error", () => finish(new Error("无法启动 Windows 提醒，请检查 Codex Pulse 安装")));
    child.stdin.on("error", () => finish(new Error("Windows 提醒未接收到完整消息")));
    child.on("exit", () => { if (!settled) finish(new Error("Windows 提醒在展示前退出")); });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 4096) return finish(new Error("Windows 提醒返回了无效确认"));
      if (!output.includes("\n")) return;
      try {
        const acknowledgement = JSON.parse(output.slice(0, output.indexOf("\n")));
        if (acknowledgement.status !== (payload.persistent ? "shown" : "requested")) throw Error();
        finish(null, { deliveryStatus: payload.persistent ? "window_shown" : "notification_request_accepted" });
      } catch { finish(new Error("Windows 提醒返回了无效确认")); }
    });
    // Drain, but never include native stderr or source text in diagnostics.
    child.stderr.resume();
    child.stdin.end(JSON.stringify(payload));
  });
}
