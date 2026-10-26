import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publicContentFindings, scanPublicDirectory, scanPublicRepository, safeLocation } from "../scripts/public-content-policy.mjs";

const fakeToken = () => "gh" + "p_" + "A".repeat(40);
const temporary = () => mkdtempSync(path.join(os.tmpdir(), "pulse-public-check-"));

test("public checks preserve useful architecture, public endpoints and synthetic examples", () => {
  const text = "https://codex-reset.com /Users/tester dev@example.invalid hooks/list config/batchWrite";
  assert.deepEqual(publicContentFindings("README.md", Buffer.from(text)), []);
  assert.deepEqual(publicContentFindings(".env.example", Buffer.from("TOKEN=replace-me")), []);
});

test("secret findings expose location and type, never the value", () => {
  const secret = fakeToken(), text = Buffer.from("sample\n" + secret);
  const found = publicContentFindings("sample.txt", text);
  assert.deepEqual(found, [{ rule: "github-credential", line: 2 }]);
  assert.equal(JSON.stringify(found).includes(secret), false);
  assert.equal(safeLocation(secret + ".txt").includes(secret), false);
  const key = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  assert.ok(publicContentFindings("sample.txt", Buffer.from(key)).some(f => f.rule === "private-key"));
});

test("personal paths, personal email and internal domains are blocked without raw output", () => {
  const email = ["private-person", "gmail.com"].join("@");
  const text = ["/Users/" + "private-person/project", email, ["tools", "corp", "example", "com"].join(".")].join("\n");
  const found = publicContentFindings("sample.txt", Buffer.from(text));
  assert.deepEqual(found.map(f => f.rule).sort(), ["personal-home-path", "personal-email", "internal-domain"].sort());
  assert.equal(JSON.stringify(found).includes(email), false);
  assert.equal(safeLocation(email + "/file.txt").includes(email), false);
});

test("archive checks reject credential files, private directories and symlinks", () => {
  const root = temporary();
  try {
    mkdirSync(path.join(root, "private"));
    writeFileSync(path.join(root, "private/note.md"), "private note");
    writeFileSync(path.join(root, "auth.json"), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(root, "SUBMISSION.md"), "maintainer details");
    symlinkSync("auth.json", path.join(root, "shortcut"));
    const found = scanPublicDirectory(root).findings;
    for (const rule of ["private-file", "symlink", "maintainer-file-in-artifact"]) assert.ok(found.some(f => f.rule === rule));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("history scan catches a removed credential while reporting only safe metadata", () => {
  const root = temporary(), secret = fakeToken();
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "-q"); git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid"); git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(root, "sample.txt"), secret); git("add", "sample.txt"); git("commit", "-qm", "fixture");
    writeFileSync(path.join(root, "sample.txt"), "removed"); git("add", "sample.txt"); git("commit", "-qm", "remove fixture value");
    const report = scanPublicRepository(root);
    assert.ok(report.findings.some(f => f.object && f.rule === "github-credential"));
    assert.equal(report.historicalEmailCommits, 0);
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gitignore protects local credentials without hiding example templates", () => {
  const project = path.resolve(import.meta.dirname, "..");
  const input = [".env", ".env.local", "auth.json", "private/note.md", "credit-operations/pending.json", "private.key"].join("\n") + "\n";
  const ignored = execFileSync("git", ["check-ignore", "--stdin"], { cwd: project, input, encoding: "utf8" });
  assert.equal(ignored.trim().split("\n").length, 6);
  assert.throws(() => execFileSync("git", ["check-ignore", ".env.example"], { cwd: project, stdio: "pipe" }));
});

test("commit message secrets are blocked while historical author email is only counted", () => {
  const root = temporary(), secret = fakeToken();
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init", "-q"); git("config", "user.name", "Fixture");
    git("config", "user.email", ["private-person", "gmail.com"].join("@"));
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(root, "sample.txt"), "safe"); git("add", "sample.txt"); git("commit", "-qm", secret);
    const report = scanPublicRepository(root);
    assert.equal(report.historicalEmailCommits, 1);
    assert.ok(report.findings.some(f => f.file === "commit-message" && f.rule === "github-credential"));
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("command-line failure output is redacted and returns nonzero", () => {
  const root = temporary(), secret = fakeToken();
  try {
    writeFileSync(path.join(root, "sample.txt"), secret);
    let error;
    try { execFileSync(process.execPath, [path.resolve(import.meta.dirname, "../scripts/check-public-content.mjs"), "--directory", root], { stdio: "pipe" }); }
    catch (e) { error = e; }
    assert.equal(error?.status, 1);
    const output = error.stdout.toString() + error.stderr.toString();
    assert.equal(JSON.parse(error.stdout).ok, false);
    assert.equal(output.includes(secret), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
