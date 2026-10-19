import assert from "node:assert/strict";
import test from "node:test";

import {
  hookReviewMessage,
  openHookReview,
} from "../src/hook-review-onboarding.mjs";

test("hook review guide gives the complete one-time user path", () => {
  const message = hookReviewMessage();
  assert.match(message, /安装程序会直接打开 Codex CLI/);
  assert.match(message, /\/hooks/);
  assert.match(message, /按 t 信任/);
  assert.match(message, /Active 变为 1/);
  assert.match(message, /重新打开 Codex 桌面端/);
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
