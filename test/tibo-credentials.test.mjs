import assert from "node:assert/strict";
import test from "node:test";

import {
  configureXBearerToken,
  readXBearerToken,
} from "../src/tibo-credentials.mjs";

test("environment credential takes precedence without invoking Keychain", async () => {
  let invoked = false;
  const token = await readXBearerToken({
    env: { CODEX_PULSE_X_BEARER_TOKEN: "  env-token  " },
    platform: "darwin",
    execFile: async () => {
      invoked = true;
      return { stdout: "keychain-token" };
    },
  });
  assert.equal(token, "env-token");
  assert.equal(invoked, false);
});

test("Keychain credential is read in memory and missing credentials return null", async () => {
  assert.equal(
    await readXBearerToken({
      env: {},
      platform: "darwin",
      execFile: async () => ({ stdout: "keychain-token\n" }),
    }),
    "keychain-token",
  );
  assert.equal(
    await readXBearerToken({
      env: {},
      platform: "darwin",
      execFile: async () => {
        throw new Error("not found");
      },
    }),
    null,
  );
});

test("Keychain setup prompts for the secret instead of placing it in argv", () => {
  let invocation = null;
  configureXBearerToken({
    platform: "darwin",
    spawnSync: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0 };
    },
  });
  assert.equal(invocation.command, "/usr/bin/security");
  assert.equal(invocation.args.at(-1), "-w");
  assert.equal(invocation.options.stdio, "inherit");
  assert.equal(invocation.args.some((arg) => /token|secret/i.test(arg)), false);
});
