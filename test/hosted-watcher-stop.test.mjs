import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { hostedWatcherStop } from "../src/hosted-watcher-stop.mjs";

test("hosted stop waits for complete ownership, delivers once, and handles split frames", () => {
  const input = new PassThrough(), stop = hostedWatcherStop({ enabled: true, input });
  let calls = 0;
  input.write("codex-pulse-"); assert.equal(stop.requested, false);
  input.write("stop\r\n"); assert.equal(stop.requested, true); assert.equal(calls, 0);
  stop.ready(() => calls++); input.write("codex-pulse-stop\n");
  assert.equal(calls, 1); stop.close();
});
test("host death requests stop without interrupting incomplete ownership", async () => {
  const input = new PassThrough(), stop = hostedWatcherStop({ enabled: true, input });
  let calls = 0; input.end(); await setImmediate();
  assert.equal(stop.requested, true); assert.equal(calls, 0);
  stop.ready(() => calls++); assert.equal(calls, 1); stop.close();
});
test("hosted protocol bounds frames and does not consume ordinary CLI stdin", () => {
  const input = new PassThrough(), stop = hostedWatcherStop({ enabled: true, input });
  input.write("x".repeat(1024) + "codex-pulse-stop\nunknown\n");
  assert.equal(stop.requested, false);
  let calls = 0; stop.ready(() => calls++); input.write("codex-pulse-stop\n");
  assert.equal(calls, 1); stop.close();
  const ordinary = new PassThrough(), disabled = hostedWatcherStop({ enabled: false, input: ordinary });
  assert.equal(ordinary.listenerCount("data"), 0);
  disabled.close(); assert.equal(ordinary.destroyed, false); ordinary.destroy();
});
