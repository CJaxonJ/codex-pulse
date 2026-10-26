import { open } from "node:fs/promises";

// A separate app-server can replay an unfinished Desktop turn as interrupted.
// Only a persisted lifecycle marker proves termination across that boundary.
// Read backwards in bounded chunks; never store message bodies or prompts.
export async function readPersistedLifecycle(filePath, { maxBytes = 16 * 1024 * 1024 } = {}) {
  const file = await open(filePath, "r");
  try {
    const { size } = await file.stat();
    let end = size;
    let suffix = "";
    const lowerBound = Math.max(0, size - maxBytes);
    while (end > lowerBound) {
      const start = Math.max(lowerBound, end - 256 * 1024);
      const buffer = Buffer.alloc(end - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = (buffer.subarray(0, bytesRead).toString("utf8") + suffix).split("\n");
      suffix = start > 0 ? lines.shift() : "";
      for (let i = lines.length - 1; i >= 0; i--) {
        let record;
        try { record = JSON.parse(lines[i]); } catch { continue; }
        if (record.type !== "event_msg") continue;
        const p = record.payload;
        const turnId = p?.turn_id || p?.root_turn_id;
        if (!turnId) continue;
        if (p.type === "task_started") return { id: turnId, status: "inProgress" };
        if (p.type === "task_complete") return { id: turnId,
          status: p.error ? "failed" : "completed", error: p.error || null };
        if (p.type === "turn_aborted") return { id: turnId, status: "interrupted" };
      }
      end = start;
    }
    return null;
  } finally { await file.close(); }
}

export async function readLatestTurn(client, threadId, itemsView = "notLoaded") {
  let metadata = await client.request("thread/read", { threadId });
  let history;
  try {
    history = await client.request("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView });
  } catch (error) {
    if (!/list_turns is not supported|not supported.*legacy/i.test(error.message)) throw error;
    // Older/local threads still use legacy history, including some versions
    // which silently ignore historyMode on thread/start.
    metadata = await client.request("thread/read", { threadId, includeTurns: true });
    history = { data: metadata.thread?.turns?.slice(-1) || [] };
  }
  const replayed = history.data?.[0] || null;
  const filePath = metadata.thread?.path;
  if (!filePath) return { ...replayed, status: "unknown" };
  let lifecycle;
  try { lifecycle = await readPersistedLifecycle(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!lifecycle) return { ...replayed, status: "unknown" };
  return { ...(lifecycle.id === replayed?.id ? replayed : {}), ...lifecycle };
}
