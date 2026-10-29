#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pulseDataDirectory } from "../src/platform-runtime.mjs";

import { AppServerClient } from "../src/app-server-client.mjs";
import { ChatContinuityController } from "../src/chat-continuity-controller.mjs";
import { ChatContinuityStore } from "../src/chat-continuity-store.mjs";
import { ManagedTaskController } from "../src/managed-task-controller.mjs";
import { ManagedTaskStore } from "../src/managed-task-store.mjs";
import { readResumePreview } from "../src/resume-preview.mjs";
import { ProtectionConsent } from "../src/protection-consent.mjs";
import { CreditAutoRedeemer, personalAccountBinding, evaluateCreditAwareQuota } from "../src/credit-auto-redeemer.mjs";
import {
  evaluateResetCredits,
  summarizeRateLimits,
} from "../src/quota-monitor-core.mjs";
import {
  notificationForEvent,
  applyNotificationPreferences,
  sendMacNotification,
} from "../src/macos-notifier.mjs";
import { TiboResetClient } from "../src/tibo-client.mjs";
import {
  configureXBearerToken,
  forgetXBearerToken,
  readXBearerToken,
} from "../src/tibo-credentials.mjs";
import {
  attachPersonalLanding,
  correlateRecentPersonalReset,
  evaluateTiboFetchFailure,
  evaluateTiboSnapshot,
  normalizeTiboSnapshot,
} from "../src/tibo-monitor-core.mjs";
import { WorkspaceInspector } from "../src/workspace-inspector.mjs";
import { WorktreeLockManager } from "../src/worktree-lock-manager.mjs";
import { UsageObservationStore } from "../src/usage-observation-store.mjs";
import { UserEventJournal } from "../src/user-event-journal.mjs";
import {
  inspectLocalInstallation,
  redactDiagnosticText,
} from "../src/doctor.mjs";
import {
  PulsePreferencesStore,
  QUOTA_POLICIES,
  TIBO_SOURCES,
  userSettings,
} from "../src/preferences-store.mjs";
import {
  adviseTaskStart,
  TASK_PRIORITIES,
  TASK_SIZES,
} from "../src/usage-advisor.mjs";

const args = process.argv.slice(2);
const packageManifest = JSON.parse(
  await readFile(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
);
const command = args[0] || "status";
const once = args.includes("--once");
const pollSeconds = Number(process.env.CODEX_PULSE_POLL_SECONDS || 60);
const dataDir = pulseDataDirectory();
const statePath = path.join(dataDir, "state.json");

function argValue(name, fallback = null) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function log(message, details = null) {
  const prefix = `[${new Date().toISOString()}] ${message}`;
  console.log(details == null ? prefix : `${prefix} ${JSON.stringify(details)}`);
}

async function loadState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return {};
  }
}

async function saveState(state) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readQuotaSummary(client) {
  const fixturePath = process.env.CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH;
  if (!fixturePath) {
    return summarizeRateLimits(await client.readRateLimits());
  }
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.CODEX_PULSE_TEST_MODE !== "watcher-restart-e2e"
  ) {
    throw new Error(
      "CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH is restricted to the watcher restart E2E",
    );
  }
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

