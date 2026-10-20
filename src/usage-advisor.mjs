import {
  describeWeeklyPacing,
  evaluateWeeklyPacing,
} from "./weekly-pacing.mjs";

const DEFAULT_TASK_COST = {
  small: 8,
  medium: 20,
  large: 40,
};

const VALID_SIZES = new Set(Object.keys(DEFAULT_TASK_COST));
const VALID_PRIORITIES = new Set(["low", "normal", "high"]);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function learnedCosts(tasks, observations, { taskSize, model }) {
  const managedCosts = tasks
    .filter((task) => task.taskSize === taskSize)
    .flatMap((task) => task.usageSegments || [])
    .filter(
      (segment) =>
        Number.isFinite(segment.consumedPercent) &&
        segment.consumedPercent >= 0 &&
        (!model || !segment.model || segment.model === model),
    )
    .map((segment) => segment.consumedPercent);
  const observedCosts = observations
    .filter(
      (observation) =>
        observation.taskSize === taskSize &&
        Number.isFinite(observation.consumedPercent) &&
        observation.consumedPercent >= 0 &&
        (!model || !observation.model || observation.model === model),
    )
    .map((observation) => observation.consumedPercent);
  return [...managedCosts, ...observedCosts];
}

function confidenceFor(sampleCount) {
  if (sampleCount >= 5) return "high";
  if (sampleCount >= 2) return "medium";
  return "low";
}

function minutesUntil(timestamp, now) {
  if (!timestamp) return null;
  return Math.max(0, Math.round((timestamp - now) / 60));
}

export function adviseTaskStart(input, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const taskSize = input.taskSize || "medium";
  const priority = input.priority || "normal";
  if (!VALID_SIZES.has(taskSize)) throw new Error(`Unknown task size: ${taskSize}`);
  if (!VALID_PRIORITIES.has(priority)) throw new Error(`Unknown priority: ${priority}`);

  const summary = input.summary || {};
  const tasks = input.tasks || [];
  const observations = input.observations || [];
  const samples = learnedCosts(tasks, observations, {
    taskSize,
    model: input.model,
  });
  const learnedMedian = median(samples);
  const estimatedCostPercent = Math.max(
    2,
    Math.round(learnedMedian ?? DEFAULT_TASK_COST[taskSize]),
  );
  const safetyReservePercent = priority === "high" ? 5 : 10;
  // Managed tasks enter drain mode at 15%, so admitting new work at or below
  // that boundary would immediately contradict the recommendation.
  const recommendedStartFloor = Math.min(
    95,
    Math.max(20, estimatedCostPercent + safetyReservePercent),
  );
  const remaining = summary.fiveHour?.remainingPercent ?? null;
  const weeklyRemaining = summary.weekly?.remainingPercent ?? null;
  const weeklyPacing = evaluateWeeklyPacing(summary, { now });
  const weeklyReason = describeWeeklyPacing(weeklyPacing);
  const weeklyCaution =
    weeklyRemaining != null &&
    (weeklyRemaining <= 10 || weeklyPacing?.status === "at_risk");
  const weeklyAction =
    weeklyRemaining != null && weeklyRemaining <= 10
      ? "周额度已进入最后 10%。这是节奏提醒，不会阻止你明确发起的任务；先完成当前可验收结果，再决定是否扩展。"
      : weeklyPacing?.status === "at_risk"
        ? `周消耗速度偏快。任务仍会继续，但建议今天把新增工作控制在约 ${weeklyPacing.dailyBudgetPercent}% 周额度内。`
        : null;
  const resetInMinutes = minutesUntil(summary.fiveHour?.resetsAt, now);
  const confidence = confidenceFor(samples.length);
  const basis = samples.length
    ? `参考 ${samples.length} 个同类托管任务，中位消耗约 ${estimatedCostPercent}%`
    : `暂无同类历史，暂按${taskSize === "small" ? "小" : taskSize === "large" ? "大" : "中等"}任务保守估算 ${estimatedCostPercent}%`;

  // Weekly pacing is advisory. Only the personal short-window hard floor may
  // stop an explicitly submitted task.
  if (remaining == null) {
    return {
      verdict: weeklyCaution ? "start_bounded" : "start_now",
      confidence,
      taskSize,
      priority,
      estimatedCostPercent,
      safetyReservePercent,
      recommendedStartFloor: 0,
      weeklyPacing,
      title: weeklyCaution ? "可以继续，留意周额度" : "可以开始",
      action:
        weeklyAction || (weeklyPacing?.status === "tight"
          ? "可以开始，但周额度节奏偏紧；先完成一个可验收结果，再决定是否扩展。"
          : "当前没有可用的 5 小时窗口约束；继续关注周额度与任务范围。"),
      reason: weeklyReason ? `${basis}；${weeklyReason}` : basis,
    };
  }

  if (remaining >= recommendedStartFloor) {
    return {
      verdict: weeklyCaution ? "start_bounded" : "start_now",
      confidence,
      taskSize,
      priority,
      estimatedCostPercent,
      safetyReservePercent,
      recommendedStartFloor,
      weeklyPacing,
      title: weeklyCaution ? "可以继续，留意周额度" : "现在可以开工",
      action:
        weeklyAction ||
        `按当前估算，完成后至少保留 ${safetyReservePercent}% 安全余量。`,
      reason: `${basis}；当前 5 小时额度剩余 ${Math.round(remaining)}%。${weeklyReason ? ` ${weeklyReason}` : ""}`,
    };
  }

  const expiringSoon = (summary.resetCredits?.expiries || []).some(
    (expiresAt) => expiresAt > now && expiresAt - now <= 24 * 60 * 60,
  );
  if (
    priority === "high" &&
    summary.resetCredits?.availableCount > 0 &&
    expiringSoon &&
    remaining <= 20
  ) {
    return {
      verdict: "consider_reset",
      confidence,
      taskSize,
      priority,
      estimatedCostPercent,
      safetyReservePercent,
      recommendedStartFloor,
      weeklyPacing,
      title: "高优先级任务可以考虑使用重置卡",
      action: "先确认这项任务确实要现在完成，再由你手动确认重置；Pulse 不会自动消耗重置卡。",
      reason: `${basis}；当前只剩 ${Math.round(remaining)}%，且有重置卡将在 24 小时内到期。`,
    };
  }

  if (priority !== "high" && resetInMinutes != null && resetInMinutes <= 90) {
    return {
      verdict: "wait_for_reset",
      confidence,
      taskSize,
      priority,
      estimatedCostPercent,
      safetyReservePercent,
      recommendedStartFloor,
      weeklyPacing,
      title: "等这轮额度恢复更划算",
      action: `约 ${Math.max(1, resetInMinutes)} 分钟后再启动，当前可先整理需求、测试范围或验收标准。`,
      reason: `${basis}；建议至少剩余 ${recommendedStartFloor}% 时启动，当前为 ${Math.round(remaining)}%。`,
    };
  }

  return {
    verdict: "scope_down",
    confidence,
    taskSize,
    priority,
    estimatedCostPercent,
    safetyReservePercent,
    recommendedStartFloor,
    weeklyPacing,
    title: "可以做，但先缩小这一轮",
    action:
      taskSize === "small"
        ? "只完成一个可验收结果，关闭并行探索和非必要重构。"
        : "把任务拆成一个小步骤，只跑必要检查；剩余部分排到额度恢复后。",
    reason: `${basis}；建议起步额度 ${recommendedStartFloor}%，当前为 ${Math.round(remaining)}%。`,
  };
}

export const TASK_SIZES = [...VALID_SIZES];
export const TASK_PRIORITIES = [...VALID_PRIORITIES];
