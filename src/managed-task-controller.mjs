import { createHash, randomUUID } from "node:crypto";

const DRAIN_REMAINING = 15;
const HARD_PAUSE_REMAINING = 10;
const FINISH_CURRENT_HARD_REMAINING = 5;
const DEADLINE_DRAIN_REMAINING = 5;
const DEADLINE_HARD_REMAINING = 1;
const DRAIN_GRACE_SECONDS = 10 * 60;
const MIN_START_REMAINING = 50;
const ACTIVE_STATUSES = new Set(["starting", "running", "draining", "pausing", "resuming"]);
const PRIORITY_SCORE = { high: 3, normal: 2, low: 1 };
const SIZE_SCORE = { small: 0, medium: 1, large: 2 };
const USER_ACTION_METHODS = new Map([
  ["item/commandExecution/requestApproval", "approval_required"],
  ["item/fileChange/requestApproval", "approval_required"],
  ["item/permissions/requestApproval", "permission_required"],
  ["item/tool/requestUserInput", "user_input_required"],
  ["mcpServer/elicitation/request", "mcp_input_required"],
  ["item/tool/call", "dynamic_tool_required"],
]);

function nowSeconds(options) {
  return options.now ?? Math.floor(Date.now() / 1000);
}

function remaining(summary) {
  return summary?.fiveHour?.remainingPercent ?? null;
}

function effectiveRemaining(summary) {
  const quota = remaining(summary);
  if (quota != null) return quota;
  return String(summary?.planType || "").toLowerCase().includes("pro") ? 100 : null;
}

function quotaPolicy(task) {
  return task.quotaPolicy || "finish_current";
}

function shouldPause(task, quota, now) {
  const policy = quotaPolicy(task);
  if (policy === "strict_reserve") return quota <= HARD_PAUSE_REMAINING;
  const graceExpired =
    task.status === "draining" &&
    task.drainRequestedAt != null &&
    now - task.drainRequestedAt >= DRAIN_GRACE_SECONDS;
  if (policy === "deadline") {
    return quota <= DEADLINE_HARD_REMAINING || graceExpired;
  }
  return quota <= FINISH_CURRENT_HARD_REMAINING || graceExpired;
}

function shouldDrain(task, quota) {
  if (task.status !== "running") return false;
  return quotaPolicy(task) === "deadline"
    ? quota <= DEADLINE_DRAIN_REMAINING
    : quota <= DRAIN_REMAINING;
}

function openUsageSegment(task, summary, now, reason) {
  return [
    ...(task.usageSegments || []),
    {
      startedAt: now,
      windowKey: summary?.fiveHour?.resetsAt || null,
      startRemaining: remaining(summary),
      model: task.model,
      reason,
    },
  ];
}

function closeUsageSegment(task, summary, now, endReason) {
  const segments = [...(task.usageSegments || [])];
  const index = segments.findLastIndex((segment) => segment.endedAt == null);
  if (index < 0) return segments;
  const segment = segments[index];
  const endRemaining = remaining(summary);
  const sameWindow =
    segment.windowKey != null && segment.windowKey === summary?.fiveHour?.resetsAt;
  segments[index] = {
    ...segment,
    endedAt: now,
    endRemaining,
    consumedPercent:
      sameWindow && segment.startRemaining != null && endRemaining != null
        ? Math.max(0, segment.startRemaining - endRemaining)
        : null,
    durationSeconds: Math.max(0, now - segment.startedAt),
    endReason,
  };
  return segments;
}

function diffHash(diff) {
  if (!diff) return null;
  return createHash("sha256").update(diff).digest("hex");
}

function recoveryPrompt(task) {
  return `Resume this task after a Codex quota pause. First inspect the current workspace and compare it with the checkpoint. Preserve existing changes. Continue from the first unfinished step, run the listed verification, and stop if the workspace diverged, an approval is needed, or the objective is already complete.\n\nCheckpoint:\n${JSON.stringify(task.checkpoint, null, 2)}`;
}

function checkpointFor(
  task,
  quota,
  workspaceFingerprint,
  now,
  pauseReason = "five_hour_quota_guard",
) {
  const plan = task.lastPlan || [];
  return {
    threadId: task.threadId,
    turnId: task.turnId,
    cwd: task.cwd,
    objective: task.objective,
    pauseReason,
    quotaAtPause: quota,
    completed: plan.filter((step) => step.status === "completed"),
    remaining: plan.filter((step) => step.status !== "completed"),
    currentStep: plan.find((step) => step.status === "inProgress")?.step || null,
    verification: task.verification || [],
    blockers: task.blockers || [],
    lastPlan: plan,
    diffFingerprint: task.lastDiffHash,
    workspaceFingerprint,
    permissionMode: task.permissionMode || "default",
    pausedAt: now,
    resumeState: "waiting_for_personal_reset",
  };
}

