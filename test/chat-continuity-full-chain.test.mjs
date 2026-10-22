import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("10% pause, checkpoint plan, recovered quota, and exactly-once resume work as one offline chain", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [path.join(projectDir, "scripts", "e2e-chat-continuity-simulated.mjs")],
    { cwd: projectDir, timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.quotaSpent, 0);
  assert.equal(result.resumeCount, 1);
  assert.equal(result.proof, "RESUME_OK");
  assert.deepEqual(result.remainingLocks, []);
  assert.equal(result.timeline.length, 5);
  assert.match(result.timeline[2], /unrelated sibling workspace changed/);
});
