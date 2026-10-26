# Technical and developer reference

[返回首页](../README.md) · [中文安装指南](../开始使用.md)

Implementation details, advanced configuration, and release verification for
Codex Pulse. For normal installation, start with the guide above. Commands below
run from the repository or installed runtime root, not from this docs folder.

## What is monitored

- Personal account: reads the signed-in user's real five-hour and weekly windows through Codex App Server.
- Personal warnings: 20%, 10%, and 5%, plus a fast-consumption forecast.
- Native preferences: a compact, system-themed macOS window configures early
  warning percentage (15–80%), public signals, expiring-card notices, persistent
  windows, sound and protection policy. Notification switches never disable
  the hard-floor safety warning. Ordinary settings save without restarting;
  auto-redemption remains a separate, explicit account-consent action.
- Persistent status: double-click `Codex Pulse.app` in `~/Applications` to see
  the latest local quota snapshot, active protection policy, and most recent
  critical event even after a notification banner disappears.
- Must-see recovery outcomes also open a floating Codex Pulse alert that stays
  visible until dismissed. The release gate verifies the native window remains
  on screen without blocking the quota watcher.
- Weekly pacing: estimates whether Plus or Pro usage is ahead of schedule and
  turns the remaining allowance into a practical average daily percentage.
- Tibo signal: reads the zero-configuration `codex-reset.com` feed by default;
  maintainers can optionally switch to direct X API reads and local classification.
- Three visible alert levels: critical (red, persistent), warning (orange), and
  information (neutral). Public previews, public confirmations, personal landings,
  normal five-hour recovery, and credit redemption are explicitly distinguished.
- Read-only continuation preview: view the original Goal, saved progress, next
  action, earliest personal recovery time and an explicit remaining-work estimate
  when available. Unknown duration stays unknown; preview never calls a model.
- Optional expiring-credit rescue: explicitly enable it for a personal Plus/Pro
  account in the status app. Only a known available Codex credit expiring in less
  than ten minutes is considered, and only with used eligible quota. Durable
  idempotency, account checks and a post-consume read prevent blind multi-card use.
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

Starting in 0.9.18, interactive installation opens a native “开启自动保护”
window. Purpose and limits come first; exact commands and definition hashes
are available in optional details. Only an explicit user confirmation submits
the reviewed definitions through Codex's version-checked configuration interface.
Pulse verifies the actual trust result before showing success; changed definitions
need a new review. Cancelling leaves trust untouched. There is no CLI launch or
synthetic trust keypress. Authorization applies to new sessions; the user may
choose a restart when convenient, with a clear warning that active tasks stop.
Non-interactive installation grants nothing and points to the app's “保护授权”
entry. This is a Pulse-owned consent window, not an OpenAI system dialog. The
underlying configuration contract is checked against the installed Codex; an
incompatible version fails visibly rather than pretending authorization worked.

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

In strict-reserve mode, task-start and post-tool Hooks keep an early recovery
baseline without saving prompt text. The watcher can use it when inference or
compaction fails before another tool or Stop event. The Hook persists a checkpoint request and pause-time
workspace baseline at the hard floor, before depending on a final model reply.
If the turn ends without Stop or a final handoff, the watcher checks persisted
turn history and reconstructs a conservative continuation after confirming that
the original turn is terminal. A live turn is never treated as stopped because
observation timed out. Missing baselines produce an explicit attention alert;
the watcher never invents a pause-time snapshot after recovery.
This also covers a late quota crossing first observed by the Stop hook.
If the chat already has a native
Codex Goal, Pulse pauses it at the reserve and snapshots its exact user-approved
objective. The final checkpoint is parsed
into completed work, verification, remaining work, next action, and blockers.
After the personal five-hour window materially recovers, Pulse reactivates the
Goal with a continuation objective that keeps the original objective authoritative
and starts from the first unfinished step; the
official `codex queue` entry point delivers the continuation to the owning
session. Setting a Goal active alone is not considered sufficient to wake a
different process. Pulse never claims a second writer for that thread.
If the chat did not have a Goal, Pulse creates a recovery-only Goal
after quota returns. Its scope comes from the existing thread context and the
structured checkpoint; Pulse does not persist the original prompt or invent a
second external writer for the Desktop-owned chat.

