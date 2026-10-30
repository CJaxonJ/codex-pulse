import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, mkdir, writeFile, readFile, symlink, realpath, readdir, rm, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ensureWindowsPrivateDirectory } from "../src/private-directory.mjs";
import { windowsUIFixture } from "../scripts/test-support/windows-ui-fixture.mjs";

const windows = { skip: process.platform !== "win32", timeout: 90000 };
const shell = async (target, command) => JSON.parse((await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; " + command], { env: { ...process.env, PULSE_ACL_TARGET: target }, encoding: "utf8", windowsHide: true, timeout: 20000 })).stdout.replace(/^\uFEFF/, ""));
const acl = target => shell(target, "$directory=([IO.File]::GetAttributes($env:PULSE_ACL_TARGET) -band [IO.FileAttributes]::Directory) -ne 0; $a=if($directory){[IO.Directory]::GetAccessControl($env:PULSE_ACL_TARGET)}else{[IO.File]::GetAccessControl($env:PULSE_ACL_TARGET)}; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @{protected=$a.AreAccessRulesProtected; sddl=$a.Sddl; expected=@($sid,'S-1-5-18'); rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress");
const rejectedFor = reason => error => /无法确认/.test(error.message) && reason.test(error.cause?.stderr || "");

for (const change of ["vanished-descendants", "late-junction", "missing-root"]) test(`actual Windows ACL scan handles ${change} without ignoring unsafe state`, windows, async () => {
  const f = await windowsUIFixture({ installed: false });
  const file = path.join(f.dataDir, "ephemeral.tmp"), directory = path.join(f.dataDir, "changing-lock"), checkpoint = path.join(f.dataDir, "checkpoint.json");
  const outside = path.join(f.root, "outside");
  await mkdir(directory); await writeFile(path.join(directory, "owner.json"), "temporary");
  await writeFile(file, "temporary"); await writeFile(checkpoint, "preserve existing goal");
  await mkdir(outside); await writeFile(path.join(outside, "keep.txt"), "external data");
  const externalBefore = (await acl(outside)).sddl;
  const marker = path.join(f.root, "acl-scan-complete"), release = path.join(f.root, "release-acl");
  const script = path.join(f.appRoot, "src", "private-directory-windows.ps1"), source = await readFile(script, "utf8"), needle = "$phase = 'acl'";
  assert.equal(source.split(needle).length, 2);
  const literal = text => "'" + text.replaceAll("'", "''") + "'";
  await writeFile(script, source.replace(needle, `${needle}
[IO.File]::WriteAllText(${literal(marker)},'ready')
$pause=[Diagnostics.Stopwatch]::StartNew()
while(-not [IO.File]::Exists(${literal(release)})){if($pause.ElapsedMilliseconds -gt 18000){throw 'Isolated scan barrier expired'};Start-Sleep -Milliseconds 20}
`));
  const checking = f.cli(["background-prepare"]); checking.catch(() => {});
  try {
    const deadline = Date.now() + 15000;
    while (true) {
      try { await readFile(marker); break; } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Date.now() > deadline) throw Error("Actual ACL scan did not reach the deterministic barrier");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (change === "vanished-descendants") {
      await rm(file); await rm(directory, { recursive: true });
    } else if (change === "late-junction") {
      await rename(directory, path.join(f.root, "retired-lock"));
      await symlink(outside, directory, "junction");
    } else await rm(f.dataDir, { recursive: true });
    await writeFile(release, "continue");
    if (change === "vanished-descendants") {
      const result = await checking; assert.equal(result.ok, true); assert(result.vanished >= 2);
      assert.equal(await readFile(checkpoint, "utf8"), "preserve existing goal");
      for (const entry of [f.dataDir, checkpoint]) {
        const actual = await acl(entry); assert.equal(actual.protected, true); assert.deepEqual(actual.rules.sort(), actual.expected.sort());
      }
    } else {
      await assert.rejects(checking, error => /无法确认/.test(error.stderr || ""));
      if (change === "missing-root") await assert.rejects(readdir(f.dataDir), { code: "ENOENT" });
    }
    assert.equal((await acl(outside)).sddl, externalBefore);
    assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "external data");
  } finally { await writeFile(release, "cleanup"); await checking.catch(() => {}); }
});

test("Windows data ACL removes broad existing access, protects existing files and future children, and is repeatable", windows, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse 私有 ACL-"));
  const data = path.join(root, "数据 空格"), record = path.join(data, "checkpoint.json");
  await mkdir(data); await writeFile(record, "preserved checkpoint");
  // Modify DACL only. Get-Acl/Set-Acl of the full descriptor can also attempt
  // an owner write, which is neither needed nor allowed for this fixture.
  await shell(record, "$a=New-Object Security.AccessControl.FileSecurity; $current=[IO.File]::GetAccessControl($env:PULSE_ACL_TARGET); $a.SetSecurityDescriptorSddlForm($current.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access),[Security.AccessControl.AccessControlSections]::Access); $s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow'))); [IO.File]::SetAccessControl($env:PULSE_ACL_TARGET,$a); @{ok=$true} | ConvertTo-Json -Compress");
  const publicBefore = await acl(record);
  assert(publicBefore.rules.includes("S-1-1-0"), JSON.stringify(publicBefore));
  assert.equal((await ensureWindowsPrivateDirectory(data)).ok, true);
  const staged = path.join(data, "app", "src"); await mkdir(staged, { recursive: true });
  for (const name of ["private-directory.mjs", "private-directory-windows.ps1", "windows-process-bridge.mjs"]) await cp(path.resolve(import.meta.dirname, "../src", name), path.join(staged, name));
  for (const name of ["CodexPulse.exe", "CodexPulse.exe.config"]) await cp(path.resolve(import.meta.dirname, "../build/windows", name), path.join(data, "app", name));
  const installed = await import(pathToFileURL(path.join(staged, "private-directory.mjs")).href);
  assert.equal((await installed.ensureWindowsPrivateDirectory(data)).ok, true, "The same check must work from the real data/app/src installation layout");
  for (const entry of [data, record]) {
    const value = await acl(entry);
    assert.equal(value.protected, true);
    assert.deepEqual(value.rules.sort(), value.expected.sort());
  }
  const child = path.join(data, "new-record.json"); await writeFile(child, "new");
  const inherited = await acl(child);
  assert.deepEqual(inherited.rules.sort(), inherited.expected.sort());
  assert.equal(await readFile(record, "utf8"), "preserved checkpoint");
  assert.equal(await readFile(child, "utf8"), "new");
});

