import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AppServerClient } from "../../src/app-server-client.mjs";
import { sendWindowsNotification } from "../../src/windows-notifier.mjs";

if (process.platform !== "win32" || !process.send) throw Error("Isolated Windows IPC fixture required");
const client = new AppServerClient({ binary: process.execPath, binaryArgs: [process.argv[2]] });
try {
  await client.start();
  const tree = await client.request("proof");
  let noticePid; const noticeToken = randomUUID();
  await sendWindowsNotification({ title: "【隔离测试】后台退出后仍需保留", body: "这是测试窗口，不代表真实额度。 " + noticeToken, persistent: true, sound: false }, {
    env: { ...process.env, CODEX_PULSE_DISABLE_NOTIFICATIONS: "0" },
    spawn: (...args) => { const child = spawn(...args); noticePid = child.pid; return child; },
  });
  process.send({ ok: true, tree, bridgePid: client.child.pid, noticePid, noticeToken });
  setInterval(() => {}, 1000);
} catch (error) { process.send({ ok: false, error: error.message }); client.stop(); process.exitCode = 1; }
