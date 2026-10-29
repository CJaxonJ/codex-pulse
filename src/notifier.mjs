import { sendMacNotification } from "./macos-notifier.mjs";
import { sendWindowsNotification } from "./windows-notifier.mjs";

export function sendNotification(notice, options = {}) {
  const platform = options.platform || process.platform;
  if (platform === "win32") return sendWindowsNotification(notice, options);
  if (platform === "darwin") return sendMacNotification(notice);
  return Promise.reject(new Error("当前系统尚未支持 Codex Pulse 桌面提醒"));
}
