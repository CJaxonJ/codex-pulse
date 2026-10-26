#!/usr/bin/env node
import path from "node:path";
import { scanPublicDirectory, scanPublicRepository } from "./public-content-policy.mjs";

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--directory")) throw Error("Invalid arguments");
  const result = args.length ? scanPublicDirectory(path.resolve(args[1])) :
    scanPublicRepository(path.resolve(import.meta.dirname, ".."));
  console.log(JSON.stringify({ ok: result.findings.length === 0, ...result,
    warnings: result.historicalEmailCommits ? ["Historical non-noreply author emails exist. Review GitHub email privacy; history was not changed."] : [],
    scope: "Selected credential/privacy patterns; not a comprehensive security audit. Matched values are never printed.",
  }, null, 2));
  if (result.findings.length) process.exitCode = 1;
} catch {
  // Child-process errors may contain buffered secrets. Do not echo them.
  console.error("Public-content check could not complete. No scan success is claimed; inspect the local environment privately.");
  process.exitCode = 1;
}
