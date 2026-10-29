import { open, rename } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute=promisify(execFile);

// The caller must flush and close the temporary file before publishing it.
// Do not swallow Windows' unsupported directory-fsync error and pretend the
// redemption identity is durable: use the native write-through move instead.
export async function durableReplace(temporary,destination){
  if(path.dirname(temporary)!==path.dirname(destination))throw Error("Durable replacement must stay in the same directory");
  if(process.platform==="win32"){
    await execute("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",path.join(import.meta.dirname,"durable-replace-windows.ps1")],{
      windowsHide:true,timeout:20000,maxBuffer:64*1024,
      env:{...process.env,CODEX_PULSE_MOVE_SOURCE:temporary,CODEX_PULSE_MOVE_DESTINATION:destination},
    });
    return;
  }
  await rename(temporary,destination);
  const directory=await open(path.dirname(destination),"r");
  try{await directory.sync();}finally{await directory.close();}
}
