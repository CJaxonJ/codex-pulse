#!/usr/bin/env node

import { TiboResetClient } from "../src/tibo-client.mjs";
import { normalizeTiboSnapshot } from "../src/tibo-monitor-core.mjs";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastError = null;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const raw = await new TiboResetClient().readSnapshot();
    if (!Array.isArray(raw.feed?.tweets)) {
      throw new Error("feed.tweets is not an array");
    }
    if (!raw.forecast || typeof raw.forecast !== "object") {
      throw new Error("forecast payload is missing");
    }
    const snapshot = normalizeTiboSnapshot(raw, { now });
    if (snapshot.sourceHealth.status !== "healthy") {
      throw new Error(
        `feed is not healthy: ${JSON.stringify(snapshot.sourceHealth)}`,
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          source: snapshot.source,
          sourceHealth: snapshot.sourceHealth,
          latestPost: snapshot.latestPost
            ? {
                id: snapshot.latestPost.id,
                at: snapshot.latestPost.occurredAt,
                kind: snapshot.latestPost.kind,
                lane: snapshot.latestPost.lane,
              }
            : null,
          previewId: snapshot.preview?.id || null,
          confirmedKey: snapshot.confirmed?.key || null,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < 3) await delay(2_000);
  }
}

console.error(JSON.stringify({ ok: false, error: lastError?.message || "unknown" }, null, 2));
process.exit(1);
