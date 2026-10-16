import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export class WorkspaceInspector {
  async exists(cwd) {
    try {
      await access(cwd);
      return true;
    } catch {
      return false;
    }
  }

  async fingerprint(cwd) {
    try {
      const [head, status, diff] = await Promise.all([
        git(cwd, ["rev-parse", "HEAD"]),
        git(cwd, ["status", "--porcelain=v2", "--untracked-files=all"]),
        git(cwd, ["diff", "--binary", "HEAD"]),
      ]);
      return createHash("sha256").update(head).update(status).update(diff).digest("hex");
    } catch {
      return null;
    }
  }
}
