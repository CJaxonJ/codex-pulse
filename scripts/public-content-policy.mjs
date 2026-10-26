import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// A small, explicit privacy guard, complementary to GitHub secret scanning.
// Never put matched values or raw subprocess output into a failure report.
const rules = [
  ["github-credential", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["openai-credential", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/],
  ["aws-credential", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["jwt-credential", /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}/],
  ["literal-bearer", /\bBearer\s+[A-Za-z0-9._~+\/-]{24,}/],
  ["internal-domain", /\b(?:[a-z0-9-]+\.)*(?:corp|internal)\.[a-z0-9.-]+\.[a-z]{2,}\b/i],
  ["personal-email", /\b[A-Z0-9._%+-]+@(?:gmail\.com|163\.com|qq\.com|outlook\.com|hotmail\.com|icloud\.com)\b/i],
];
const exampleUsers = new Set(["tester", "runner", "example", "user", "username"]);
const privateDirectories = new Set(["private", ".codex", "credit-operations",
  "protection-review", "hook-decisions", "managed-tasks", "chat-continuity"]);
const privateNames = /^(?:\.env(?:\..+)?|auth(?:-.+)?\.json|credentials.*\.json|cookies.*\.(?:json|txt)|id_rsa|id_ed25519|state\.json|monitor\.log)$/i;

export function publicPathFindings(filename, { artifact = false } = {}) {
  const parts = filename.split(/[\\/]/), name = parts.at(-1);
  const forbidden = parts.some(p => privateDirectories.has(p)) ||
    (name !== ".env.example" && privateNames.test(name)) || /\.(?:pem|key|p12|pfx)$/i.test(name);
  return forbidden ? [{ rule: "private-file", line: null }] :
    artifact && name === "SUBMISSION.md" ? [{ rule: "maintainer-file-in-artifact", line: null }] : [];
}

export function publicContentFindings(filename, buffer, options = {}) {
  const findings = publicPathFindings(filename, options);
  if (buffer.includes(0)) return findings; // Images and binary metadata need separate manual review.
  for (const [index, text] of buffer.toString("utf8").split("\n").entries()) {
    for (const [rule, pattern] of rules) if (pattern.test(text)) findings.push({ rule, line: index + 1 });
    for (const m of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) {
      if (!exampleUsers.has(m[1])) findings.push({ rule: "personal-home-path", line: index + 1 });
    }
  }
  return findings;
}

// Paths themselves can contain an address/secret. Keep locations useful without
// turning the scanner's own output into another disclosure channel.
export function safeLocation(filename) {
  let value = filename.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<email>");
  for (const [, pattern] of rules) value = value.replace(new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g"), "<redacted>");
  return value.replace(/\/(?:Users|home)\/[^/]+/g, "/<home>");
}

export function scanPublicDirectory(root, options = { artifact: true }) {
  let files = 0; const findings = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), relative = path.relative(root, full);
      if (entry.isSymbolicLink()) findings.push({ file: safeLocation(relative), rule: "symlink", line: null });
      else if (entry.isDirectory()) {
        for (const finding of publicPathFindings(relative + "/", options)) findings.push({ file: safeLocation(relative), ...finding });
        walk(full);
      } else {
        files++;
        for (const finding of publicContentFindings(relative, readFileSync(full), options)) findings.push({ file: safeLocation(relative), ...finding });
      }
    }
  }
  walk(root);
  return { files, findings };
}

export function scanPublicRepository(root) {
  const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  const files = git("ls-files", "-z").toString().split("\0").filter(Boolean);
  const findings = [];
  for (const file of files) {
    const full = path.join(root, file);
    let stat;
    try { stat = lstatSync(full); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    if (stat.isSymbolicLink()) findings.push({ file: safeLocation(file), rule: "symlink", line: null });
    else for (const finding of publicContentFindings(file, readFileSync(full))) findings.push({ file: safeLocation(file), ...finding });
  }
  const objects = git("rev-list", "--objects", "--all").toString().trim().split("\n").filter(Boolean)
    .map(s => ({ id: s.slice(0, 40), file: s.slice(41) }));
  const all = execFileSync("git", ["cat-file", "--batch"], { cwd: root,
    input: objects.map(o => o.id).join("\n") + "\n", maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
  let offset = 0, historicalEmailCommits = 0;
  for (const object of objects) {
    const end = all.indexOf(10, offset), header = all.subarray(offset, end).toString().split(" ");
    const size = Number(header[2]);
    if (end < 0 || !Number.isSafeInteger(size) || size < 0) throw Error("Invalid Git object response");
    offset = end + 1;
    const buffer = all.subarray(offset, offset + size); offset += size + 1;
    if (header[1] === "blob") {
      for (const finding of publicContentFindings(object.file, buffer)) findings.push({
        file: safeLocation(object.file), object: object.id.slice(0, 12), ...finding });
    } else if (header[1] === "commit") {
      const author = buffer.toString().match(/^author .*<([^>]+)>/m)?.[1];
      if (author && !/@(?:users\.noreply\.github\.com|example\.(?:com|test|invalid))$/i.test(author)) historicalEmailCommits++;
      const message = buffer.subarray(buffer.indexOf("\n\n") + 2);
      for (const finding of publicContentFindings("commit-message", message)) findings.push({
        file: "commit-message", object: object.id.slice(0, 12), ...finding });
    } else if (header[1] === "tag") {
      const message = buffer.subarray(buffer.indexOf("\n\n") + 2);
      for (const finding of publicContentFindings("tag-message", message)) findings.push({
        file: "tag-message", object: object.id.slice(0, 12), ...finding });
    }
  }
  return { files: files.length, historyObjects: objects.length, historicalEmailCommits, findings };
}
