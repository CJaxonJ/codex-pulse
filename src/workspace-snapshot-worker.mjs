import { WorkspaceInspector } from "./workspace-inspector.mjs";

const [cwd, optionsText] = process.argv.slice(2);
const inspector = new WorkspaceInspector();
const { mode = "snapshot", snapshot, ...options } = JSON.parse(optionsText || "{}");
const value = mode === "compare" ? await inspector.compareSnapshot(cwd, snapshot)
  : mode === "fingerprint" ? await inspector.fingerprint(cwd, options)
  : await inspector.snapshot(cwd, options);
process.stdout.write(JSON.stringify({ value, failure: inspector.failureDiagnostic() }));
