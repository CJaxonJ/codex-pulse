#!/usr/bin/env node
// Real launchd process swap/rollback under a unique temporary service label.
// No product service, Codex account, GUI permission or user settings are touched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceInstallation, stopService, serviceLoaded } from "./installation-transaction.mjs";

if (process.platform !== "darwin") throw Error("macOS required");
const root=mkdtempSync(path.join(os.tmpdir(),"pulse-launchd-acceptance-"));
const runtime=path.join(root,"runtime"), app=path.join(root,"App"), marker=path.join(root,"marker.txt");
const staged=path.join(root,"staged"), stagedApp=path.join(root,"staged-app");
const label=`com.cjaxonj.codex-pulse.acceptance.${process.pid}`;
const service=`gui/${process.getuid()}/${label}`, plist=path.join(root,"service.plist");
const xml=s=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
function candidate(folder,version) {
  mkdirSync(folder,{recursive:true});
  writeFileSync(path.join(folder,"worker.cjs"),`const fs=require("node:fs"); setInterval(()=>fs.writeFileSync(${JSON.stringify(marker)},${JSON.stringify(version)}),100);`);
}
function waitMarker(value) {
  const deadline=Date.now()+8000;
  while (Date.now()<deadline) {
    try {if(readFileSync(marker,"utf8")===value)return;} catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,100);
  }
  throw Error(`Test service did not produce ${value}`);
}
candidate(runtime,"old");mkdirSync(app);writeFileSync(path.join(app,"version"),"old");
writeFileSync(plist,`<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(path.join(runtime,"worker.cjs"))}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`);
try {
  execFileSync("/bin/launchctl",["bootstrap",`gui/${process.getuid()}`,plist]);waitMarker("old");
  candidate(staged,"new");mkdirSync(stagedApp);writeFileSync(path.join(stagedApp,"version"),"new");
  assert.throws(()=>replaceInstallation({components:[[runtime,staged],[app,stagedApp]],service,plistPath:plist,
    verify(){waitMarker("new");throw Error("intentional-validation-failure");}}),/intentional-validation-failure/);
  waitMarker("old");assert.equal(readFileSync(path.join(app,"version"),"utf8"),"old");
  assert.equal(serviceLoaded(service),true);
  candidate(staged,"new");cpSync(app,stagedApp,{recursive:true});writeFileSync(path.join(stagedApp,"version"),"new");
  replaceInstallation({components:[[runtime,staged],[app,stagedApp]],service,plistPath:plist,verify(){waitMarker("new");}});
  assert.equal(readFileSync(path.join(app,"version"),"utf8"),"new");
  console.log(JSON.stringify({ok:true,realLaunchd:true,realProcessRollback:true,realProcessUpgrade:true,
    productionServiceTouched:false,quotaSpent:0,evidence:root},null,2));
} finally {
  stopService(service,plist);
  assert.equal(serviceLoaded(service),false,"Test service must not remain loaded");
}
