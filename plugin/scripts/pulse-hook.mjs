#!/usr/bin/env node

import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_STATE_AGE_SECONDS = 180;

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function admitRecoveryWake(dataDir, input, now, continuityStore) {
  const id = String(input.prompt || "").match(/^\[Codex Pulse recovery ([a-f0-9]{64})\]\n/)?.[1];
  if (!id) return null;
  const chat = await continuityStore.get(input.session_id);
  if (!chat || !["resuming", "native_goal_active"].includes(chat.status)) {
    return { decision: "block", reason: "Codex Pulse ignored a stale recovery request; the paused task is no longer awaiting this wakeup." };
  }
  const root = path.join(dataDir, "wake-admissions");
  const directory = path.join(root, id);
  try {
    await mkdir(root, { recursive: true });
    await mkdir(directory);
    await writeJsonAtomic(path.join(directory, "admission.json"), {
      sessionId: input.session_id, turnId: input.turn_id, admittedAt: now,
    });
    return null;
  } catch (error) {
    if (error.code === "EEXIST") {
      const previous = await readJson(path.join(directory, "admission.json"));
      if (previous?.turnId && previous.turnId === input.turn_id && previous.sessionId === input.session_id) return null;
    }
    return { decision: "block", reason: "Codex Pulse blocked a duplicate or unverifiable recovery wakeup. The same paused task must not be started twice." };
  }
}

function inferTaskSize(prompt = "") {
  const explicit = prompt.match(/\[pulse:(small|medium|large)\]/i)?.[1]?.toLowerCase();
  if (explicit) return explicit;
  if (
    prompt.length >= 1_000 ||
    /(?:重构|迁移|完整实现|全量|端到端|从零搭建|architecture|migrate|refactor|end[- ]to[- ]end)/i.test(
      prompt,
    )
  ) {
    return "large";
  }
  if (
    prompt.length <= 260 &&
    /(?:解释|查看|检查|改一处|修一个|只读|拼写|rename|typo|read[- ]only|one fix|explain)/i.test(
      prompt,
    )
  ) {
    return "small";
  }
  return "medium";
}

function inferPriority(prompt = "") {
  const explicit = prompt.match(/\[pulse:(low|normal|high)\]/i)?.[1]?.toLowerCase();
  if (explicit) return explicit;
  if (/(?:紧急|立即|今天必须|线上故障|阻塞发布|urgent|production down|blocking release)/i.test(prompt)) {
    return "high";
  }
  if (/(?:不着急|有空再|低优先级|when convenient|low priority)/i.test(prompt)) {
    return "low";
  }
  return "normal";
}

function quotaPolicy(verdict, mode) {
  if (verdict === "start_bounded") {
    return "Codex Pulse weekly pacing advisory: the user explicitly submitted this task, so continue it. Keep the work bounded to the request, but do not treat weekly pacing as a hard stop. Only the configured five-hour hard floor may stop tool work.";
  }
  if (mode === "deadline") {
    return "Codex Pulse deadline policy: the user chose to prioritize the current bounded deadline result. Keep moving toward that result, avoid optional exploration, and never redeem a reset credit without explicit confirmation.";
  }
  if (mode === "strict_reserve") {
    return "Codex Pulse strict-reserve policy: preserve the user's remaining quota. Keep the result bounded; do not expand scope, start optional work, or continue past the configured hard floor.";
  }
  if (verdict === "wait_for_reset") {
    return "Codex Pulse quota policy: the user submitted the prompt despite a nearby reset. Continue with one bounded, useful result only. Do not broaden scope, spawn optional subagents, perform unrelated refactors, or add nonessential verification. End with a concise checkpoint for deferred work.";
  }
  if (verdict === "consider_reset") {
    return "Codex Pulse quota policy: do not consume a reset credit automatically. Work only on a bounded result until the user explicitly confirms any reset-card action.";
  }
  return "Codex Pulse quota policy: quota headroom is tight. Complete one bounded deliverable, avoid optional exploration and broad refactors, run only necessary checks, and leave a concise checkpoint.";
}

