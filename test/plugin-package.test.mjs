import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("plugin manifest and marketplace point at packaged hook files", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(ROOT, "plugin", "plugin.json"), "utf8"),
  );
  const marketplace = JSON.parse(
    await readFile(path.join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  const packageManifest = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const hooksPath = manifest.extensions["com.openai"].hooks.replace(/^\.\//, "");
  const hooks = JSON.parse(
    await readFile(path.join(ROOT, "plugin", hooksPath), "utf8"),
  );

  assert.equal(
    manifest.version,
    packageManifest.version,
    "plugin and release versions must stay in sync so upgrades are not skipped",
  );
  assert.equal(marketplace.name, "codex-pulse-local");
  assert.equal(marketplace.plugins[0].source.path, "./plugin");
  assert.ok(hooks.hooks.UserPromptSubmit);
  assert.ok(hooks.hooks.Stop);
  assert.ok(hooks.hooks.Interrupt);
  assert.ok(hooks.hooks.SessionStart);
  await readFile(path.join(ROOT, "plugin", "scripts", "pulse-hook.mjs"), "utf8");
  await readFile(path.join(ROOT, "plugin", "skills", "setup", "SKILL.md"), "utf8");
});
