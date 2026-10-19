import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function formatResetTime(timestamp) {
  if (!timestamp) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1000));
}

export function notificationForEvent(event) {
  if (event.type === "chat_continuity_resumed") {
    return {
      title: "Codex 聊天已自动续跑",
      body: "个人额度已经恢复，正在原聊天中根据本机检查点继续未完成工作。",
    };
  }
  if (event.type === "chat_continuity_complete") {
    return {
      title: "Codex 聊天续跑已完成",
      body: "恢复后的任务已正常结束，不会再次自动启动。",
    };
  }
  if (event.type === "chat_continuity_attention") {
    const reasons = {
      workspace_changed: "暂停后工作区发生了变化",
      cwd_missing: "原工作目录不可用",
      approval_required: "任务需要你审批命令或文件修改",
      permission_required: "任务需要你确认额外权限",
      user_input_required: "任务正在等待你的选择或回答",
      mcp_input_required: "连接的工具正在等待你的确认",
      dynamic_tool_required: "任务需要宿主应用执行工具调用",
      newer_thread_activity: "暂停后聊天出现了新的用户操作",
      thread_history_unavailable: "暂时无法核对聊天历史",
      workspace_unverifiable: "无法可靠校验暂停时的工作区状态",
      resume_state_unknown: "后台重启后无法确认续跑任务是否仍在执行",
      resume_failed: "恢复后的任务执行失败",
      resume_interrupted: "恢复后的任务被中断",
      resume_incomplete: "恢复请求未能完整启动",
    };
    return {
      title: "Codex 聊天续跑需要确认",
      body: `${reasons[event.reason] || "恢复条件不再安全"}，已停止自动续跑。`,
    };
  }
  if (event.type === "managed_task_started") {
    return {
      title: "Codex Pulse 已启动托管任务",
      body: "任务已经进入额度保护模式；接近阈值时会自动保存现场并暂停。",
    };
  }
  if (event.type === "managed_task_draining") {
    return {
      title: "Codex 托管任务开始收尾",
      body: "5 小时额度已进入保护区，正在停止扩展范围并整理检查点。",
    };
  }
  if (event.type === "managed_task_paused") {
    return {
      title: "Codex 托管任务已安全暂停",
      body: "任务现场已保存；只有个人额度恢复且工作区未变化时才会自动续跑。",
    };
  }
  if (event.type === "managed_task_resumed") {
    return {
      title: "Codex 托管任务已恢复",
      body: "个人额度已经恢复，任务正在原线程从第一个未完成步骤继续。",
    };
  }
  if (event.type === "managed_task_complete") {
    return {
      title: "Codex 托管任务已完成",
      body: "任务已正常结束，不会再次自动启动。",
    };
  }
  if (event.type === "managed_task_attention") {
    const reasons = {
      workspace_changed: "工作区在暂停期间发生变化",
      cwd_missing: "原工作目录不可用",
      approval_required: "任务需要你审批命令或文件修改",
      permission_required: "任务需要你确认额外权限",
      user_input_required: "任务正在等待你的选择或回答",
      mcp_input_required: "连接的工具正在等待你的表单或确认",
      dynamic_tool_required: "任务需要宿主应用执行工具调用",
      newer_thread_activity: "暂停后线程出现了新的用户操作",
      thread_history_unavailable: "暂时无法核对线程是否被继续过",
    };
    const reason = reasons[event.reason] || "任务需要你的确认";
    return {
      title: "Codex 托管任务需要确认",
      body: `${reason}，已阻止自动续跑，避免覆盖现有修改。`,
    };
  }
  if (event.type === "credit_expiring") {
    return {
      title: `Codex 重置卡约 ${Math.max(1, Math.ceil(event.hoursRemaining))} 小时后过期`,
      body: "先确认当前额度是否值得重置，再安排高价值任务；不要为了不浪费卡，反而浪费剩余额度。",
    };
  }
  if (event.type === "tibo_preview") {
    const quote = event.text ? `“${event.text.slice(0, 70)}”` : "出现了新的重置信号";
    return {
      title: "Tibo 发出 Codex 重置信号",
      body: `${quote}。这是预告，不代表你的账户已到账；我会继续监控。数据：codex-reset.com`,
    };
  }
  if (event.type === "tibo_limits_update") {
    const quote = event.text ? `“${event.text.slice(0, 95)}”` : "Codex 使用体验有新变化";
    return {
      title: "Tibo 更新 Codex 容量或额度信息",
      body: `${quote}。这是使用体验更新，不代表额度重置。数据：codex-reset.com`,
    };
  }
  if (event.type === "tibo_source_unhealthy") {
    return {
      title: "Codex Pulse 暂时收不到 Tibo 数据",
      body: "codex-reset.com 连续失败或数据已过期；个人额度监控仍继续，恢复后会通知。",
    };
  }
  if (event.type === "tibo_source_recovered") {
    return {
      title: "Tibo 数据源已恢复",
      body: "Codex Pulse 已重新收到 codex-reset.com 的最新数据。",
    };
  }
  if (event.type === "tibo_confirmed") {
    return {
      title: "Codex 公共重置已确认",
      body: "公共侧已观察到重置，但你的账户可能稍后到账；我会继续盯个人额度。数据：codex-reset.com",
    };
  }
  if (event.type === "personal_landed") {
    return {
      title: "你的 Codex 重置已到账",
      body: `已从你的账户读到额度回升，当前 5 小时额度剩余 ${Math.round(event.remainingPercent)}%。`,
    };
  }
  if (event.type === "threshold") {
    return {
      title: `Codex 5 小时额度剩余 ${Math.round(event.remainingPercent)}%`,
      body: `已跌破 ${event.threshold}% 预警线，预计 ${formatResetTime(event.resetsAt)} 恢复。先暂停新增长任务或切换更省额度的模型。`,
    };
  }
  if (event.type === "forecast") {
    return {
      title: "Codex 额度消耗正在加快",
      body: `按最近速度，约 ${event.minutesToTarget} 分钟后剩余 ${event.targetRemaining}%。当前剩余 ${Math.round(event.remainingPercent)}%。`,
    };
  }
  return {
    title: "Codex 5 小时额度已恢复",
    body: `当前剩余 ${Math.round(event.remainingPercent)}%，可以继续被额度打断的任务。`,
  };
}

export function sendMacNotification({ title, body }) {
  if (process.env.CODEX_PULSE_DISABLE_NOTIFICATIONS === "1") {
    return Promise.resolve();
  }
  const nativeApp =
    process.env.CODEX_PULSE_NOTIFIER_APP ||
    path.join(os.homedir(), "Applications", "Codex Pulse.app");
  if (existsSync(nativeApp)) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "/usr/bin/open",
        ["-W", "-g", "-n", nativeApp, "--args", title, body],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `open exited with ${code}`));
      });
    });
  }

  const script = `const app = Application.currentApplication(); app.includeStandardAdditions = true; app.displayNotification(${JSON.stringify(
    body,
  )}, { withTitle: ${JSON.stringify(title)}, soundName: "Glass" });`;
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `osascript exited with ${code}`));
    });
  });
}