function thresholdPolicy(remaining, mode) {
  if (mode === "strict_reserve" && remaining <= 10) {
    return {
      band: 10,
      stop: true,
      systemMessage: `Codex Pulse：严格保余额模式已在 ${Math.round(remaining)}% 停止本轮。`,
      context:
        "Codex Pulse strict-reserve stop: preserve existing edits and stop opening or continuing work. In the final response write a compact handoff with these labels: Completed, Verification, Remaining, Next action, Blockers. Do not claim the task is complete. Resume only after quota recovery or after the user changes the policy.",
    };
  }
  if (mode === "deadline") {
    if (remaining <= 1) {
      return {
        band: 1,
        stop: true,
        systemMessage: "Codex Pulse：截止日期模式已到最后 1%，停止继续消耗。",
        context:
          "Codex Pulse deadline hard floor: preserve current edits and stop. Leave remaining work for quota recovery.",
      };
    }
    if (remaining <= 5) {
      return {
        band: 5,
        systemMessage: `Codex Pulse：截止日期模式剩余 ${Math.round(remaining)}%，只完成最近的可交付结果。`,
        context:
          "Codex Pulse deadline drain: finish the nearest shippable result, run only essential verification, avoid any new scope, and leave a checkpoint.",
      };
    }
    return null;
  }
  if (remaining <= 10) {
    return {
      band: 10,
      systemMessage: `Codex Pulse：5 小时额度只剩 ${Math.round(remaining)}%，本轮进入收尾模式。`,
      context:
        "Codex Pulse hard-floor guidance: do not open new work. Finish the current bounded result if it is close, preserve existing edits, run only essential verification, and end with completed work, remaining steps, and blockers. Do not start another implementation branch.",
    };
  }
  if (remaining <= 15) {
    return {
      band: 15,
      systemMessage: `Codex Pulse：5 小时额度剩余 ${Math.round(remaining)}%，开始停止扩展范围。`,
      context:
        "Codex Pulse drain guidance: stop expanding scope. Finish only the current bounded step, avoid optional tools or agents, and prepare a concise checkpoint before the turn ends.",
    };
  }
  return null;
}

async function loadManagedTasks(dataDir) {
  const tasksDir = path.join(dataDir, "managed-tasks");
  try {
    const names = (await readdir(tasksDir)).filter((name) => name.endsWith(".json"));
    const tasks = [];
    for (const name of names) {
      const task = await readJson(path.join(tasksDir, name));
      if (task) tasks.push(task);
    }
    return tasks;
  } catch {
    return [];
  }
}

function matchesManagedSession(tasks, input) {
  return tasks.some(
    (task) =>
      task.threadId === input.session_id ||
      (input.turn_id && task.turnId === input.turn_id),
  );
}

function workspaceHints(input, cwd) {
  const values = [];
  const toolInput = input.tool_input;
  if (toolInput && typeof toolInput === "object") {
    for (const key of ["path", "file_path", "workdir", "cwd"]) {
      if (typeof toolInput[key] === "string") values.push(toolInput[key]);
    }
  }
  if (
    input.tool_name === "apply_patch" &&
    typeof toolInput?.command === "string"
  ) {
    for (const match of toolInput.command.matchAll(
      /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm,
    )) {
      values.push(match[1].trim());
    }
  }
  const root = path.resolve(cwd);
  return [...new Set(values.flatMap((value) => {
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return [];
    }
    return [relative || "."];
  }))].slice(0, 100);
}

async function rememberWorkspaceHints(continuityStore, input, cwd) {
  if (!input.session_id) return null;
  const hints = workspaceHints(input, cwd);
  if (!hints.length) return continuityStore.get(input.session_id);
  const existing = await continuityStore.get(input.session_id);
  const sameTurn =
    existing && (!input.turn_id || !existing.turnId || input.turn_id === existing.turnId);
  if (
    existing &&
    !sameTurn &&
    ["paused_quota", "resuming", "running", "native_goal_active"].includes(existing.status)
  ) {
    return existing;
  }
  const base = sameTurn ? existing : { sessionId: input.session_id };
  return continuityStore.put({
    ...base,
    status: base?.status || "observing",
    cwd,
    turnId: input.turn_id || base?.turnId || null,
    model: input.model || base?.model || null,
    permissionMode: input.permission_mode || base?.permissionMode || "default",
    workspaceHints: [...new Set([...(base?.workspaceHints || []), ...hints])].slice(0, 100),
  });
}

async function captureWorkspace(workspace, cwd, hints, timeoutMs = 2000) {
  const workspaceSnapshot = await workspace.snapshot(cwd, { hints, timeoutMs });
  // The worker enforces a total deadline, including fallback/retries/scopes.
  // Never start an unbounded second scan after that deadline expires.
  const workspaceFingerprint = workspaceSnapshot?.digest || null;
  return {
    workspaceSnapshot,
    workspaceFingerprint,
    ...(workspaceFingerprint == null
      ? { workspaceFingerprintFailure: workspace.failureDiagnostic?.() || null }
      : {}),
  };
}