Goal activation is reported as a pending start. Pulse reports actual execution
only after observing a different turn with persisted lifecycle evidence. The
comparison uses the saved paused-turn id, not the mutable current-turn id that
the first-tool Hook updates. If the original turn remains terminal and no
new turn is observed within three minutes of activation, it reports a dispatch
failure instead of claiming automatic recovery succeeded.

Each paused turn has a stable recovery admission key. Retries use the same key;
the trusted prompt Hook blocks duplicate and stale wake requests. Current
pre-tool and prompt Hooks must be enabled and trusted before a wake is sent.
Local admission records contain only session/turn identifiers and timestamps.

Developer acceptance runs in a disposable thread and workspace with
`npm run e2e:chat:sandbox`, not against a user's active task. It requires real
registered Hooks, independent-process dispatch and model-written proof. Offline
tests alone do not establish that the dispatcher ran. A natural Desktop recovery
can be audited from its existing lifecycle/admission records without deliberately
burning quota, interrupting a user task or replaying a test into that chat.

Before reactivating a Goal, the background watcher verifies that the latest turn
still matches the saved checkpoint. The first resumed tool is then held by the
trusted PreToolUse Hook while it verifies the workspace snapshot inside Codex's
already-authorized workspace context. New checkpoints scope that snapshot to
repositories touched by the turn, so unrelated files elsewhere under a broad
workspace do not block recovery. Missing snapshots, changed files, newer user
activity, approvals, questions, or an unavailable Goal state stop the automation
and require attention. If the user edits the Goal while Pulse is paused, Pulse
never overwrites it with the old continuation plan and instead asks for attention.
Temporary App Server and network failures remain retryable with bounded backoff
instead of becoming permanent failures. Sleep only delays polling: after wake or
watcher restart, Pulse reloads the checkpoint and retry schedule from disk.
Every active resume owns a durable lock for its canonical
worktree, so a watcher restart cannot start a second task in the same checkout.

Checkpoints created by an older runtime may not contain a usable pause-time
workspace fingerprint. Pulse never reconstructs that evidence after the fact:
it shows a persistent explanation and asks the user to continue in the original
chat instead of claiming an unsafe automatic resume will happen.

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
characters), the exact objective of an existing user-created native Goal when
present, thread/turn identifiers, local working-directory path, and a
workspace snapshot under the user's local application-support directory. It
contains relative scope paths and hashes, not source contents. The
plugin never auto-approves permissions, expands sandbox access, calls App Server
`turn/interrupt` on an ordinary chat, or redeems a credit without the user's
account-bound opt-in. Sleep, offline time, or a stopped monitor can miss expiry;
auto-redemption is not a delivery guarantee. Business/enterprise accounts are
excluded from auto-redemption because the public account/read response does not
expose a stable workspace identity for binding consent safely.

## Public plugin directory

