import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Antivirus/indexers can temporarily deny replacement on Windows. Keep the
// original destination intact; retry the same prepared file, never unlink it.
export async function renameAtomic(source,destination,{platform=process.platform,move=rename,
  retryDelays=[10,20,40,80,160,200],
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const delays=retryDelays;
  for(let attempt=0;;attempt++){
    try{return await move(source,destination);}
    catch(error){
      if(platform!=="win32" || !["EPERM","EACCES","EBUSY"].includes(error.code) || attempt===delays.length)throw error;
      await sleep(delays[attempt]);
    }
  }
}

// Publish a complete shared snapshot. This does not replace the durable
// credit-operation journal or its separate Windows write-through contract.
export async function writeJsonSnapshotAtomic(destination, value) {
  const encoded = JSON.stringify(value, null, 2);
  if (typeof encoded !== "string") throw new TypeError("A JSON snapshot is required");
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let owned = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    owned = true;
    try { await file.writeFile(encoded + "\n", "utf8"); await file.sync(); }
    finally { await file.close(); }
    // A shared status snapshot has active cross-process readers. Its publisher
    // can tolerate a longer bounded contention window than a Hook checkpoint;
    // never truncate/unlink the prior snapshot to make replacement succeed.
    await renameAtomic(temporary, destination, {
      retryDelays: [10,20,40,80,160,200,250,300,400,500,500,500],
    });
  } finally { if (owned) await rm(temporary, { force: true }); }
}
