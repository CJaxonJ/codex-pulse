import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("plugin manifest and marketplace point at packaged hook files", async () => {
  const codexManifest = JSON.parse(
    await readFile(
      path.join(ROOT, "plugin", ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  const marketplace = JSON.parse(
    await readFile(path.join(ROOT, ".agents", "plugins", "marketplace.json"), "utf8"),
  );
  const packageManifest = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const hooks = JSON.parse(
    await readFile(path.join(ROOT, "plugin", "hooks", "hooks.json"), "utf8"),
  );

  assert.ok(
    packageManifest.codexPulse?.compatiblePluginVersions?.includes(
      codexManifest.version,
    ),
    "The bundled Hook plugin must be declared compatible with this runtime release",
  );
  assert.deepEqual(codexManifest.hooks, hooks);
  assert.equal(codexManifest.skills, "./skills/");
  assert.equal(marketplace.name, "codex-pulse-local");
  assert.equal(marketplace.plugins[0].source.path, "./plugin");
  assert.ok(hooks.hooks.UserPromptSubmit);
  assert.ok(hooks.hooks.Stop);
  assert.ok(hooks.hooks.Interrupt);
  assert.ok(hooks.hooks.SessionStart);
  await readFile(path.join(ROOT, "plugin", "scripts", "pulse-hook.mjs"), "utf8");
  await readFile(path.join(ROOT, "plugin", "skills", "setup", "SKILL.md"), "utf8");
});
