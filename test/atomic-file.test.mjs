import test from "node:test";
import assert from "node:assert/strict";
import { mkdirExclusive, renameAtomic, writeJsonSnapshotAtomic, readJsonSnapshot } from "../src/atomic-file.mjs";
import { mkdtemp, mkdir, readdir, writeFile, readFile, rename } from "node:fs/promises";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";

test("snapshot reads retry actual contention codes without hiding unknown, malformed or permanently denied data", async () => {
  let attempts = 0;
  assert.deepEqual(await readJsonSnapshot("snapshot", { platform: "win32", sleep: async () => {}, read: async () => {
    if (++attempts < 3) throw Object.assign(Error("busy"), { code: "EBUSY" }); return '{"ready":true}';
  } }), { ready: true });
  assert.equal(attempts, 3);
  for (const [platform, code, count] of [["win32", "EACCES", 7], ["darwin", "EBUSY", 1], ["win32", "EINVAL", 1], ["win32", "ENOENT", 1]]) {
    let calls = 0;
    await assert.rejects(readJsonSnapshot("snapshot", { platform, sleep: async () => {}, read: async () => { calls++; throw Object.assign(Error(code), { code }); } }), { code });
    assert.equal(calls, count);
  }
  assert.equal(await readJsonSnapshot("missing", { optional: true, read: async () => { throw Object.assign(Error("missing"), { code: "ENOENT" }); } }), null);
  await assert.rejects(readJsonSnapshot("damaged", { optional: true, read: async () => "{" }), SyntaxError);
});

test("exclusive Windows lock mkdir retries delete-pending denial without claiming an existing lock", async () => {
  const calls = [], waits = [];
  await mkdirExclusive("exact-owned-lock", { platform: "win32", create: async directory => {
    calls.push(directory); if (calls.length < 3) throw Object.assign(Error("delete pending"), { code: "EPERM" });
  }, sleep: async ms => waits.push(ms) });
  assert.deepEqual(calls, ["exact-owned-lock", "exact-owned-lock", "exact-owned-lock"]); assert.deepEqual(waits, [10, 20]);
  for (const [platform, code, expectedCalls] of [["win32", "EACCES", 7], ["win32", "EEXIST", 1], ["win32", "ENOENT", 1], ["darwin", "EPERM", 1]]) {
    let count = 0;
    await assert.rejects(mkdirExclusive("lock", { platform, create: async () => { count++; throw Object.assign(Error(code), { code }); }, sleep: async () => {} }), { code });
    assert.equal(count, expectedCalls);
  }
});
test("Windows sharing violations retry the same paths with a bounded budget, without deleting the destination",async()=>{
  const calls=[],waits=[];
  await renameAtomic("prepared.tmp","current.json",{platform:"win32",move:async(...args)=>{
    calls.push(args);if(calls.length<4)throw Object.assign(Error("sharing violation"),{code:"EPERM"});
  },sleep:async ms=>waits.push(ms)});
  assert.deepEqual(waits,[10,20,40]);assert(calls.every(c=>c[0]==="prepared.tmp"&&c[1]==="current.json"));
});
test("permanent Windows denial is surfaced; missing source and non-Windows errors are never hidden",async()=>{
  let calls=0;
  await assert.rejects(renameAtomic("source","destination",{platform:"win32",move:async()=>{
    calls++;throw Object.assign(Error("denied"),{code:"EACCES"});},sleep:async()=>{}}),/denied/);
  assert.equal(calls,7);
  for(const [platform,code]of [["win32","ENOENT"],["darwin","EPERM"]]){
    let retries=0;await assert.rejects(renameAtomic("a","b",{platform,move:async()=>{throw Object.assign(Error(code),{code});},sleep:async()=>{retries++;}}));
    assert.equal(retries,0);
  }
});
test("actual Windows file sharing denial recovers without deleting or truncating the old record",{skip:process.platform!=="win32",timeout:20000},async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"pulse sharing 记录-"));
  const destination=path.join(root,"current.json"),source=path.join(root,"prepared.tmp"),release=path.join(root,"release");
  await writeFile(destination,"old-record");await writeFile(source,"new-record");
  const script=`$f=[IO.File]::Open($env:PULSE_LOCK_TARGET,'Open','Read',[IO.FileShare]::Read);try{[Console]::WriteLine('locked');$s=[Diagnostics.Stopwatch]::StartNew();while(-not [IO.File]::Exists($env:PULSE_LOCK_RELEASE) -and $s.ElapsedMilliseconds -lt 10000){Start-Sleep -Milliseconds 10}}finally{$f.Dispose()}`;
  const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(script,"utf16le").toString("base64")],{
    windowsHide:true,env:{...process.env,PULSE_LOCK_TARGET:destination,PULSE_LOCK_RELEASE:release},stdio:["ignore","pipe","pipe"],
  });
  const exited=new Promise(resolve=>child.once("exit",resolve));
  try{
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error("Windows sharing lock was not acquired")),10000);
      child.stdout.on("data",chunk=>{if(chunk.toString().includes("locked")){clearTimeout(timer);resolve();}});
      child.once("error",error=>{clearTimeout(timer);reject(error);});
      child.once("exit",()=>{clearTimeout(timer);reject(Error("Lock holder exited before acquiring the file"));});
    });
    let denied=0;
    await renameAtomic(source,destination,{move:async(a,b)=>{
      try{await rename(a,b);}catch(error){denied++;await writeFile(release,"release");throw error;}
    }});
    assert(denied>0,"The real Windows file handle must actually deny at least one replacement");
    assert.equal(await readFile(destination,"utf8"),"new-record");
  }finally{await writeFile(release,"release");await exited;child.kill();}
});

