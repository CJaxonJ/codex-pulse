import { readFileSync, writeFileSync } from "node:fs";

// Static executable fixture; all variable values remain data, never source.
const marker = process.argv[2];
const version = readFileSync(new URL("./version", import.meta.url), "utf8");
if (!marker || !["old", "new"].includes(version)) throw Error("Invalid launchd fixture input");
setInterval(() => writeFileSync(marker, version), 100);
