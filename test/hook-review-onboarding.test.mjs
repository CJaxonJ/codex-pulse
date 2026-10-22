import assert from "node:assert/strict";
import test from "node:test";

import {
  hookReviewMessage,
  offerCodexRestart,
  openHookReview,
  restartPromptMessage,
} from "../src/hook-review-onboarding.mjs";

test("hook review guide gives the complete one-time user path", () => {
  const message = hookReviewMessage();
  assert.match(message, /安装程序会直接打开 Codex CLI/);
  assert.match(message, /\/hooks/);
  assert.match(message, /按 t 信任/);
  assert.match(message, /Active 变为 1/);
  assert.match(message, /再弹窗询问是否立即重启 Codex/);
});

test("restart guide explains the effect before offering a restart", () => {
  const message = restartPromptMessage();
  assert.match(message, /Active 变为 1/);
  assert.match(message, /正在运行的 Codex 任务会停止/);
  assert.match(message, /稍后重启/);
});

test("interactive onboarding opens the reviewed CLI after explicit user choice", () => {
  const calls = [];
  const result = openHookReview({
    codexPath: "/Applications/CodexCLI",
    interactive: true,
    env: {},
    run(command, args, options) {
      calls.push({ command, args, options });
      if (command === "/usr/bin/osascript") {
        return { status: 0, stdout: "button returned:打开 Codex CLI\n" };
      }
      return { status: 0, signal: null };
    },
  });

  assert.equal(result.launched, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].command, "/Applications/CodexCLI");
  assert.equal(calls[1].options.stdio, "inherit");
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
    run(command, args, options) {
      calls.push({ command, args, options });
      if (command === "/usr/bin/osascript") {
        return { status: 0, stdout: "button returned:打开 Codex CLI\n" };
      }
      return { status: 0, signal: null };
    },
  });

  assert.equal(result.launched, true);
  assert.equal(calls.length, 2);
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