async function observeRecoveryBaseline({ continuityStore, goalCoordinator, workspace, input,
  summary, mode, now, newTurn = false }) {
  if (!input.session_id || !input.turn_id || mode !== "strict_reserve") return;
  const existing = await continuityStore.get(input.session_id);
  // Goal dispatch may emit UserPromptSubmit before its first tool. Keep the
  // armed validation/checkpoint intact until that tool has been checked.
  if (existing?.workspaceValidationRequired === true &&
    ["resuming", "native_goal_active"].includes(existing.status)) return;
  const sameTurn = existing?.turnId === input.turn_id;
  if (sameTurn && existing.status !== "observing") return;
  const base = sameTurn ? existing : { sessionId: input.session_id };
  const cwd = path.resolve(input.cwd || base.cwd || process.cwd());
  const record = await continuityStore.put({ ...base, status: "observing", cwd,
    turnId: input.turn_id, quotaPolicy: mode,
    workspaceValidationMode: "pre_tool_hook_v1",
    wakeAdmissionVersion: 1,
    observationWindowKey: summary.fiveHour?.resetsAt || null,
    observationStartedAt: base.observationStartedAt || now,
  });
  const [baseline, goal] = await Promise.all([
    captureWorkspace(workspace, cwd, record.workspaceHints || [], newTurn ? 800 : 1200),
    record.initialGoal ? Promise.resolve(record.initialGoal) :
      goalCoordinator.readSnapshot?.(input.session_id).catch(() => null) || Promise.resolve(null),
  ]);
  const current = await continuityStore.get(input.session_id);
  if (current?.turnId !== input.turn_id || current.status !== "observing") return;
  const originalGoal = existing?.initialGoal &&
    existing.checkpoint?.continuationGoal?.objective === goal?.objective
    ? existing.initialGoal : goal;
  await continuityStore.put({ ...current,
    initialGoal: current.initialGoal || (goal?.status === "active" ? originalGoal : null),
    observedGoalObjective: current.observedGoalObjective || goal?.objective || null,
    reserveBaseline: { ...baseline, observedAt: now, turnId: input.turn_id },
  });
}

async function validateRecoveryWorkspace({
  continuityStore,
  workspace,
  goalCoordinator,
  input,
  now,
}) {
  if (!input.session_id) return null;
  const chat = await continuityStore.get(input.session_id);
  if (chat?.status === "needs_attention" && chat.validationFailedTurnId) {
    return { decision: "block", reason: "Codex Pulse recovery remains blocked after workspace validation failed. Stop and wait for a new explicit user request; do not retry tools against the changed workspace." };
  }
  if (
    !["native_goal_active", "resuming"].includes(chat?.status) ||
    chat.workspaceValidationRequired !== true
  ) {
    return null;
  }

  const cwd = path.resolve(input.cwd || chat.cwd || process.cwd());
  let reason = null;
  let changedScopes = [];
  if (!chat.cwd || !(await workspace.exists(cwd)) || path.resolve(chat.cwd) !== cwd) {
    reason = "cwd_missing";
  } else if (chat.checkpoint?.workspaceSnapshot) {
    const comparison = await workspace.compareSnapshot(
      cwd,
      chat.checkpoint.workspaceSnapshot,
      { timeoutMs: 4000 },
    );
    if (comparison?.verifiable === false) {
      reason = "workspace_unverifiable";
    } else if (!comparison?.same) {
      reason = "workspace_changed";
      changedScopes = comparison?.changedScopes || [];
    }
  } else if (chat.checkpoint?.workspaceFingerprint) {
    const fingerprint = await workspace.fingerprint(cwd, {
      timeoutMs: 4000,
      strategy: String(chat.checkpoint.workspaceFingerprint).startsWith("fs:")
        ? "filesystem"
        : undefined,
    });
    if (fingerprint == null) reason = "workspace_unverifiable";
    else if (fingerprint !== chat.checkpoint.workspaceFingerprint) {
      reason = "workspace_changed";
    }
  } else {
    reason = "checkpoint_missing_fingerprint";
  }

  if (reason) {
    try {
      await goalCoordinator.pauseIfActive(input.session_id);
    } catch {
      // Blocking the tool is the safety boundary. Goal pausing is best effort.
    }
    await continuityStore.put({
      ...chat,
      status: "needs_attention",
      blocker: reason,
      blockerDetails: changedScopes.length ? { changedScopes } : null,
      autoResume: false,
      holdWorktreeLock: false,
      workspaceValidationRequired: false,
      validationFailedAt: now,
      validationFailedTurnId: input.turn_id || chat.turnId,
    });
    return {
      decision: "block",
      reason:
        reason === "workspace_changed"
          ? "Codex Pulse blocked the resumed tool because the target workspace changed while quota was paused. Review the current files and continue manually."
          : "Codex Pulse could not safely verify the paused workspace, so it blocked the resumed tool. Review the workspace and continue manually.",
      systemMessage:
        reason === "workspace_changed"
          ? "Codex Pulse：暂停期间工作区发生变化，已停止自动续跑，避免覆盖新修改。"
          : "Codex Pulse：无法验证暂停时的工作区，已停止自动续跑。",
    };
  }

  await continuityStore.put({
    ...chat,
    turnId: input.turn_id || chat.turnId,
    workspaceValidationRequired: false,
    workspaceValidatedAt: now,
  });
  return null;
}

