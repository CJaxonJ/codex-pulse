import { AppServerClient } from "../../src/app-server-client.mjs";
import { CreditAutoRedeemer } from "../../src/credit-auto-redeemer.mjs";
import { PulsePreferencesStore } from "../../src/preferences-store.mjs";
const [dataDir, nowText] = process.argv.slice(2);
const client = new AppServerClient({ binary: process.env.CODEX_PULSE_TEST_CREDIT_BINARY, requestTimeoutMs: 800 });
client.on("exit", () => {});
try {
  await client.start();
  const result = await new CreditAutoRedeemer({ client, preferences: new PulsePreferencesStore(dataDir), dataDir,
    now: () => Number(nowText) }).poll();
  // Only test metadata is output. Do not echo protocol params/card ids.
  console.log(JSON.stringify({ status: result.status, eventTypes: result.events.map((event) => event.type) }));
} finally { client.stop(); }
