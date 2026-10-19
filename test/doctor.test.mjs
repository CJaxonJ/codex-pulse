import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectLocalInstallation,
  redactDiagnosticText,
} from "../src/doctor.mjs";

function createInstalledFixture() {
  const homeDir = path.join(
    os.tmpdir(),
    `codex-pulse-doctor-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  const dataDir = path.join(homeDir, "Library", "Application Support", "Codex Pulse");
  const paths = [
    path.join(dataDir, "app", "bin"),
    path.join(homeDir, "Library", "LaunchAgents"),
    path.join(homeDir, "Applications", "Codex Pulse.app"),
    path.join(
      homeDir,
      ".codex",
      "plugins",
      "cache",
      "codex-pulse-local",
      "codex-pulse",
      "0.9.0",
    ),
  ];
  for (const directory of paths) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(dataDir, "app", "bin", "codex-pulse.mjs"), "");
  writeFileSync(
    path.join(dataDir, "app", "package.json"),
    JSON.stringify({ version: "0.9.0" }),
  );
  writeFileSync(
    path.join(homeDir, "Library", "LaunchAgents", "com.cjaxonj.codex-pulse.plist"),
    "",
  );
  writeFileSync(path.join(dataDir, "state.json"), "{}");
  writeFileSync(path.join(dataDir, "monitor.log"), "ok");
  mkdirSync(path.join(homeDir, ".codex"), { recursive: true });
  writeFileSync(
    path.join(homeDir, ".codex", "config.toml"),
    '[plugins."codex-pulse@codex-pulse-local"]\nenabled = true\n',
  );
  return homeDir;
}

test("doctor reports a healthy installed runtime without exposing account data", () => {
  const homeDir = createInstalledFixture();
  const result = inspectLocalInstallation({
    homeDir,
    uid: 501,
    expectedVersion: "0.9.0",
    run: () => "service exists",
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((item) => item.id === "launch-agent").status, "pass");
  assert.equal(result.checks.find((item) => item.id === "plugin").status, "pass");
  assert.deepEqual(result.support.pluginVersions, ["0.9.0"]);
  assert.equal(result.support.runtimeVersion, "0.9.0");
  assert.equal(JSON.stringify(result).includes(homeDir), false);
});

test("doctor fails when runtime or plugin versions are stale", () => {
  const homeDir = createInstalledFixture();
  writeFileSync(
    path.join(
      homeDir,
      "Library",
      "Application Support",
      "Codex Pulse",
      "app",
      "package.json",
    ),
    JSON.stringify({ version: "0.8.1" }),
  );
  const result = inspectLocalInstallation({
    homeDir,
    uid: 501,
    expectedVersion: "0.9.0",
    run: () => "service exists",
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "runtime").status, "fail");
  assert.equal(result.checks.find((item) => item.id === "plugin").status, "pass");
});

test("doctor fails closed when the service and runtime are missing", () => {
  const homeDir = path.join(
    os.tmpdir(),
    `codex-pulse-doctor-empty-${process.pid}-${Date.now()}`,
  );
  mkdirSync(homeDir, { recursive: true });
  const result = inspectLocalInstallation({
    homeDir,
    uid: 501,
    run: () => {
      throw new Error("not loaded");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.checks.find((item) => item.id === "runtime").status, "fail");
  assert.equal(result.checks.find((item) => item.id === "launch-agent").status, "fail");
});

test("doctor redacts home paths and likely bearer credentials from errors", () => {
  const homeDir = "/Users/tester";
  const input =
    "failed under /Users/tester/.codex with Bearer abcdefghijklmnop and sk-example123456";
  const output = redactDiagnosticText(input, homeDir);

  assert.equal(output.includes(homeDir), false);
  assert.equal(output.includes("abcdefghijklmnop"), false);
  assert.equal(output.includes("example123456"), false);
  assert.equal(output, "failed under <HOME>/.codex with <REDACTED> and <REDACTED>");
});
