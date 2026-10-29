import test from "node:test";
import assert from "node:assert/strict";
import { renameAtomic } from "../src/atomic-file.mjs";
import { mkdtemp, writeFile, readFile, rename } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

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
