# Changelog

## 0.9.10 — 2026-10-22

- Replaced the invalid external-writer path for ordinary Desktop chats with
  native Codex Goal pause/reactivation. Chats without a user-created Goal now
  save a checkpoint and clearly require manual continuation.
- Removed the misleading App-Server-owned “ordinary chat” live gate and made
  real Desktop Goal acceptance an explicit release requirement.
- Added concurrent native-Goal recovery coverage and fixed colliding temporary
  filenames when two watcher processes update the same continuity record.
- Made native-Goal pause outcomes persistent and clarified that the 10% warning
  promises automatic continuation only when the chat has a native Goal.

## 0.9.9 — 2026-10-22

- Scoped ordinary-chat recovery checks to repositories actually touched by the
  paused turn, preventing unrelated sibling files in a broad workspace from
  incorrectly blocking automatic continuation.
- Stored relative verification scopes and reported which scope changed while
  continuing to fail closed for genuine target-repository changes.
- Extended the full 10% pause-and-resume release gate with a nested repository
  and an unrelated workspace mutation during the pause.

## 0.9.8 — 2026-10-20

- Added a native macOS E2E that proves must-see alerts remain visible for three
  seconds before the test closes them automatically; it consumes no Codex quota.
- Persistent alerts now use a floating window, stay open until explicit
  dismissal, and launch without blocking the quota watcher.
- Pause notifications now disclose whether a reliable workspace fingerprint
  was captured. Missing pause-time evidence is explained as a manual-resume case
  instead of promising unsafe automatic continuation.
- The release gate now compiles the native notifier and runs its persistent
  window E2E before packaging.
- Runtime-only upgrades can explicitly retain a compatible already-trusted
  plugin version, avoiding an unnecessary Hook review when Hook code did not
  change.

## 0.9.7 — 2026-10-20

- Fixed automatic chat recovery when Git fingerprinting is unavailable inside
  the Hook sandbox by using a bounded filesystem fingerprint and verifying the
  same strategy before resume.
- Made quota-recovery, automatic-resume, and resume-attention alerts remain on
  screen until the user dismisses them or opens the Codex Pulse status panel.
- Added regression coverage for the fallback fingerprint and persistent recovery
  alerts.

## 0.9.6 — 2026-10-20

- Made strict-reserve the default for new installs so the advertised 10% safety
  boundary matches the out-of-box behavior; existing explicit preferences stay
  unchanged.
- Added a local rolling journal for every user-visible quota, reset, pause,
  resume, and attention event, including notification-delivery status.
- Made `Codex Pulse.app` open a small status window showing the current quota,
  reset time, protection policy, and latest critical event after banners vanish.
- Added an explicit time-sensitive notification when an ordinary chat has saved
  its 10% checkpoint, while keeping notification failures from breaking task
  reconciliation.
- Tightened the strict-reserve handoff contract to Completed, Verification,
  Remaining, Next action, and Blockers.
- Added a runtime-only updater so monitor and status-window fixes do not replace
  the Codex plugin or ask users to review unchanged hooks again.

## 0.9.5 — 2026-10-20

- Made public-reset notifications explicit: an unexplained quota jump now shows
  the before/after percentages and stays marked as unconfirmed until a public
  signal arrives.
- Correlate a public confirmation that arrives shortly after the user's quota
  recovered, then clear the pending signal so a later normal five-hour reset
  cannot be mislabeled as the public reset.
- Send reset previews, confirmations, and personal landing notices as macOS
  time-sensitive notifications. Notification approval remains under user
  control.

## 0.9.4 — 2026-10-20

- Updated `doctor` to recognize a hook execution observed after the current
  plugin was installed, so an already-working setup no longer keeps asking the
  user to review `/hooks`.
- Kept hook trust manual and reported only execution evidence; Codex Pulse still
  cannot approve hooks on the user's behalf.

## 0.9.3 — 2026-10-20

- Increased the Codex CLI plugin-management timeout from 20 to 90 seconds after
  a valid local `plugin list --json` call took about 58 seconds during upgrade.

## 0.9.2 — 2026-10-20

- Changed weekly quota pacing from a hard admission gate to an advisory for
  explicit ordinary and managed tasks on both Plus and Pro.
- Kept strict-reserve hard stops scoped to the personal five-hour window only.
- Removed the obsolete managed-task `weeklyFloor` field and added regression
  coverage proving weekly warnings cannot block prompts or tool calls.

## 0.9.1 — 2026-10-19

- Kept `codex-reset.com` as the zero-configuration default and added an optional
  direct X API source for maintainers who want an independent fallback.
- Added local, explainable reset classification with parent-post context for terse
  replies such as “Done and dusted.”
- Store the optional X bearer token in macOS Keychain and keep it out of state,
  logs, command-line arguments, and diagnostics.
- Isolated the aggregator behind a replaceable adapter and delayed source-health
  notifications until a sustained outage.
- Replaced the external release check with a deterministic local X API contract
  and classifier end-to-end test, while retaining a separate live check for the
  default zero-configuration source.

- Added the supported `.codex-plugin/plugin.json` compatibility manifest so the
  current Codex CLI discovers bundled lifecycle hooks.
- Clarified that `/hooks` must be run in Codex CLI, not in the desktop chat
  composer.
- Made the interactive installer open Codex CLI for the user and show the exact
  one-time `/hooks` trust steps instead of asking users to find the CLI themselves.

## 0.9.0 — 2026-10-19

- Added strict-reserve continuity for ordinary Codex chats: at the hard floor,
  trusted hooks block additional tools, save the turn's final summary locally,
  and resume the same chat only after personal quota recovery.
- Added fail-closed workspace verification and exact turn matching before any
  automatic resume or completion transition.
- Added durable per-worktree locking for ordinary-chat continuity and recovery
  after watcher restarts for both ordinary and managed tasks.
- Kept stale low-quota observations protective in strict-reserve mode while
  leaving stale healthy observations non-interfering.
- Added a real App Server continuity release gate without using a synthetic
  `turn/interrupt` to manufacture the pause.
- Added installed runtime/plugin version checks to the redacted doctor report.

## 0.8.1 — 2026-10-16

- Added an MIT license and contributor, support, conduct, and pull-request guidance.
- Added CodeQL scanning and Dependabot updates for pinned GitHub Actions.
- Fixed the macOS archive so it extracts into one product folder without
  `__MACOSX` metadata or development-only release and E2E scripts.
- Added automatic archive-layout verification and a published SHA-256 checksum.
- Declared the supported Node.js version in package metadata.

## 0.8.0 — 2026-10-16

- Added separate Tibo reset previews and capacity/limit notices.
- Added source-health and recovery notifications for `codex-reset.com`.
- Added Plus and Pro weekly pacing guidance.
- Added selectable finish-current, strict-reserve, and deadline policies.
- Added quota-aware managed task pause, checkpoint, and safe resume.
- Added a durable per-worktree lock shared across watcher processes.
- Added live release gates for the reset feed and real Codex App Server execution.
- Added a Chinese quick-start guide, double-click installer, and redacted `doctor` report.
