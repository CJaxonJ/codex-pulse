import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

function recordName(sessionId) {
  return `${createHash("sha256").update(String(sessionId)).digest("hex")}.json`;
}

export class ChatContinuityStore {
  constructor(dataDir) {
    this.recordsDir = path.join(dataDir, "chat-continuity");
  }

  async get(sessionId) {
    try {
      return JSON.parse(
        await readFile(path.join(this.recordsDir, recordName(sessionId)), "utf8"),
      );
    } catch {
      return null;
    }
  }

  async list() {
    await mkdir(this.recordsDir, { recursive: true });
    const names = (await readdir(this.recordsDir)).filter((name) => name.endsWith(".json"));
    const records = [];
    for (const name of names) {
      try {
        records.push(JSON.parse(await readFile(path.join(this.recordsDir, name), "utf8")));
      } catch {
        // Atomic writes prevent normal partial files. Ignore manually damaged records.
      }
    }
    return records.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async put(record) {
    if (!record?.sessionId) throw new Error("chat continuity record requires sessionId");
    await mkdir(this.recordsDir, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const next = {
      ...record,
      id: record.id || `chat:${record.sessionId}`,
      createdAt: record.createdAt || now,
      updatedAt: now,
    };
    const target = path.join(this.recordsDir, recordName(next.sessionId));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(temporary, target);
    return next;
  }
}

export class MemoryChatContinuityStore {
  constructor(records = []) {
    this.records = new Map(
      records.map((record) => [record.sessionId, structuredClone(record)]),
    );
  }

  async get(sessionId) {
    const record = this.records.get(sessionId);
    return record ? structuredClone(record) : null;
  }

  async list() {
    return [...this.records.values()].map((record) => structuredClone(record));
  }

  async put(record) {
    const next = { ...structuredClone(record), updatedAt: record.updatedAt || 1 };
    this.records.set(record.sessionId, next);
    return structuredClone(next);
  }
}
