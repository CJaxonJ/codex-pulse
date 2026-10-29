import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { sendWindowsNotification, windowsNotificationPayload } from "../src/windows-notifier.mjs";
import { sendNotification } from "../src/notifier.mjs";

test("Windows notifications transfer bounded plain text over stdin and whitelist source actions", () => {
  const packet = windowsNotificationPayload({ title: "你好", body: "$(bad) & <not html>", sourceUrl: "file:///C:/private", persistent: true, sound: false, severity: "critical", command: "never pass", eventId: "unsafe/id" });
  assert.equal(packet.sourceUrl, null);
  assert.equal(packet.sound, false);
  assert.equal(packet.body, "$(bad) & <not html>");
  assert.equal(packet.eventId, null);
  assert.equal(packet.command, undefined);
  assert.equal(windowsNotificationPayload({ sourceUrl: "https://twitter.com/thsottiaux/status/123?tracking=test" }).sourceUrl, "https://x.com/thsottiaux/status/123");
  assert.equal(windowsNotificationPayload({ sourceText: "x".repeat(22000) }).sourceText.length, 20000);
});

function fakeProcess(start) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.unref = () => { child.unreferenced = true; };
  child.kill = () => { child.killed = true; };
  child.stdin.on("finish", () => start(child));
  return child;
}

test("Windows delivery requires a native UI acknowledgement, not a spawned process", async () => {
  let invocation, child;
  const result = await sendWindowsNotification({ title: "原文有空格 & 引号\"", persistent: true }, { env: { CODEX_PULSE_NOTIFIER_APP: "C:\\开发 空格\\CodexPulse.exe" }, spawn: (...args) => {
    invocation = args;
    child = fakeProcess(c => c.stdout.end('{"status":"shown"}\n'));
    return child;
  } });
  assert.deepEqual(result, { deliveryStatus: "window_shown" });
  assert.deepEqual(invocation[1], ["--notify"]);
  assert.equal(invocation[2].shell, undefined);
  assert.equal(invocation[2].windowsHide, true);
  assert.equal(child.unreferenced, true);
  assert.equal(child.killed, undefined);
});

test("Windows missing helper, early exit, timeout and false shown acknowledgement fail explicitly", async () => {
  for (const kind of ["missing", "exit", "timeout", "mismatch", "malformed"]) {
    let child;
    await assert.rejects(sendWindowsNotification({ persistent: true }, { env: {}, timeoutMs: 25, spawn: () => {
      child = fakeProcess(c => {
        if (kind === "missing") c.emit("error", Error("private home path"));
        if (kind === "exit") c.emit("exit", 1);
        if (kind === "mismatch") c.stdout.end('{"status":"requested"}\n');
        if (kind === "malformed") c.stdout.end('not JSON\n');
      });
      return child;
    } }), error => !error.message.includes("private home path"), kind);
    assert.equal(child.killed, true, kind);
  }
});

test("Windows disabled delivery does not launch a helper, and unsupported OS never invokes macOS tools", async () => {
  assert.deepEqual(await sendWindowsNotification({}, { env: { CODEX_PULSE_DISABLE_NOTIFICATIONS: "1" }, spawn: () => assert.fail("must not start") }), { deliveryStatus: "disabled" });
  await assert.rejects(sendNotification({}, { platform: "linux" }), /尚未支持/);
  assert.deepEqual(await sendNotification({}, { platform: "win32", env: { CODEX_PULSE_DISABLE_NOTIFICATIONS: "1" } }), { deliveryStatus: "disabled" });
});
