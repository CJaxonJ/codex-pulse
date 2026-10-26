import { RealRpcPeer } from "./real-rpc-peer.mjs";
import { ChatContinuityController } from "../../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../../src/chat-continuity-store.mjs";
import { WorktreeLockManager } from "../../src/worktree-lock-manager.mjs";
import { AppServerClient } from "../../src/app-server-client.mjs";

const [url, dataDir, threadId, nowText, resetText, observationMode] = process.argv.slice(2);
const client = url === "stdio" ? new AppServerClient() : new RealRpcPeer(url);
const store = new ChatContinuityStore(dataDir);
const events = [];
try {
  await client.start();
  const controller = new ChatContinuityController({ client, store,
    lockManager: new WorktreeLockManager(dataDir), onEvent: async event => events.push(event) });
  const summary = { planType: "plus",
    fiveHour: { remainingPercent: 100, resetsAt: Number(resetText) } };
  await controller.reconcile(summary, { now: Number(nowText) });
  if (observationMode === "after-first-hook") {
    const deadline = Date.now() + 30000;
    let observed = false;
    while (Date.now() < deadline) {
      const current = await store.get(threadId);
      if (current?.workspaceValidatedAt) {
        // Deliberately let the real Hook win the race before the independent
        // watcher reads history. It must still notice execution, not requeue.
        await controller.reconcile(summary, {
          now: Math.max(Number(nowText), Math.floor(Date.now() / 1000)),
        });
        observed = Boolean((await store.get(threadId))?.executionObservedAt);
        break;
      }
      if (current?.status === "needs_attention") throw Error(`Recovery blocked: ${current.blocker}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!observed) throw Error("Independent watcher did not observe execution after the real first-tool Hook");
  }
  const record = await store.get(threadId);
  console.log(JSON.stringify({ pid: process.pid, events, status: record.status,
    wakeSubmittedAt: record.wakeSubmittedAt, wakeAttempts: record.wakeAttempts,
    lastWakeError: record.lastWakeError, executionObservedAt: record.executionObservedAt }));
} finally { if (client.close) client.close(); else client.stop(); }
