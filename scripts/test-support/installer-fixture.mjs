import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function installerFixture(source,{existing=false,realCodex=null}={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),"pulse-install-fixture-"));
  const project=path.join(root,"release"),home=path.join(root,"home");
  mkdirSync(home);mkdirSync(project);
  mkdirSync(path.join(home,".codex"));
  // Copy product code only, never the developer's private notes or local runtime.
  for(const entry of ["bin","src","scripts","native","plugin",".agents","brand","package.json"]) {
    if(existsSync(path.join(source,entry))) cpSync(path.join(source,entry),path.join(project,entry),{recursive:true});
  }
  writeFileSync(path.join(home,"isolated-installer-fixture"),"isolated");
  const data=path.join(home,"Library/Application Support/Codex Pulse");
  const runtime=path.join(data,"app"),app=path.join(home,"Applications/Codex Pulse.app");
  const plist=path.join(home,"Library/LaunchAgents/com.cjaxonj.codex-pulse.plist");
  mkdirSync(data,{recursive:true});
  writeFileSync(path.join(data,"preferences.json"),'{"quotaPolicy":"strict_reserve","autoRedeem":{"enabled":false}}');
  writeFileSync(path.join(data,"checkpoint-fixture.json"),"untouched-checkpoint");
  if(existing){
    mkdirSync(path.join(runtime,"bin"),{recursive:true});writeFileSync(path.join(runtime,"bin/codex-pulse.mjs"),"old-runtime");
    writeFileSync(path.join(runtime,"package.json"),JSON.stringify({name:"codex-pulse",version:"0.9.17"}));
    mkdirSync(path.join(app,"Contents/MacOS"),{recursive:true});writeFileSync(path.join(app,"Contents/MacOS/CodexPulseNotifier"),"old-app");
    mkdirSync(path.dirname(plist),{recursive:true});writeFileSync(plist,"old-plist");
    const cache=path.join(home,".codex/plugins/cache/codex-pulse-local/codex-pulse/0.9.17");
    cpSync(path.join(source,"plugin"),cache,{recursive:true});
    const manifestFile=path.join(cache,".codex-plugin/plugin.json");
    const manifest=JSON.parse(readFileSync(manifestFile));manifest.version="0.9.17";
    writeFileSync(manifestFile,JSON.stringify(manifest));
    writeFileSync(path.join(home,".codex/config.toml"),'[plugins."codex-pulse@codex-pulse-local"]\nenabled = true\n# fixture-user-trust-unchanged\n');
  }
  writeFileSync(path.join(home,"platform.json"),JSON.stringify({running:existing,marketplaces:[],plugins:existing?
    [{pluginId:"codex-pulse@codex-pulse-local",version:"0.9.17"},{pluginId:"unrelated@other",version:"1"}]:[]}));
  const loader=path.resolve(import.meta.dirname,"installer-boundary-loader.mjs");
  const env={...process.env,HOME:home,CODEX_HOME:path.join(home,".codex"),
    CODEX_BINARY:realCodex || path.join(root,"fixture-codex"),PULSE_INSTALL_FIXTURE:home,
    PULSE_INSTALL_REAL_CODEX:realCodex ? "1" : "0",
    NODE_OPTIONS:`--import=${pathToFileURL(loader).href}`,CODEX_PULSE_INTERACTIVE_INSTALL:"1"};
  const run=(script,failure="")=>{
    try {return {code:0,stdout:execFileSync(process.execPath,[path.join(project,"scripts",script)],{env:{...env,PULSE_INSTALL_FAILURE:failure},encoding:"utf8",stdio:"pipe",timeout:20000})};}
    catch(e){return {code:e.status || 1,stdout:e.stdout?.toString() || "",stderr:e.stderr?.toString() || ""};}
  };
  const read=p=>existsSync(p)?readFileSync(p,"utf8"):null;
  return {root,home,project,data,runtime,app,plist,env,run,read,platform:()=>JSON.parse(read(path.join(home,"platform.json"))),
    calls:()=>read(path.join(home,"calls.jsonl"))?.trim().split("\n").map(JSON.parse) || []};
}
