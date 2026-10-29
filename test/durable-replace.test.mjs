import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { durableReplace } from "../src/durable-replace.mjs";

test("durable replacement publishes and replaces flushed records on the actual host OS",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"pulse-durable 记录-"));
  const file=path.join(root,"record.json");
  for(let revision=1;revision<=2;revision++){
    const temporary=path.join(root,`pending-${revision}.tmp`),value={revision,key:"same-operation-identity"};
    const handle=await open(temporary,"wx",0o600);
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    await durableReplace(temporary,file);assert.deepEqual(JSON.parse(await readFile(file,"utf8")),value);
  }
  await assert.rejects(durableReplace(path.join(root,"other/temp"),file),/same directory/);
});