async function prepareNativeGoalPause(goalCoordinator, sessionId, existing, now) {
  if (existing?.goalCheckedTurnId === existing?.turnId) {
    return {
      autoResume: existing.autoResume === true,
      resumeMode: existing.resumeMode || "manual",
      goalWasActive: existing.goalWasActive === true,
      goalCheckedAt: existing.goalCheckedAt || now,
      goalCheckedTurnId: existing.goalCheckedTurnId || existing.turnId || null,
      resumeUnavailableReason: existing.resumeUnavailableReason || null,
      initialGoal: existing.initialGoal || null,
      goalAtPause: existing.goalAtPause || null,
    };
  }
  try {
    const result = await goalCoordinator.pauseIfActive(sessionId);
    if (result.paused) {
      return {
        autoResume: true,
        resumeMode: "native_goal",
        goalWasActive: true,
        goalCheckedAt: now,
        goalCheckedTurnId: existing?.turnId || null,
        resumeUnavailableReason: null,
        initialGoal: existing?.initialGoal || result.goalSnapshot || null,
        goalAtPause: result.goalSnapshot || existing?.goalAtPause || null,
      };
    }
    return {
      autoResume: false,
      resumeMode: "manual",
      goalWasActive: false,
      goalCheckedAt: now,
      goalCheckedTurnId: existing?.turnId || null,
      resumeUnavailableReason: "native_goal_required",
    };
  } catch (error) {
    return {
      autoResume: false,
      resumeMode: "manual",
      goalWasActive: false,
      goalCheckedAt: now,
      goalCheckedTurnId: existing?.turnId || null,
      resumeUnavailableReason: "native_goal_unavailable",
      goalPauseError: String(error?.message || error).slice(0, 500),
    };
  }
}

async function requestQuotaCheckpoint({
  continuityStore,
  goalCoordinator,
  input,
  mode,
  summary,
  remaining,
  now,
  workspace,
}) {
  if (!input.session_id) return null;
  const existingChat = await continuityStore.get(input.session_id);
  const sameTurn =
    existingChat &&
    (!input.turn_id || !existingChat.turnId || input.turn_id === existingChat.turnId);
  const baseChat = sameTurn ? existingChat : { sessionId: input.session_id };
  if (
    sameTurn &&
    ["checkpoint_requested", "checkpointing", "paused_quota", "complete", "needs_attention"].includes(existingChat.status)
  ) {
    return existingChat;
  }
  const cwd = path.resolve(input.cwd || baseChat.cwd || process.cwd());
  // Write the intent before scanning files or making an RPC. Either operation
  // may outlive the hook; the watcher must be able to reconcile that failure.
  const requested = await continuityStore.put({
    ...baseChat,
    status: "checkpoint_requested",
    workspaceValidationMode: "pre_tool_hook_v1",
    wakeAdmissionVersion: 1,
    cwd,
    turnId: input.turn_id || baseChat.turnId || null,
    model: input.model || baseChat.model || null,
    permissionMode: input.permission_mode || baseChat.permissionMode || "default",
    quotaPolicy: mode,
    resumeFloor: baseChat.resumeFloor ?? 50,
    pausedWindowKey: summary.fiveHour?.resetsAt || null,
    pausedRemaining: remaining,
    checkpointRequestedAt: now,
    executionObservedAt: null,
    pausedTurnId: null,
    wakeSourceTurnId: null,
    wakeSubmittedAt: null,
    wakeAttempts: 0,
    checkpoint: { quotaAtPause: remaining, requestedAt: now },
  });
  const captured = await captureWorkspace(workspace, cwd, baseChat.workspaceHints || []);
  const prepared = await continuityStore.put({
    ...requested,
    checkpoint: { ...requested.checkpoint, ...captured },
  });
  const goalPause = await prepareNativeGoalPause(
    goalCoordinator,
    input.session_id,
    { ...baseChat, turnId: input.turn_id || baseChat.turnId || null },
    now,
  );
  return continuityStore.put({
    ...prepared,
    status: "checkpoint_requested",
    workspaceValidationMode: "pre_tool_hook_v1",
    cwd,
    turnId: input.turn_id || baseChat.turnId || null,
    model: input.model || baseChat.model || null,
    permissionMode: input.permission_mode || baseChat.permissionMode || "default",
    quotaPolicy: mode,
    ...goalPause,
    resumeFloor: baseChat.resumeFloor ?? 50,
    pausedWindowKey: summary.fiveHour?.resetsAt || null,
    pausedRemaining: remaining,
    checkpointRequestedAt: now,
    checkpoint: {
      ...prepared.checkpoint,
      quotaAtPause: remaining,
      requestedAt: now,
    },
  });
}

