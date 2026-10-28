const PUBLIC_EVENTS = new Set([
  "tibo_preview", "tibo_preview_expired", "tibo_confirmed", "tibo_limits_update", "public_reset_landed",
]);

export function isTiboPostEvent(event) {
  return PUBLIC_EVENTS.has(event?.type);
}

export function xPostUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)
      || url.username || url.password || url.port
      || !/^\/(?:[a-zA-Z0-9_]{1,15}|i)\/(?:status|web\/status)\/\d{1,25}\/?$/.test(url.pathname)) return null;
    return `https://x.com${url.pathname.replace(/\/$/, "")}`;
  } catch { return null; }
}

export function postUrlFromId(value) {
  return /^\d{1,25}$/.test(String(value || "")) ? `https://x.com/i/status/${value}` : null;
}

export function tiboPostSource(event) {
  if (!isTiboPostEvent(event)) return {};
  const sourceAt = Object.hasOwn(event, "sourceAt") ? event.sourceAt : event.occurredAt;
  return {
    isTiboPost: true,
    sourceUrl: xPostUrl(event.sourceUrl || event.url) || postUrlFromId(event.sourcePostId || event.id),
    parentUrl: xPostUrl(event.parentUrl),
    sourceText: String(event.sourceText || event.originalText || event.text || "").slice(0, 20_000),
    sourceTextKind: event.sourceTextKind === "summary" ? "summary" : "original",
    sourceAt: Number.isFinite(sourceAt) ? sourceAt : null,
  };
}