export class ManagedTaskController {
  constructor({
    client,
    store,
    workspace,
    lockManager = null,
    onEvent = async () => {},
  }) {
    this.client = client;
    this.store = store;
    this.workspace = workspace;
    this.lockManager = lockManager;
    this.onEvent = onEvent;
    this.serial = Promise.resolve();
    this.lastSummary = null;
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
    const now = nowSeconds(options);
    this.lastSummary = summary;
    const quota = effectiveRemaining(summary);
    const events = [];
    let tasks = await this.store.list();
    let activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    const hadActiveTasks = activeTasks.length > 0;

    for (const originalTask of activeTasks.filter(
      (task) => task.worktreeLock && !this.#lockBelongsToCurrentWatcher(task),
    )) {
      const claim = await this.#claimLock(originalTask);
      if (!claim.acquired) continue;
      const event = await this.#recoverAfterWatcherRestart(claim.task, summary, now);
      if (event) {
        events.push(event);
        await this.onEvent(event);
      }
    }

    if (quota == null) return events;
    tasks = await this.store.list();
    activeTasks = tasks.filter((task) => ACTIVE_STATUSES.has(task.status));
    for (const originalTask of activeTasks) {
      if (originalTask.worktreeLock && !this.#lockBelongsToCurrentWatcher(originalTask)) {
        continue;
      }
      const claim = await this.#claimLock(originalTask);
      if (!claim.acquired) continue;
      const task = claim.task;
      let event = null;
      if (
        ["running", "draining"].includes(task.status) &&
        shouldPause(task, quota, now)
      ) {
        event = await this.#pause(task, summary, now);
      } else if (shouldDrain(task, quota)) {
        event = await this.#drain(task, summary, now);
      }
      if (event) {
        events.push(event);
        await this.onEvent(event);
      }
    }
    // Never fill a newly released slot in the same reconciliation cycle. This
    // gives App Server completion/interrupt notifications time to settle.
    if (hadActiveTasks || activeTasks.length) return events;

    const candidates = tasks
      .filter((task) => task.status === "queued" || task.status === "paused_quota")
      .sort((a, b) => {
        const priority =
          (PRIORITY_SCORE[b.priority || "normal"] || 0) -
          (PRIORITY_SCORE[a.priority || "normal"] || 0);
        if (priority) return priority;
        const continuity = Number(b.status === "paused_quota") - Number(a.status === "paused_quota");
        if (continuity) return continuity;
        const size =
          (SIZE_SCORE[a.taskSize || "medium"] || 0) -
          (SIZE_SCORE[b.taskSize || "medium"] || 0);
        return size || a.createdAt - b.createdAt;
      });
    for (const task of candidates) {
      let event = null;
      if (
        task.status === "paused_quota" &&
        task.autoResume &&
        !task.pendingRequest
      ) {
        const newWindow = task.pausedWindowKey !== summary.fiveHour?.resetsAt;
        const materiallyRecovered = quota >= (task.pausedRemaining ?? 0) + 30;
        if ((newWindow || materiallyRecovered) && quota >= task.resumeFloor) {
          event = await this.#resume(task, summary, now);
        }
      } else if (
        task.status === "queued" &&
        quota >= (task.startFloor ?? MIN_START_REMAINING) &&
        (task.retryNotBefore == null || now >= task.retryNotBefore)
      ) {
        event = await this.#start(task, summary, now);
      }
      if (event) {
        events.push(event);
        await this.onEvent(event);
        break;
      }
    }
    return events;
  }