test("shared JSON snapshots remain complete during real cross-process replacement, without hiding parse/read failures", { timeout: 30000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse atomic 快照-")), file = path.join(root, "state.json");
  await writeJsonSnapshotAtomic(file, { sequence: 0, payload: "", digest: createHash("sha256").update("").digest("hex") });
  const writer = fork(path.resolve(import.meta.dirname, "../scripts/test-support/snapshot-writer.mjs"), [file], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let started, done = false, barrier = null, failure, reads = 0;
  const ready = new Promise((resolve, reject) => {
    started = resolve;
    writer.once("error", reject);
    writer.once("exit", code => { if (!done) { failure = Error("Snapshot writer exited before completion: " + code); reject(failure); } });
  });
  writer.on("message", message => {
    if (message.type === "ready") started();
    if (message.type === "barrier") barrier = message.sequence;
    if (message.type === "done") done = true;
    if (message.type === "failed") failure = Error(message.error);
  });
  const exit = once(writer, "exit"), observed = new Set();
  try {
    await ready; writer.send({ type: "start" });
    while (!done) {
      if (failure) throw failure;
      // Deliberately no catch/retry around readFile or JSON.parse. An empty,
      // absent or partial file is a failure, not an allowed intermediate state.
      const snapshot = JSON.parse(await readFile(file, "utf8")); reads++;
      assert.equal(createHash("sha256").update(snapshot.payload).digest("hex"), snapshot.digest);
      assert.equal(snapshot.payload, snapshot.sequence ? String(snapshot.sequence).padStart(2, "0").repeat(128 * 1024) : "");
      observed.add(snapshot.sequence);
      if (barrier === snapshot.sequence) { barrier = null; writer.send({ type: "continue" }); }
    }
    assert.equal((await exit)[0], 0);
    assert(reads >= 4);
    for (const sequence of [10, 20, 30, 40]) assert(observed.has(sequence));
    assert.equal(JSON.parse(await readFile(file, "utf8")).sequence, 40);
    assert.deepEqual(await readdir(root), ["state.json"], "Owned temporary files must be cleaned");
  } finally { if (writer.exitCode == null) writer.kill(); }
});

test("Windows snapshot publishing survives a real sharing handle held beyond the ordinary checkpoint retry budget", { skip: process.platform !== "win32", timeout: 20000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse snapshot occupied-")), file = path.join(root, "state.json");
  await writeJsonSnapshotAtomic(file, { quota: 10 });
  const script = `$f=[IO.File]::Open($env:PULSE_LOCK_TARGET,'Open','Read',[IO.FileShare]::Read);try{[Console]::WriteLine('locked');[Console]::Out.Flush();Start-Sleep -Milliseconds 1000}finally{$f.Dispose()}`;
  const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, env: { ...process.env, PULSE_LOCK_TARGET: file }, stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(holder, "exit");
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Sharing holder never became ready")), 10000);
      holder.stdout.on("data", value => { if (value.toString().includes("locked")) { clearTimeout(timer); resolve(); } });
      holder.once("error", error => { clearTimeout(timer); reject(error); });
      holder.once("exit", () => { clearTimeout(timer); reject(Error("Sharing holder exited before readiness")); });
    });
    const publishing = writeJsonSnapshotAtomic(file, { quota: 100 });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { quota: 10 }, "Denied replacement must leave the old complete snapshot readable");
    await publishing;
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { quota: 100 });
    assert.deepEqual(await readdir(root), ["state.json"]);
    assert.equal((await exited)[0], 0);
  } finally { if (holder.exitCode == null) holder.kill(); }
});

test("failed snapshot preparation or actual replacement preserves prior data and cleans only its own temporary file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse snapshot failure-")), file = path.join(root, "state.json");
  await writeJsonSnapshotAtomic(file, { quota: 10 });
  const circular = {}; circular.self = circular;
  await assert.rejects(writeJsonSnapshotAtomic(file, circular), /circular/i);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { quota: 10 });
  const directory = path.join(root, "not-a-file"); await mkdir(directory); await writeFile(path.join(directory, "keep"), "preserve");
  await assert.rejects(writeJsonSnapshotAtomic(directory, { quota: 100 }));
  assert.equal(await readFile(path.join(directory, "keep"), "utf8"), "preserve");
  assert.deepEqual((await readdir(root)).sort(), ["not-a-file", "state.json"]);
});
