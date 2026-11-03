import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameAtomic } from "./atomic-file.mjs";

function recordName(sessionId) {
  return `${createHash("sha256").update(String(sessionId)).digest("hex")}.json`;
}

async function writeRecord(target, record) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await renameAtomic(temporary, target);
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

  async getLastFailure(sessionId) {
    try { return JSON.parse(await readFile(path.join(this.recordsDir, "incidents", recordName(sessionId)), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
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
    if (next.status === "needs_attention" && next.blocker) {
      try {
        const incidents = path.join(this.recordsDir, "incidents");
        await mkdir(incidents, { recursive: true, mode: 0o700 });
        await writeRecord(path.join(incidents, recordName(next.sessionId)), next);
      } catch {
        // Diagnostics must not throw out a safety refusal (Hook callers may
        // fail open on an unexpected exception). Persist the refusal anyway.
        next.incidentCaptureFailed = true;
      }
    }
    await writeRecord(target, next);
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
