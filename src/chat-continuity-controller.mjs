import { buildRecoveryGoal, buildContinuationGoal } from "./goal-continuation.mjs";

const USER_ACTION_METHODS = new Map([
  ["item/commandExecution/requestApproval", "approval_required"],
  ["item/fileChange/requestApproval", "approval_required"],
  ["item/permissions/requestApproval", "permission_required"],
  ["item/tool/requestUserInput", "user_input_required"],
  ["mcpServer/elicitation/request", "mcp_input_required"],
  ["item/tool/call", "dynamic_tool_required"],
]);

function remaining(summary) {
  return summary?.fiveHour?.remainingPercent ?? null;
}

function turnStatus(turn) {
  return turn?.status || null;
}

function recoveryReady(record, summary, quota) {
  if (quota == null) return false;
  const newWindow = record.pausedWindowKey !== summary.fiveHour?.resetsAt;
  const materiallyRecovered = quota >= (record.pausedRemaining ?? 0) + 30;
  return (
    (newWindow || materiallyRecovered) &&
    quota >= (record.resumeFloor ?? 50)
  );
}

function canBootstrapRecoveryGoal(record) {
  return Boolean(
    record.resumeUnavailableReason === "native_goal_required" &&
      record.checkpoint?.summary &&
      record.workspaceValidationMode === "pre_tool_hook_v1",
  );
}

function shouldAutoResume(record) {
  return Boolean(
    record.autoResume !== false ||
      (record.resumeUnavailableReason === "native_goal_required" &&
        record.checkpoint?.summary),
  );
}

function retryIsDue(record, now) {
  return record.retryNotBefore == null || now >= record.retryNotBefore;
}

function samePendingCheckpoint(current, expected) {
  return current?.turnId === expected.turnId &&
    ["checkpoint_requested", "checkpointing", "paused_quota"].includes(current?.status);
}

function retryableResumeError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return [
    "timeout",
    "timed out",
    "aborted",
    "app server exited",
    "econn",
    "enet",
    "eai_again",
    "socket",
    "network",
    "offline",
    "temporarily unavailable",
    "broken pipe",
    "not running",
    "503",
    "502",
    "429",
  ].some((needle) => message.includes(needle));
}

function retryDelaySeconds(retryCount) {
  return Math.min(900, 30 * 2 ** Math.max(0, retryCount - 1));
}

export class ChatContinuityController {
  constructor({
    client,
    store,
    lockManager = null,
    onEvent = async () => {},
  }) {
    this.client = client;
    this.store = store;
    this.lockManager = lockManager;
    this.onEvent = onEvent;
    this.serial = Promise.resolve();
  }

  reconcile(summary, options = {}) {
    return this.#serialize(() => this.#reconcile(summary, options));
  }

  handleNotification(message) {
    return this.#serialize(() => this.#handleNotification(message));
  }

  handleServerRequest(message) {
    return this.#serialize(() => this.#handleServerRequest(message));
  }

