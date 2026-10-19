import assert from "node:assert/strict";
import test from "node:test";

import { classifyTiboPost } from "../src/tibo-classifier.mjs";

test("a terse completion reply is a reset only when its parent supplies reset context", () => {
  const reply = {
    text: "Done and dusted",
    referenced_posts: [{ type: "replied_to", id: "parent-1" }],
  };
  assert.deepEqual(classifyTiboPost(reply), {
    kind: "other",
    lane: null,
    explicitResetClaim: false,
    verificationStatus: null,
    confidence: "high",
    reason: "no_reset_signal",
  });
  const classified = classifyTiboPost(reply, {
    id: "parent-1",
    text: "Did the Codex usage limit reset finish?",
  });
  assert.equal(classified.kind, "reset");
  assert.equal(classified.verificationStatus, "confirmed");
  assert.equal(classified.reason, "contextual_reply_confirmation");
});

test("future landing language becomes a preview when the conversation is about resets", () => {
  const classified = classifyTiboPost(
    {
      text: "Landing within the next 2 hours",
      referenced_posts: [{ type: "replied_to", id: "parent-2" }],
    },
    { id: "parent-2", text: "When is the next Codex reset?" },
  );
  assert.equal(classified.kind, "signal");
  assert.equal(classified.verificationStatus, "pending");
});

test("capacity news stays informational and does not become a reset", () => {
  const classified = classifyTiboPost({
    text: "We added more compute and increased usage limits for Plus users.",
  });
  assert.equal(classified.kind, "boost");
  assert.equal(classified.verificationStatus, null);
  assert.equal(classified.explicitResetClaim, false);
});

test("ordinary Codex discussion is ignored", () => {
  const classified = classifyTiboPost({
    text: "The team shipped a new code review experience today.",
  });
  assert.equal(classified.kind, "other");
});
