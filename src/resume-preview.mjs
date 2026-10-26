import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseQuotaHandoff } from "./goal-continuation.mjs";

const VISIBLE = new Set(["checkpoint_requested", "checkpointing", "paused_quota", "pausing",
  "draining", "resuming", "native_goal_active", "running", "needs_attention"]);
const LABELS = {
  checkpoint_requested: "正在保存暂停计划", checkpointing: "正在保存暂停计划",
  pausing: "正在安全暂停", draining: "正在收尾", paused_quota: "已暂停，等待个人额度恢复",
  resuming: "已请求续跑，等待实际启动", native_goal_active: "已请求续跑，等待实际启动",
  running: "执行中", needs_attention: "需要你确认",
};
const REASONS = {
  workspace_changed: "暂停后文件已变化，请回到原聊天确认后继续。",
  workspace_unverifiable: "暂时无法校验工作区，不能安全续跑。",
  hook_review_required: "请先审查并信任 Codex Pulse Hook。",
  native_goal_changed: "原目标被修改，不会用旧计划覆盖新目标。",
  newer_thread_activity: "聊天出现了新操作，请回到原聊天确认。",
  cwd_missing: "原工作目录不可用。",
  resume_state_unknown: "尚无法确认上次执行是否停止，暂不重复启动。",
  runtime_state_unknown: "尚无法确认上次执行是否停止，暂不重复启动。",
  approval_required: "正在等你审批。", permission_required: "正在等你确认权限。",
  user_input_required: "正在等你回答问题。",
  native_goal_not_started: "续跑请求已提交，但尚未观察到实际执行。",
};

function remainingDuration(checkpoint, sections, updatedAt) {
  // Only explicit remaining-work estimates qualify. Whole-task history is not
  // a remaining-work estimate, and reading this screen must never call a model.
  const explicit = checkpoint?.remainingEstimate;
  const min = explicit?.minMinutes, max = explicit?.maxMinutes;
  if (Number.isFinite(min) && Number.isFinite(max) && min > 0 && max >= min && max < 100_000) {
    return { minMinutes: min, maxMinutes: max, confidence: "low",
      source: "检查点中的剩余工作估算（非承诺）", updatedAt };
  }
  const match = String(sections.remaining || "").match(
    /预计剩余耗时\s*[:：]\s*(\d+)\s*(?:[-–—~～至]\s*(\d+)\s*)?分钟/,
  );
  if (match && +match[1] > 0 && +(match[2] || match[1]) >= +match[1]) {
    return { minMinutes: +match[1], maxMinutes: +(match[2] || match[1]), confidence: "low",
      source: "检查点中的剩余工作估算（非承诺）", updatedAt };
  }
  return { minMinutes: null, maxMinutes: null, confidence: "unknown",
    source: "暂无法可靠估算；不会额外消耗额度生成估时", updatedAt };
}

function restartEstimate(record, state, now, pollSeconds) {
  if (record.status === "needs_attention" || record.pendingRequest) return { kind: "blocked", text: "确认问题前不会自动启动" };
  if (record.status !== "paused_quota") return { kind: "not_waiting", text: "以当前实际执行状态为准" };
  // The native-goal bootstrap is explicitly allowed by the recovery contract.
  if (record.autoResume === false && record.resumeUnavailableReason !== "native_goal_required") {
    return { kind: "manual", text: "自动续跑未开启，请回到原聊天继续" };
  }
  const checkedAt = state.quotaCheckedAt ?? state.fiveHour?.lastCheckedAt;
  if (!Number.isFinite(checkedAt) || now - checkedAt > 180 || checkedAt > now + 30) {
    return { kind: "stale", text: "额度数据已过期或暂不可用，等待后台联网核实" };
  }
  const window = state.lastSummary?.fiveHour;
  if (!window) return { kind: "unknown", text: "当前账户未提供 5 小时窗口，无法预测启动时间" };
  const recovered = window.remainingPercent >= (record.resumeFloor ?? 50)
    && (record.pausedWindowKey !== window.resetsAt
      || window.remainingPercent >= (record.pausedRemaining ?? 0) + 30);
  if (recovered) return { kind: "eligible", text: "额度条件已满足；等待后台核对文件、任务占用及启动权限" };
  if (!Number.isFinite(window.resetsAt) || window.resetsAt <= now) {
    return { kind: "unknown", text: "恢复时间待后台重新核实" };
  }
  return { kind: "window", earliestAt: window.resetsAt, latestPollAt: window.resetsAt + pollSeconds,
    text: `这是最早可恢复的额度时间，正常轮询约 ${pollSeconds} 秒；离线、睡眠、权限或任务占用会延后实际启动` };
}

function planItems(items) {
  return Array.isArray(items) ? items.map((item) => typeof item === "string" ? item : item.step).filter(Boolean).join("\n") : "";
}

export function buildResumePreview({ chats = [], managed = [], state = {}, now = Math.floor(Date.now() / 1000), pollSeconds = 60 } = {}) {
  const tasks = [...chats.map((r) => ({ ...r, kind: "chat" })), ...managed.map((r) => ({ ...r, kind: "managed" }))]
    .filter((r) => VISIBLE.has(r.status))
    .map((record) => {
      const checkpoint = record.checkpoint || {};
      const sections = record.kind === "chat" ? parseQuotaHandoff(checkpoint.summary) : {
        completed: planItems(checkpoint.completed), remaining: planItems(checkpoint.remaining),
        nextAction: checkpoint.currentStep || "", verification: planItems(checkpoint.verification),
        blockers: planItems(checkpoint.blockers),
      };
      const updatedAt = checkpoint.pausedAt ?? record.pausedAt ?? record.updatedAt ?? null;
      return {
        id: `${record.kind}:${record.sessionId || record.id}`, kind: record.kind,
        objective: record.initialGoal?.objective || record.objective || "原聊天中的未完成请求（未单独设置 Goal）",
        status: record.status,
        statusText: record.executionObservedAt && record.status === "native_goal_active" ? "已观察到续跑执行" : LABELS[record.status],
        completed: sections.completed || "尚无已保存的完成记录",
        remaining: sections.remaining || "暂停计划尚未完整保存，请等待后台核实",
        nextAction: sections.nextAction || "先核对原聊天与已保存检查点，再继续未完成步骤",
        verification: sections.verification || "尚未记录验证结果",
        blockers: record.blocker ? (REASONS[record.blocker] || `自动续跑已暂停（${record.blocker}），请回到原聊天确认。`) : (sections.blockers || "未记录额外阻碍；启动前仍会校验文件和执行状态"),
        restart: restartEstimate(record, state, now, pollSeconds),
        duration: remainingDuration(checkpoint, sections, updatedAt), updatedAt,
      };
    });
  return { generatedAt: now, readOnly: true, tasks };
}

async function readJSON(file, fallback) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}
async function readRecords(directory) {
  let names;
  try { names = await readdir(directory); } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return (await Promise.all(names.filter((n) => n.endsWith(".json")).sort()
    .map((n) => readJSON(path.join(directory, n), null)))).filter((r) => r && typeof r === "object");
}
export async function readResumePreview(dataDir, options = {}) {
  const [chats, managed, state] = await Promise.all([
    readRecords(path.join(dataDir, "chat-continuity")), readRecords(path.join(dataDir, "managed-tasks")),
    readJSON(path.join(dataDir, "state.json"), {}),
  ]);
  return buildResumePreview({ ...options, chats, managed, state });
}