async function deliverUserEvent(
  event,
  {
    journal = new UserEventJournal(dataDir),
    notification = notificationForEvent(event),
    context = {},
  } = {},
) {
  const preferences = await new PulsePreferencesStore(dataDir).get();
  const delivery = applyNotificationPreferences(event, notification, preferences);
  notification = delivery.notification;
  let journalEntry = null;
  try {
    journalEntry = await journal.append({
      type: event.type,
      title: notification.title,
      body: notification.body,
      occurredAt: Math.floor(Date.now() / 1000),
      deliveryStatus: "pending",
      severity: notification.severity,
      sourceUrl: notification.sourceUrl,
      parentUrl: notification.parentUrl,
      sourceText: notification.sourceText,
      sourceTextKind: notification.sourceTextKind,
      sourceAt: notification.sourceAt,
    });
  } catch (error) {
    log("user event journal write failed", { type: event.type, error: error.message });
  }
  let deliveryStatus = delivery.enabled ? "notification_request_accepted" : "muted_by_preferences";
  try {
    if (delivery.enabled) await sendMacNotification({ ...notification, eventId: journalEntry?.id });
  } catch (error) {
    deliveryStatus = "failed";
    log("notification delivery failed", {
      type: event.type,
      error: error.message,
      ...context,
    });
  }
  if (journalEntry) {
    try {
      await journal.updateDeliveryStatus(journalEntry.id, deliveryStatus);
    } catch (error) {
      log("user event journal status update failed", {
        type: event.type,
        error: error.message,
      });
    }
  }
  return { notification, deliveryStatus };
}

async function withClient(fn) {
  const client = new AppServerClient();
  try {
    await client.start();
    return await fn(client);
  } finally {
    client.stop();
  }
}

async function printStatus() {
  await withClient(async (client) => {
    const summary = summarizeRateLimits(await client.readRateLimits());
    console.log(JSON.stringify({ ok: true, summary }, null, 2));
  });
}

async function testNotification() {
  const preferences = await new PulsePreferencesStore(dataDir).get();
  const quotaExample = notificationForEvent({
    type: "threshold",
    threshold: 10,
    remainingPercent: 10,
    resetsAt: Math.floor(Date.now() / 1000) + 60 * 60,
    quotaPolicy: preferences.quotaPolicy,
  });
  const notification = {
    title: `【测试】${quotaExample.title}`,
    body: `这是一条测试通知，不代表真实额度。${quotaExample.body}`,
  };
  const result = await deliverUserEvent(
    { type: "test_threshold" },
    { notification },
  );
  log("test notification processed", { deliveryStatus: result.deliveryStatus });
}

async function printActivity() {
  const state = await loadState();
  const preferences = await new PulsePreferencesStore(dataDir).get();
  const journal = new UserEventJournal(dataDir);
  console.log(
    JSON.stringify(
      {
        ok: true,
        quota: {
          planType: state.lastSummary?.planType || null,
          fiveHour: state.lastSummary?.fiveHour || null,
          weekly: state.lastSummary?.weekly || null,
          resetCreditCount: state.lastSummary?.resetCredits?.availableCount ?? 0,
        },
        protection: preferences.quotaPolicy,
        latestEvent: await journal.latest(),
        privacy:
          "This view excludes prompts, authentication material, and reset-credit identifiers.",
      },
      null,
      2,
    ),
  );
}

async function runDoctor() {
  const checks = [];
  try {
    const summary = await withClient(async (client) =>
      summarizeRateLimits(await client.readRateLimits()),
    );
    checks.push({
      id: "codex-account",
      status: "pass",
      detail: {
        planType: summary.planType || "unknown",
        hasFiveHourWindow: Boolean(summary.fiveHour),
        hasWeeklyWindow: Boolean(summary.weekly),
      },
    });
  } catch (error) {
    checks.push({
      id: "codex-account",
      status: "fail",
      detail: `无法读取已登录的 Codex 额度：${redactDiagnosticText(error.message, os.homedir())}`,
    });
  }

  const local = inspectLocalInstallation({
    homeDir: os.homedir(),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    uid: process.getuid?.() ?? 0,
    expectedVersion: packageManifest.version,
    compatiblePluginVersions:
      packageManifest.codexPulse?.compatiblePluginVersions || [packageManifest.version],
  });
  checks.push(...local.checks);
  const ok = checks.every((item) => item.status !== "fail");
  const hookObserved = local.support.hookObservedForInstalledPlugin;

  console.log(
    JSON.stringify(
      {
        ok,
        installationOk: ok,
        hookTrust: hookObserved ? "observed_active" : "manual_verification_required",
        generatedAt: new Date().toISOString(),
        checks,
        privacy:
          "This report excludes authentication material, reset-credit IDs, prompt text, and absolute home paths.",
        nextStep: !ok
          ? (process.platform === "win32" ? "重新运行 Windows 安装器后再检查；仍失败时，可预览脱敏报告后向开发者反馈。" : "Re-run node scripts/install-macos.mjs, then run doctor again. If it still fails, share this report with the developer.")
          : hookObserved
            ? "Codex Pulse is installed and a Hook execution was observed. If protection seems inactive, check current trust through Codex Pulse → 保护授权."
            : "Open Codex Pulse → 保护授权, personally review and confirm the definitions, then reopen Codex when convenient. New sessions load the authorization; no CLI trust keypress is required.",
      },
      null,
      2,
    ),
  );
  if (!ok) process.exitCode = 1;
}

