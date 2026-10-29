import { rename } from "node:fs/promises";

// Antivirus/indexers can temporarily deny replacement on Windows. Keep the
// original destination intact; retry the same prepared file, never unlink it.
export async function renameAtomic(source,destination,{platform=process.platform,move=rename,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  const delays=[10,20,40,80,160,200];
  for(let attempt=0;;attempt++){
    try{return await move(source,destination);}
    catch(error){
      if(platform!=="win32" || !["EPERM","EACCES","EBUSY"].includes(error.code) || attempt===delays.length)throw error;
      await sleep(delays[attempt]);
    }
  }
}
