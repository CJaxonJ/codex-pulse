const MINUTE = 60;

export const DEFAULT_CONFIG = {
  thresholds: [20, 10, 5],
  forecastTargetRemaining: 10,
  forecastWithinMinutes: 15,
  sampleWindowMinutes: 15,
};

export const DEFAULT_CREDIT_EXPIRY_THRESHOLDS = [24, 6, 1];

export function summarizeRateLimits(result) {
  const buckets = result.rateLimitsByLimitId || {};
  const planType =
    result.planType ||
    result.rateLimits?.planType ||
    Object.values(buckets).find((bucket) => bucket?.planType)?.planType ||
    null;
  const windows = Object.values(buckets).flatMap((bucket) =>
    [bucket?.primary, bucket?.secondary].filter(Boolean),
  );
  const fiveHour = windows.find((window) => window.windowDurationMins === 300) || null;
  const weekly = windows.find((window) => window.windowDurationMins === 10_080) || null;

  return {
    planType,
    fiveHour: fiveHour
      ? {
          usedPercent: fiveHour.usedPercent,
          remainingPercent: Math.max(0, 100 - fiveHour.usedPercent),
          resetsAt: fiveHour.resetsAt,
        }
      : null,
    weekly: weekly
      ? {
          usedPercent: weekly.usedPercent,
          remainingPercent: Math.max(0, 100 - weekly.usedPercent),
          resetsAt: weekly.resetsAt,
        }
      : null,
    resetCredits: {
      availableCount: result.rateLimitResetCredits?.availableCount ?? 0,
      expiries:
        result.rateLimitResetCredits?.credits
          ?.filter((credit) => credit.status === "available")
          .map((credit) => credit.expiresAt)
          .filter(Boolean)
          .sort((a, b) => a - b) ?? [],
    },
  };
}

function closestCrossedThreshold(previousRemaining, currentRemaining, thresholds) {
  const descending = [...thresholds].sort((a, b) => b - a);
  const crossed = descending.filter(
    (threshold) => previousRemaining > threshold && currentRemaining <= threshold,
  );
  return crossed.length ? Math.min(...crossed) : null;
}

function startupThreshold(currentRemaining, thresholds) {
  const eligible = thresholds.filter((threshold) => currentRemaining <= threshold);
  return eligible.length ? Math.min(...eligible) : null;
}

function estimateMinutesToTarget(samples, targetRemaining, sampleWindowMinutes) {
  if (samples.length < 2) return null;
  const latest = samples.at(-1);
  const cutoff = latest.at - sampleWindowMinutes * MINUTE;
  const earliest = samples.find((sample) => sample.at >= cutoff) || samples[0];
  const elapsedMinutes = (latest.at - earliest.at) / MINUTE;
  const consumed = earliest.remainingPercent - latest.remainingPercent;
  if (elapsedMinutes < 1 || consumed <= 0) return null;
  const burnPerMinute = consumed / elapsedMinutes;
  if (burnPerMinute < 0.05 || latest.remainingPercent <= targetRemaining) return null;
  return (latest.remainingPercent - targetRemaining) / burnPerMinute;
}

export function evaluateFiveHourSample(previousState, summary, options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const window = summary.fiveHour;
  if (!window) {
    return {
      state: { ...previousState, lastCheckedAt: now },
      events: [],
    };
  }

  const previous = previousState || {};
  const isNewWindow = previous.windowKey && previous.windowKey !== window.resetsAt;
  const notifiedThresholds = isNewWindow ? [] : [...(previous.notifiedThresholds || [])];
  const samples = isNewWindow ? [] : [...(previous.samples || [])];
  samples.push({ at: now, remainingPercent: window.remainingPercent });
  const trimmedSamples = samples.filter(
    (sample) => sample.at >= now - Math.max(config.sampleWindowMinutes, 30) * MINUTE,
  );
  const events = [];

  if (
    previous.lastRemainingPercent != null &&
    window.remainingPercent >= previous.lastRemainingPercent + 30
  ) {
    events.push({
      type: "reset",
      previousRemainingPercent: previous.lastRemainingPercent,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt,
      detectedAt: now,
    });
  }

  const detectedReset = events.find((event) => event.type === "reset") || null;

  const crossed =
    previous.lastRemainingPercent == null
      ? startupThreshold(window.remainingPercent, config.thresholds)
      : closestCrossedThreshold(
          previous.lastRemainingPercent,
          window.remainingPercent,
          config.thresholds,
        );
  if (crossed != null && !notifiedThresholds.includes(crossed)) {
    notifiedThresholds.push(crossed);
    events.push({
      type: "threshold",
      threshold: crossed,
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt,
    });
  }

  const minutesToTarget = estimateMinutesToTarget(
    trimmedSamples,
    config.forecastTargetRemaining,
    config.sampleWindowMinutes,
  );
  const forecastAlreadySent = isNewWindow ? false : Boolean(previous.forecastAlreadySent);
  let nextForecastAlreadySent = forecastAlreadySent;
  if (
    !forecastAlreadySent &&
    minutesToTarget != null &&
    minutesToTarget <= config.forecastWithinMinutes
  ) {
    nextForecastAlreadySent = true;
    events.push({
      type: "forecast",
      targetRemaining: config.forecastTargetRemaining,
      minutesToTarget: Math.max(1, Math.ceil(minutesToTarget)),
      remainingPercent: window.remainingPercent,
      resetsAt: window.resetsAt,
    });
  }

  return {
    state: {
      windowKey: window.resetsAt,
      lastCheckedAt: now,
      lastRemainingPercent: window.remainingPercent,
      notifiedThresholds,
      forecastAlreadySent: nextForecastAlreadySent,
      samples: trimmedSamples,
      lastDetectedReset: detectedReset
        ? {
            detectedAt: detectedReset.detectedAt,
            previousRemainingPercent: detectedReset.previousRemainingPercent,
            remainingPercent: detectedReset.remainingPercent,
            resetsAt: detectedReset.resetsAt,
          }
        : previous.lastDetectedReset || null,
    },
    events,
  };
}

export function evaluateResetCredits(previousState, summary, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const thresholds = options.thresholds || DEFAULT_CREDIT_EXPIRY_THRESHOLDS;
  const previous = previousState || {};
  const previousNotified = previous.notified || {};
  const notified = {};
  const events = [];

  for (const expiresAt of summary.resetCredits?.expiries || []) {
    const key = String(expiresAt);
    const hoursRemaining = (expiresAt - now) / 3600;
    if (hoursRemaining <= 0) continue;
    const alreadySent = [...(previousNotified[key] || [])];
    const eligible = thresholds.filter((threshold) => hoursRemaining <= threshold);
    const nextThreshold = eligible.length ? Math.min(...eligible) : null;
    if (nextThreshold != null && !alreadySent.includes(nextThreshold)) {
      alreadySent.push(nextThreshold);
      events.push({
        type: "credit_expiring",
        thresholdHours: nextThreshold,
        hoursRemaining,
        expiresAt,
      });
    }
    notified[key] = alreadySent;
  }

  return {
    state: { lastCheckedAt: now, notified },
    events,
  };
}
