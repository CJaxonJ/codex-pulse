const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function evaluateWeeklyPacing(summary, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const weekly = summary?.weekly;
  if (
    !weekly ||
    !Number.isFinite(weekly.usedPercent) ||
    !Number.isFinite(weekly.remainingPercent) ||
    !weekly.resetsAt
  ) {
    return null;
  }

  const secondsRemaining = Math.max(0, weekly.resetsAt - now);
  const elapsedSeconds = Math.max(0, WEEK - secondsRemaining);
  const elapsedDays = elapsedSeconds / DAY;
  const daysRemaining = secondsRemaining / DAY;
  const expectedUsedPercent = Math.min(100, (elapsedSeconds / WEEK) * 100);
  const observedDailyBurnPercent =
    elapsedDays >= 0.25 ? weekly.usedPercent / elapsedDays : null;
  const projectedUsedPercent =
    observedDailyBurnPercent == null
      ? weekly.usedPercent
      : Math.min(999, observedDailyBurnPercent * 7);
  const dailyBudgetPercent =
    daysRemaining > 0
      ? weekly.remainingPercent / Math.max(1, Math.ceil(daysRemaining))
      : 0;
  const overPacePercent = weekly.usedPercent - expectedUsedPercent;
  const confidence =
    elapsedDays >= 2 ? "high" : elapsedDays >= 0.5 ? "medium" : "low";

  let status = "on_track";
  if (weekly.remainingPercent <= 10) {
    status = "critical";
  } else if (elapsedDays < 0.25) {
    status = "establishing";
  } else if (overPacePercent >= 12 || projectedUsedPercent >= 115) {
    status = "at_risk";
  } else if (overPacePercent >= 5 || projectedUsedPercent >= 95) {
    status = "tight";
  }

  return {
    status,
    confidence,
    usedPercent: round(weekly.usedPercent),
    remainingPercent: round(weekly.remainingPercent),
    daysRemaining: round(daysRemaining),
    elapsedDays: round(elapsedDays),
    expectedUsedPercent: round(expectedUsedPercent),
    overPacePercent: round(overPacePercent),
    projectedUsedPercent: round(projectedUsedPercent),
    dailyBudgetPercent: round(dailyBudgetPercent),
    resetsAt: weekly.resetsAt,
  };
}

export function describeWeeklyPacing(pacing) {
  if (!pacing) return null;
  const days = Math.max(0.1, pacing.daysRemaining);
  const budget = Math.max(0, pacing.dailyBudgetPercent);
  if (pacing.status === "critical") {
    return `周额度只剩 ${Math.round(pacing.remainingPercent)}%，距离恢复约 ${days} 天。`;
  }
  if (pacing.status === "at_risk") {
    return `按目前节奏，周窗口可能用到约 ${Math.round(pacing.projectedUsedPercent)}%；接下来每天平均可用约 ${budget}% 周额度。`;
  }
  if (pacing.status === "tight") {
    return `周额度节奏偏紧，接下来每天平均可用约 ${budget}%，距离恢复约 ${days} 天。`;
  }
  if (pacing.status === "establishing") {
    return `本周窗口刚开始，样本还少；当前每天平均预算约 ${budget}% 周额度。`;
  }
  return `周额度节奏正常，接下来每天平均可用约 ${budget}%，距离恢复约 ${days} 天。`;
}
