#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { installerFixture } from "./test-support/installer-fixture.mjs";
import { resolveCodexBinary } from "../src/app-server-client.mjs";

const project=path.resolve(import.meta.dirname,"..");
const binary=resolveCodexBinary();
const fixture=installerFixture(project,{realCodex:binary});
const cli=args=>JSON.parse(execFileSync(binary,args,{env:fixture.env,encoding:"utf8",timeout:30_000}));
const id="codex-pulse@codex-pulse-local";
try {
  const first=fixture.run("install-macos.mjs"); assert.equal(first.code,0,first.stderr);
  const installed=cli(["plugin","list","--json"]).installed.find(p=>p.pluginId===id);
  assert.ok(installed); assert.equal(installed.enabled,true);
  const before=fixture.read(path.join(fixture.home,".codex/config.toml"));
  // Installer opens consent only; it never writes hook trust on its own.
  assert.doesNotMatch(before,/\[hooks\.state\./);
  const second=fixture.run("install-macos.mjs"); assert.equal(second.code,0,second.stderr);
  assert.equal(fixture.read(path.join(fixture.home,".codex/config.toml")),before);
  const removed=fixture.run("uninstall-macos.mjs"); assert.equal(removed.code,0,removed.stderr);
  assert.equal(cli(["plugin","list","--json"]).installed.some(p=>p.pluginId===id),false);
  assert.equal(cli(["plugin","marketplace","list","--json"]).marketplaces.some(p=>p.name==="codex-pulse-local"),false);
  assert.equal(existsSync(fixture.runtime),false); assert.equal(existsSync(fixture.app),false);
  assert.equal(fixture.read(path.join(fixture.data,"checkpoint-fixture.json")),"untouched-checkpoint");
  console.log(JSON.stringify({ok:true,realCodexPluginCommands:true,reinstallPreservedConfig:true,
    actualOSInstallTest:false,simulatedBoundaries:["launchd","native build","account","notifications"],
    productionInstallTouched:false,hookTrustGranted:false,quotaSpent:0,evidence:fixture.root},null,2));
} catch (error) {
  console.error(JSON.stringify({ok:false,error:error.message,evidence:fixture.root}));process.exitCode=1;
}
