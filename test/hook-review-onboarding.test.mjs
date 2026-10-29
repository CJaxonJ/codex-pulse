import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  areCodexPulseHooksTrusted,
  areCurrentCodexPulseHooksTrusted,
  hookReviewMessage,
  offerCodexRestart,
  openHookReview,
  restartCodex,
  restartPromptMessage,
  waitForTrust,
} from "../src/hook-review-onboarding.mjs";

test("hook review guide gives the complete one-time user path", () => {
  const message = hookReviewMessage();
  assert.match(message, /打开 CLI 并继续信任/);
  assert.match(message, /\/hooks/);
  assert.match(message, /按 t 信任/);
  assert.match(message, /Active 变为 1/);
  assert.match(message, /自动关闭这个 CLI/);
  assert.match(message, /并重启 Codex/);
});

test("restart guide explains the effect before offering a restart", () => {
  const message = restartPromptMessage();
  assert.match(message, /Active 变为 1/);
  assert.match(message, /正在运行的 Codex 任务会停止/);
  assert.match(message, /稍后重启/);
});

test("interactive onboarding opens the reviewed CLI after explicit user choice", () => {
  const calls = [];
  let waitedFor = null;
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    interactive: true,
    env: {},
    configPath: "/tmp/codex-pulse-config.toml",
    pidPath: "/tmp/codex-pulse-review.pid",
    trustCheck() {
      return false;
    },
    waitForReview({ pidPath }) {
      waitedFor = pidPath;
      return "trusted";
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return { status: 0, stdout: "button returned:打开 CLI 并继续信任\n" };
      }
      return { status: 0, signal: null };
    },
  });

  assert.equal(result.launched, true);
  assert.equal(result.terminalActivated, true);
  assert.equal(result.reason, "completed");
  assert.equal(waitedFor, "/tmp/codex-pulse-review.pid");
  assert.equal(calls.length, 2);
  assert.match(calls[0].args[1], /tell application "Terminal" to activate/);
  assert.equal(calls[1].command, "/usr/bin/osascript");
  assert.match(calls[1].args[1], /do script/);
  assert.match(calls[1].args[1], /CodexCLI/);
  assert.match(calls[1].args[1], /codex-pulse-review\.pid/);
});

test("non-interactive install never launches or trusts anything", () => {
  let called = false;
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    interactive: false,
    env: {},
    run() {
      called = true;
      return { status: 0 };
    },
  });

  assert.equal(result.launched, false);
  assert.equal(result.reason, "non_interactive");
  assert.equal(called, false);
});

test("choosing later does not open the CLI", () => {
  const calls = [];
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    interactive: true,
    env: {},
    trustCheck() {
      return false;
    },
    run(command) {
      calls.push(command);
      return { status: 1, stdout: "", signal: null };
    },
  });

  assert.equal(result.launched, false);
  assert.equal(result.reason, "deferred");
  assert.deepEqual(calls, ["/usr/bin/osascript"]);
});

test("finder-launched installer is interactive even without a tty", () => {
  const calls = [];
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    env: { CODEX_PULSE_INTERACTIVE_INSTALL: "1" },
    configPath: "/tmp/codex-pulse-config.toml",
    pidPath: "/tmp/codex-pulse-finder-review.pid",
    trustCheck() {
      return false;
    },
    waitForReview() {
      return "trusted";
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return { status: 0, stdout: "button returned:打开 CLI 并继续信任\n" };
      }
      return { status: 0, signal: null };
    },
  });

  assert.equal(result.launched, true);
  assert.equal(result.terminalActivated, true);
  assert.equal(calls.length, 2);
});

test("CLI launch failure never promises a restart step", () => {
  const calls = [];
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    interactive: true,
    env: {},
    configPath: "/tmp/codex-pulse-config.toml",
    pidPath: "/tmp/codex-pulse-failed-review.pid",
    trustCheck() {
      return false;
    },
    waitForReview() {
      throw new Error("must not wait when launch failed");
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return { status: 0, stdout: "button returned:打开 CLI 并继续信任\n" };
      }
      return { status: 1, stdout: "", stderr: "Terminal launch failed" };
    },
  });

  assert.equal(result.launched, false);
  assert.equal(result.reason, "cli_launch_failed");
  assert.match(result.error, /Terminal launch failed/);
  assert.equal(calls.length, 2);
});

