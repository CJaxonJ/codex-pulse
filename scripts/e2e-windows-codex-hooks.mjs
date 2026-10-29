import assert from "node:assert/strict";
import path from "node:path";
import { protectionFixture } from "./test-support/protection-fixture.mjs";
import { AppServerClient } from "../src/app-server-client.mjs";

if(process.platform!=="win32")throw Error("This acceptance requires native Windows, not a platform mock");
const project=path.resolve(import.meta.dirname,"..");
const fixture=await protectionFixture(project);
const originalHome=process.env.CODEX_HOME;
process.env.CODEX_HOME=fixture.home;
const client=new AppServerClient();
try{
  await client.start();
  const result=await client.request("hooks/list",{cwds:[fixture.home]});
  const hooks=(result.data||[]).flatMap(e=>e.hooks||[]).filter(h=>h.pluginId==="codex-pulse@codex-pulse-local");
  assert.equal(hooks.length,6);
  console.error(JSON.stringify({actualCodexWindowsHookMetadata:{fields:Object.keys(hooks[0]),command:hooks[0].command,commandWindows:hooks[0].commandWindows}}));
}finally{client.stop();if(originalHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=originalHome;}
const before=await fixture.config();
const review=await fixture.cli(["protection","prepare"]);
assert.equal(review.trusted,false);assert.equal(await fixture.config(),before);
const confirmation=await fixture.cli(["protection","enable","--review",review.reviewId,"--yes"]);
assert.equal(confirmation.trusted,true);
assert.equal((await fixture.cli(["protection","status"])).trusted,true);
console.log(JSON.stringify({ok:true,nativeWindows:true,actualCodex:true,isolatedConsentOnly:true,productionConfigTouched:false,quotaSpent:0}));
