import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const X_API_KEYCHAIN_SERVICE = "com.cjaxonj.codex-pulse.x-api";
export const X_API_KEYCHAIN_ACCOUNT = "tibo-monitor";

export async function readXBearerToken(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const exec = options.execFile || execFileAsync;
  const fromEnvironment = env.CODEX_PULSE_X_BEARER_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;
  if (platform !== "darwin") return null;

  try {
    const { stdout } = await exec("/usr/bin/security", [
      "find-generic-password",
      "-a",
      X_API_KEYCHAIN_ACCOUNT,
      "-s",
      X_API_KEYCHAIN_SERVICE,
      "-w",
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function configureXBearerToken(options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || spawnSync;
  if (platform !== "darwin") {
    throw new Error("X API Keychain setup is currently supported on macOS only.");
  }
  const result = spawn(
    "/usr/bin/security",
    [
      "add-generic-password",
      "-a",
      X_API_KEYCHAIN_ACCOUNT,
      "-s",
      X_API_KEYCHAIN_SERVICE,
      "-U",
      "-w",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error("X API credential was not saved to macOS Keychain.");
  }
}

export function forgetXBearerToken(options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || spawnSync;
  if (platform !== "darwin") return false;
  const result = spawn(
    "/usr/bin/security",
    [
      "delete-generic-password",
      "-a",
      X_API_KEYCHAIN_ACCOUNT,
      "-s",
      X_API_KEYCHAIN_SERVICE,
    ],
    { stdio: "ignore" },
  );
  return result.status === 0;
}