The full local Hook plugin is not eligible for the public directory. The official
[packaging documentation](https://developers.openai.com/plugins/build/plugins)
limits lifecycle Hooks to manually installed Codex desktop plugins. A separate
desktop-only, skills-only submission ZIP provides onboarding and read-only local
queries; it neither installs Hooks nor replaces the macOS runtime. See
[`SUBMISSION.md`](https://github.com/CJaxonJ/codex-pulse/blob/main/SUBMISSION.md) for the package and outstanding identity,
publication, and review requirements. A prepared ZIP is not a published listing.

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
not a fabricated token count. Weekly pacing is advisory: it never hard-blocks
an explicitly submitted task. Only the configured short-window reserve controls
the quota hard stop. For managed tasks it learns the median percentage
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

The local App Server watcher remains the execution engine for Pulse-owned managed
tasks. It does not call `thread/resume` or `turn/start` on a Codex Desktop-owned
ordinary chat: the Desktop retains its writer, so ordinary-chat continuation is
delegated to a native Goal, either preserved from the user or recovery-scoped by
Pulse from the local checkpoint, and delivered through the official `codex queue`
entry point. Merely setting a Goal to active is not treated as execution.
Codex scheduled tasks are not used to
modify a managed workspace because their unattended sandbox may be read-only.

The default macOS packaging command is quota-free. It enforces the full test
suite, a native persistent-alert E2E, a deterministic local X API
contract/classifier test, and an offline
full-chain simulation of the 10% pause, structured checkpoint, recovered-quota
detection, exactly-once resume, and lock cleanup. The simulation uses the
production Hook handler, stores, workspace fingerprinting, controller, and
durable worktree lock. A second resilience gate forces a network timeout, replaces
the watcher, reclaims its stale lock, bootstraps a recovery Goal, simulates output
creation and verifies exactly-once completion. That offline proof is written by
the deterministic test, not by a real model. Only the native-Goal protocol
boundary is replaced with a deterministic fake:

```bash
npm run package:macos
```

Live compatibility tests are opt-in because they use external services and the
real Codex App Server. They never consume a reset credit, but the App Server
tests do use ordinary signed-in Codex allowance:

```bash
CODEX_PULSE_RUN_LIVE_E2E=1 npm run package:macos
```

The live gates check the Tibo source, a managed-task smoke test, and an isolated
ordinary-chat recovery test using the installed candidate Hooks. The last test
requires the candidate plugin to already be installed and officially trusted; it
never changes trust automatically. Run it independently with:

```bash
npm run e2e:chat:sandbox
# Also exercise an ordinary chat with no Goal configured before quota falls:
CODEX_PULSE_TEST_INITIAL_GOAL=0 npm run e2e:chat:sandbox
```

It uses a temporary workspace and Pulse data, synthetic quota samples, a real
App Server, a disconnected/reconnected test transport, and a replacement watcher
process on an independent STDIO App Server. The registered Hooks must pause the
task and save progress; production dispatch must start the recovery, validate the
workspace before tools, and produce a model-written proof file. A repeated wake
must be rejected by the registered Hook without modifying that proof. A fallback
queue command, a requested Goal, or a manually created proof cannot pass.
The independent watcher deliberately waits until the real first-tool Hook has
validated the workspace, then must still recognize actual execution without
re-arming validation or sending another wake.

`CODEX_PULSE_TEST_REGISTERED_HOOKS=0` is a lower-level missing-Stop diagnostic,
not installed-Hook acceptance. Isolation proves these runtime boundaries but
does not prove a currently open Desktop thread has reloaded changed Hooks, or
that physical macOS sleep/wake works. Those remain distinct acceptance checks;
the test never sleeps the user's machine or uses their current chat as a fixture.

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
print authentication material. See [PRIVACY.md](../PRIVACY.md) and
[SECURITY.md](../SECURITY.md) before sharing diagnostic output.

Run the tests with:

```bash
node --test
```

Build the shareable macOS zip with:

```bash
npm run package:macos
```

The release build produces a single-folder ZIP plus `SHA256SUMS.txt`, then checks
the archive layout, checksum and extracted public content before succeeding.
Maintainer submission notes are not included in future archives. Published
versioned archives are not silently replaced by documentation-only updates.

## Project policies

- [Contributing](../CONTRIBUTING.md)
- [Support](../SUPPORT.md)
- [Security](../SECURITY.md)
- [Privacy](../PRIVACY.md)
- [Public disclosure](./public-disclosure.md)
- [Code of Conduct](../CODE_OF_CONDUCT.md)

Codex Pulse is available under the [MIT License](../LICENSE).
