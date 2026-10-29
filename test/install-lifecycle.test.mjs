import test from "node:test";
import { describe } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { rmSync, existsSync, readdirSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { installerFixture } from "../scripts/test-support/installer-fixture.mjs";
import { lockInstallation } from "../scripts/installation-transaction.mjs";
const project=path.resolve(import.meta.dirname,"..");

describe("macOS-specific installation lifecycle",{skip:process.platform!=="darwin"},()=>{

for(const failure of ["account","compiler","build","bootstrap","plugin","doctor","kickstart","bootout","unknown-service"]) test(`failed ${failure} preserves the previous installed bundle and history`,()=>{
  const f=installerFixture(project,{existing:true});
  try {
    const result=f.run("install-macos.mjs",failure);assert.notEqual(result.code,0);
    assert.equal(f.read(path.join(f.runtime,"bin/codex-pulse.mjs")),"old-runtime");
    assert.equal(f.read(path.join(f.app,"Contents/MacOS/CodexPulseNotifier")),"old-app");
    assert.equal(f.read(f.plist),"old-plist");assert.equal(f.platform().running,true);
    assert.equal(f.read(path.join(f.data,"checkpoint-fixture.json")),"untouched-checkpoint");
    assert.equal(JSON.parse(f.read(path.join(f.data,"preferences.json"))).autoRedeem.enabled,false);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("a prior crashed-upgrade backup is retained and blocks replacement",()=>{
  const f=installerFixture(project,{existing:true});
  try {
    const backup=`${f.runtime}.pulse-backup-previous-process`;mkdirSync(backup);writeFileSync(path.join(backup,"evidence"),"keep");
    const result=f.run("update-runtime-macos.mjs");assert.notEqual(result.code,0);assert.match(result.stderr,/未处理的安装备份/);
    assert.equal(f.read(path.join(backup,"evidence")),"keep");assert.equal(f.platform().running,true);
    assert.equal(f.read(path.join(f.runtime,"bin/codex-pulse.mjs")),"old-runtime");
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

for (const failure of ["build", "bootstrap", "kickstart", "doctor", "bootout"]) test(`runtime-only update ${failure} preserves both old runtime and App`, () => {
  const f=installerFixture(project,{existing:true});
  try {
    const config=f.read(path.join(f.home,".codex/config.toml"));
    const result=f.run("update-runtime-macos.mjs",failure); assert.notEqual(result.code,0);
    assert.equal(f.read(path.join(f.runtime,"bin/codex-pulse.mjs")),"old-runtime");
    assert.equal(f.read(path.join(f.app,"Contents/MacOS/CodexPulseNotifier")),"old-app");
    assert.equal(f.platform().running,true);
    assert.equal(f.read(path.join(f.home,".codex/config.toml")),config);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("compatible upgrade preserves plugin cache and trust without remove/add",()=>{
  const f=installerFixture(project,{existing:true});
  try {
    const config=f.read(path.join(f.home,".codex/config.toml"));
    const result=f.run("install-macos.mjs"); assert.equal(result.code,0,result.stderr);
    assert.equal(f.read(path.join(f.home,".codex/config.toml")),config);
    assert.equal(f.platform().plugins.find(p=>p.pluginId==="codex-pulse@codex-pulse-local").version,"0.9.17");
    assert.equal(f.calls().some(c=>c.args[0]==="plugin" && ["remove","add"].includes(c.args[1])),false);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("uninstall plugin removal failure leaves running program intact",()=>{
  const f=installerFixture(project,{existing:true});
  try {
    assert.notEqual(f.run("uninstall-macos.mjs","remove-plugin").code,0);
    assert.equal(f.platform().running,true); assert.ok(existsSync(f.app)); assert.ok(existsSync(f.runtime));
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("changed reviewed definitions fail preflight without removing the old plugin",()=>{
  const f=installerFixture(project,{existing:true});
  try {
    appendFileSync(path.join(f.project,"plugin/scripts/pulse-hook.mjs"),"\n// changed-definition-fixture\n");
    const result=f.run("install-macos.mjs"); assert.notEqual(result.code,0);
    assert.equal(f.platform().running,true);
    assert.equal(f.read(path.join(f.runtime,"bin/codex-pulse.mjs")),"old-runtime");
    assert.equal(f.calls().some(c=>c.args[0]==="plugin" && c.args[1]==="remove"),false);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("a Windows-only launcher difference does not invalidate compatible macOS hooks",()=>{
  const f=installerFixture(project,{existing:true});
  try {
    appendFileSync(path.join(f.project,"plugin/scripts/pulse-hook-windows.ps1"),"\n# Windows-only change\n");
    const config=f.read(path.join(f.home,".codex/config.toml"));
    const result=f.run("install-macos.mjs");assert.equal(result.code,0,result.stderr);
    assert.equal(f.read(path.join(f.home,".codex/config.toml")),config);
    assert.equal(f.calls().some(c=>c.args[0]==="plugin" && ["remove","add"].includes(c.args[1])),false);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("failed fresh install removes its new marketplace and leaves user history",()=>{
  const f=installerFixture(project);
  try {
    assert.notEqual(f.run("install-macos.mjs","doctor").code,0);
    assert.deepEqual(f.platform().plugins,[]); assert.deepEqual(f.platform().marketplaces,[]);
    assert.equal(existsSync(f.app),false);assert.equal(existsSync(f.runtime),false);
    assert.equal(f.read(path.join(f.data,"checkpoint-fixture.json")),"untouched-checkpoint");
    assert.equal(readdirSync(f.data).some(name=>name.includes("install-") || name.includes("backup-")),false);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("install, update and uninstall all refuse a concurrent installation",async()=>{
  const f=installerFixture(project,{existing:true});
  const release=await lockInstallation(f.data);
  try {
    for (const script of ["install-macos.mjs","update-runtime-macos.mjs","uninstall-macos.mjs"]) {
      const result=f.run(script); assert.notEqual(result.code,0);
      assert.match(result.stderr,/正在安装、更新或卸载/);
      assert.equal(f.read(path.join(f.runtime,"bin/codex-pulse.mjs")),"old-runtime");
      assert.equal(f.platform().running,true);
    }
  } finally {await release();rmSync(f.root,{recursive:true,force:true});}
});

test("fresh install opens review without granting consent; uninstall removes owned programs but preserves history",()=>{
  const f=installerFixture(project);
  try {
    const installed=f.run("install-macos.mjs");assert.equal(installed.code,0,installed.stderr);
    assert.equal(existsSync(path.join(f.runtime,"bin/codex-pulse.mjs")),true);
    assert.equal(f.platform().running,true);
    assert.ok(f.calls().some(c=>c.kind==="native-window" && c.args.includes("--protection")));
    assert.equal(f.calls().some(c=>c.args.includes("--yes")),false);
    const removed=f.run("uninstall-macos.mjs");assert.equal(removed.code,0,removed.stderr);
    assert.equal(existsSync(f.runtime),false);assert.equal(existsSync(f.app),false);assert.equal(existsSync(f.plist),false);
    assert.equal(f.platform().running,false);
    assert.equal(f.platform().plugins.some(p=>p.pluginId==="codex-pulse@codex-pulse-local"),false);
    assert.equal(f.read(path.join(f.data,"checkpoint-fixture.json")),"untouched-checkpoint");
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test("uninstall does not remove an unrelated plugin",()=>{
  const f=installerFixture(project,{existing:true});
  try {assert.equal(f.run("uninstall-macos.mjs").code,0);assert.ok(f.platform().plugins.some(p=>p.pluginId==="unrelated@other"));}
  finally {rmSync(f.root,{recursive:true,force:true});}
});
});
