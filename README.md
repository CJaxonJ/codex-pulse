# Codex Pulse

[![Tests](https://github.com/CJaxonJ/codex-pulse/actions/workflows/test.yml/badge.svg)](https://github.com/CJaxonJ/codex-pulse/actions/workflows/test.yml)
[![CodeQL](https://github.com/CJaxonJ/codex-pulse/actions/workflows/codeql.yml/badge.svg)](https://github.com/CJaxonJ/codex-pulse/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

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
> or supported by OpenAI or X.

## Download

Download the current macOS beta from
[GitHub Releases](https://github.com/CJaxonJ/codex-pulse/releases/latest).
Chinese setup instructions are in [`开始使用.md`](./开始使用.md).

The release includes `SHA256SUMS.txt`. After downloading both files, verify the
archive before opening it:

```bash
shasum -a 256 -c SHA256SUMS.txt
```

## What is monitored

- Personal account: reads the signed-in user's real five-hour and weekly windows through Codex App Server.
- Personal warnings: 20%, 10%, and 5%, plus a fast-consumption forecast.
- Persistent status: double-click `Codex Pulse.app` in `~/Applications` to see
  the latest local quota snapshot, active protection policy, and most recent
  critical event even after a notification banner disappears.
- Weekly pacing: estimates whether Plus or Pro usage is ahead of schedule and
  turns the remaining allowance into a practical average daily percentage.
- Tibo signal: reads the zero-configuration `codex-reset.com` feed by default;
  maintainers can optionally switch to direct X API reads and local classification.
- Two alert levels: reset/banked signals are urgent previews; capacity, limit, and
  usage-policy changes are informational and are explicitly labeled as not being a reset.
- Source health: brief upstream failures stay quiet. A warning appears only after a
  sustained 15-minute outage or a stale feed, without interrupting personal
  quota monitoring.
- Four distinct states: Tibo preview, usage/capacity update, public reset
  confirmation, and personal-account landing.

Tibo alerts are public social-media signals, not an OpenAI guarantee. A reset is
shown as personally landed only after this Mac reads a material quota increase
from the user's own account.

Pulse logs the latest public post id, its classification, source
freshness, and the emitted event type. This makes “no new reset signal,” “ordinary
post ignored,” and “data source unavailable” distinguishable during support. It
never treats a public forecast as proof that this user's quota has landed.

Tibo monitoring works out of the box through the public `codex-reset.com` feed;
ordinary users do not need an X developer account or API credential. Personal
quota warnings, reset-credit expiry, task pausing, and safe resume remain local
and continue if that feed is unavailable.

For maintainers who prefer to read Tibo's public posts directly, an optional X
API source can be configured on macOS:

```bash
node bin/codex-pulse.mjs tibo-source --configure-x
```

Paste the token only into the macOS Keychain prompt. Codex Pulse never writes it
to its state file or log. Inspect or disable the source with:

```bash
node bin/codex-pulse.mjs tibo-source
node bin/codex-pulse.mjs tibo-source --mode disabled
node bin/codex-pulse.mjs tibo-source --forget-x
```

The direct X source is an advanced fallback, not part of normal onboarding. Use
`--mode codex-reset` to return to the zero-configuration default at any time.

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

At the end of an interactive installation, a native guide offers to open Codex
CLI in the same Terminal window. The user only needs to run `/hooks`, inspect the
Codex Pulse hook commands, press `t` when their paths stay inside the installed
plugin, exit the CLI, and restart the desktop app. `/hooks` is not a command in
the desktop chat composer. Non-interactive installs print the same instructions.
Codex intentionally requires this one-time review; the installer opens the right
surface but never bypasses hook trust.

Once trusted, normal Codex chats get automatic guidance:

- before a prompt: start now, scope down, wait for reset, or consider a reset card;
- at 15% remaining: stop expanding scope and finish the current bounded step;
- in strict-reserve mode at 10%: block additional tool calls, let the model
  summarize the turn, and save that final summary as a local checkpoint;
- after a turn: learn the observed percentage cost for similar future work.

The user-facing warning appears only when the recommendation changes. The model
still receives the quiet scope boundary on later low-quota turns, so repeated
prompts do not create repeated banners.

Choose how Pulse behaves near exhaustion:

```bash
# Let the current bounded result finish; pause at 5% or after 10 minutes of draining.
node bin/codex-pulse.mjs policy --mode finish_current

# Default: preserve a hard reserve, block new turns, and pause active work at 10%.
node bin/codex-pulse.mjs policy --mode strict_reserve

# Prioritize a deadline result: defer draining until 5%, with a 1% hard floor.
node bin/codex-pulse.mjs policy --mode deadline
```

Run `node bin/codex-pulse.mjs policy` to inspect the current mode. A managed task
can override the default with `--quota-policy MODE`.

Every user-visible quota, reset, pause, resume, and attention event is also kept
in a small local rolling journal. Run `node bin/codex-pulse.mjs activity` for a
redacted text view, or double-click `~/Applications/Codex Pulse.app`; prompt text
and authentication material are never written to this journal.

In strict-reserve mode, an ordinary chat can resume automatically after the
personal five-hour window materially recovers. Pulse resumes the same thread only
when its latest turn still matches the saved checkpoint and the workspace
fingerprint is unchanged. Missing fingerprints, newer user activity, approvals,
questions, failed/interrupted turns, or an unknown App Server state stop the
automation and require attention. Every active resume owns a durable lock for its
canonical worktree, so a watcher restart cannot start a second turn in the same
checkout.

Create a redacted support report after installation:

```bash
node bin/codex-pulse.mjs doctor
```

The report verifies the signed-in plan shape, background service, recent state,
notification helper, and local plugin. It excludes credentials, reset-credit IDs,
prompt text, and absolute home paths.

Prompt text is inspected in memory only to estimate task size and priority; the
original prompt is never written to Codex Pulse history. For strict-reserve
continuity, Pulse does store the final assistant checkpoint (up to 8,000
characters), thread/turn identifiers, local working-directory path, and a
workspace fingerprint under the user's local application-support directory. The
plugin never auto-approves permissions, expands sandbox access, calls App Server
`turn/interrupt` on an ordinary chat, or consumes a reset card.

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

The default macOS packaging command is quota-free. It enforces the full test
suite, a deterministic local X API contract/classifier test, and an offline
full-chain simulation of the 10% pause, structured checkpoint, recovered-quota
detection, exactly-once resume, and lock cleanup. The simulation uses the
production Hook handler, stores, workspace fingerprinting, controller, and
durable worktree lock; only the Codex App Server is replaced with a deterministic
fake:

```bash
npm run package:macos
```

Live compatibility tests are opt-in because they use external services and the
real Codex App Server. They never consume a reset credit, but the App Server
tests do use ordinary signed-in Codex allowance:

```bash
CODEX_PULSE_RUN_LIVE_E2E=1 npm run package:macos
```

The live gate checks the Tibo source and protocol drift, then runs managed-task
and ordinary-chat smoke tests in disposable workspaces. Hook dispatch and
one-time trust are host-owned, so the tests invoke the same Hook handler directly
instead of claiming to automate trust.

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

If an update changes only the background monitor or status app, update it without
touching the plugin or repeating Hook review:

```bash
npm run runtime:update
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

The release build produces a single-folder ZIP plus `SHA256SUMS.txt`, then checks
the archive layout and checksum before succeeding.

## Project policies

- [Contributing](./CONTRIBUTING.md)
- [Support](./SUPPORT.md)
- [Security](./SECURITY.md)
- [Privacy](./PRIVACY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)

Codex Pulse is available under the [MIT License](./LICENSE).
