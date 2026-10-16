# Codex Pulse

Codex Pulse is a local quota copilot for people who use Codex heavily on macOS.

It helps answer four practical questions:

- Is a public reset only being discussed, or has it actually reached my account?
- Should I start this task now, narrow it, or wait for quota recovery?
- Is a long-running task about to consume the reserve I wanted to keep?
- Is a reset credit close to expiring?

Codex Pulse combines public reset/capacity signals with the signed-in user's real
Codex quota. Personal data stays on the Mac. It never auto-approves permissions,
widens sandbox access, or consumes a reset credit.

> Beta software. Codex Pulse is an independent project and is not made, endorsed,
> or supported by OpenAI or codex-reset.com.

## Download

Download the latest macOS zip from
[GitHub Releases](https://github.com/CJaxonJ/codex-pulse/releases/latest).
Chinese setup instructions are in [`开始使用.md`](./开始使用.md).

## What is monitored

- Personal account: reads the signed-in user's real five-hour and weekly windows through Codex App Server.
- Personal warnings: 20%, 10%, and 5%, plus a fast-consumption forecast.
- Weekly pacing: estimates whether Plus or Pro usage is ahead of schedule and
  turns the remaining allowance into a practical average daily percentage.
- Tibo signal: watches structured public signals from `codex-reset.com` once per minute.
- Two alert levels: reset/banked signals are urgent previews; capacity, limit, and
  usage-policy changes are informational and are explicitly labeled as not being a reset.
- Source health: warns only after three consecutive request failures or a stale
  feed, then reports recovery without interrupting personal quota monitoring.
- Four distinct states: Tibo preview, usage/capacity update, public reset
  confirmation, and personal-account landing.

Tibo alerts are third-party public signals, not an OpenAI guarantee. A reset is shown as personally landed only after this Mac reads a material quota increase from the user's own account.

Pulse logs the latest public post id, its website-provided classification, source
freshness, and the emitted event type. This makes “no new reset signal,” “ordinary
post ignored,” and “data source unavailable” distinguishable during support.

## Install on macOS

Requirements:

- macOS
- ChatGPT desktop app or Codex CLI, already signed in
- Node.js 20 or newer
- Apple Command Line Tools (`xcode-select --install`) for the small native notification helper

Unzip the release, open Terminal in the extracted folder, and run:

```bash
node scripts/install-macos.mjs
```

Chinese beta users can instead double-click `安装 Codex Pulse.command` and follow
`开始使用.md`. If macOS blocks the first open, Control-click the command and choose
Open.

Or double-click `安装 Codex Pulse.command` after unzipping the release.

The installer verifies Codex access, explains and requests notification permission,
copies its runtime to `~/Library/Application Support/Codex Pulse/app`, installs a
login agent, and installs the local Codex Pulse plugin from a stable local
marketplace. The extracted folder can then be deleted.

Restart Codex after installation. Open `/hooks`, inspect the Codex Pulse hook
commands, and trust them only when their paths stay inside the installed plugin.
Codex intentionally requires this one-time review; the installer never bypasses
hook trust.

Once trusted, normal Codex chats get automatic guidance:

- before a prompt: start now, scope down, wait for reset, or consider a reset card;
- at 15% remaining: stop expanding scope and finish the current bounded step;
- at 10% remaining: finish the nearest useful result and leave a checkpoint;
- after a turn: learn the observed percentage cost for similar future work.

The user-facing warning appears only when the recommendation changes. The model
still receives the quiet scope boundary on later low-quota turns, so repeated
prompts do not create repeated banners.

Choose how Pulse behaves near exhaustion:

```bash
# Default: let the current bounded result finish; pause at 5% or after 10 minutes of draining.
node bin/codex-pulse.mjs policy --mode finish_current

# Preserve a hard reserve: block new turns and pause active managed work at 10%.
node bin/codex-pulse.mjs policy --mode strict_reserve

# Prioritize a deadline result: defer draining until 5%, with a 1% hard floor.
node bin/codex-pulse.mjs policy --mode deadline
```

Run `node bin/codex-pulse.mjs policy` to inspect the current mode. A managed task
can override the default with `--quota-policy MODE`.

Create a redacted support report after installation:

```bash
node bin/codex-pulse.mjs doctor
```

The report verifies the signed-in plan shape, background service, recent state,
notification helper, and local plugin. It excludes credentials, reset-credit IDs,
prompt text, and absolute home paths.

Prompt text is inspected in memory only to estimate task size and priority. It is
never written to Codex Pulse history. The plugin never auto-approves permissions,
expands sandbox access, interrupts an ordinary chat, or consumes a reset card.

## Developer commands

Check the current account state:

```bash
npm run status
```

Ask whether a task is worth starting now:

```bash
node bin/codex-pulse.mjs advice --size medium --priority normal
```

Pulse does not pretend subscription usage is a fixed token balance. It recommends
`start_now`, `scope_down`, `wait_for_reset`, or `consider_reset` from the real
five-hour and weekly windows. Weekly guidance reports a percentage-per-day pace,
not a fabricated token count, and blocks ordinary new work when the current burn
rate is likely to exhaust the week early. For managed tasks it learns the median percentage
consumed by the user's own completed tasks of the same size and model; until it
has enough history, it labels the estimate low-confidence and uses a conservative
default.

Run one monitoring cycle:

```bash
npm run watch:once
```

Test the desktop notification:

```bash
npm run notify:test
```

Queue an opt-in managed task:

```bash
node bin/codex-pulse.mjs managed-run \
  --cwd /absolute/path/to/project \
  --size medium \
  --priority normal \
  --quota-policy finish_current \
  --objective "Implement the requested change and make the relevant tests pass"
```

The background watcher calculates a start floor from task size, priority, weekly
headroom, and the user's own completed-task history instead of imposing a fixed
50% rule. Its low-quota behavior follows the selected policy. It resumes in the
same thread after a personal quota recovery, provided the workspace fingerprint
still matches. It uses the desktop App Server's current `workspace-write` wire
enum with `approvalPolicy: never`; it never
expands permissions or approves an escalation.

Auto-resume is fail-closed. If App Server reports a command/file approval,
additional permission request, tool question, or MCP elicitation, Pulse stores
only request metadata, disables auto-resume, interrupts the headless turn, and
notifies the user. Before a quota-paused task resumes, Pulse also checks the
latest persisted turn; any newer user activity prevents stale work from being
revived.

Only one managed task can run at a time. Waiting tasks are selected by priority,
then paused-task continuity, then expected task size and creation time. Recovering
quota therefore cannot fan out into several concurrent turns.

Each active task also owns an atomic lock keyed by the canonical worktree path.
The lock is shared by every watcher process, survives watcher restarts, and can
be reclaimed only after its recorded owner process is gone. Two watchers can
therefore never start two managed turns in the same checkout.

The local App Server watcher is the execution engine. A Codex scheduled task is
not used to resume or modify a managed workspace: scheduled tasks run with their
configured unattended sandbox, which may be read-only. They are suitable only
for optional checks or reminders unless a project-scoped task has been manually
verified with the required sandbox.

The macOS packaging command enforces the full test suite, a live
`codex-reset.com` schema/freshness check, and the real managed-task smoke test
before it creates an artifact. The managed-task E2E launches
the actual Codex App Server, queues work in a disposable directory, waits for a
real turn to write and verify a proof file, checks task completion, and confirms
that the worktree lock was released:

```bash
npm run package:macos
```

This test also catches protocol-version drift: current public protocol examples
use `workspaceWrite`, while the desktop-bundled App Server used by this release
accepts `workspace-write`. The runtime test, not a copied mock expectation, is
the final compatibility gate. It consumes a small amount of the signed-in Codex
allowance, never uses a reset credit, and suppresses desktop notifications.

List managed tasks:

```bash
npm run managed:list
```

Install the background monitor so it starts at login:

```bash
node scripts/install-macos.mjs
```

To reinstall only the local plugin after an update:

```bash
npm run plugin:install
```

The installer also builds a small native `Codex Pulse.app` under `~/Applications` so macOS can grant notification permission to a named application. The first notification may display a system permission prompt.

The installer first explains why notification access is needed, then opens the macOS permission request and sends a clearly labeled test notification. To rerun the notification setup later:

```bash
node scripts/setup-notifications-macos.mjs
```

Logs are written to `~/Library/Application Support/Codex Pulse/monitor.log`.

To stop and remove the login item while preserving local history:

```bash
node scripts/uninstall-macos.mjs
```

The diagnostic and feasibility probes redact opaque reset-credit IDs and do not
print authentication material. See [PRIVACY.md](./PRIVACY.md) and
[SECURITY.md](./SECURITY.md) before sharing diagnostic output.

Run the tests with:

```bash
node --test
```

Build the shareable macOS zip with:

```bash
npm run package:macos
```
