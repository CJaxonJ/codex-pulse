import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DEFAULT_LIMIT = 50;

export class UserEventJournal {
  constructor(dataDir, options = {}) {
    this.filePath = path.join(dataDir, "user-events.json");
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.serial = Promise.resolve();
  }

  async list() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed.events) ? parsed.events : [];
    } catch {
      return [];
    }
  }

  async latest() {
    return (await this.list()).at(-1) || null;
  }

  append(event) {
    const next = this.serial.then(() => this.#append(event));
    this.serial = next.catch(() => {});
    return next;
  }

  updateDeliveryStatus(id, deliveryStatus) {
    const next = this.serial.then(async () => {
      const events = await this.list();
      const index = events.findIndex((event) => event.id === id);
      if (index < 0) return null;
      events[index] = { ...events[index], deliveryStatus };
      await this.#write(events);
      return events[index];
    });
    this.serial = next.catch(() => {});
    return next;
  }

  async #append(event) {
    const existing = await this.list();
    const entry = {
      id: event.id || randomUUID(),
      type: String(event.type || "unknown"),
      title: String(event.title || "Codex Pulse").slice(0, 180),
      body: String(event.body || "").slice(0, 600),
      occurredAt: event.occurredAt ?? Math.floor(Date.now() / 1000),
      deliveryStatus: event.deliveryStatus || "unknown",
    };
    const events = [...existing, entry].slice(-this.limit);
    await this.#write(events);
    return entry;
  }

  async #write(events) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ events }, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }
}
