import assert from "node:assert/strict";
import test from "node:test";

import { notificationForEvent } from "../src/macos-notifier.mjs";

test("attention notifications tell the user what is actually blocking resume", () => {
  const input = notificationForEvent({
    type: "managed_task_attention",
    reason: "user_input_required",
  });
  const approval = notificationForEvent({
    type: "managed_task_attention",
    reason: "approval_required",
  });
  assert.match(input.body, /等待你的选择或回答/);
  assert.match(approval.body, /审批命令或文件修改/);
  assert.match(input.body, /阻止自动续跑/);
});

test("limits updates are clearly separated from reset alerts", () => {
  const update = notificationForEvent({
    type: "tibo_limits_update",
    text: "More compute has landed",
  });
  assert.match(update.title, /容量或额度信息/);
  assert.match(update.body, /不代表额度重置/);

  const reset = notificationForEvent({
    type: "tibo_preview",
    text: "Landing within two hours",
  });
  assert.match(reset.title, /重置信号/);
  assert.match(reset.body, /不代表你的账户已到账/);
});

test("source health notifications preserve the personal quota distinction", () => {
  const unhealthy = notificationForEvent({ type: "tibo_source_unhealthy" });
  assert.match(unhealthy.body, /个人额度监控仍继续/);
  const recovered = notificationForEvent({ type: "tibo_source_recovered" });
  assert.match(recovered.title, /已恢复/);
});

test("reset notifications explain ambiguity and later public correlation", () => {
  const first = notificationForEvent({
    type: "reset",
    previousRemainingPercent: 24,
    remainingPercent: 100,
  });
  assert.match(first.title, /24% → 100%/);
  assert.match(first.body, /普通 5 小时恢复还是公共重置/);
  assert.equal(first.interruptionLevel, "time-sensitive");
  assert.equal(first.persistent, true);

  const confirmed = notificationForEvent({
    type: "public_reset_landed",
    previousRemainingPercent: 24,
    remainingPercent: 100,
  });
  assert.match(confirmed.title, /刚才是 Codex 公共重置/);
  assert.match(confirmed.body, /无需使用重置卡/);
  assert.equal(confirmed.interruptionLevel, "time-sensitive");
  assert.equal(confirmed.persistent, true);
});

test("recovery and resume outcomes stay visible until the user dismisses them", () => {
  assert.equal(notificationForEvent({ type: "personal_landed", remainingPercent: 80 }).persistent, true);
  assert.equal(notificationForEvent({ type: "chat_continuity_resumed" }).persistent, true);
  assert.equal(
    notificationForEvent({ type: "chat_continuity_attention", reason: "workspace_unverifiable" }).persistent,
    true,
  );
});

test("strict reserve makes the ten-percent action explicit and persistent", () => {
  const threshold = notificationForEvent({
    type: "threshold",
    threshold: 10,
    remainingPercent: 9,
    resetsAt: 2_000_000_000,
    quotaPolicy: "strict_reserve",
  });
  assert.match(threshold.title, /10% 保护线/);
  assert.match(threshold.body, /拦截后续工具调用/);
  assert.match(threshold.body, /保存检查点/);
  assert.equal(threshold.interruptionLevel, "time-sensitive");

  const paused = notificationForEvent({ type: "chat_continuity_paused" });
  assert.match(paused.title, /安全暂停/);
  assert.match(paused.body, /个人额度恢复后只会续跑一次/);
  assert.equal(paused.interruptionLevel, "time-sensitive");
});