async function queueManagedTask() {
  const objective = argValue("--objective");
  if (!objective) {
    throw new Error("managed-run requires --objective \"...\"");
  }
  const cwd = path.resolve(argValue("--cwd", process.cwd()));
  const model = argValue("--model", "gpt-6.1-sol");
  const taskSize = argValue("--size", "medium");
  const priority = argValue("--priority", "normal");
  const preferencesStore = new PulsePreferencesStore(dataDir);
  const preferences = await preferencesStore.get();
  const quotaPolicy = argValue("--quota-policy", preferences.quotaPolicy);
  if (!TASK_SIZES.includes(taskSize)) {
    throw new Error(`--size must be one of: ${TASK_SIZES.join(", ")}`);
  }
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new Error(`--priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
  }
  if (!QUOTA_POLICIES.includes(quotaPolicy)) {
    throw new Error(`--quota-policy must be one of: ${QUOTA_POLICIES.join(", ")}`);
  }
  const store = new ManagedTaskStore(dataDir);
  const observationStore = new UsageObservationStore(dataDir);
  const summary = await withClient(async (client) =>
    summarizeRateLimits(await client.readRateLimits()),
  );
  const advice = adviseTaskStart({
    summary,
    tasks: await store.list(),
    observations: await observationStore.list(),
    taskSize,
    priority,
    model,
  });
  const startFloor = Number(
    argValue("--start-floor", String(advice.recommendedStartFloor)),
  );
  const resumeFloor = Number(
    argValue("--resume-floor", String(Math.max(30, startFloor))),
  );
  if (!Number.isFinite(startFloor) || startFloor < 0 || startFloor > 100) {
    throw new Error("--start-floor must be between 0 and 100");
  }
  if (!Number.isFinite(resumeFloor) || resumeFloor < 1 || resumeFloor > 100) {
    throw new Error("--resume-floor must be between 1 and 100");
  }
  const task = await store.queue({
    objective,
    cwd,
    model,
    taskSize,
    priority,
    quotaPolicy,
    startFloor,
    resumeFloor,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        task: {
          id: task.id,
          status: task.status,
          cwd: task.cwd,
          model: task.model,
          taskSize: task.taskSize,
          priority: task.priority,
          quotaPolicy: task.quotaPolicy,
          startFloor: task.startFloor,
          resumeFloor: task.resumeFloor,
        },
        advice,
        note: "The background watcher will start this task when personal five-hour and weekly quota pass the recommended gates.",
      },
      null,
      2,
    ),
  );
}

async function printTaskAdvice() {
  const taskSize = argValue("--size", "medium");
  const priority = argValue("--priority", "normal");
  const model = argValue("--model", "gpt-6.1-sol");
  if (!TASK_SIZES.includes(taskSize)) {
    throw new Error(`--size must be one of: ${TASK_SIZES.join(", ")}`);
  }
  if (!TASK_PRIORITIES.includes(priority)) {
    throw new Error(`--priority must be one of: ${TASK_PRIORITIES.join(", ")}`);
  }
  const store = new ManagedTaskStore(dataDir);
  const observationStore = new UsageObservationStore(dataDir);
  const summary = await withClient(async (client) =>
    summarizeRateLimits(await client.readRateLimits()),
  );
  const advice = adviseTaskStart({
    summary,
    tasks: await store.list(),
    observations: await observationStore.list(),
    taskSize,
    priority,
    model,
  });
  console.log(JSON.stringify({ ok: true, summary, advice }, null, 2));
}

async function managePolicy() {
  const store = new PulsePreferencesStore(dataDir);
  const mode = argValue("--mode");
  if (mode && !QUOTA_POLICIES.includes(mode)) {
    throw new Error(`--mode must be one of: ${QUOTA_POLICIES.join(", ")}`);
  }
  const preferences = mode ? await store.set({ quotaPolicy: mode }) : await store.get();
  console.log(
    JSON.stringify(
      {
        ok: true,
        preferences,
        modes: {
          finish_current: "Finish the current bounded result before pausing.",
          strict_reserve: "Default: protect the reserve, block new work, and pause at 10%.",
          deadline: "Prioritize a bounded deadline task and drain only at critically low quota.",
        },
      },
      null,
      2,
    ),
  );
}

async function manageTiboSource() {
  const store = new PulsePreferencesStore(dataDir);
  if (args.includes("--configure-x")) {
    console.log(
      "Paste the X API bearer token at the Keychain prompt. It is stored by macOS and is never written to Codex Pulse state or logs.",
    );
    configureXBearerToken();
    await store.set({ tiboSource: "x-api" });
  }
  if (args.includes("--forget-x")) {
    forgetXBearerToken();
    await store.set({ tiboSource: "codex-reset" });
  }
  const mode = argValue("--mode");
  if (mode && !TIBO_SOURCES.includes(mode)) {
    throw new Error(`--mode must be one of: ${TIBO_SOURCES.join(", ")}`);
  }
  if (mode) await store.set({ tiboSource: mode });
  const preferences = await store.get();
  const xApiCredentialConfigured = Boolean(await readXBearerToken());
  console.log(
    JSON.stringify(
      {
        ok: true,
        source: preferences.tiboSource,
        xApiCredentialConfigured,
        zeroConfigurationSource: "codex-reset",
        note:
          preferences.tiboSource === "auto"
            ? "The existing auto setting uses the zero-configuration codex-reset source."
            : "The watcher picks up this setting without reinstalling or restarting.",
      },
      null,
      2,
    ),
  );
}

async function listManagedTasks() {
  const store = new ManagedTaskStore(dataDir);
  const tasks = (await store.list()).map((task) => ({
    id: task.id,
    status: task.status,
    objective: task.objective,
    cwd: task.cwd,
    threadId: task.threadId,
    turnId: task.turnId,
    taskSize: task.taskSize || "medium",
    priority: task.priority || "normal",
    quotaPolicy: task.quotaPolicy || "finish_current",
    startFloor: task.startFloor ?? 50,
    resumeCount: task.resumeCount || 0,
    latestUsageSegment: task.usageSegments?.at(-1) || null,
    blocker: task.blocker || null,
    updatedAt: task.updatedAt,
  }));
  console.log(JSON.stringify({ ok: true, tasks }, null, 2));
}

async function manageCreditPolicy() {
  if (args.includes("--enable") && args.includes("--disable")) throw new Error("不能同时开启和关闭自动用卡");
  const store = new PulsePreferencesStore(dataDir);
  if (args.includes("--disable")) await store.set({ autoRedeem: { enabled: false } });
  if (args.includes("--enable")) {
    if (!args.includes("--yes")) throw new Error("请先确认：仅当前个人账户、不足十分钟临期、确有可重置额度时，自动使用一张；确认后加 --yes");
    await withClient(async (client) => {
      const accountBinding = personalAccountBinding(await client.request("account/read", { refreshToken: false }));
      if (!accountBinding) throw new Error("无法确认个人 Plus/Pro 账户身份；为避免跨账户代用，未开启");
      await store.set({ autoRedeem: { enabled: true, accountBinding, consentedAt: Math.floor(Date.now() / 1000) } });
    });
  }
  const policy = (await store.get()).autoRedeem;
  console.log(JSON.stringify({ ok: true, enabled: policy.enabled === true,
    accountBound: Boolean(policy.accountBinding), note: "只在临期不足十分钟且确有可重置额度时使用最早到期的一张；不购买，睡眠或离线可能错过。" }, null, 2));
}

async function watch() {
  const client = new AppServerClient();
  const preferencesStore = new PulsePreferencesStore(dataDir);
  const tiboClient = new TiboResetClient({
    sourceProvider: async () => (await preferencesStore.get()).tiboSource,
  });
  const lockManager = new WorktreeLockManager(dataDir);
  const autoRedeemer = new CreditAutoRedeemer({ client, preferences: preferencesStore, dataDir });
  const managedTaskStore = new ManagedTaskStore(dataDir);
  const eventJournal = new UserEventJournal(dataDir);
  const managedController = new ManagedTaskController({
    client,
    store: managedTaskStore,
    workspace: new WorkspaceInspector(),
    lockManager,
    onEvent: async (event) => {
      const delivered = await deliverUserEvent(event, {
        journal: eventJournal,
        context: { taskId: event.taskId },
      });
      log("managed task notification processed", {
        type: event.type,
        taskId: event.taskId,
        title: delivered.notification.title,
        deliveryStatus: delivered.deliveryStatus,
      });
    },
  });
  const continuityController = new ChatContinuityController({
    client,
    store: new ChatContinuityStore(dataDir),
    workspace: new WorkspaceInspector(),
    lockManager,
    onEvent: async (event) => {
      const delivered = await deliverUserEvent(event, {
        journal: eventJournal,
        context: { sessionId: event.sessionId },
      });
      log("ordinary chat continuity notification processed", {
        type: event.type,
        sessionId: event.sessionId,
        title: delivered.notification.title,
        deliveryStatus: delivered.deliveryStatus,
      });
    },
  });
  let state = await loadState();
  let polling = false;
  let stopped = false;
  let lastTiboPollAt = 0;

  async function poll(reason = "timer") {
    if (polling || stopped) return;
    polling = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      let summary = await readQuotaSummary(client);
      const beforeSample = { ...state };
      const currentPreferences = await preferencesStore.get();
      const config = { thresholds: [currentPreferences.lowQuotaPercent, 10, 5] };
      let redemption = { events: [] };
      let evaluated = evaluateCreditAwareQuota(state, summary, redemption, { now, config });
      state.creditResetAttributionUntil = evaluated.attributionUntil;
      let creditEvaluation = evaluateResetCredits(state.resetCredits, summary, { now });
      // Publish fresh quota before waking a thread. Its Hook must not see the
      // old 9% sample and immediately stop the recovered task again. Auxiliary
      // Tibo requests must not delay this critical chain either.
      state = { ...state, fiveHour: evaluated.state,
        resetCredits: creditEvaluation.state, lastSummary: summary, quotaCheckedAt: now };
      await saveState(state);
      try {
        await managedController.reconcile(summary, { now });
      } catch (error) {
        log("managed task reconciliation failed", { error: error.message });
      }
      try {
        await continuityController.reconcile(summary, { now });
      } catch (error) {
        log("ordinary chat continuity reconciliation failed", { error: error.message });
      }
      // Existing protection/recovery always runs first. A slow card/account RPC
      // must not delay publishing 9% or interrupting a quota-draining task.
      // Test quota fixtures are never allowed to reach real consume RPCs.
      if (!process.env.CODEX_PULSE_TEST_QUOTA_SUMMARY_PATH) {
        try { redemption = await autoRedeemer.poll(); }
        catch { redemption = { events: [{ type: "credit_auto_failed", reason: "local_failure" }] }; }
        if (redemption.raw) summary = summarizeRateLimits(redemption.raw);
        evaluated = evaluateCreditAwareQuota(beforeSample, summary, redemption, { now, config });
        creditEvaluation = evaluateResetCredits(beforeSample.resetCredits, summary, { now });
        state = { ...state, creditResetAttributionUntil: evaluated.attributionUntil,
          fiveHour: evaluated.state, resetCredits: creditEvaluation.state, lastSummary: summary };
        await saveState(state);
        if (["reset", "alreadyRedeemed", "settled"].includes(redemption.status)) {
          // Publish the post-consume sample BEFORE waking. Reuse the existing
          // safety gate rather than letting redemption itself start any task.
          try { await managedController.reconcile(summary, { now }); }
          catch (error) { log("post-credit task reconciliation failed", { error: error.message }); }
          try { await continuityController.reconcile(summary, { now }); }
          catch (error) { log("post-credit chat reconciliation failed", { error: error.message }); }
        }
      }
      const tiboEvents = [];
      if (reason !== "server-event" && now - lastTiboPollAt >= 60) {
        lastTiboPollAt = now;
        try {
          const rawTibo = await tiboClient.readSnapshot({
            sinceId: state.tibo?.lastSeenTweetId || null,
          });
          if (!rawTibo) {
            log("Tibo signal source disabled; quota monitoring continues");
          } else {
            const tiboSnapshot = normalizeTiboSnapshot(rawTibo, { now });
            const evaluatedTibo = evaluateTiboSnapshot(state.tibo, tiboSnapshot, {
              now,
            });
            state = { ...state, tibo: evaluatedTibo.state };
            tiboEvents.push(...evaluatedTibo.events);
            log("Tibo signal checked", {
              previewId: tiboSnapshot.preview?.id ?? null,
              confirmedKey: tiboSnapshot.confirmed?.key ?? null,
              latestPostId: tiboSnapshot.latestPost?.id ?? null,
              latestPostKind: tiboSnapshot.latestPost?.kind ?? null,
              latestPostLane: tiboSnapshot.latestPost?.lane ?? null,
              sourceStatus: tiboSnapshot.sourceHealth?.status ?? "unknown",
              degradedComponents: tiboSnapshot.degradedComponents,
              eventTypes: evaluatedTibo.events.map((event) => event.type),
              eventCount: evaluatedTibo.events.length,
            });
          }
        } catch (error) {
          const failure = evaluateTiboFetchFailure(state.tibo, { now });
          state = { ...state, tibo: failure.state };
          tiboEvents.push(...failure.events);
          log("Tibo signal check failed; quota monitoring continues", {
            error: error.message,
            consecutiveFailures: failure.state.consecutiveSourceFailures,
            eventTypes: failure.events.map((event) => event.type),
          });
        }
      }

      if (summary.planType && !String(summary.planType).toLowerCase().includes("plus")) {
        log("account has a non-Plus plan; observing only the quota windows actually returned", {
          planType: summary.planType,
        });
      }
      const landing = attachPersonalLanding(evaluated.events, state.tibo, { now });
      const correlatedTibo = correlateRecentPersonalReset(
        tiboEvents,
        landing.tiboState,
        evaluated.state,
        { now },
      );
      state = {
        ...state,
        fiveHour: evaluated.state,
        resetCredits: creditEvaluation.state,
        tibo: correlatedTibo.tiboState,
        lastSummary: summary,
      };
      await saveState(state);
      log("quota checked", {
        reason,
        planType: summary.planType,
        remainingPercent: summary.fiveHour?.remainingPercent ?? null,
        resetsAt: summary.fiveHour?.resetsAt ?? null,
        eventCount: landing.events.length + creditEvaluation.events.length,
      });
      const preferences = await preferencesStore.get();
      for (const event of [
        ...correlatedTibo.events,
        ...redemption.events,
        ...creditEvaluation.events,
        ...landing.events,
      ]) {
        const enrichedEvent = { ...event, quotaPolicy: preferences.quotaPolicy };
        const delivered = await deliverUserEvent(enrichedEvent, {
          journal: eventJournal,
        });
        log("notification processed", {
          type: event.type,
          title: delivered.notification.title,
          deliveryStatus: delivered.deliveryStatus,
        });
      }
    } catch (error) {
      log("quota check failed", { error: error.message });
      if (once) throw error;
    } finally {
      polling = false;
    }
  }

  await client.start();
  client.on("exit", (error) => {
    if (stopped) return;
    log("app server exited; launchd will restart the watcher", {
      error: error.message,
    });
    process.exit(1);
  });
  client.on("notification", (message) => {
    if (message.method === "account/rateLimits/updated") void poll("server-event");
    void managedController.handleNotification(message).catch((error) => {
      log("managed task event handling failed", {
        method: message.method,
        error: error.message,
      });
    });
    void continuityController.handleNotification(message).catch((error) => {
      log("ordinary chat continuity event handling failed", {
        method: message.method,
        error: error.message,
      });
    });
  });
  client.on("serverRequest", (message) => {
    void managedController.handleServerRequest(message).catch((error) => {
      log("managed task user-action handling failed", {
        method: message.method,
        error: error.message,
      });
    });
    void continuityController.handleServerRequest(message).catch((error) => {
      log("ordinary chat continuity user-action handling failed", {
        method: message.method,
        error: error.message,
      });
    });
  });
  await poll("startup");
  if (once) {
    stopped = true;
    client.stop();
    return;
  }

  const timer = setInterval(() => void poll("timer"), pollSeconds * 1000);
  const shutdown = () => {
    stopped = true;
    clearInterval(timer);
    client.stop();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  log("watcher started", { pollSeconds, statePath });
}

try {
  if (command === "status") await printStatus();
  else if (command === "activity") await printActivity();
  else if (command === "protection") await withClient(async (client) => {
    const consent = new ProtectionConsent({client,dataDir});
    const action=args[1] || 'status';
    const result=action==='prepare' ? await consent.prepare() : action==='enable'
      ? await consent.enable(argValue('--review'),{confirmed:args.includes('--yes')})
      : action==='status' ? await consent.status() : null;
    if(!result) throw new Error('未知保护操作');
    console.log(JSON.stringify(result));
  });
  else if (command === "preview") console.log(JSON.stringify(await readResumePreview(dataDir, { pollSeconds }), null, 2));
  else if (command === "settings") {
    const store = new PulsePreferencesStore(dataDir);
    const patch = argValue("--update");
    if (args.includes("--update") && patch == null) throw new Error("--update 需要设置对象");
    const preferences = patch == null ? await store.get() : await store.setUserSettings(JSON.parse(patch));
    console.log(JSON.stringify({ ok: true, settings: userSettings(preferences), autoRedeemEnabled: preferences.autoRedeem?.enabled === true }, null, 2));
  }
  else if (command === "credits-policy") await manageCreditPolicy();
  else if (command === "doctor") await runDoctor();
  else if (command === "notify-test") await testNotification();
  else if (command === "managed-run") await queueManagedTask();
  else if (command === "managed-list") await listManagedTasks();
  else if (command === "advice") await printTaskAdvice();
  else if (command === "policy") await managePolicy();
  else if (command === "tibo-source") await manageTiboSource();
  else if (command === "watch") await watch();
  else {
    console.error(
      "Usage: codex-pulse [status|activity|preview|settings [--update JSON]|credits-policy [--enable --yes|--disable]|doctor|watch [--once]|notify-test|advice [--size small|medium|large] [--priority low|normal|high] [--model MODEL]|policy [--mode finish_current|strict_reserve|deadline]|tibo-source [--configure-x|--forget-x|--mode disabled|auto|x-api|codex-reset]|managed-run --objective TEXT [--cwd PATH] [--model MODEL] [--size SIZE] [--priority PRIORITY] [--quota-policy POLICY] [--start-floor N] [--resume-floor N]|managed-list]",
    );
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
