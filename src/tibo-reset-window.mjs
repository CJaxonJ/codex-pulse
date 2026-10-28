const DAY = 86400;

function timestamp(value) {
  if (typeof value === "number") {
    const seconds = value > 1e10 ? value / 1000 : value;
    return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null;
  }
  // Never interpret an upstream date in the machine's local timezone.
  if (typeof value !== "string" || !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
  const seconds = Date.parse(value) / 1000;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function resolveTiboWindow(signal) {
  if (!signal || !Number.isFinite(signal.occurredAt)) return null;
  const window = signal.window;
  if (window != null) {
    if (typeof window !== "object") return null;
    const kind = window.target_kind || (window.target_at ? "at" : "range");
    if (!["deadline", "at", "range", "window"].includes(kind)) return null;
    const target = timestamp(window.target_at);
    const start = timestamp(window.start_at);
    const end = timestamp(window.end_at);
    const endAt = kind === "deadline" || kind === "at" ? target ?? end : end;
    if (endAt == null || endAt < signal.occurredAt || endAt > signal.occurredAt + 31 * DAY
      || (start != null && start > endAt)
      || ((kind === "range" || kind === "window") && start == null)) return null;
    let offsetMinutes = null;
    if (window.time_zone) {
      try {
        const offset = new Intl.DateTimeFormat("en", {
          timeZone: window.time_zone, timeZoneName: "shortOffset",
        }).formatToParts(new Date(endAt * 1000)).find((part) => part.type === "timeZoneName")?.value;
        const match = offset?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
        offsetMinutes = match ? (match[1] === "+" ? 1 : -1) * (+match[2] * 60 + +(match[3] || 0)) : 0;
      } catch { return null; }
    }
    let alternateAt = null;
    const literal = signal.text?.match(/\b(PST|PDT)\b/i)?.[1]?.toUpperCase();
    if (kind === "deadline" && literal && window.time_zone === "America/Los_Angeles") {
      const literalOffset = literal === "PST" ? -480 : -420;
      if (literalOffset !== offsetMinutes) alternateAt = endAt + (offsetMinutes - literalOffset) * 60;
    }
    return {
      kind: kind === "window" ? "range" : kind,
      startAt: kind === "range" || kind === "window" ? start : null,
      endAt, alternateAt,
      expiresAt: Math.max(endAt, alternateAt ?? endAt),
      basis: "public_window",
    };
  }
  // Only unambiguous durations, anchored to the post rather than each fetch.
  const duration = signal.text?.match(/\bwithin\s+(?:(?:the\s+)?next\s+)?(\d+(?:\.\d+)?|one|two|three|four|six|twelve|twenty-four)\s*(hours?|hrs?|minutes?|mins?)\b/i);
  if (!duration) return null;
  const words = { one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12, "twenty-four": 24 };
  const amount = words[duration[1].toLowerCase()] ?? Number(duration[1]);
  const seconds = amount * (/^(?:hour|hr)/i.test(duration[2]) ? 3600 : 60);
  if (!(seconds > 0 && seconds <= 31 * DAY)) return null;
  const endAt = signal.occurredAt + seconds;
  return { kind: "deadline", startAt: null, endAt, alternateAt: null, expiresAt: endAt, basis: "post_relative" };
}

export function tiboWindowKey(window) {
  return window ? JSON.stringify([window.kind, window.startAt, window.endAt, window.alternateAt]) : null;
}

function beijingTime(seconds) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(seconds * 1000));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
}

export function describeTiboWindow(window) {
  if (!window) return { title: "具体时间未定", detail: "原帖没有可可靠换算的时间，请勿当作倒计时。" };
  const end = beijingTime(window.endAt);
  if (window.alternateAt != null) {
    return {
      title: `北京时间 ${end} 或 ${beijingTime(window.alternateAt)} 前`,
      detail: "原帖 PST/PDT 表述与公共数据源的时区换算不一致，以上是两种截止时间解释，不是到账区间；也可能提前。",
    };
  }
  if (window.kind === "range") return {
    title: `北京时间 ${beijingTime(window.startAt)} 至 ${end}`,
    detail: "这是预告时间窗口，不保证按时发生。",
  };
  return {
    title: `北京时间 ${end}${window.kind === "deadline" ? " 前" : " 左右"}`,
    detail: window.kind === "deadline" ? "这是预告截止时间，也可能提前。" : "这是预告时间，不保证准点发生。",
  };
}
