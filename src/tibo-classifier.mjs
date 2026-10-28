const RESET_CONTEXT =
  /\b(?:codex|rate|usage|weekly|five[- ]hour|5[- ]hour)?\s*(?:limit|limits|quota|quotas|reset|resets|credit|credits)\b/i;
const BANKED_RESET =
  /\b(?:banked\s+reset|reset\s+credit|reset\s+credits|banked\s+credit|banked\s+credits)\b/i;
const DIRECT_CONFIRMATION = [
  /\b(?:we|i)(?:'ve| have)?\s+reset\b[^.\n]{0,80}\b(?:codex|rate|usage|limit|limits|quota|quotas|everyone|accounts?)\b/i,
  /\b(?:rate|usage|codex)\s+(?:limit|limits|quota|quotas)\s+(?:have\s+been\s+|were\s+|are\s+)?reset\b/i,
  /\breset\s+button\s+(?:pressed|hit)\b/i,
  /\b(?:reset|limits?|quota)\b[^.\n]{0,80}\b(?:is|are|has|have|was|were)?\s*(?:done|completed|confirmed|live)\b/i,
];
const CONTEXTUAL_CONFIRMATION =
  /^\s*(?:done(?:\s+and\s+dusted)?|done!|completed|landed|shipped|all set|it'?s done)\s*[.!]?\s*$/i;
const PREVIEW = [
  /\b(?:will|we(?:'ll| will)|going to)\b[^.\n]{0,80}\breset(?:ting)?\b/i,
  /\breset(?:ting)?\b[^.\n]{0,80}\b(?:soon|later|today|tomorrow|tonight|within|in a bit|by eod|on (?:the|its) way|coming)\b/i,
  /\b(?:landing|arriving)\b[^.\n]{0,80}\b(?:soon|today|tonight|tomorrow|within|next|by eod)\b/i,
  /\blands?\s+by\s+(?:midnight|noon|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i,
];
const LIMIT_UPDATE =
  /\b(?:more\s+compute|capacity|usage\s+(?:limit|limits|quota|quotas)|rate\s+(?:limit|limits)|limit\s+increase|limits\s+increase|increase(?:d|s|ing)?\s+(?:the\s+)?(?:limit|limits|quota|quotas)|\d+x\s+more\s+usage|credits?\s+refunded)\b/i;
const BOOST_UPDATE =
  /\b(?:more\s+compute|increase(?:d|s|ing)?|\d+x|boost(?:ed|s|ing)?|lift(?:ed|s|ing)?)\b/i;

export function postText(post) {
  return (
    post?.note_post?.text ||
    post?.note_tweet?.text ||
    post?.text ||
    ""
  ).trim();
}

export function classifyTiboPost(post, parentPost = null) {
  const text = postText(post);
  const parentText = postText(parentPost);
  const combinedContext = `${parentText}\n${text}`;
  const isReply = Boolean(
    post?.in_reply_to_user_id ||
      post?.referenced_posts?.some((item) => item.type === "replied_to") ||
      post?.referenced_tweets?.some((item) => item.type === "replied_to"),
  );

  if (BANKED_RESET.test(combinedContext)) {
    const confirmed = DIRECT_CONFIRMATION.some((pattern) => pattern.test(text));
    return {
      kind: "banked",
      lane: "reset_related",
      explicitResetClaim: confirmed,
      verificationStatus: confirmed ? "confirmed" : "pending",
      confidence: confirmed ? "high" : "medium",
      reason: confirmed ? "banked_reset_confirmed" : "banked_reset_mentioned",
    };
  }

  if (DIRECT_CONFIRMATION.some((pattern) => pattern.test(text))) {
    return {
      kind: "reset",
      lane: "reset_related",
      explicitResetClaim: true,
      verificationStatus: "confirmed",
      confidence: "high",
      reason: "explicit_reset_confirmation",
    };
  }

  if (
    isReply &&
    RESET_CONTEXT.test(parentText) &&
    CONTEXTUAL_CONFIRMATION.test(text)
  ) {
    return {
      kind: "reset",
      lane: "reset_related",
      explicitResetClaim: true,
      verificationStatus: "confirmed",
      confidence: "high",
      reason: "contextual_reply_confirmation",
    };
  }

  if (
    PREVIEW.some((pattern) => pattern.test(text)) &&
    (RESET_CONTEXT.test(combinedContext) || /\blanding|arriving\b/i.test(text))
  ) {
    return {
      kind: "signal",
      lane: "reset_related",
      explicitResetClaim: false,
      verificationStatus: "pending",
      confidence: "high",
      reason: "future_reset_window",
    };
  }

  if (LIMIT_UPDATE.test(text)) {
    const boosted = BOOST_UPDATE.test(text);
    return {
      kind: boosted ? "boost" : "limits",
      lane: "reset_related",
      explicitResetClaim: false,
      verificationStatus: null,
      confidence: "high",
      reason: boosted ? "capacity_boost" : "limits_update",
    };
  }

  return {
    kind: "other",
    lane: null,
    explicitResetClaim: false,
    verificationStatus: null,
    confidence: "high",
    reason: "no_reset_signal",
  };
}