  #lockBelongsToCurrentWatcher(task) {
    return Boolean(
      this.lockManager?.holderId &&
        task.worktreeLock?.holderId === this.lockManager.holderId,
    );
  }

  async #recoverAfterWatcherRestart(task, summary, now) {
    if (!task.threadId || !task.turnId) {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "runtime_state_unknown",
      });
      await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "runtime_state_unknown",
      };
    }

    let latestTurn;
    try {
      const history = await this.client.request("thread/turns/list", {
        threadId: task.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      latestTurn = history.data?.[0] || null;
    } catch {
      await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "thread_history_unavailable",
        holdWorktreeLock: true,
      });
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "thread_history_unavailable",
      };
    }

    if (task.status === "resuming" && latestTurn?.id === task.turnId) {
      const paused = await this.store.put({
        ...task,
        status: "paused_quota",
        holdWorktreeLock: false,
        lastResumeError: "Watcher restarted before the resumed turn was created.",
      });
      await this.#releaseLock(paused);
      return null;
    }

    const terminal = ["completed", "failed", "interrupted"].includes(
      latestTurn?.status,
    );
    if (!latestTurn || latestTurn.id !== task.turnId) {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "runtime_state_unknown",
        latestTurnId: latestTurn?.id || null,
        holdWorktreeLock: !terminal,
      });
      if (terminal) await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "runtime_state_unknown",
      };
    }

    if (latestTurn.status === "completed") {
      if (["draining", "pausing"].includes(task.status)) {
        const workspaceFingerprint = await this.workspace.fingerprint(task.cwd);
        const paused = await this.store.put({
          ...task,
          status: "paused_quota",
          holdWorktreeLock: false,
          checkpoint: checkpointFor(
            task,
            remaining(summary),
            workspaceFingerprint,
            now,
            "watcher_restart_after_drain",
          ),
          pausedWindowKey: summary.fiveHour?.resetsAt || null,
          pausedRemaining: remaining(summary),
          pausedAt: now,
          usageSegments: closeUsageSegment(
            task,
            summary,
            now,
            "watcher_restart_after_drain",
          ),
        });
        await this.#releaseLock(paused);
        return { type: "managed_task_paused", taskId: task.id };
      }
      const completed = await this.store.put({
        ...task,
        status: "complete",
        holdWorktreeLock: false,
        completedAt: now,
        usageSegments: closeUsageSegment(
          task,
          summary,
          now,
          "watcher_restart_completed",
        ),
      });
      await this.#releaseLock(completed);
      return { type: "managed_task_complete", taskId: task.id };
    }

    if (["failed", "interrupted"].includes(latestTurn.status)) {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: `turn_${latestTurn.status}`,
        holdWorktreeLock: false,
      });
      await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: `turn_${latestTurn.status}`,
      };
    }

    await this.store.put({
      ...task,
      status: "needs_attention",
      blocker: "runtime_state_unknown",
      holdWorktreeLock: true,
    });
    return {
      type: "managed_task_attention",
      taskId: task.id,
      reason: "runtime_state_unknown",
    };
  }

  async #start(task, summary, now) {
    if (!(await this.workspace.exists(task.cwd))) {
      await this.store.put({ ...task, status: "needs_attention", blocker: "cwd_missing" });
      return { type: "managed_task_attention", taskId: task.id, reason: "cwd_missing" };
    }
    const claim = await this.#claimLock(task);
    if (!claim.acquired) return null;
    task = claim.task;
    let starting = await this.store.put({
      ...task,
      status: "starting",
      startingAt: now,
      lastStartError: null,
    });
    try {
      const started = await this.client.request("thread/start", {
        model: task.model,
        cwd: task.cwd,
        approvalPolicy: "never",
        // The desktop-bundled App Server currently accepts the kebab-case
        // wire enum even though newer protocol docs show camelCase.
        // scripts/e2e-managed-task.mjs is the release gate for version drift.
        sandbox: "workspace-write",
        serviceName: "codex_pulse",
      });
      const threadId = started.thread.id;
      starting = await this.store.put({ ...starting, threadId });
      const turn = await this.client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: task.objective }],
      });
      await this.store.put({
        ...starting,
        status: "running",
        threadId,
        turnId: turn.turn.id,
        startedAt: now,
        startWindowKey: summary.fiveHour?.resetsAt || null,
        usageSegments: openUsageSegment(starting, summary, now, "initial_start"),
      });
      return { type: "managed_task_started", taskId: task.id, threadId };
    } catch (error) {
      if (starting.threadId) {
        const failed = await this.store.put({
          ...starting,
          status: "needs_attention",
          blocker: "start_incomplete",
          lastStartError: error.message,
        });
        await this.#releaseLock(failed);
      } else {
        const failed = await this.store.put({
          ...starting,
          status: "queued",
          retryNotBefore: now + 60,
          lastStartError: error.message,
        });
        await this.#releaseLock(failed);
      }
      throw error;
    }
  }

  async #drain(task, summary, now) {
    const policy = quotaPolicy(task);
    await this.client.request("turn/steer", {
      threadId: task.threadId,
      expectedTurnId: task.turnId,
      input: [
        {
          type: "text",
          text:
            policy === "deadline"
              ? "Codex Pulse deadline mode: quota is now critically low. Finish the nearest shippable result without opening new scope, run only essential verification, capture completed work and remaining steps, then stop so the task can resume safely if needed."
              : "Quota protection mode: stop opening new scope. Finish only the current bounded step, capture completed work, remaining steps, verification results, and blockers, then stop so the task can resume safely after quota recovery.",
        },
      ],
    });
    await this.store.put({
      ...task,
      status: "draining",
      drainRequestedAt: now,
      drainRemaining: remaining(summary),
      quotaPolicy: policy,
    });
    return { type: "managed_task_draining", taskId: task.id };
  }

  async #pause(task, summary, now) {
    const workspaceFingerprint = await this.workspace.fingerprint(task.cwd);
    const taskWithUsage = {
      ...task,
      usageSegments: closeUsageSegment(task, summary, now, "quota_pause"),
    };
    const checkpoint = checkpointFor(
      taskWithUsage,
      remaining(summary),
      workspaceFingerprint,
      now,
    );
    const pausing = await this.store.put({
      ...taskWithUsage,
      status: "pausing",
      checkpoint,
      pausedWindowKey: summary.fiveHour?.resetsAt || null,
      pausedRemaining: remaining(summary),
    });
    if (task.turnId) {
      await this.client.request("turn/interrupt", {
        threadId: task.threadId,
        turnId: task.turnId,
      });
    }
    let goalWasActive = false;
    try {
      const result = await this.client.request("thread/goal/get", {
        threadId: task.threadId,
      });
      if (result.goal?.status === "active") {
        goalWasActive = true;
        await this.client.request("thread/goal/set", {
          threadId: task.threadId,
          status: "paused",
        });
      }
    } catch {
      // Not every managed task has a goal.
    }
    const paused = await this.store.put({
      ...pausing,
      status: "paused_quota",
      goalWasActive,
      pausedAt: now,
    });
    await this.#releaseLock(paused);
    return { type: "managed_task_paused", taskId: task.id, checkpoint };
  }

  async #resume(task, summary, now) {
    if (!(await this.workspace.exists(task.cwd))) {
      await this.store.put({ ...task, status: "needs_attention", blocker: "cwd_missing" });
      return { type: "managed_task_attention", taskId: task.id, reason: "cwd_missing" };
    }
    const claim = await this.#claimLock(task);
    if (!claim.acquired) return null;
    task = claim.task;
    const currentFingerprint = await this.workspace.fingerprint(task.cwd, {
      strategy: String(task.checkpoint?.workspaceFingerprint || "").startsWith("fs:")
        ? "filesystem"
        : undefined,
    });
    if (
      task.checkpoint?.workspaceFingerprint == null ||
      currentFingerprint == null
    ) {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "workspace_unverifiable",
        blockerDetails:
          this.workspace.failureDiagnostic?.() ||
          task.checkpoint?.workspaceFingerprintFailure ||
          null,
      });
      await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "workspace_unverifiable",
      };
    }
    if (
      currentFingerprint !== task.checkpoint.workspaceFingerprint
    ) {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "workspace_changed",
      });
      await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "workspace_changed",
      };
    }

    let latestTurn;
    try {
      const history = await this.client.request("thread/turns/list", {
        threadId: task.threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      latestTurn = history.data?.[0] || null;
    } catch {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "thread_history_unavailable",
      });
      await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "thread_history_unavailable",
      };
    }
    if (!latestTurn || latestTurn.id !== task.turnId) {
      const blocked = await this.store.put({
        ...task,
        status: "needs_attention",
        blocker: "newer_thread_activity",
        latestTurnId: latestTurn?.id || null,
      });
      await this.#releaseLock(blocked);
      return {
        type: "managed_task_attention",
        taskId: task.id,
        reason: "newer_thread_activity",
      };
    }

    const resumeAttemptId = randomUUID();
    const resuming = await this.store.put({
      ...task,
      status: "resuming",
      resumeAttemptId,
      resumeWindowKey: summary.fiveHour?.resetsAt || null,
    });
    try {
      await this.client.request("thread/resume", {
        threadId: task.threadId,
        excludeTurns: true,
      });
      if (task.goalWasActive) {
        await this.client.request("thread/goal/set", {
          threadId: task.threadId,
          status: "active",
        });
      }
      const turn = await this.client.request("turn/start", {
        threadId: task.threadId,
        input: [{ type: "text", text: recoveryPrompt(task) }],
      });
      await this.store.put({
        ...resuming,
        status: "running",
        turnId: turn.turn.id,
        resumedAt: now,
        resumeCount: (task.resumeCount || 0) + 1,
        usageSegments: openUsageSegment(resuming, summary, now, "quota_resume"),
      });
      return { type: "managed_task_resumed", taskId: task.id, threadId: task.threadId };
    } catch (error) {
      const blocked = await this.store.put({
        ...resuming,
        status: "needs_attention",
        blocker: "resume_incomplete",
        lastResumeError: error.message,
      });
      await this.#releaseLock(blocked);
      throw error;
    }
  }

  async #handleNotification(message) {
    const params = message.params || {};
    const tasks = await this.store.list();
    const turnId = params.turnId || params.turn?.id || params.item?.turnId;
    const task = tasks.find(
      (candidate) => candidate.turnId === turnId,
    );
    if (!task) return;

    if (message.method === "turn/plan/updated") {
      await this.store.put({ ...task, lastPlan: params.plan || [] });
      return;
    }
    if (message.method === "turn/diff/updated") {
      await this.store.put({ ...task, lastDiffHash: diffHash(params.diff) });
      return;
    }
    if (message.method === "turn/completed") {
      if (task.status === "draining") {
        const quota = remaining(this.lastSummary);
        const now = Math.floor(Date.now() / 1000);
        const workspaceFingerprint = await this.workspace.fingerprint(task.cwd);
        const paused = await this.store.put({
          ...task,
          status: "paused_quota",
          checkpoint: checkpointFor(task, quota, workspaceFingerprint, now),
          pausedWindowKey: this.lastSummary?.fiveHour?.resetsAt || null,
          pausedRemaining: quota,
          pausedAt: now,
          usageSegments: closeUsageSegment(
            task,
            this.lastSummary,
            now,
            "drain_complete",
          ),
        });
        await this.#releaseLock(paused);
        await this.onEvent({ type: "managed_task_paused", taskId: task.id });
      } else if (task.status === "running" && params.turn?.status === "completed") {
        const now = Math.floor(Date.now() / 1000);
        const completed = await this.store.put({
          ...task,
          status: "complete",
          completedAt: now,
          usageSegments: closeUsageSegment(
            task,
            this.lastSummary,
            now,
            "task_complete",
          ),
        });
        await this.#releaseLock(completed);
        await this.onEvent({ type: "managed_task_complete", taskId: task.id });
      }
    }
  }

  async #handleServerRequest(message) {
    const reason = USER_ACTION_METHODS.get(message.method);
    if (!reason) return;
    const params = message.params || {};
    const tasks = await this.store.list();
    const task = tasks.find(
      (candidate) => candidate.turnId === params.turnId,
    );
    if (!task || !ACTIVE_STATUSES.has(task.status)) return;

    const now = Math.floor(Date.now() / 1000);
    const workspaceFingerprint = await this.workspace.fingerprint(task.cwd);
    const taskWithUsage = {
      ...task,
      usageSegments: closeUsageSegment(
        task,
        this.lastSummary,
        now,
        "user_action_required",
      ),
    };
    const checkpoint = checkpointFor(
      taskWithUsage,
      remaining(this.lastSummary),
      workspaceFingerprint,
      now,
      reason,
    );
    const blocked = await this.store.put({
      ...taskWithUsage,
      status: "needs_attention",
      blocker: reason,
      autoResume: false,
      checkpoint,
      pendingRequest: {
        method: message.method,
        requestId: message.id,
        threadId: params.threadId || task.threadId,
        turnId: params.turnId || task.turnId,
        itemId: params.itemId || null,
        receivedAt: now,
      },
    });
    let safeToRelease = !task.turnId;
    if (task.turnId) {
      try {
        await this.client.request("turn/interrupt", {
          threadId: task.threadId,
          turnId: task.turnId,
        });
        safeToRelease = true;
      } catch {
        // The task is already fail-closed in needs_attention. App Server may
        // have cleared the request before the interrupt reached it. Keep the
        // worktree lock when interruption cannot be proven so no second task
        // can enter the same checkout.
      }
    }
    if (safeToRelease) await this.#releaseLock(blocked);
    await this.onEvent({
      type: "managed_task_attention",
      taskId: task.id,
      reason,
    });
  }

  async #claimLock(task) {
    if (!this.lockManager) return { acquired: true, task };
    const result = await this.lockManager.acquire(task.cwd, task.id);
    if (!result.acquired) return { acquired: false, task, reason: result.reason };
    const current = task.worktreeLock;
    if (
      current?.holderId === result.handle.holderId &&
      current?.token === result.handle.token
    ) {
      return { acquired: true, task };
    }
    const claimed = await this.store.put({
      ...task,
      worktreeLock: result.handle,
    });
    return { acquired: true, task: claimed };
  }

  async #releaseLock(task) {
    if (!this.lockManager || !task.worktreeLock) return;
    const released = await this.lockManager.release(task.worktreeLock);
    if (released) await this.store.put({ ...task, worktreeLock: null });
  }
}