async function runtimeModules(appRoot) {
  const advisorUrl = pathToFileURL(path.join(appRoot, "src", "usage-advisor.mjs")).href;
  const storeUrl = pathToFileURL(
    path.join(appRoot, "src", "usage-observation-store.mjs"),
  ).href;
  const preferencesUrl = pathToFileURL(
    path.join(appRoot, "src", "preferences-store.mjs"),
  ).href;
  const continuityStoreUrl = pathToFileURL(
    path.join(appRoot, "src", "chat-continuity-store.mjs"),
  ).href;
  const workspaceUrl = pathToFileURL(
    path.join(appRoot, "src", "workspace-inspector.mjs"),
  ).href;
  const goalCoordinatorUrl = pathToFileURL(
    path.join(appRoot, "src", "native-goal-coordinator.mjs"),
  ).href;
  const goalContinuationUrl = pathToFileURL(
    path.join(appRoot, "src", "goal-continuation.mjs"),
  ).href;
  const [
    { adviseTaskStart },
    { UsageObservationStore },
    { PulsePreferencesStore },
    { ChatContinuityStore },
    { WorkspaceInspector },
    { NativeGoalCoordinator },
    { buildContinuationGoal },
  ] = await Promise.all([
    import(advisorUrl),
    import(storeUrl),
    import(preferencesUrl),
    import(continuityStoreUrl),
    import(workspaceUrl),
    import(goalCoordinatorUrl),
    import(goalContinuationUrl),
  ]);
  return {
    adviseTaskStart,
    UsageObservationStore,
    PulsePreferencesStore,
    ChatContinuityStore,
    WorkspaceInspector,
    NativeGoalCoordinator,
    buildContinuationGoal,
  };
}

function observationId(input) {
  return `${input.session_id || "unknown"}-${input.turn_id || "unknown"}`;
}

function isFresh(state, now) {
  const checkedAt = state?.fiveHour?.lastCheckedAt;
  return checkedAt != null && now - checkedAt <= MAX_STATE_AGE_SECONDS;
}

async function markThreshold(dataDir, turnId, band) {
  const safeTurn = String(turnId || "unknown").replaceAll(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dataDir, "hook-thresholds", `${safeTurn}.json`);
  const previous = (await readJson(filePath, { bands: [] })) || { bands: [] };
  if (previous.bands?.includes(band)) return false;
  await writeJsonAtomic(filePath, {
    bands: [...(previous.bands || []), band],
    updatedAt: Math.floor(Date.now() / 1000),
  });
  return true;
}

async function markDecision(dataDir, sessionId, advice, mode, now) {
  const safeSession = String(sessionId || "unknown").replaceAll(
    /[^a-zA-Z0-9._-]/g,
    "_",
  );
  const filePath = path.join(dataDir, "hook-decisions", `${safeSession}.json`);
  const previous = await readJson(filePath);
  const changed = previous?.verdict !== advice.verdict || previous?.mode !== mode;
  await writeJsonAtomic(filePath, {
    verdict: advice.verdict,
    mode,
    title: advice.title,
    updatedAt: now,
  });
  return { changed, previous };
}

