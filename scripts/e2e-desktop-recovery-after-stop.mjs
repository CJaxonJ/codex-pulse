#!/usr/bin/env node

// Uses synthetic quota samples, but the real current Desktop thread and Goal
// dispatcher. The observer never calls turn/start, never writes the proof, and
// never declares success merely because thread/goal/set returned successfully.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "../src/app-server-client.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { NativeGoalCoordinator } from "../src/native-goal-coordinator.mjs";
import { handleHook } from "../plugin/scripts/pulse-hook.mjs";

const script = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(script), "..");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => JSON.parse(await readFile(file, "utf8"));
const save = (file, data) => writeFile(file, JSON.stringify(data, null, 2) + "\n");
const quota = (remainingPercent, resetsAt) => ({ planType: "plus",
  fiveHour: { remainingPercent, usedPercent: 100 - remainingPercent, resetsAt } });

if (process.argv[2] === "--inspect") {
  const client = new AppServerClient();
  try {
    await client.start();
    const threadId = process.argv[3];
    const history = await client.request("thread/turns/list", {
      threadId, limit: 3, sortDirection: "desc", itemsView: "notLoaded",
    });
    const state = await client.request("thread/read", { threadId });
    console.log(JSON.stringify({ turns: history.data?.map(t => ({ id: t.id, status: t.status })),
      threadStatus: state.thread?.status, path: state.thread?.path,
      id: state.thread?.id, source: state.thread?.source }, null, 2));
  } finally { client.stop(); }
} else if (process.argv[2] === "--cancel") {
  const evidencePath = process.argv[3];
  const evidence = await readJson(evidencePath);
  if (evidence.observerPid) {
    let command = "";
    try { command = execFileSync("/bin/ps", ["-p", String(evidence.observerPid), "-o", "command="], { encoding: "utf8" }); }
    catch (error) { if (error.status !== 1) throw error; }
    if (command.includes(`${script} --observe ${evidencePath}`)) process.kill(evidence.observerPid, "SIGTERM");
  }
  const client = new AppServerClient();
  try {
    await client.start();
    const current = (await client.request("thread/goal/get", { threadId: evidence.threadId })).goal;
    if (current?.objective?.includes(evidence.proofText)) {
      await client.request("thread/goal/set", { threadId: evidence.threadId,
        objective: evidence.originalObjective, status: "active", origin: "automatic",
        ...(evidence.originalGoal.tokenBudget != null ? { tokenBudget: evidence.originalGoal.tokenBudget } : {}),
      });
    }
    evidence.phase = "cancelled";
    evidence.cancellationReason = "User requested isolated acceptance; user message cannot prove autonomous dispatch.";
    await save(evidencePath, evidence);
    console.log(JSON.stringify({ cancelled: true, originalGoalPreserved: true }));
  } finally { client.stop(); }
} else if (process.argv[2] === "--restore") {
  const evidence = await readJson(process.argv[3]);
  if (evidence.phase !== "passed") throw Error("Verify real execution before restoring the test Goal");
  const client = new AppServerClient();
  try {
    await client.start();
    const current = (await client.request("thread/goal/get", { threadId: evidence.threadId })).goal;
    if (!current?.objective?.includes(evidence.proofText) && current?.objective !== evidence.originalObjective) {
      throw Error("Goal changed outside the canary; refusing to overwrite it");
    }
    await client.request("thread/goal/set", { threadId: evidence.threadId,
      objective: evidence.originalObjective, status: "active", origin: "automatic",
      ...(evidence.originalGoal.tokenBudget != null ? { tokenBudget: evidence.originalGoal.tokenBudget } : {}),
    });
    console.log(JSON.stringify({ originalGoalRestored: true }));
  } finally { client.stop(); }
} else if (process.argv[2] === "--verify") {
  const evidence = await readJson(process.argv[3]);
  if (evidence.phase !== "passed" || !evidence.newTurnId || !evidence.proofObservedAt ||
    evidence.externalWriterCalls !== 0) throw Error(`Acceptance is not proven: ${evidence.phase}`);
  console.log(JSON.stringify(evidence, null, 2));
} else if (process.argv[2] === "--observe") {
  const evidencePath = process.argv[3];
  const e = await readJson(evidencePath);
  const client = new AppServerClient({ requestTimeoutMs: 15000 });
  const store = new ChatContinuityStore(e.dataDir);
  const recordedClient = { async request(method, params) {
    if (["thread/resume", "turn/start"].includes(method)) {
      e.externalWriterCalls++;
      throw Error("External writer forbidden for Desktop acceptance");
    }
    return client.request(method, params);
  }, readLatestTurn: (...args) => client.readLatestTurn(...args) };
  const controller = new ChatContinuityController({ client: recordedClient, store,
    onEvent: async event => { e.events.push({ ...event, at: Date.now() }); await save(evidencePath, e); },
  });
  try {
    await client.start();
    e.observerPid = process.pid;
    await save(evidencePath, e);
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      try {
        const latest = await client.readLatestTurn(e.threadId);
        if (!latest) throw Error("No authoritative current turn");
        if (e.phase === "armed" && latest.id === e.pausedTurnId &&
          ["completed", "failed"].includes(latest.status)) {
          e.stoppedAt = Date.now();
          e.stoppedStatus = latest.status;
          e.phase = "recovering";
          await save(evidencePath, e);
        }
        if (e.phase === "recovering") {
          await controller.reconcile(quota(100, e.window + 18000));
          const r = await store.get(e.threadId);
          if (r?.status === "needs_attention") throw Error(`Recovery blocked: ${r.blocker}`);
          if (r?.status === "native_goal_active") e.phase = "waiting_for_new_turn";
          await save(evidencePath, e);
        }
        if (e.phase === "waiting_for_new_turn") {
          // Continue checking actual history after the activation, including
          // across transient polling failures. A timeout does not mean success.
          await controller.reconcile(quota(100, e.window + 18000));
          const r = await store.get(e.threadId);
          if (r?.status === "needs_attention") throw Error(`Dispatch failed: ${r.blocker}`);
          if (latest.id !== e.pausedTurnId) {
            e.newTurnId = latest.id;
            e.newTurnObservedAt ||= Date.now();
            try {
              if ((await readFile(e.proofPath, "utf8")).trim() === e.proofText) {
                e.proofObservedAt = Date.now();
                e.phase = "passed";
                await save(evidencePath, e);
                break;
              }
            } catch (error) { if (error.code !== "ENOENT") throw error; }
          }
          await save(evidencePath, e);
        }
        if (latest.id !== e.pausedTurnId && !e.stoppedAt) {
          throw Error("Another turn started before the stopped turn could be verified");
        }
      } catch (error) {
        if (/blocked|Dispatch failed|Another turn/.test(error.message)) throw error;
        e.lastObservationError = error.message;
        await save(evidencePath, e);
      }
      await sleep(2000);
    }
    if (e.phase !== "passed") throw Error("Timed out without proof of actual Desktop execution");
  } catch (error) {
    e.phase = "failed";
    e.failure = error.message;
    await save(evidencePath, e);
    process.exitCode = 1;
  } finally { client.stop(); }
} else if (process.argv[2] === "--arm") {
  const threadId = process.argv[3];
  const cwd = path.resolve(process.argv[4] || process.cwd());
  if (!threadId) throw Error("Current Desktop thread id is required");
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-desktop-after-stop-"));
  const dataDir = path.join(root, "data");
  const evidencePath = path.join(root, "evidence.json");
  const proofPath = path.join(root, "actual-resumed-agent-proof.txt");
  const client = new AppServerClient();
  let before;
  let armed = false;
  try {
    await client.start();
    before = (await client.request("thread/goal/get", { threadId })).goal;
    if (before?.status !== "active") throw Error("The current user Goal must be active");
    const turn = await client.readLatestTurn(threadId);
    if (!turn || turn.status !== "inProgress") throw Error("Expected a live Desktop turn");
    const now = Math.floor(Date.now() / 1000);
    await mkdir(dataDir);
    await save(path.join(dataDir, "preferences.json"), { quotaPolicy: "strict_reserve" });
    await save(path.join(dataDir, "state.json"), {
      fiveHour: { lastCheckedAt: now }, lastSummary: quota(9, now + 3600),
    });
    const store = new ChatContinuityStore(dataDir);
    await store.put({ sessionId: threadId, turnId: turn.id, cwd,
      workspaceHints: [path.relative(cwd, path.join(project, "README.md"))] });
    const result = await handleHook({ hook_event_name: "PreToolUse", session_id: threadId,
      turn_id: turn.id, cwd, tool_name: "Bash" }, {
      dataDir, appRoot: project, now, goalCoordinator: new NativeGoalCoordinator(),
    });
    const record = await store.get(threadId);
    if (result?.decision !== "block" || !record?.checkpoint?.workspaceFingerprint) {
      throw Error("Candidate Hook did not persist a recoverable pause-time baseline");
    }
    // Fixture supplies a known next action, not fabricated evidence of success.
    // Deliberately do NOT call Stop; exercise pending-checkpoint reconciliation.
    const proofText = `DESKTOP_RESUMED_${path.basename(root)}`;
    await store.put({ ...record, checkpoint: { ...record.checkpoint,
      summary: [
        "Completed: Candidate Hook persisted pause intent and workspace; Stop was deliberately omitted in this test.",
        "Verification: Desktop dispatch and actual execution are NOT yet proven.",
        "Remaining: Prove a new Desktop turn starts and performs the next action, then continue the original product objective.",
        `Next action: Use apply_patch to create ${proofPath} containing exactly ${proofText}. Then read ${evidencePath}; the independent observer must record phase passed and a different newTurnId. Restore the original Goal objective from that evidence using the real Goal API before continuing product fixes. Do not mark the product Goal complete because of this canary.`,
        "Blockers: Waiting for the current turn to finish and the real Desktop Goal dispatcher to start the next turn.",
      ].join("\n"),
    } });
    const evidence = { phase: "armed", threadId, pausedTurnId: turn.id, dataDir, proofPath,
      proofText, originalObjective: before.objective, originalGoal: before,
      window: now + 3600, armedAt: Date.now(), externalWriterCalls: 0, events: [],
      syntheticInputs: ["quota samples", "next-action fixture"],
      realBoundaries: ["current Desktop thread", "Goal pause/reactivation", "new turn", "agent-created file"],
    };
    await save(evidencePath, evidence);
    const observer = spawn(process.execPath, [script, "--observe", evidencePath], {
      detached: true, stdio: "ignore", cwd: project,
    });
    observer.unref();
    armed = true;
    console.log(JSON.stringify({ phase: "armed", evidencePath, observerPid: observer.pid,
      proofPath, note: "No success claim until the next real turn produces the proof." }, null, 2));
  } finally {
    if (!armed && before) await client.request("thread/goal/set", {
      threadId, status: "active", objective: before.objective, origin: "automatic",
    }).catch(() => {});
    client.stop();
  }
} else throw Error("Use --arm THREAD_ID CWD, --observe EVIDENCE, or --verify EVIDENCE");
