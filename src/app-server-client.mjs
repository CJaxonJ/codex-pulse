import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { readLatestTurn } from "./thread-lifecycle.mjs";
import { queueNativeWakeup, trustedRecoveryHooks } from "./native-wakeup.mjs";
import { codexInvocation, resolveCodexExecutable } from "./platform-runtime.mjs";

export function resolveCodexBinary() {
  return resolveCodexExecutable();
}

export class AppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.binary = options.binary || resolveCodexBinary();
    this.binaryArgs = options.binaryArgs || [];
    this.requestTimeoutMs = options.requestTimeoutMs || 15_000;
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = "";
  }

  async start() {
    if (this.child) return;
    const invocation = codexInvocation(this.binary, [...this.binaryArgs, "app-server"]);
    this.child = spawn(invocation.file, invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child.on("error", (error) => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.emit("exit", error);
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderrTail += chunk.toString();
      if (this.stderrTail.length > 4_000) this.stderrTail = this.stderrTail.slice(-4_000);
    });

    this.child.on("exit", (code) => {
      const error = new Error(
        `Codex App Server exited with code ${code}${
          this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ""
        }`,
      );
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.emit("exit", error);
    });

    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this._onLine(line));

    await this.request("initialize", {
      clientInfo: {
        name: "codex_pulse",
        title: "Codex Pulse",
        version: "0.9.20",
      },
    });
    this.notify("initialized", {});
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        const error = new Error(message.error.message || "App Server error");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      }
      else pending.resolve(message.result);
      return;
    }

    if (message.id != null && message.method) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) this.emit("notification", message);
  }

  request(method, params = {}) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  readRateLimits() {
    return this.request("account/rateLimits/read", {});
  }

  readLatestTurn(threadId, itemsView) {
    return readLatestTurn(this, threadId, itemsView);
  }

  async assertWakeReady(record) {
    const hooks = await this.request("hooks/list", { cwds: [record.cwd] });
    if (record.wakeAdmissionVersion !== 1 || !trustedRecoveryHooks(hooks)) {
      const error = new Error("Codex Pulse recovery hooks must be installed, enabled, and reviewed before automatic wakeup.");
      error.code = "PULSE_HOOK_REVIEW_REQUIRED";
      throw error;
    }
  }

  wakeThread(record) { return queueNativeWakeup(this.binary, record); }

  stop() {
    this.child?.kill();
    this.child = null;
  }
}
