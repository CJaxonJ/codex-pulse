import { classifyTiboPost, postText } from "./tibo-classifier.mjs";

const DEFAULT_BASE_URL = "https://api.x.com";
const DEFAULT_USERNAME = "thsottiaux";

function referencedPosts(post) {
  return post?.referenced_posts || post?.referenced_tweets || [];
}

function includedPosts(payload) {
  return payload?.includes?.posts || payload?.includes?.tweets || [];
}

function parentFor(post, parentById) {
  const parentRef = referencedPosts(post).find((item) => item.type === "replied_to");
  return parentRef ? parentById.get(String(parentRef.id)) || null : null;
}

async function fetchJson(fetchImpl, url, bearerToken, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
        "User-Agent": "CodexPulse/0.9.3 (+https://github.com/CJaxonJ/codex-pulse)",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const retryAfter = response.headers?.get?.("retry-after");
      const suffix = retryAfter ? `; retry after ${retryAfter}s` : "";
      throw new Error(`X API returned HTTP ${response.status}${suffix}`);
    }
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePost(post, parent, username) {
  const classification = classifyTiboPost(post, parent);
  return {
    id: String(post.id),
    url: `https://x.com/${username}/status/${post.id}`,
    text: postText(post),
    created_at: post.created_at,
    conversation_id: post.conversation_id || null,
    is_reply: Boolean(parent || post.in_reply_to_user_id),
    in_reply_to_tweet_id:
      referencedPosts(post).find((item) => item.type === "replied_to")?.id || null,
    kind: classification.kind,
    tibo_lane: classification.lane,
    explicit_reset_claim: classification.explicitResetClaim,
    reset_verification_status: classification.verificationStatus,
    classifier_version: "codex-pulse-rules-v1",
    classifier_confidence: classification.confidence,
    classifier_reason: classification.reason,
  };
}

export class TiboXApiClient {
  constructor(options = {}) {
    if (!options.bearerToken) throw new Error("X API bearer token is required");
    this.bearerToken = options.bearerToken;
    this.baseUrl = options.baseUrl || DEFAULT_BASE_URL;
    this.username = options.username || DEFAULT_USERNAME;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs || 10_000;
    this.user = null;
  }

  async resolveUser() {
    if (this.user) return this.user;
    const url = new URL(
      `/2/users/by/username/${encodeURIComponent(this.username)}`,
      this.baseUrl,
    );
    url.searchParams.set("user.fields", "id,username,name,public_metrics");
    const payload = await fetchJson(
      this.fetchImpl,
      url,
      this.bearerToken,
      this.timeoutMs,
    );
    if (!payload?.data?.id) throw new Error("X API user lookup returned no user id");
    this.user = payload.data;
    return this.user;
  }

  async readSnapshot(options = {}) {
    const user = await this.resolveUser();
    const url = new URL(`/2/users/${encodeURIComponent(user.id)}/tweets`, this.baseUrl);
    url.searchParams.set("max_results", "100");
    url.searchParams.set("exclude", "retweets");
    url.searchParams.set(
      "post.fields",
      "created_at,conversation_id,note_post,referenced_posts",
    );
    url.searchParams.set("expansions", "referenced_posts");
    if (/^\d{1,25}$/.test(options.sinceId || "")) {
      url.searchParams.set("since_id", options.sinceId);
    }

    const payload = await fetchJson(
      this.fetchImpl,
      url,
      this.bearerToken,
      this.timeoutMs,
    );
    const parentById = new Map(
      includedPosts(payload).map((post) => [String(post.id), post]),
    );
    const tweets = (payload.data || [])
      .map((post) => normalizePost(post, parentFor(post, parentById), this.username))
      .filter((post) => post.created_at)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const confirmed = tweets.find(
      (post) =>
        post.reset_verification_status === "confirmed" &&
        (post.kind === "reset" || post.kind === "banked"),
    );
    const preview = tweets.find(
      (post) =>
        post.reset_verification_status === "pending" &&
        ["signal", "banked"].includes(post.kind),
    );
    const fetchedAt = new Date().toISOString();

    return {
      source: "x-api",
      forecast: {
        last_reset_at: confirmed?.created_at || null,
        latest_alert: confirmed
          ? {
              id: confirmed.id,
              state: "confirmed",
              source_at: confirmed.created_at,
              summary: confirmed.text,
              url: confirmed.url,
              text: confirmed.text,
              in_reply_to_tweet_id: confirmed.in_reply_to_tweet_id,
            }
          : null,
        official_signal: preview
          ? {
              id: preview.id,
              source_at: preview.created_at,
              text: preview.text,
              url: preview.url,
              in_reply_to_tweet_id: preview.in_reply_to_tweet_id,
            }
          : null,
        teased_window: null,
      },
      feed: {
        version: 1,
        fetched_at: fetchedAt,
        source: "x-api",
        source_scope: "timeline",
        stale: false,
        newest_post_at: tweets[0]?.created_at || null,
        profile: {
          handle: user.username || this.username,
          name: user.name || "Tibo",
          followers: user.public_metrics?.followers_count ?? null,
        },
        tweets,
      },
    };
  }
}
