#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  throw new Error("The native persistent-notification E2E requires macOS.");
}

const executable = process.argv.includes("--build") ? path.resolve(import.meta.dirname, "../build/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier") : path.join(
  os.homedir(),
  "Applications",
  "Codex Pulse.app",
  "Contents",
  "MacOS",
  "CodexPulseNotifier",
);

if (!existsSync(executable)) {
  throw new Error("Codex Pulse.app is not built. Run node scripts/build-notifier-macos.mjs first.");
}

const child = spawn(
  executable,
  [
    "【自动测试】常驻提醒",
    "这个窗口会保持 3 秒，然后由测试自动关闭。",
    "--persistent-self-test",
    "--severity", "critical",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
const code = await new Promise((resolve) => child.on("exit", resolve));
clearTimeout(timeout);

if (code !== 0) {
  throw new Error(stderr.trim() || `native notifier self-test exited with ${code}`);
}

const line = stdout
  .trim()
  .split("\n")
  .findLast((candidate) => candidate.startsWith("{"));
const result = line ? JSON.parse(line) : null;
if (!result?.ok || result.visibleForSeconds < 3 || result.severity !== "critical") {
  throw new Error(`persistent alert did not remain visible: ${stdout.trim() || "no result"}`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      mode: "native_persistent_alert_e2e",
      visibleForSeconds: result.visibleForSeconds,
      quotaSpent: 0,
    },
    null,
    2,
  ),
);
