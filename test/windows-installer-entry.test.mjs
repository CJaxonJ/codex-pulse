import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

// A non-Windows host must reject, not silently do nothing, even when the
// executable script was opened via an alias. Windows execution has its own
// real installer acceptance and must never touch this test runner's account.
test("installer entry executes its platform check through a real directory alias", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse-setup-entry-")), alias = path.join(root, "package-alias");
  await symlink(path.resolve(import.meta.dirname, ".."), alias, "dir");
  await assert.rejects(promisify(execFile)(process.execPath, [path.join(alias, "scripts", "install-windows.mjs")], { timeout: 15000 }),
    error => error.code === 1 && /原生 Windows/.test(error.stderr), "The public entry must run and explicitly reject this platform");
});
