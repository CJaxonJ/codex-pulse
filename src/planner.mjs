import {
  describeWeeklyPacing,
  evaluateWeeklyPacing,
} from "./weekly-pacing.mjs";

const HOUR = 60 * 60;

function hoursUntil(timestamp, now) {
  if (!timestamp) return null;
  return Math.max(0, (timestamp - now) / HOUR);
}

function findWindows(snapshot) {
  const buckets = Object.values(snapshot.buckets || {});
  const windows = buckets.flatMap((bucket) =>
    [bucket.primary, bucket.secondary].filter(Boolean),
  );
  return {
    fiveHour: windows.find((window) => window.windowDurationMins === 300) || null,
    weekly: windows.find((window) => window.windowDurationMins === 10_080) || null,
  };
}

function projectWindow(window, now) {
  if (!window || window.usedPercent == null || !window.resetsAt) return null;
  const totalHours = window.windowDurationMins / 60;
  const remainingHours = hoursUntil(window.resetsAt, now);
  const elapsedHours = Math.max(0, totalHours - remainingHours);
  if (elapsedHours < 0.25) {
    return {
      remainingHours,
      projectedUsedPercent: window.usedPercent,
      confidence: "low",
    };
  }
  const hourlyBurn = window.usedPercent / elapsedHours;
  return {
    remainingHours,
    projectedUsedPercent: window.usedPercent + hourlyBurn * remainingHours,
    confidence: elapsedHours >= totalHours * 0.25 ? "medium" : "low",
  };
}

function expiringCredit(snapshot, now) {
  const credits = snapshot.resetCredits?.credits || [];
  return credits
    .filter((credit) => credit.status === "available" && credit.expiresAt)
    .map((credit) => ({ ...credit, hoursLeft: hoursUntil(credit.expiresAt, now) }))
    .sort((a, b) => a.hoursLeft - b.hoursLeft)[0] || null;
}

function plusRecommendation(snapshot, now) {
  const { fiveHour, weekly } = findWindows(snapshot);
  const fiveHourProjection = projectWindow(fiveHour, now);
  const weeklyProjection = projectWindow(weekly, now);
  const weeklyPacing = evaluateWeeklyPacing(
    {
      weekly: weekly
        ? {
            usedPercent: weekly.usedPercent,
            remainingPercent: Math.max(0, 100 - weekly.usedPercent),
            resetsAt: weekly.resetsAt,
          }
        : null,
    },
    { now },
  );

  if (fiveHour?.usedPercent >= 90 && fiveHourProjection?.remainingHours > 0.5) {
    return {
      state: "at_risk",
      priority: 90,
      title: "5 小时额度快见底了",
      action: "把低价值任务切到更省额度的模型，重要任务缩小范围后再跑。",
      reason: `已使用 ${Math.round(fiveHour.usedPercent)}%，距离恢复约 ${Math.ceil(fiveHourProjection.remainingHours)} 小时。`,
    };
  }

  if (
    weeklyPacing?.status === "at_risk" ||
    weeklyProjection?.projectedUsedPercent >= 100
  ) {
    return {
      state: "at_risk",
      priority: 80,
      title: "按当前速度，周额度可能提前耗尽",
      action: "先保留高价值任务，减少无关上下文，并把批量试错切到更省额度的模型。",
      reason:
        describeWeeklyPacing(weeklyPacing) ||
        `预计自然刷新前会用到约 ${Math.round(weeklyProjection.projectedUsedPercent)}%。`,
    };
  }

  return {
    state: "healthy",
    priority: 20,
    title: "当前额度够用",
    action: "可以继续工作，暂时不需要动用重置卡。",
    reason: weekly
      ? `周额度已使用 ${Math.round(weekly.usedPercent)}%。`
      : "暂未发现周额度风险。",
  };
}

function proRecommendation(snapshot, now) {
  const { weekly } = findWindows(snapshot);
  const weeklyProjection = projectWindow(weekly, now);
  const weeklyPacing = evaluateWeeklyPacing(
    {
      weekly: weekly
        ? {
            usedPercent: weekly.usedPercent,
            remainingPercent: Math.max(0, 100 - weekly.usedPercent),
            resetsAt: weekly.resetsAt,
          }
        : null,
    },
    { now },
  );

  if (
    weeklyPacing?.status === "at_risk" ||
    weeklyProjection?.projectedUsedPercent >= 100
  ) {
    return {
      state: "at_risk",
      priority: 80,
      title: "Pro 也可能在周窗口内跑满",
      action: "检查是否把 Fast/Ultrafast 用在了非紧急任务，并收窄长任务的上下文。",
      reason:
        describeWeeklyPacing(weeklyPacing) ||
        `按近期速度，预计自然刷新前会用到约 ${Math.round(weeklyProjection.projectedUsedPercent)}%。`,
    };
  }

  return {
    state: "healthy",
    priority: 20,
    title: "Pro 当前不缺短窗口额度",
    action: "重点优化模型与速度档位，把高倍率模式留给真正卡时间的任务。",
    reason: weekly
      ? `周额度已使用 ${Math.round(weekly.usedPercent)}%。`
      : "当前没有可评估的周窗口。",
  };
}

export function planQuota(snapshot, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const planType = (snapshot.planType || "unknown").toLowerCase();
  const base = planType.includes("pro")
    ? proRecommendation(snapshot, now)
    : plusRecommendation(snapshot, now);
  const credit = expiringCredit(snapshot, now);

  if (credit && credit.hoursLeft <= 24) {
    return {
      state: "credit_expiring",
      priority: 100,
      title: "有一张重置卡将在 24 小时内过期",
      action:
        base.state === "at_risk"
          ? "当前额度也有耗尽风险，安排在高价值任务开始前使用。"
          : "先安排一批真正需要额度的任务，再在到期前使用，避免白白作废。",
      reason: `剩余约 ${Math.max(1, Math.ceil(credit.hoursLeft))} 小时；${base.reason}`,
      underlying: base,
    };
  }

  if (credit && credit.hoursLeft <= 72) {
    return {
      ...base,
      reminder: `最近一张重置卡约 ${Math.ceil(credit.hoursLeft)} 小时后过期。`,
    };
  }

  return base;
}
