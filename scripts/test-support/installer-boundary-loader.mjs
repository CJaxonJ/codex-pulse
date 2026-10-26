// Test-process-only platform boundary: no launchctl, GUI, account or trust writes.
import child from "node:child_process";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const home = process.env.PULSE_INSTALL_FIXTURE;
if (!home || !existsSync(path.join(home, "isolated-installer-fixture"))) throw Error("Missing isolated installer fixture");
const realExec = child.execFileSync;
os.homedir = () => home;
const record = (kind, args) => appendFileSync(path.join(home, "calls.jsonl"), JSON.stringify({kind,args}) + "\n");
const stateFile = path.join(home, "platform.json");
const load = () => JSON.parse(readFileSync(stateFile));
const save = state => writeFileSync(stateFile, JSON.stringify(state));
const json = value => Buffer.from(JSON.stringify(value));
child.execFileSync = (command, args = [], options = {}) => {
  record(command, args);
  const fail = process.env.PULSE_INSTALL_FAILURE;
  // Optional acceptance: real CLI operations, still isolated CODEX_HOME.
  // launchd, account reads, notification permission and trust stay simulated.
  if (command === process.env.CODEX_BINARY && process.env.PULSE_INSTALL_REAL_CODEX === "1")
    return realExec(command, args, {...options,env:{...process.env,...options.env}});
  if (command === process.execPath) {
    const script = path.basename(args[0] || "");
    if (script === "build-notifier-macos.mjs") {
      if (fail === "build") throw Error("Fixture build failed");
      const app = path.join(path.dirname(path.dirname(args[0])), "build/Codex Pulse.app");
      mkdirSync(path.join(app, "Contents/MacOS"), {recursive:true});
      writeFileSync(path.join(app, "Contents/MacOS/CodexPulseNotifier"), "candidate-app");
      writeFileSync(path.join(app, "Contents/Info.plist"), "candidate-plist");
      if (!args.includes("--no-install")) {
        mkdirSync(path.join(home, "Applications/Codex Pulse.app/Contents/MacOS"), {recursive:true});
        writeFileSync(path.join(home, "Applications/Codex Pulse.app/Contents/MacOS/CodexPulseNotifier"), "candidate-app");
      }
      return json({ok:true});
    }
    if (script === "codex-pulse.mjs") {
      if (args[1] === "status" && fail === "account") throw Error("Fixture account unavailable");
      if (args[1] === "doctor" && fail === "doctor") throw Error("Fixture doctor failed");
      return json({ok:true,installationOk:true});
    }
    if (script === "setup-notifications-macos.mjs") return json({ok:true,permission:"not-simulated-as-granted"});
    if (script === "install-plugin.mjs") {
      if (fail === "plugin") throw Error("Fixture plugin unavailable");
      return realExec(command, args, {...options, env:{...process.env,...options.env}});
    }
  }
  if (command === process.env.CODEX_BINARY) {
    const state = load();
    if (args.join(" ").startsWith("plugin marketplace list")) return json({marketplaces:state.marketplaces});
    if (args.join(" ").startsWith("plugin marketplace add")) {
      state.marketplaces.push({name:"codex-pulse-local",source:args[3]}); save(state); return json({ok:true});
    }
    if (args.join(" ").startsWith("plugin marketplace remove")) {
      state.marketplaces=state.marketplaces.filter(m=>m.name!==args[3]); save(state); return json({ok:true});
    }
    if (args[0] === "plugin" && args[1] === "list") return json({installed:state.plugins});
    if (args[0] === "plugin" && args[1] === "remove") {
      if (fail === "remove-plugin") throw Error("Fixture plugin remove failed");
      state.plugins=state.plugins.filter(p=>p.pluginId!==args[2]);save(state);return json({ok:true});
    }
    if (args[0] === "plugin" && args[1] === "add") {
      state.plugins.push({pluginId:args[2],version:"0.9.18"}); save(state); return json({ok:true});
    }
  }
  if (command === "/bin/launchctl") {
    const state=load();
    if (args[0] === "print" && fail === "unknown-service") throw Object.assign(Error("Fixture unknown service state"),{status:1});
    if (args[0] === "print" && !state.running) throw Object.assign(Error("Fixture service not loaded"),{status:113});
    if (args[0] === "bootout") {
      if (fail === "bootout") throw Error("Fixture service refuses to stop");
      state.running=false;
    }
    else if (args[0] === "bootstrap") {
      if (fail === "bootstrap" && !state.failureInjected) {state.failureInjected=true;save(state);throw Error("Fixture bootstrap failed");}
      state.running=true;
    }
    if (args[0] === "kickstart" && fail === "kickstart" && !state.failureInjected) {
      state.failureInjected=true;save(state);throw Error("Fixture kickstart failed");
    }
    save(state);return Buffer.from("");
  }
  if (command === "/usr/bin/xcrun") {
    if(fail === "compiler") throw Error("Fixture compiler missing");
    return Buffer.from("/fixture/clang");
  }
  if (command.endsWith("/lsregister") || command === "/usr/bin/codesign") return Buffer.from("");
  throw Error("Unexpected platform operation in isolated installer test");
};
child.spawnSync = (command,args) => {record("native-window",[command,...args]);return {status:0};};
syncBuiltinESMExports();
