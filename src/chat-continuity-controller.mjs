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

function recoveryPrompt(record) {
  const checkpoint = record.checkpoint || {};
  const summary = String(checkpoint.summary || "No textual checkpoint was captured.").slice(
    0,
    6_000,
  );
  return [
    "Codex Pulse restored this chat after its personal quota recovered.",
    "Continue the user's unfinished task in this same chat.",
    "First inspect the current workspace and the checkpoint below. Preserve existing changes.",
    "Do not redo completed work. Stop and ask the user if the workspace diverged, a permission is required, newer user activity exists, or the task is already complete.",
    "",
    "Local checkpoint:",
    summary,
  ].join("\n");
}

export class ChatContinuityController {
  constructor({ client, store, workspace, lockManager = null, onEvent = async () => {} }) {
    this.client = client;
    this.store = store;
    this.workspace = workspace;
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
      };
      events.push(event);
      await this.onEvent(event);
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
        !this.#lockBelongsToCurrentWatcher(candidate),
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
          record.autoResume !== false &&
          !record.pendingRequest,
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
    if (!(await this.workspace.exists(original.cwd))) {
      const blocked = await this.store.put({
        ...original,
        status: "needs_attention",
        blocker: "cwd_missing",
      });
      await this.#releaseLock(blocked);
      return { type: "chat_continuity_attention", sessionId: original.sessionId, reason: "cwd_missing" };
    }

    const claim = await this.#claimLock(original);
    if (!claim.acquired) return null;
    const record = claim.record;
    const snapshotComparison = record.checkpoint?.workspaceSnapshot
      ? await this.workspace.compareSnapshot(
          record.cwd,
          record.checkpoint.workspaceSnapshot,
        )
      : null;
    const fingerprint = snapshotComparison
      ? null
      : await this.workspace.fingerprint(record.cwd, {
          strategy: String(record.checkpoint?.workspaceFingerprint || "").startsWith("fs:")
            ? "filesystem"
            : undefined,
        });
    if (
      snapshotComparison?.verifiable === false ||
      (!snapshotComparison &&
        (record.checkpoint?.workspaceFingerprint == null || fingerprint == null))
    ) {
      const reason = !snapshotComparison && record.checkpoint?.workspaceFingerprint == null
        ? "checkpoint_missing_fingerprint"
        : "workspace_unverifiable";
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: reason,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason,
      };
    }
    if (
      snapshotComparison
        ? !snapshotComparison.same
        : fingerprint !== record.checkpoint.workspaceFingerprint
    ) {
      const blocked = await this.store.put({
        ...record,
        status: "needs_attention",
        blocker: "workspace_changed",
        blockerDetails: snapshotComparison
          ? { changedScopes: snapshotComparison.changedScopes }
          : null,
      });
      await this.#releaseLock(blocked);
      return {
        type: "chat_continuity_attention",
        sessionId: record.sessionId,
        reason: "workspace_changed",
        changedScopes: snapshotComparison?.changedScopes || [],
      };
    }

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

    const resuming = await this.store.put({
      ...record,
      status: "resuming",
      holdWorktreeLock: false,
      resumeWindowKey: summary.fiveHour?.resetsAt || null,
      lastResumeError: null,
    });
    try {
      await this.client.request("thread/resume", {
        threadId: record.sessionId,
        excludeTurns: true,
      });
      const turn = await this.client.request("turn/start", {
        threadId: record.sessionId,
        input: [{ type: "text", text: recoveryPrompt(record) }],
      });
      await this.store.put({
        ...resuming,
        status: "running",
        holdWorktreeLock: false,
        turnId: turn.turn.id,
        resumedAt: now,
        resumeCount: (record.resumeCount || 0) + 1,
      });
      return {
        type: "chat_continuity_resumed",
        sessionId: record.sessionId,
        turnId: turn.turn.id,
      };
    } catch (error) {
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
