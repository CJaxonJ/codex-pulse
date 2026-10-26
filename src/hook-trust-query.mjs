import { AppServerClient } from "./app-server-client.mjs";
import { trustedRecoveryHooks } from "./native-wakeup.mjs";

const client = new AppServerClient({ binary: process.argv[2], requestTimeoutMs: 1000 });
try {
  await client.start();
  const result = await client.request("hooks/list", { cwds: [process.cwd()] });
  const hooks = (result.data || []).flatMap(entry => entry.hooks || []);
  const required = ["preToolUse", "postToolUse", "sessionStart", "userPromptSubmit", "stop", "interrupt"];
  const trusted = trustedRecoveryHooks(result) && required.every(eventName => hooks.some(hook =>
    hook.eventName === eventName && hook.pluginId === "codex-pulse@codex-pulse-local" &&
    hook.enabled && ["trusted", "managed"].includes(hook.trustStatus)));
  console.log(JSON.stringify({ trusted }));
} catch { console.log(JSON.stringify({ trusted: false })); }
finally { client.stop(); }