export async function handleHook(input, options = {}) {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const dataDir =
    options.dataDir ||
    process.env.CODEX_PULSE_DATA_DIR ||
    path.join(os.homedir(), "Library", "Application Support", "Codex Pulse");
  const appRoot =
    options.appRoot ||
    process.env.CODEX_PULSE_APP_ROOT ||
    path.join(dataDir, "app");
  const state = await readJson(path.join(dataDir, "state.json"), {});
  const cachedPreferences = await readJson(path.join(dataDir, "preferences.json"), {});
  const staleStrictReserve =
    !isFresh(state, now) &&
    cachedPreferences?.quotaPolicy === "strict_reserve" &&
    state.lastSummary?.fiveHour?.remainingPercent != null &&
    state.lastSummary.fiveHour.remainingPercent <= 10;
  if (!state.lastSummary || (!isFresh(state, now) && !staleStrictReserve)) {
    return input.hook_event_name === "Stop" ? {} : null;
  }

  const summary = state.lastSummary;
  const {
    adviseTaskStart,
    UsageObservationStore,
    PulsePreferencesStore,
    ChatContinuityStore,
    WorkspaceInspector,
    NativeGoalCoordinator,
    buildContinuationGoal,
  } = await runtimeModules(appRoot);
  const preferences = await new PulsePreferencesStore(dataDir).get();
  const mode = preferences.quotaPolicy;
  const observationStore = new UsageObservationStore(dataDir);
  const continuityStore = new ChatContinuityStore(dataDir);
  const workspace = new WorkspaceInspector();
  const goalCoordinator =
    options.goalCoordinator || new NativeGoalCoordinator();
  const id = observationId(input);

  if (input.hook_event_name === "UserPromptSubmit") {
    const recovery = input.session_id ? await continuityStore.get(input.session_id) : null;
    const recoveryContext = recovery?.workspaceValidationRequired === true &&
      ["resuming", "native_goal_active"].includes(recovery.status) && recovery.checkpoint?.summary
      ? `Codex Pulse saved progress (original user objective remains authoritative):\n${recovery.checkpoint.summary.slice(0, 8000)}` : "";
    const currentRemaining = summary.fiveHour?.remainingPercent;
    const managedTasks = await loadManagedTasks(dataDir);
    if (
      mode === "strict_reserve" &&
      currentRemaining != null &&
      currentRemaining <= 10
    ) {
      return {
        decision: "block",
        reason: `Codex Pulse 严格保余额模式：当前 5 小时额度剩余 ${Math.round(currentRemaining)}%，已阻止新任务。额度恢复后重试，或运行 codex-pulse policy --mode finish_current 切换策略。`,
      };
    }
    const taskSize = inferTaskSize(input.prompt || "");
    const wakeAdmission = await admitRecoveryWake(dataDir, input, now, continuityStore);
    if (wakeAdmission) return wakeAdmission;
    const priority = inferPriority(input.prompt || "");
    if (!matchesManagedSession(managedTasks, input)) {
      await observeRecoveryBaseline({ continuityStore, goalCoordinator, workspace, input,
        summary, mode, now, newTurn: true });
    }
    const existing = await observationStore.get(id);
    await observationStore.put({
      ...(existing || {}),
      id,
      source: "trusted_codex_hook",
      sessionId: input.session_id || null,
      turnId: input.turn_id || null,
      model: input.model || null,
      taskSize,
      priority,
      startedAt: existing?.startedAt || now,
      windowKey: existing?.windowKey || summary.fiveHour?.resetsAt || null,
      startRemaining:
        existing?.startRemaining ?? summary.fiveHour?.remainingPercent ?? null,
    });
    const advice = adviseTaskStart({
      summary,
      tasks: managedTasks,
      observations: await observationStore.list(),
      taskSize,
      priority,
      model: input.model,
    });
    const decision = await markDecision(dataDir, input.session_id, advice, mode, now);
    if (advice.verdict === "start_now") {
      if (recoveryContext) return { hookSpecificOutput: {
        hookEventName: "UserPromptSubmit", additionalContext: recoveryContext,
      } };
      if (decision.changed && decision.previous) {
        return {
          systemMessage: `Codex Pulse：${advice.title}。${advice.action}`,
        };
      }
      return null;
    }
    return {
      ...(decision.changed
        ? { systemMessage: `Codex Pulse：${advice.title}。${advice.action}` }
        : {}),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: [quotaPolicy(advice.verdict, mode), recoveryContext].filter(Boolean).join("\n\n"),
      },
    };
  }

  if (input.hook_event_name === "PreToolUse") {
    const recoveryValidation = await validateRecoveryWorkspace({
      continuityStore,
      workspace,
      goalCoordinator,
      input,
      now,
    });
    if (recoveryValidation) return recoveryValidation;
    const remaining = summary.fiveHour?.remainingPercent;
    if (mode !== "strict_reserve" || remaining == null || remaining > 10) {
      return null;
    }
    if (matchesManagedSession(await loadManagedTasks(dataDir), input)) return null;
    if (input.session_id) {
      await requestQuotaCheckpoint({
        continuityStore,
        goalCoordinator,
        input,
        mode,
        summary,
        remaining,
        now,
        workspace,
      });
    }
    return {
      decision: "block",
      reason:
        "Codex Pulse strict-reserve hard floor reached. Do not call another tool. In the final response write a compact handoff with exactly these sections: Completed, Verification, Remaining, Next action, Blockers. Do not claim the task is complete. Then stop.",
      systemMessage: `Codex Pulse：严格保余额模式剩余 ${Math.round(remaining)}%，已阻止新的工具调用并要求保存检查点。`,
    };
  }

  if (input.hook_event_name === "PostToolUse") {
    const remaining = summary.fiveHour?.remainingPercent;
    if (remaining == null) return null;
    if (matchesManagedSession(await loadManagedTasks(dataDir), input)) return null;
    const observedCwd = path.resolve(input.cwd || process.cwd());
    await rememberWorkspaceHints(continuityStore, input, observedCwd);
    if (remaining > 10) {
      await observeRecoveryBaseline({ continuityStore, goalCoordinator, workspace, input,
        summary, mode, now });
    }
    const policy = thresholdPolicy(remaining, mode);
    if (!policy || !(await markThreshold(dataDir, input.turn_id, policy.band))) {
      return null;
    }
    if (policy.stop && input.session_id) {
      await requestQuotaCheckpoint({
        continuityStore,
        goalCoordinator,
        input,
        mode,
        summary,
        remaining,
        now,
        workspace,
      });
    }
    return {
      ...(policy.stop
        ? {
            decision: "block",
            reason:
              "Codex Pulse strict-reserve hard floor reached. Do not call another tool. In the final response write a compact handoff with exactly these sections: Completed, Verification, Remaining, Next action, Blockers. Do not claim the task is complete. Then stop.",
          }
        : {}),
      systemMessage: policy.systemMessage,
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: policy.context,
      },
    };
  }

  if (input.hook_event_name === "SessionStart") {
    const remaining = summary.fiveHour?.remainingPercent;
    if (remaining == null || remaining > 20) return null;
    return {
      systemMessage: `Codex Pulse：当前 5 小时额度剩余 ${Math.round(remaining)}%。`,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          mode === "deadline"
            ? "Codex Pulse deadline session guidance: prioritize one bounded deadline result, avoid optional exploration, and never redeem reset credits automatically."
            : mode === "strict_reserve"
              ? "Codex Pulse strict-reserve session guidance: quota is low. Preserve the remaining quota and do not begin broad new work."
              : "Codex Pulse session guidance: quota is low. Keep new work bounded, prefer one verifiable outcome, and avoid optional exploration until the quota window recovers.",
      },
    };
  }

  if (["Stop", "Interrupt"].includes(input.hook_event_name)) {
    const existing = await observationStore.get(id);
    if (existing) {
      const endRemaining = summary.fiveHour?.remainingPercent ?? null;
      const sameWindow =
        existing.windowKey != null && existing.windowKey === summary.fiveHour?.resetsAt;
      await observationStore.put({
        ...existing,
        endedAt: now,
        endRemaining,
        consumedPercent:
          sameWindow && existing.startRemaining != null && endRemaining != null
            ? Math.max(0, existing.startRemaining - endRemaining)
            : null,
        durationSeconds: Math.max(0, now - existing.startedAt),
        outcome: input.hook_event_name === "Stop" ? "completed" : "interrupted",
      });
    }
    let chat = input.session_id
      ? await continuityStore.get(input.session_id)
      : null;
    let matchingChatTurn =
      chat && (!input.turn_id || !chat.turnId || input.turn_id === chat.turnId);
    const remaining = summary.fiveHour?.remainingPercent;
    if (
      input.hook_event_name === "Stop" &&
      mode === "strict_reserve" &&
      remaining != null &&
      remaining <= 10 &&
      input.session_id &&
      !matchesManagedSession(await loadManagedTasks(dataDir), input) &&
      (!matchingChatTurn ||
        !["paused_quota", "complete", "needs_attention"].includes(chat.status))
    ) {
      chat = await requestQuotaCheckpoint({
        continuityStore,
        goalCoordinator,
        input,
        mode,
        summary,
        remaining,
        now,
        workspace,
      });
      matchingChatTurn =
        chat && (!input.turn_id || !chat.turnId || input.turn_id === chat.turnId);
    }
    if (
      input.hook_event_name === "Stop" &&
      matchingChatTurn &&
      ["checkpoint_requested", "checkpointing"].includes(chat.status)
    ) {
      const cwd = path.resolve(input.cwd || chat.cwd || process.cwd());
      const workspaceCapture = chat.checkpoint?.workspaceFingerprint ? {
        workspaceSnapshot: chat.checkpoint.workspaceSnapshot,
        workspaceFingerprint: chat.checkpoint.workspaceFingerprint,
      } : await captureWorkspace(
        workspace,
        cwd,
        chat.workspaceHints || [],
      );
      const checkpointSummary = String(
        input.last_assistant_message ||
          "The turn stopped at the strict quota reserve. Inspect the workspace before continuing.",
      ).slice(0, 8_000);
      const continuationGoal =
        chat.resumeMode === "native_goal"
          ? buildContinuationGoal({
              originalObjective: chat.initialGoal?.objective,
              checkpointSummary,
            })
          : null;
      await continuityStore.put({
        ...chat,
        status: "paused_quota",
        cwd,
        turnId: input.turn_id || chat.turnId,
        pausedAt: now,
        checkpoint: {
          ...(chat.checkpoint || {}),
          summary: checkpointSummary,
          ...(continuationGoal ? { continuationGoal } : {}),
          ...workspaceCapture,
          completedAt: now,
        },
      });
      return {
        continue: false,
        stopReason: "Codex Pulse saved a local quota checkpoint.",
        systemMessage:
          chat.resumeMode === "native_goal"
            ? "Codex Pulse：检查点和原生 Goal 已暂停；额度恢复后将由 Codex 在当前聊天续跑。"
            : "Codex Pulse：检查点已保存在本机；额度恢复后会在当前聊天创建续跑 Goal，并在首次工具调用前校验工作区。",
      };
    }
    if (
      input.hook_event_name === "Interrupt" &&
      matchingChatTurn &&
      chat.status === "checkpoint_requested"
    ) {
      const cwd = path.resolve(input.cwd || chat.cwd || process.cwd());
      // Interrupt hooks have a three-second maximum. Use only the snapshot
      // already persisted at the boundary; never scan the workspace here.
      const workspaceCapture = {
        workspaceSnapshot: chat.checkpoint?.workspaceSnapshot || null,
        workspaceFingerprint: chat.checkpoint?.workspaceFingerprint || null,
      };
      await continuityStore.put({
        ...chat,
        status: "paused_quota",
        cwd,
        turnId: input.turn_id || chat.turnId,
        pausedAt: now,
        checkpoint: {
          ...(chat.checkpoint || {}),
          summary:
            "The turn was interrupted at the strict quota reserve. Inspect current workspace changes, then continue only the unfinished work.",
          ...workspaceCapture,
          completedAt: now,
        },
      });
      return {
        systemMessage: "Codex Pulse：中断状态已保存，额度恢复后将进行安全检查。",
      };
    }
    if (matchingChatTurn) {
      await continuityStore.put({
        ...chat,
        status: input.hook_event_name === "Stop" ? "complete" : "interrupted",
        autoResume: input.hook_event_name === "Stop" ? chat.autoResume : false,
        completedAt: input.hook_event_name === "Stop" ? now : chat.completedAt,
        interruptedAt: input.hook_event_name === "Interrupt" ? now : chat.interruptedAt,
      });
    }
    return input.hook_event_name === "Stop" ? {} : null;
  }

  return null;
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text || "{}");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const output = await handleHook(await readStdin());
    if (output != null) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    process.stderr.write(`Codex Pulse hook skipped: ${error.message}\n`);
    process.exitCode = 0;
  }
}
