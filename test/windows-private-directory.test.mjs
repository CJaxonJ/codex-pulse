import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureWindowsPrivateDirectory } from "../src/private-directory.mjs";

const windows = { skip: process.platform !== "win32", timeout: 90000 };
const shell = async (target, command) => JSON.parse((await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env: { ...process.env, PULSE_ACL_TARGET: target }, encoding: "utf8", windowsHide: true, timeout: 20000 })).stdout.replace(/^\uFEFF/, ""));
const acl = target => shell(target, "$a=Get-Acl -LiteralPath $env:PULSE_ACL_TARGET; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @{protected=$a.AreAccessRulesProtected; sddl=$a.Sddl; expected=@($sid,'S-1-5-18'); rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object {$_.IdentityReference.Value})} | ConvertTo-Json -Compress");

test("Windows data ACL removes broad existing access, protects existing files and future children, and is repeatable", windows, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pulse 私有 ACL-"));
  const data = path.join(root, "数据 空格"), record = path.join(data, "checkpoint.json");
  await mkdir(data); await writeFile(record, "preserved checkpoint");
  await shell(record, "$a=Get-Acl -LiteralPath $env:PULSE_ACL_TARGET; $s=New-Object Security.Principal.SecurityIdentifier('S-1-1-0'); $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($s,'Read','Allow'))); Set-Acl -LiteralPath $env:PULSE_ACL_TARGET -AclObject $a; @{ok=$true} | ConvertTo-Json -Compress");
  assert((await acl(record)).rules.includes("S-1-1-0"));
  assert.equal((await ensureWindowsPrivateDirectory(data)).ok, true);
  assert.equal((await ensureWindowsPrivateDirectory(data)).ok, true);
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
  await assert.rejects(ensureWindowsPrivateDirectory(data), /无法确认/);
  await assert.rejects(ensureWindowsPrivateDirectory(path.join(data, "junction", "new")), /无法确认/);
  assert.equal((await acl(data)).sddl, before);
  assert.equal((await acl(outside)).sddl, external);
  assert.equal(await readFile(path.join(outside, "keep"), "utf8"), "outside unchanged");
  const tempAcl = (await acl(os.tmpdir())).sddl;
  await assert.rejects(ensureWindowsPrivateDirectory(os.tmpdir()), /无法确认/);
  assert.equal((await acl(os.tmpdir())).sddl, tempAcl);
  const broken = path.join(root, "broken-data"); await mkdir(broken);
  await symlink(path.join(root, "missing-target"), path.join(broken, "junction"), "junction");
  const brokenAcl = (await acl(broken)).sddl;
  await assert.rejects(ensureWindowsPrivateDirectory(broken), /无法确认/);
  assert.equal((await acl(broken)).sddl, brokenAcl);
});

test("Windows ACL setup is an explicit no-op on other platforms", { skip: process.platform === "win32" }, async () => {
  assert.deepEqual(await ensureWindowsPrivateDirectory(os.tmpdir()), { ok: true, applicable: false });
});
