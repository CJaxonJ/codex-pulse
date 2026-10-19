const HOUR = 60 * 60;
const PREVIEW_MAX_AGE_SECONDS = 24 * HOUR;
const PERSONAL_LANDING_MAX_AGE_SECONDS = 12 * HOUR;
const SOURCE_STALE_SECONDS = 30 * 60;
const SOURCE_FAILURE_THRESHOLD = 15;
const STRONG_SIGNAL_KINDS = new Set(["signal", "reset", "banked"]);
const OPERATIONAL_UPDATE_KINDS = new Set(["limits", "boost"]);

function unixSeconds(value) {
  if (value == null) return null;
  if (typeof value === "number") {
    return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function firstText(...values) {
  return values.find((value) => typeof value === "string" && value.trim())?.trim() || null;
}

function normalizeOfficialSignal(signal) {
  if (!signal) return null;
  if (typeof signal === "string") {
    return { id: `official:${signal}`, text: signal, occurredAt: null, url: null };
  }
  const id = signal.id || signal.tweet_id || signal.event_id;
  const text = firstText(signal.text, signal.summary, signal.message, signal.quote);
  const occurredAt = unixSeconds(
    signal.source_at || signal.created_at || signal.tweeted_at || signal.at,
  );
  if (!id && !text) return null;
  return {
    id: String(id || `official:${occurredAt || text}`),
    text,
    occurredAt,
    url: signal.url || signal.source_url || null,
  };
}

function normalizeFeedTweet(tweet) {
  const occurredAt = unixSeconds(
    tweet.source_at || tweet.created_at || tweet.tweeted_at || tweet.at || tweet.timestamp,
  );
  return {
    id: String(tweet.id || tweet.tweet_id || `${occurredAt}:${tweet.text}`),
    text: firstText(tweet.text, tweet.summary),
    occurredAt,
    url: tweet.url || (tweet.id ? `https://x.com/thsottiaux/status/${tweet.id}` : null),
    kind: tweet.kind || null,
    lane: tweet.tibo_lane || null,
    explicitResetClaim: tweet.explicit_reset_claim === true,
    isReply: tweet.is_reply === true,
    verificationStatus: tweet.reset_verification_status || null,
  };
}

export function normalizeTiboSnapshot(raw, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const forecast = raw?.forecast || {};
  const feed = raw?.feed || {};
  const lastResetAt = unixSeconds(forecast.last_reset_at);
  const latestAlert = forecast.latest_alert || null;
  const posts = (feed.tweets || [])
    .map(normalizeFeedTweet)
    .filter((tweet) => tweet.occurredAt != null)
    .sort((a, b) => b.occurredAt - a.occurredAt);
  const forecastConfirmed = lastResetAt
    ? {
        key: String(latestAlert?.id || `reset:${lastResetAt}`),
        occurredAt: lastResetAt,
        text: firstText(latestAlert?.summary, latestAlert?.text),
        url: latestAlert?.url || null,
      }
    : null;
  const confirmedPost = posts.find(
    (post) =>
      post.verificationStatus === "confirmed" &&
      (post.kind === "reset" || post.kind === "banked"),
  );
  const feedConfirmed = confirmedPost
    ? {
        key: confirmedPost.id,
        occurredAt: confirmedPost.occurredAt,
        text: confirmedPost.text,
        url: confirmedPost.url,
      }
    : null;
  const confirmed = [forecastConfirmed, feedConfirmed]
    .filter(Boolean)
    .sort((a, b) => b.occurredAt - a.occurredAt)[0] || null;

  const candidates = [];
  const official = normalizeOfficialSignal(forecast.official_signal);
  if (official) candidates.push(official);

  if (latestAlert && latestAlert.state && latestAlert.state !== "confirmed") {
    candidates.push({
      id: String(latestAlert.id || `alert:${latestAlert.source_at}`),
      text: firstText(latestAlert.summary, latestAlert.text),
      occurredAt: unixSeconds(latestAlert.source_at || latestAlert.created_at),
      url: latestAlert.url || null,
    });
  }

  for (const normalized of posts) {
    const isPreview =
      (STRONG_SIGNAL_KINDS.has(normalized.kind) || normalized.explicitResetClaim) &&
      normalized.verificationStatus !== "confirmed";
    if (isPreview) candidates.push(normalized);
  }

  const preview = candidates
    .filter((candidate) => candidate.occurredAt != null)
    .filter((candidate) => now - candidate.occurredAt <= PREVIEW_MAX_AGE_SECONDS)
    .filter(
      (candidate) =>
        !confirmed?.occurredAt || candidate.occurredAt > confirmed.occurredAt,
    )
    .sort((a, b) => b.occurredAt - a.occurredAt)[0] || null;
  const sourceFetchedAt = unixSeconds(feed.fetched_at);
  const sourceAgeSeconds = sourceFetchedAt == null ? null : Math.max(0, now - sourceFetchedAt);
  const sourceStatus =
    feed.stale === true ||
    (sourceAgeSeconds != null && sourceAgeSeconds > SOURCE_STALE_SECONDS)
      ? "unhealthy"
      : sourceFetchedAt != null
        ? "healthy"
        : "unknown";

  return {
    fetchedAt: now,
    preview,
    confirmed,
    latestPost: posts[0] || null,
    operationalUpdates: posts.filter((post) =>
      OPERATIONAL_UPDATE_KINDS.has(post.kind),
    ),
    sourceHealth: {
      status: sourceStatus,
      fetchedAt: sourceFetchedAt,
      stale: feed.stale === true,
      contentAgeDays: Number.isFinite(feed.content_age_days)
        ? feed.content_age_days
        : null,
      newestPostAt: unixSeconds(feed.newest_post_at) || posts[0]?.occurredAt || null,
    },
    teasedWindow: forecast.teased_window || null,
    source: raw?.source || feed.source || "unknown",
    degradedComponents: Array.isArray(raw?.degradedComponents)
      ? raw.degradedComponents
      : [],
  };
}

export function evaluateTiboSnapshot(previousState, snapshot, options = {}) {
  const now = options.now ?? snapshot.fetchedAt ?? Math.floor(Date.now() / 1000);
  const previous = previousState || null;
  if (!previous?.initializedAt) {
    return {
      state: {
        initializedAt: now,
        lastCheckedAt: now,
        lastPreviewId: snapshot.preview?.id || null,
        lastConfirmedKey: snapshot.confirmed?.key || null,
        lastConfirmedAt: snapshot.confirmed?.occurredAt || null,
        pendingPublicReset: null,
        seenTweetIds: snapshot.latestPost
          ? snapshot.operationalUpdates.map((tweet) => tweet.id).slice(0, 100)
          : [],
        lastSeenTweetId: snapshot.latestPost?.id || null,
        lastSeenTweetAt: snapshot.latestPost?.occurredAt || null,
        sourceHealthStatus: snapshot.sourceHealth?.status || "unknown",
        sourceFetchedAt: snapshot.sourceHealth?.fetchedAt || null,
        source: snapshot.source || null,
        consecutiveSourceFailures: 0,
      },
      events:
        snapshot.sourceHealth?.status === "unhealthy"
          ? [{ type: "tibo_source_unhealthy", reason: "stale_feed", source: snapshot.source }]
          : [],
    };
  }

  const events = [];
  const previousSeenTweetIds = new Set(previous.seenTweetIds || []);
  const newOperationalUpdates = snapshot.operationalUpdates.filter(
    (tweet) => !previousSeenTweetIds.has(tweet.id),
  );
  const newestOperationalUpdate = newOperationalUpdates[0] || null;
  if (newestOperationalUpdate) {
    events.push({
      type: "tibo_limits_update",
      source: snapshot.source,
      ...newestOperationalUpdate,
    });
  }

  const sourceHealthStatus = snapshot.sourceHealth?.status || "unknown";
  if (
    sourceHealthStatus === "unhealthy" &&
    previous.sourceHealthStatus !== "unhealthy"
  ) {
    events.push({
      type: "tibo_source_unhealthy",
      reason: "stale_feed",
      source: snapshot.source,
    });
  } else if (
    sourceHealthStatus === "healthy" &&
    previous.sourceHealthStatus === "unhealthy"
  ) {
    events.push({ type: "tibo_source_recovered", source: snapshot.source });
  }
  let pendingPublicReset = previous.pendingPublicReset || null;
  if (
    pendingPublicReset &&
    now - pendingPublicReset.confirmedAt > PERSONAL_LANDING_MAX_AGE_SECONDS
  ) {
    pendingPublicReset = null;
  }

  if (snapshot.preview && snapshot.preview.id !== previous.lastPreviewId) {
    events.push({
      type: "tibo_preview",
      source: snapshot.source,
      ...snapshot.preview,
      teasedWindow: snapshot.teasedWindow,
    });
  }

  const isNewConfirmation =
    snapshot.confirmed &&
    snapshot.confirmed.key !== previous.lastConfirmedKey &&
    (previous.lastConfirmedAt == null ||
      snapshot.confirmed.occurredAt > previous.lastConfirmedAt);
  if (isNewConfirmation) {
    const event = {
      type: "tibo_confirmed",
      source: snapshot.source,
      ...snapshot.confirmed,
    };
    events.push(event);
    pendingPublicReset = {
      key: snapshot.confirmed.key,
      confirmedAt: snapshot.confirmed.occurredAt,
    };
  }

  return {
    state: {
      initializedAt: previous.initializedAt,
      lastCheckedAt: now,
      lastPreviewId: snapshot.preview?.id || previous.lastPreviewId || null,
      lastConfirmedKey: snapshot.confirmed?.key || previous.lastConfirmedKey || null,
      lastConfirmedAt: snapshot.confirmed?.occurredAt || previous.lastConfirmedAt || null,
      pendingPublicReset,
      seenTweetIds: [
        ...new Set([
          ...snapshot.operationalUpdates.map((tweet) => tweet.id),
          ...(previous.seenTweetIds || []),
        ]),
      ].slice(0, 100),
      lastSeenTweetId: snapshot.latestPost?.id || previous.lastSeenTweetId || null,
      lastSeenTweetAt: snapshot.latestPost?.occurredAt || previous.lastSeenTweetAt || null,
      sourceHealthStatus,
      sourceFetchedAt: snapshot.sourceHealth?.fetchedAt || previous.sourceFetchedAt || null,
      source: snapshot.source || previous.source || null,
      consecutiveSourceFailures: 0,
    },
    events,
  };
}

export function evaluateTiboFetchFailure(previousState, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const previous = previousState || {};
  const failures = (previous.consecutiveSourceFailures || 0) + 1;
  const becameUnhealthy =
    failures >= SOURCE_FAILURE_THRESHOLD && previous.sourceHealthStatus !== "unhealthy";
  return {
    state: {
      ...previous,
      lastCheckedAt: now,
      lastSourceFailureAt: now,
      consecutiveSourceFailures: failures,
      sourceHealthStatus: becameUnhealthy ? "unhealthy" : previous.sourceHealthStatus,
    },
    events: becameUnhealthy
      ? [
          {
            type: "tibo_source_unhealthy",
            reason: "consecutive_failures",
            failures,
            source: previous.source || null,
          },
        ]
      : [],
  };
}

export function attachPersonalLanding(quotaEvents, tiboState, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const pending = tiboState?.pendingPublicReset;
  if (!pending || now - pending.confirmedAt > PERSONAL_LANDING_MAX_AGE_SECONDS) {
    return { events: quotaEvents, tiboState };
  }
  let landed = false;
  const events = quotaEvents.map((event) => {
    if (!landed && event.type === "reset") {
      landed = true;
      return { ...event, type: "personal_landed", publicResetAt: pending.confirmedAt };
    }
    return event;
  });
  return {
    events,
    tiboState: landed ? { ...tiboState, pendingPublicReset: null } : tiboState,
  };
}