test("existing official hook trust skips redundant CLI review", () => {
  let called = false;
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    interactive: true,
    env: {},
    trustCheck() {
      return true;
    },
    run() {
      called = true;
      return { status: 0 };
    },
  });

  assert.equal(result.launched, false);
  assert.equal(result.reason, "already_trusted");
  assert.equal(called, false);
});

test("reads historical trusted hashes without treating them as current Hook approval", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-trust-"));
  const events = [
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "user_prompt_submit",
    "stop",
    "interrupt",
  ];
  const config = events
    .map(
      (event) =>
        `[hooks.state."codex-pulse@codex-pulse-local:plugin.json#hooks[0]:${event}:0:0"]\ntrusted_hash = "sha256:${"a".repeat(64)}"`,
    )
    .join("\n\n");
  const configPath = path.join(dir, "config.toml");
  await writeFile(configPath, config);

  assert.equal(areCodexPulseHooksTrusted(configPath), true);
});

test("current trust is queried from Codex, not inferred from old trusted_hash records", () => {
  assert.equal(areCurrentCodexPulseHooksTrusted({ codexPath: "codex", execute: () => '{"trusted":false}' }), false);
  assert.equal(areCurrentCodexPulseHooksTrusted({ codexPath: "codex", execute: () => '{"trusted":true}' }), true);
});

test("trusted hook records stop only the installer-owned review CLI", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-pulse-review-pid-"));
  const configPath = path.join(dir, "config.toml");
  const pidPath = path.join(dir, "review.pid");
  const events = [
    "pre_tool_use",
    "post_tool_use",
    "session_start",
    "user_prompt_submit",
    "stop",
    "interrupt",
  ];
  await writeFile(
    configPath,
    events
      .map(
        (event) =>
          `[hooks.state."codex-pulse@codex-pulse-local:plugin.json#hooks[0]:${event}:0:0"]\ntrusted_hash = "sha256:${"b".repeat(64)}"`,
      )
      .join("\n\n"),
  );
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  await writeFile(pidPath, String(child.pid));

  assert.equal(waitForTrust({ configPath, pidPath, timeoutMs: 1_000,
    trustCheck: areCodexPulseHooksTrusted }), "trusted");
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  if(process.platform==="win32") assert.equal(exit.code,1); // Windows reports forced process termination as an exit code.
  else assert.equal(exit.signal, "SIGTERM");
});

test("restart stays explicit and reopens ChatGPT only after user confirmation", () => {
  const calls = [];
  const result = offerCodexRestart({
    interactive: true,
    env: {},
    run(command, args, options) {
      calls.push({ command, args, options });
      if (calls.length === 1) {
        return { status: 0, stdout: "button returned:立即重启 Codex\n" };
      }
      return { status: 0, stdout: "" };
    },
  });

  assert.equal(result.restarted, true);
  assert.equal(result.reason, "restarted");
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[1], /tell application "ChatGPT" to quit/);
  assert.match(calls[1].args[1], /tell application "ChatGPT" to activate/);
});

test("completed hook review can restart Codex without a second dialog", () => {
  const calls = [];
  const result = restartCodex({
    chatgptInstalled: true,
    run(command, args) {
      calls.push({ command, args });
      return { status: 0, stdout: "" };
    },
  });

  assert.equal(result.restarted, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /tell application "ChatGPT" to quit/);
  assert.match(calls[0].args[1], /tell application "ChatGPT" to activate/);
});

test("choosing a later restart leaves the desktop app untouched", () => {
  const calls = [];
  const result = offerCodexRestart({
    interactive: true,
    env: {},
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 1, stdout: "", stderr: "", signal: null };
    },
  });

  assert.equal(result.restarted, false);
  assert.equal(result.reason, "deferred");
  assert.equal(calls.length, 1);
});

test("restart is never attempted during non-interactive installation", () => {
  let called = false;
  const result = offerCodexRestart({
    interactive: false,
    env: {},
    run() {
      called = true;
      return { status: 0 };
    },
  });

  assert.equal(result.restarted, false);
  assert.equal(result.reason, "non_interactive");
  assert.equal(called, false);
});
