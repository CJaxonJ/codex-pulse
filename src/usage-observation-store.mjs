import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renameAtomic } from "./atomic-file.mjs";

function safeId(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 220);
}

export class UsageObservationStore {
  constructor(dataDir) {
    this.observationsDir = path.join(dataDir, "usage-observations");
  }

  async list() {
    await mkdir(this.observationsDir, { recursive: true });
    const names = (await readdir(this.observationsDir))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .slice(-500);
    const observations = [];
    for (const name of names) {
      try {
        observations.push(
          JSON.parse(await readFile(path.join(this.observationsDir, name), "utf8")),
        );
      } catch {
        // Atomic writes prevent normal partial records. Ignore manual damage.
      }
    }
    return observations;
  }

  async get(id) {
    try {
      return JSON.parse(
        await readFile(path.join(this.observationsDir, `${safeId(id)}.json`), "utf8"),
      );
    } catch {
      return null;
    }
  }

  async put(observation) {
    await mkdir(this.observationsDir, { recursive: true });
    const next = {
      ...observation,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    const target = path.join(this.observationsDir, `${safeId(next.id)}.json`);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await renameAtomic(temporary, target);
    return next;
  }
}

export class MemoryUsageObservationStore {
  constructor(observations = []) {
    this.observations = new Map(
      observations.map((observation) => [observation.id, structuredClone(observation)]),
    );
  }

  async list() {
    return [...this.observations.values()].map((value) => structuredClone(value));
  }

  async get(id) {
    const value = this.observations.get(id);
    return value ? structuredClone(value) : null;
  }

  async put(observation) {
    const next = structuredClone(observation);
    this.observations.set(next.id, next);
    return structuredClone(next);
  }
}
