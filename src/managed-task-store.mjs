import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameAtomic } from "./atomic-file.mjs";

export class ManagedTaskStore {
  constructor(dataDir) {
    this.tasksDir = path.join(dataDir, "managed-tasks");
  }

  async queue(input) {
    const now = Math.floor(Date.now() / 1000);
    const task = {
      id: randomUUID(),
      status: "queued",
      objective: input.objective,
      cwd: path.resolve(input.cwd),
      model: input.model || "gpt-6.1-sol",
      taskSize: input.taskSize || "medium",
      priority: input.priority || "normal",
      quotaPolicy: input.quotaPolicy || "finish_current",
      autoResume: input.autoResume !== false,
      resumeFloor: input.resumeFloor ?? 50,
      startFloor: input.startFloor ?? input.resumeFloor ?? 50,
      threadId: null,
      turnId: null,
      lastPlan: [],
      lastDiffHash: null,
      checkpoint: null,
      usageSegments: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.put(task);
    return task;
  }

  async list() {
    await mkdir(this.tasksDir, { recursive: true });
    const names = (await readdir(this.tasksDir)).filter((name) => name.endsWith(".json"));
    const tasks = [];
    for (const name of names) {
      try {
        tasks.push(JSON.parse(await readFile(path.join(this.tasksDir, name), "utf8")));
      } catch {
        // Ignore a partial or manually damaged record; atomic writes prevent normal partials.
      }
    }
    return tasks.sort((a, b) => a.createdAt - b.createdAt);
  }

  async put(task) {
    await mkdir(this.tasksDir, { recursive: true });
    const next = { ...task, updatedAt: Math.floor(Date.now() / 1000) };
    const target = path.join(this.tasksDir, `${next.id}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await renameAtomic(temporary, target);
    return next;
  }
}

export class MemoryTaskStore {
  constructor(tasks = []) {
    this.tasks = new Map(tasks.map((task) => [task.id, structuredClone(task)]));
  }

  async list() {
    return [...this.tasks.values()].map((task) => structuredClone(task));
  }

  async put(task) {
    const next = { ...structuredClone(task), updatedAt: task.updatedAt || 1 };
    this.tasks.set(task.id, next);
    return structuredClone(next);
  }
}
