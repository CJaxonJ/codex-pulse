import { buildRecoveryGoal } from "./goal-continuation.mjs";

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

  async #recoverAfterWatcherRestart(original, now) {
    const claim = this.#lockBelongsToCurrentWatcher(original)
      ? { acquired: true, record: original }
      : await this.#claimLock(original);
    if (!claim.acquired) return null;
    const record = claim.record;
    let latestTurn;
    try {
      const history = await this.client.request("thread/turns/list", {
        threadId: record.sessionId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      latestTurn = history.data?.[0] || null;
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

    if (record.status === "resuming" && latestTurn?.id === record.turnId) {
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
      const history = await this.client.request("thread/turns/list", {
        threadId: record.sessionId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      latestTurn = history.data?.[0] || null;
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
      await this.store.put({
        ...resuming,
        status: "native_goal_active",
        holdWorktreeLock: false,
        autoResume: true,
        resumeMode: "native_goal",
        goalWasActive: true,
        resumeUnavailableReason: null,
        workspaceValidationRequired: true,
        workspaceValidatedAt: null,
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
      });
      return {
        type: "chat_continuity_resumed",
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
        blocker: "resume_incomplete",
        lastResumeError: error.message,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "resume_incomplete",
      };
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
      const [goalResult, history] = await Promise.all([
        this.client.request("thread/goal/get", { threadId: record.sessionId }),
        this.client.request("thread/turns/list", {
          threadId: record.sessionId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }),
      ]);
      goal = goalResult.goal || null;
      latestTurn = history.data?.[0] || null;
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

    if (latestTurn?.id && latestTurn.id !== record.turnId) {
      await this.store.put({ ...record, turnId: latestTurn.id });
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
    const claimed = await this.store.put({ ...record, worktreeLock: result.handle });
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