test("Windows ACL guard rejects broad roots and junctions before altering either tree", windows, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse ACL boundary-"));
  const data = path.join(root, "data"), outside = path.join(root, "outside");
  await mkdir(data); await mkdir(outside);
  await writeFile(path.join(outside, "keep"), "outside unchanged");
  const before = (await acl(data)).sddl, external = (await acl(outside)).sddl;
  await symlink(outside, path.join(data, "junction"), "junction");
  await assert.rejects(ensureWindowsPrivateDirectory(data), rejectedFor(/Refusing a linked/));
  await assert.rejects(ensureWindowsPrivateDirectory(path.join(data, "junction", "new")), rejectedFor(/Refusing a linked/));
  assert.equal((await acl(data)).sddl, before);
  assert.equal((await acl(outside)).sddl, external);
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "outside unchanged");
  const tempAcl = (await acl(os.tmpdir())).sddl;
  await assert.rejects(ensureWindowsPrivateDirectory(os.tmpdir()), rejectedFor(/Refusing a broad data directory/));
  assert.equal((await acl(os.tmpdir())).sddl, tempAcl);
  const broken = path.join(root, "broken-data"); await mkdir(broken);
  await symlink(path.join(root, "missing-target"), path.join(broken, "junction"), "junction");
  const brokenAcl = (await acl(broken)).sddl;
  await assert.rejects(ensureWindowsPrivateDirectory(broken), rejectedFor(/Refusing a linked/));
  await assert.rejects(ensureWindowsPrivateDirectory(path.join(broken, "junction", "new")), rejectedFor(/Refusing a linked/));
  assert.equal((await acl(broken)).sddl, brokenAcl);
});

test("Windows ACL setup is an explicit no-op on other platforms", { skip: process.platform === "win32" }, async () => {
  assert.deepEqual(await ensureWindowsPrivateDirectory(os.tmpdir()), { ok: true, applicable: false });
});

test("8.3 aliases cannot bypass native or ACL broad-directory guards; only an isolated child TEMP is used", windows, async context => {
  const f = await windowsUIFixture({ installed: true });
  const location = path.join(f.root, "isolated temporary area"), sentinel = path.join(location, "keep.txt");
  await mkdir(location); await writeFile(sentinel, "keep this isolated directory unchanged");
  const target = await realpath(location);
  const shortScript = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);
Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class ShortPathFixture{[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern uint GetShortPathNameW(string p,StringBuilder b,uint n);}';
$b=New-Object Text.StringBuilder(32768);$n=[ShortPathFixture]::GetShortPathNameW($env:PULSE_ACL_TARGET,$b,$b.Capacity);if($n -eq 0 -or $n -ge $b.Capacity){throw 'Could not inspect the actual short path'};@{path=$b.ToString()}|ConvertTo-Json -Compress`;
  const alias = (await shell(target, shortScript)).path;
  if (alias.toLowerCase() === target.toLowerCase()) { context.skip("This filesystem has no 8.3 alias for the isolated directory; alias-specific behavior cannot be exercised"); return; }
  const before = await acl(target), env = { ...f.env, TEMP: alias, TMP: alias, CODEX_PULSE_DATA_DIR: target, PULSE_BOUNDARY_TARGET: target };
  const module = pathToFileURL(path.resolve(import.meta.dirname, "../src/private-directory.mjs")).href;
  await assert.rejects(promisify(execFile)(process.execPath, ["--input-type=module", "-e", `import {ensureWindowsPrivateDirectory} from ${JSON.stringify(module)};await ensureWindowsPrivateDirectory(process.env.PULSE_BOUNDARY_TARGET);`], {
    env, encoding: "utf8", windowsHide: true, timeout: 45000,
  }), error => /Refusing a broad data directory/.test(error.stderr || ""));
  assert.equal((await acl(target)).sddl, before.sddl, "Refusal must precede any ACL mutation");
  await assert.rejects(promisify(execFile)(path.join(f.appRoot, "CodexPulse.exe"), ["--background"], {
    env, encoding: "utf8", windowsHide: true, timeout: 20000,
  }), error => error.code === 1 && /IOException/.test(error.stderr || ""));
  assert.deepEqual(await readdir(target), ["keep.txt"], "Native refusal must precede creating a background guard or worker");
  assert.equal(await readFile(sentinel, "utf8"), "keep this isolated directory unchanged");
  assert.equal((await acl(target)).sddl, before.sddl);
});