  #serialize(fn) {
    const next = this.serial.then(fn, fn);
    this.serial = next.catch(() => {});
    return next;
  }

  async #reconcile(summary, options) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    const quota = remaining(summary);
    const events = [];
    let records = await this.store.list();

    for (const record of records.filter(candidate => candidate.status === "observing" &&
      candidate.quotaPolicy === "strict_reserve" && retryIsDue(candidate, now))) {
      const event = await this.#guardObservedTurn(record, summary, now);
      if (event) { events.push(event); await this.onEvent(event); }
    }
    records = await this.store.list();

    for (const record of records.filter((candidate) =>
      ["checkpoint_requested", "checkpointing"].includes(candidate.status) &&
      retryIsDue(candidate, now)
    )) {
      const event = await this.#repairCheckpoint(record, now);
      if (event) {
        events.push(event);
        await this.onEvent(event);
      }
    }
    records = await this.store.list();

    for (const record of records.filter(
      (candidate) =>
        quota != null &&
        candidate.status === "paused_quota" &&
        !candidate.pauseNotifiedAt &&
        !recoveryReady(candidate, summary, quota),
    )) {
      await this.store.put({ ...record, pauseNotifiedAt: now });
      const event = {
        type: "chat_continuity_paused",
        sessionId: record.sessionId,
        resumePrepared: Boolean(record.checkpoint?.workspaceFingerprint),
        resumeMode: record.resumeMode || "manual",
        recoveryGoalBootstrap: canBootstrapRecoveryGoal(record),
      };
      events.push(event);
      await this.onEvent(event);
    }

    records = await this.store.list();

    for (const record of records.filter(
      (candidate) =>
        candidate.status === "native_goal_active" && retryIsDue(candidate, now),
    )) {
      const event = await this.#reconcileNativeGoal(record, now);
      if (event) {
        events.push(event);
        await this.onEvent(event);
      }
    }

    records = await this.store.list();

    for (const record of records.filter(
      (candidate) =>
        ["complete", "needs_attention"].includes(candidate.status) &&
        candidate.worktreeLock &&
        candidate.holdWorktreeLock !== true,
    )) {
      await this.#releaseOrReclaimLock(record);
    }

    for (const record of records.filter(
      (candidate) =>
        ["resuming", "running"].includes(candidate.status) &&
        candidate.worktreeLock &&
        retryIsDue(candidate, now),
    )) {
      const event = await this.#recoverAfterWatcherRestart(record, now);
      if (event) {
        events.push(event);
        await this.onEvent(event);
      }
    }

    if (quota == null) return events;
    records = await this.store.list();

    const candidates = records
      .filter(
        (record) =>
          record.status === "paused_quota" &&
          shouldAutoResume(record) &&
          !record.pendingRequest &&
          retryIsDue(record, now),
      )
      .sort((a, b) => (a.pausedAt || 0) - (b.pausedAt || 0));

    for (const record of candidates) {
      if (!recoveryReady(record, summary, quota)) {
        continue;
      }
      const event = await this.#resume(record, summary, now);
      if (event) {
        await this.onEvent(event);
        events.push(event);
        return events;
      }
    }
    return events;
  }

  #lockBelongsToCurrentWatcher(record) {
    return Boolean(
      this.lockManager?.holderId &&
        record.worktreeLock?.holderId === this.lockManager.holderId,
    );
  }

  async #readTurn(threadId, itemsView = "notLoaded") {
    if (this.client.readLatestTurn) return this.client.readLatestTurn(threadId, itemsView);
    const history = await this.client.request("thread/turns/list", {
      threadId, limit: 1, sortDirection: "desc", itemsView,
    });
    return history.data?.[0] || null;
  }

  async #guardObservedTurn(original, summary, now) {
    let turn;
    try { turn = await this.#readTurn(original.sessionId); }
    catch (error) {
      if (retryableResumeError(error)) {
        await this.#deferRetry(original, error, now, { status: "observing" });
        return null;
      }
      return this.#checkpointAttention(original, "thread_history_unavailable", now);
    }
    const current = await this.store.get(original.sessionId);
    if (current?.turnId !== original.turnId || current.status !== "observing") return null;
    if (!turn || turn.status === "unknown") return null;
    const quotaFailed = /usage.?limit.?exceeded/i.test(JSON.stringify(turn.error || {}));
    if (turn.id !== current.turnId || turn.status === "interrupted" ||
      (turn.status === "completed" && !current.initialGoal)) {
      await this.store.put({ ...current, status: "complete", autoResume: false });
      return null;
    }
    if (!quotaFailed && (remaining(summary) == null || remaining(summary) > 10)) {
      if (["completed", "failed"].includes(turn.status)) {
        await this.store.put({ ...current, status: "complete", autoResume: false });
      }
      return null;
    }
    // No further tool or Stop event is required: the early Hook baseline and
    // original Goal make inference/compaction failures recoverable too.
    const requested = await this.store.put({ ...current, status: "checkpoint_requested",
      checkpointRequestedAt: now,
      pausedWindowKey: current.observationWindowKey,
      pausedRemaining: quotaFailed ? 0 : remaining(summary), resumeFloor: 50,
      autoResume: Boolean(current.initialGoal),
      resumeMode: current.initialGoal ? "native_goal" : "manual",
      goalWasActive: Boolean(current.initialGoal),
      resumeUnavailableReason: current.initialGoal ? null : "native_goal_required",
      checkpoint: { ...current.reserveBaseline, quotaAtPause: quotaFailed ? 0 : remaining(summary),
        requestedAt: now, source: "watcher_no_tool_fallback" },
    });
    try {
      const result = await this.client.request("thread/goal/get", { threadId: current.sessionId });
      const goal = result.goal;
      if (goal?.status === "complete") {
        const latest = await this.store.get(current.sessionId);
        if (!samePendingCheckpoint(latest, requested)) return null;
        await this.store.put({ ...latest, status: "complete", autoResume: false });
        return null;
      }
      if (goal && (!current.initialGoal ||
        (current.observedGoalObjective || current.initialGoal.objective) !== goal.objective)) {
        return this.#checkpointAttention(requested, "native_goal_changed", now);
      }
      if (goal && goal.status !== "active") {
        return this.#checkpointAttention(requested, `native_goal_${goal.status}`, now);
      }
      if (goal) await this.client.request("thread/goal/set", {
        threadId: current.sessionId, status: "paused", origin: "automatic",
      });
      // Stop or a newer user turn may finish while either Goal RPC is pending.
      // Merge only into the current same-turn checkpoint, never the pre-RPC copy.
      const latest = await this.store.get(current.sessionId);
      if (!samePendingCheckpoint(latest, requested)) return null;
      await this.store.put({ ...latest, goalWasActive: Boolean(goal),
        goalAtPause: goal || null, resumeMode: goal ? "native_goal" : "manual",
        autoResume: Boolean(goal), resumeUnavailableReason: goal ? null : "native_goal_required",
      });
    } catch (error) {
      const latest = await this.store.get(current.sessionId);
      if (!samePendingCheckpoint(latest, requested)) return null;
      if (retryableResumeError(error)) {
        // Preserve the pending checkpoint; repair will recheck history after
        // connectivity returns rather than requiring another model event.
        await this.#deferRetry(latest, error, now, { status: latest.status });
        return null;
      }
      return this.#checkpointAttention(latest, "native_goal_state_unavailable", now);
    }
    return null;
  }

  async #repairCheckpoint(original, now) {
    // Events can be lost during sleep, network loss, or process death. Persisted
    // turn history is authoritative; elapsed time alone never means it stopped.
    let latest;
    try {
      latest = await this.#readTurn(original.sessionId, "full");
    } catch (error) {
      if (retryableResumeError(error)) {
        await this.#deferRetry(original, error, now, { status: original.status });
        return null;
      }
      return this.#checkpointAttention(original, "thread_history_unavailable", now);
    }
    if (!latest) return this.#checkpointAttention(original, "thread_history_unavailable", now);
    if (latest.id !== original.turnId) {
      return this.#checkpointAttention(original, "newer_thread_activity", now);
    }
    if (!["completed", "failed", "interrupted"].includes(turnStatus(latest))) return null;
    // A concurrent Stop may already have finished the checkpoint. Do not replace it.
    const record = await this.store.get(original.sessionId);
    if (!record || record.turnId !== original.turnId ||
      !["checkpoint_requested", "checkpointing"].includes(record.status)) return null;
    if (latest.status === "interrupted") {
      return this.#checkpointAttention(record, "resume_interrupted", now);
    }
    if (!record.checkpoint?.workspaceFingerprint) {
      // A new snapshot now would hide changes made during the pause.
      return this.#checkpointAttention(record, "checkpoint_missing_fingerprint", now);
    }
    const finalMessage = (latest.items || [])
      .filter((item) => item.type === "agentMessage")
      .map((item) => item.text || "").filter(Boolean).at(-1);
    const summary = record.checkpoint.summary || finalMessage || [
      "Completed: No final progress report was saved; inspect persisted thread history and current changes.",
      "Verification: No new verification is claimed.",
      "Remaining: Continue only the unfinished user-approved objective from this thread.",
      "Next action: Read the interrupted turn history, inspect the workspace, and reconstruct the remaining steps before editing.",
      "Blockers: The quota-paused turn ended before its final handoff was saved.",
    ].join("\n");
    const objective = record.initialGoal?.objective || record.goalAtPause?.objective;
    const continuationGoal = objective
      ? buildContinuationGoal({ originalObjective: objective, checkpointSummary: summary })
      : buildRecoveryGoal({ checkpointSummary: summary });
    await this.store.put({
      ...record, status: "paused_quota", pausedAt: now,
      autoResume: true,
      ...(objective ? {} : { resumeUnavailableReason: "native_goal_required" }),
      checkpoint: { ...record.checkpoint, summary, continuationGoal,
        completedAt: now, repairedFromTurnStatus: latest.status },
      retryNotBefore: null,
    });
    return null;
  }

  async #checkpointAttention(record, reason, now) {
    const current = await this.store.get(record.sessionId);
    if (current?.turnId !== record.turnId ||
      !["observing", "checkpoint_requested", "checkpointing"].includes(current?.status)) return null;
    await this.store.put({ ...current, status: "needs_attention", autoResume: false,
      blocker: reason, checkpointFailedAt: now });
    return { type: "chat_continuity_attention", sessionId: record.sessionId, reason };
  }

  async #recoverAfterWatcherRestart(original, now) {
    const claim = this.#lockBelongsToCurrentWatcher(original)
      ? { acquired: true, record: original }
      : await this.#claimLock(original);
    if (!claim.acquired) return null;
    const record = claim.record;
    let latestTurn;
    try {
      latestTurn = await this.#readTurn(record.sessionId);
    } catch (error) {
      if (retryableResumeError(error)) {
        await this.#deferRetry(record, error, now, { status: record.status });
        return null;
      }
      await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: "thread_history_unavailable",
        holdWorktreeLock: true,
        lastResumeError: error.message,
      });
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "thread_history_unavailable",
      };
    }

    if (record.status === "resuming" && latestTurn?.id === record.turnId &&
      ["completed", "failed", "interrupted"].includes(turnStatus(latestTurn))) {
      const paused = await this.store.put({
        ...record,
        status: "paused_quota",
        holdWorktreeLock: false,
        lastResumeError: "Watcher restarted before the resumed turn was created.",
      });
      await this.#releaseLock(paused);
      return null;
    }

    if (!latestTurn || latestTurn.id !== record.turnId) {
      const terminal = ["completed", "failed", "interrupted"].includes(
        turnStatus(latestTurn),
      );
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: "resume_state_unknown",
        holdWorktreeLock: !terminal,
        latestTurnId: latestTurn?.id || null,
      });
      if (terminal) await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "resume_state_unknown",
      };
    }

    if (turnStatus(latestTurn) === "completed") {
      const completed = await this.store.put({
        ...record,
        status: "complete",
        holdWorktreeLock: false,
        completedAt: now,
      });
      await this.#releaseLock(completed);
      return {
        type: "chat_continuity_complete",
        sessionId: record.sessionId,
        turnId: record.turnId,
      };
    }

    if (["failed", "interrupted"].includes(turnStatus(latestTurn))) {
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: `resume_${turnStatus(latestTurn)}`,
        holdWorktreeLock: false,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: `resume_${turnStatus(latestTurn)}`,
      };
    }

    await this.store.put({
      ...record,
      status: "needs_attention",
      blocker: "resume_state_unknown",
      holdWorktreeLock: true,
    });
    return {
      type: "chat_continuity_attention",
      sessionId: record.sessionId,
      reason: "resume_state_unknown",
    };
  }

  async #resume(original, summary, now) {
    const claim = await this.#claimLock(original);
    if (!claim.acquired) return null;
    const record = claim.record;
    let latestTurn;
    try {
      latestTurn = await this.#readTurn(record.sessionId);
    } catch (error) {
      if (retryableResumeError(error)) {
        await this.#deferRetry(record, error, now, { status: "paused_quota" });
        return null;
      }
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: "thread_history_unavailable",
        lastResumeError: error.message,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "thread_history_unavailable",
      };
    }
    if (!latestTurn || latestTurn.id !== record.turnId) {
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: "newer_thread_activity",
        latestTurnId: latestTurn?.id || null,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "newer_thread_activity",
      };
    }

    if (!["completed", "failed"].includes(turnStatus(latestTurn))) {
      // An unloaded replay is not authoritative evidence that the Desktop
      // writer is idle. Wait for a persisted terminal lifecycle marker.
      return null;
    }

    if (record.workspaceValidationMode !== "pre_tool_hook_v1") {
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        autoResume: false,
        blocker: "workspace_validation_upgrade_required",
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "workspace_validation_upgrade_required",
      };
    }

    const recoveryGoalBootstrap = canBootstrapRecoveryGoal(record);
    if (
      (record.resumeMode !== "native_goal" || record.goalWasActive !== true) &&
      !recoveryGoalBootstrap
    ) {
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        autoResume: false,
        blocker: "native_goal_required",
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "native_goal_required",
      };
    }

    const resuming = await this.store.put({
      ...record,
      status: "resuming",
      workspaceValidationRequired: true,
      workspaceValidatedAt: null,
      holdWorktreeLock: false,
      resumeWindowKey: summary.fiveHour?.resetsAt || null,
      lastResumeError: null,
    });
    const generatedRecoveryGoal = recoveryGoalBootstrap
      ? buildRecoveryGoal({ checkpointSummary: record.checkpoint?.summary })
      : null;
    const continuationObjective =
      record.checkpoint?.continuationGoal?.objective ||
      generatedRecoveryGoal?.objective ||
      null;
    try {
      await this.client.assertWakeReady?.(record);
      const currentGoal = await this.client.request("thread/goal/get", {
        threadId: record.sessionId,
      });
      if (!currentGoal.goal) {
        if (!recoveryGoalBootstrap || !continuationObjective) {
          const blocked = await this.store.put({
            ...resuming,
            status: "needs_attention",
            blocker: "native_goal_missing",
            lastResumeError: "The native Goal no longer exists.",
          });
          await this.#releaseLock(blocked);
          return {
            type: "chat_continuity_attention",
            sessionId: record.sessionId,
            reason: "native_goal_missing",
          };
        }
        await this.client.request("thread/goal/set", {
          threadId: record.sessionId,
          objective: continuationObjective,
          status: "active",
          origin: "automatic",
        });
      } else {
        const expectedObjectives = new Set(
          [
            record.goalAtPause?.objective,
            record.initialGoal?.objective,
            continuationObjective,
          ].filter((value) => typeof value === "string" && value.length > 0),
        );
        if (
          expectedObjectives.size > 0 &&
          !expectedObjectives.has(currentGoal.goal.objective)
        ) {
          const blocked = await this.store.put({
            ...resuming,
            status: "needs_attention",
            blocker: "native_goal_changed",
            lastResumeError: "The native Goal changed while Codex Pulse was paused.",
          });
          await this.#releaseLock(blocked);
          return {
            type: "chat_continuity_attention",
            sessionId: record.sessionId,
            reason: "native_goal_changed",
          };
        }
        if (currentGoal.goal.status === "complete") {
          const completed = await this.store.put({
            ...resuming,
            status: "complete",
            holdWorktreeLock: false,
            completedAt: now,
          });
          await this.#releaseLock(completed);
          return {
            type: "chat_continuity_complete",
            sessionId: record.sessionId,
            turnId: record.turnId,
          };
        }
        if (!["active", "paused"].includes(currentGoal.goal.status)) {
          const reason = `native_goal_${currentGoal.goal.status || "state_unavailable"}`;
          const blocked = await this.store.put({
            ...resuming,
            status: "needs_attention",
            blocker: reason,
            lastResumeError: "The native Goal is no longer safely resumable.",
          });
          await this.#releaseLock(blocked);
          return {
            type: "chat_continuity_attention",
            sessionId: record.sessionId,
            reason,
          };
        }
        if (
          currentGoal.goal.status !== "active" ||
          (continuationObjective && currentGoal.goal.objective !== continuationObjective)
        ) {
          await this.client.request("thread/goal/set", {
            threadId: record.sessionId,
            ...(continuationObjective ? { objective: continuationObjective } : {}),
            status: "active",
            origin: "automatic",
          });
        }
      }
      const afterActivation = await this.store.get(record.sessionId);
      if (afterActivation?.status === "needs_attention") return null;
      const activated = await this.store.put({
        ...resuming,
        ...(afterActivation || {}),
        status: "native_goal_active",
        holdWorktreeLock: false,
        autoResume: true,
        resumeMode: "native_goal",
        goalWasActive: true,
        resumeUnavailableReason: null,
        checkpoint: {
          ...record.checkpoint,
          ...(generatedRecoveryGoal
            ? { continuationGoal: generatedRecoveryGoal }
            : {}),
        },
        pausedTurnId: record.turnId,
        resumedAt: now,
        resumeCount: (record.resumeCount || 0) + 1,
        retryCount: 0,
        retryNotBefore: null,
        wakeSourceTurnId: record.turnId,
        wakeAttempts: 0,
      });
      if (this.client.wakeThread && !activated.executionObservedAt && activated.turnId === record.turnId) {
        await this.#deliverWake(activated, now);
      }
      return {
        type: "chat_continuity_resumed",
        activationPhase: "requested",
        threadId: record.sessionId,
        sessionId: record.sessionId,
        resumeMode: "native_goal",
      };
    } catch (error) {
      if (retryableResumeError(error)) {
        await this.#deferRetry(resuming, error, now, { status: "paused_quota" });
        return null;
      }
      const blocked = await this.store.put({
        ...resuming,
        status: "needs_attention",
        blocker: error.code === "PULSE_HOOK_REVIEW_REQUIRED" ? "hook_review_required" : "resume_incomplete",
        lastResumeError: error.message,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: error.code === "PULSE_HOOK_REVIEW_REQUIRED" ? "hook_review_required" : "resume_incomplete",
      };
    }
  }

  async #deliverWake(record, now) {
    const attempted = await this.store.put({ ...record, wakeAttemptedAt: now,
      wakeAttempts: (record.wakeAttempts || 0) + 1,
      wakeRetryAt: now + retryDelaySeconds((record.wakeAttempts || 0) + 1),
    });
    try {
      await this.client.assertWakeReady?.(attempted);
      await this.client.wakeThread({ ...attempted, pausedTurnId: attempted.wakeSourceTurnId });
      const latest = await this.store.get(record.sessionId);
      // A queued prompt may already have passed first-tool validation. Preserve
      // that newer state instead of writing the pre-command snapshot over it.
      if (latest?.wakeSourceTurnId === attempted.wakeSourceTurnId) {
        await this.store.put({ ...latest, wakeSubmittedAt: now, lastWakeError: null });
      }
    } catch (error) {
      const latest = await this.store.get(record.sessionId);
      if (latest?.wakeSourceTurnId === attempted.wakeSourceTurnId) {
        await this.store.put({ ...latest, lastWakeError: String(error.message).slice(0, 300) });
      }
      // Keep the armed validation and pending execution state. Retried queue
      // messages have the same admission key and cannot start this task twice.
    }
  }

  async #reconcileNativeGoal(original, now) {
    const claim = this.#lockBelongsToCurrentWatcher(original)
      ? { acquired: true, record: original }
      : await this.#claimLock(original);
    if (!claim.acquired) return null;
    const record = claim.record;
    let goal;
    let latestTurn;
    try {
      const [goalResult, observedTurn] = await Promise.all([
        this.client.request("thread/goal/get", { threadId: record.sessionId }),
        this.#readTurn(record.sessionId),
      ]);
      goal = goalResult.goal || null;
      latestTurn = observedTurn;
    } catch (error) {
      if (retryableResumeError(error)) {
        await this.#deferRetry(record, error, now, {
          status: "native_goal_active",
        });
        return null;
      }
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: "native_goal_state_unavailable",
        lastResumeError: error.message,
      });
      await this.#releaseOrReclaimLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "native_goal_state_unavailable",
      };
    }

    if (goal?.status === "complete") {
      const completed = await this.store.put({
        ...record,
        status: "complete",
        turnId: latestTurn?.id || record.turnId,
        completedAt: now,
        holdWorktreeLock: false,
      });
      await this.#releaseOrReclaimLock(completed);
      return {
        type: "chat_continuity_complete",
        sessionId: record.sessionId,
        turnId: latestTurn?.id || record.turnId,
      };
    }

    if (!goal || ["blocked", "paused"].includes(goal.status)) {
      const reason = !goal ? "native_goal_missing" : `native_goal_${goal.status}`;
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: reason,
        turnId: latestTurn?.id || record.turnId,
        holdWorktreeLock: false,
      });
      await this.#releaseOrReclaimLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason,
      };
    }

    // PreToolUse may already have updated turnId while validating the first
    // resumed tool. Compare against the immutable pause-cycle source instead.
    const sourceTurnId = record.pausedTurnId || record.wakeSourceTurnId || record.turnId;
    if (latestTurn?.id && latestTurn.id !== sourceTurnId &&
      ["inProgress", "completed", "failed", "interrupted"].includes(turnStatus(latestTurn))) {
      // Goal/history RPCs can outlive a Hook update. Never write the stale
      // pre-RPC snapshot over a completed validation or a new user turn.
      const current = await this.store.get(record.sessionId);
      if (current?.status !== "native_goal_active" ||
        current.resumedAt !== record.resumedAt ||
        current.pausedTurnId !== record.pausedTurnId) return null;
      await this.store.put({ ...current, turnId: latestTurn.id,
        executionObservedAt: current.executionObservedAt || now });
      if (!current.executionObservedAt) return {
        type: "chat_continuity_resumed", activationPhase: "started",
        sessionId: record.sessionId, threadId: record.sessionId,
        resumeMode: "native_goal", turnId: latestTurn.id,
      };
    } else if (!record.executionObservedAt && this.client.wakeThread &&
      record.wakeAttempts < 3 && now >= (record.wakeRetryAt || 0) &&
      ["completed", "failed"].includes(turnStatus(latestTurn))) {
      const expected = record.checkpoint?.continuationGoal?.objective || record.initialGoal?.objective;
      if (expected && goal.objective !== expected) {
        const blocked = await this.store.put({ ...record, status: "needs_attention",
          blocker: "native_goal_changed", autoResume: false, holdWorktreeLock: false });
        await this.#releaseOrReclaimLock(blocked);
        return { type: "chat_continuity_attention", sessionId: record.sessionId, reason: "native_goal_changed" };
      }
      await this.#deliverWake(record, now);
    } else if (!record.executionObservedAt &&
      now - (record.resumedAt || now) >= 180 &&
      ["completed", "failed", "interrupted"].includes(turnStatus(latestTurn))) {
      // A successful Goal RPC is not evidence that Desktop dispatched a turn.
      // Keep observing history across sleep/restart; never start a second writer.
      const expectedObjective = record.checkpoint?.continuationGoal?.objective ||
        record.initialGoal?.objective || record.goalAtPause?.objective;
      if (expectedObjective && goal.objective === expectedObjective) {
        await this.client.request("thread/goal/set", {
          threadId: record.sessionId, status: "paused", origin: "automatic",
        });
      }
      const blocked = await this.store.put({ ...record, status: "needs_attention",
        blocker: "native_goal_not_started", holdWorktreeLock: false });
      await this.#releaseOrReclaimLock(blocked);
      return { type: "chat_continuity_attention", sessionId: record.sessionId,
        reason: "native_goal_not_started" };
    }
    return null;
  }

  async #handleNotification(message) {
    if (message.method !== "turn/completed") return;
    const params = message.params || {};
    const turnId = params.turnId || params.turn?.id;
    const records = await this.store.list();
    const record = records.find(
      (candidate) =>
        candidate.status === "running" &&
        candidate.turnId === turnId,
    );
    if (!record) return;
    if (params.turn?.status === "completed") {
      const completed = await this.store.put({
        ...record,
        status: "complete",
        holdWorktreeLock: false,
        completedAt: Math.floor(Date.now() / 1000),
      });
      await this.#releaseLock(completed);
      await this.onEvent({
        type: "chat_continuity_complete",
        sessionId: record.sessionId,
        turnId,
      });
      return;
    }
    if (["failed", "interrupted"].includes(params.turn?.status)) {
      const reason = `resume_${params.turn.status}`;
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: reason,
        holdWorktreeLock: false,
      });
      await this.#releaseLock(blocked);
      await this.onEvent({
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason,
      });
    }
  }

  async #handleServerRequest(message) {
    const reason = USER_ACTION_METHODS.get(message.method);
    if (!reason) return;
    const params = message.params || {};
    const records = await this.store.list();
    const record = records.find(
      (candidate) =>
        ["resuming", "running"].includes(candidate.status) &&
        candidate.turnId === params.turnId,
    );
    if (!record) return;
    const blocked = await this.store.put({
      ...record,
      status: "needs_attention",
      blocker: reason,
      autoResume: false,
      holdWorktreeLock: true,
      pendingRequest: {
        method: message.method,
        requestId: message.id,
        receivedAt: Math.floor(Date.now() / 1000),
      },
    });
    let safeToRelease = !record.turnId;
    if (record.turnId) {
      try {
        await this.client.request("turn/interrupt", {
          threadId: record.sessionId,
          turnId: record.turnId,
        });
        safeToRelease = true;
      } catch {
        // Keep the lock when interruption cannot be proven. A second task must
        // never enter the same checkout while the resumed turn may still run.
      }
    }
    if (safeToRelease) {
      const releasable = await this.store.put({
        ...blocked,
        holdWorktreeLock: false,
      });
      await this.#releaseLock(releasable);
    }
    await this.onEvent({
      type: "chat_continuity_attention",
      sessionId: record.sessionId,
      reason,
    });
  }

  async #deferRetry(record, error, now, { status }) {
    const retryCount = (record.retryCount || 0) + 1;
    return this.store.put({
      ...record,
      status,
      blocker: null,
      holdWorktreeLock: true,
      lastResumeError: error.message,
      retryCount,
      retryNotBefore: now + retryDelaySeconds(retryCount),
    });
  }

  async #claimLock(record) {
    if (!this.lockManager) return { acquired: true, record };
    const result = await this.lockManager.acquire(record.cwd, record.id);
    if (!result.acquired) return { acquired: false, record, reason: result.reason };
    const latest = await this.store.get(record.sessionId);
    if (!latest || latest.status !== record.status || latest.turnId !== record.turnId) {
      await this.lockManager.release(result.handle);
      return { acquired: false, record, reason: "record_changed" };
    }
    const claimed = await this.store.put({ ...latest, worktreeLock: result.handle });
    return { acquired: true, record: claimed };
  }

  async #releaseLock(record) {
    if (!this.lockManager || !record.worktreeLock) return;
    const released = await this.lockManager.release(record.worktreeLock);
    if (released) await this.store.put({ ...record, worktreeLock: null });
  }

  async #releaseOrReclaimLock(record) {
    if (!this.lockManager || !record.worktreeLock) return;
    if (await this.lockManager.release(record.worktreeLock)) {
      await this.store.put({ ...record, worktreeLock: null });
      return;
    }
    const reclaimed = await this.lockManager.acquire(record.cwd, record.id);
    if (!reclaimed.acquired) return;
    if (await this.lockManager.release(reclaimed.handle)) {
      await this.store.put({ ...record, worktreeLock: null });
    }
  }
}
