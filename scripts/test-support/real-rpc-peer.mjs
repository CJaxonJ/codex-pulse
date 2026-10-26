import { EventEmitter } from "node:events";
import { readLatestTurn } from "../../src/thread-lifecycle.mjs";

export class RealRpcPeer extends EventEmitter {
  constructor(url) { super(); this.url = url; this.pending = new Map(); this.nextId = 1; }
  async start() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", event => {
      const msg = JSON.parse(event.data);
      if (msg.id != null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
      } else if (msg.id != null && msg.method) this.emit("approval", msg);
      else this.emit("notification", msg);
    });
    this.socket.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error("network offline: test socket closed")); }
      this.pending.clear();
    });
    await this.request("initialize", { clientInfo: { name: "codex_pulse_sandbox", version: "test" },
      capabilities: { experimentalApi: true } });
    this.socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }
  request(method, params = {}) {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Error("network offline: test socket closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`${method} timed out`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  readLatestTurn(id, view) { return readLatestTurn(this, id, view); }
  close() { this.socket?.close(); }
}
