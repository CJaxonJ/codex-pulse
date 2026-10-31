import test from "node:test";
import assert from "node:assert/strict";
import { WindowsRuntimeService } from "../scripts/windows-runtime-service.mjs";

// Driver-state tests use explicit OS-call/clock ports. They are not a native
// scheduler proof; the real installation/scheduler suites run on Windows.
test("scheduler drain waits for actual zero instances using only the new source's read-only installed-status", async () => {
  const service = Object.create(WindowsRuntimeService.prototype), calls = [], states = [2, 1, 0];
  service.sourceBinary = "source-native-component";
  service.call = async (file, args) => { calls.push({ file, args }); const runningInstances = states.shift(); return { installed: true, runningInstances, taskState: runningInstances > 0 ? 4 : 1 }; };
  let now = 0;
  await service.waitForSchedulerIdle({ now: () => now, sleep: async ms => { now += ms; } });
  assert.equal(calls.length, 3); assert.equal(now, 400);
  assert(calls.every(call => call.file === service.sourceBinary && call.args.join("/") === "--startup/installed-status"));
});
test("missing, malformed, denied and still-running scheduler states never authorize runtime switching", async () => {
  for (const counter of [undefined, null, -1, 0.5, "0", 1]) {
    const service = Object.create(WindowsRuntimeService.prototype);
    service.call = async () => ({ installed: true, runningInstances: counter, taskState: 1 }); let now = 0;
    await assert.rejects(service.waitForSchedulerIdle({ timeoutMs: 600, now: () => now, sleep: async ms => { now += ms; } }));
  }
  const denied = Object.create(WindowsRuntimeService.prototype);
  denied.call = async () => { throw Object.assign(Error("denied"), { code: "EACCES" }); };
  await assert.rejects(denied.waitForSchedulerIdle(), { code: "EACCES" });
});
test("zero visible instances cannot authorize switching while the scheduler is still queued or running", async () => {
  for (const taskState of [undefined, 0, 3, 4, 5]) {
    const service = Object.create(WindowsRuntimeService.prototype); let now = 0;
    service.call = async () => ({ installed: true, runningInstances: 0, taskState });
    await assert.rejects(service.waitForSchedulerIdle({ timeoutMs: 400, now: () => now, sleep: async ms => { now += ms; } }));
  }
});
