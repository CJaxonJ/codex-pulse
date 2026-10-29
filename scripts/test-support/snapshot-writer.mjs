import { once } from "node:events";
import { createHash } from "node:crypto";
import { writeJsonSnapshotAtomic } from "../../src/atomic-file.mjs";

if (!process.send) throw Error("Isolated snapshot IPC fixture required");
const [destination] = process.argv.slice(2);
const wait = once(process, "message"); process.send({ type: "ready" }); await wait;
try {
  for (let sequence = 1; sequence <= 40; sequence++) {
    const payload = String(sequence).padStart(2, "0").repeat(128 * 1024);
    await writeJsonSnapshotAtomic(destination, { sequence, payload, digest: createHash("sha256").update(payload).digest("hex") });
    if (sequence % 10 === 0) {
      const resume = once(process, "message"); process.send({ type: "barrier", sequence }); await resume;
    }
  }
  process.send({ type: "done" }); process.disconnect();
} catch (error) { process.send({ type: "failed", error: error.message }); process.disconnect(); process.exitCode = 1; }
