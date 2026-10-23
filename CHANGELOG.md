# Changelog

## 0.9.16 — 2026-10-23

- Fixed the missing ordinary-chat recovery path: a quota checkpoint created
  without a pre-existing Goal can now bootstrap a recovery-only native Goal
  after the five-hour allowance returns.
- Made temporary App Server, network, sleep, and wake failures retryable with
  persisted exponential backoff instead of permanently requiring manual action.
- Moved recovery workspace verification into the trusted pre-tool Hook, where it
  runs with the Codex workspace access the user already granted. This avoids
  macOS privacy stalls in LaunchAgent while still blocking the first resumed
  tool if files changed or the checkpoint cannot be verified.
- Added a release-gate E2E that forces an offline recovery attempt, replaces the
  watcher, reclaims its stale worktree lock, produces a real proof file, and
  verifies exactly-once Goal activation and lock cleanup.
- Kept recovery privacy-bounded: the generated Goal uses existing thread context
  plus the structured checkpoint and does not persist the original prompt.

## 0.9.15 — 2026-10-23

- Replaced the provisional identity with the selected pause-loop mark: protected
  reserve bars, a quota pulse, and a restrained Meiqiu-inspired recovery tail.
- Reworked the palette from high-contrast cyan to warm graphite and calm recovery
  green, including dedicated light- and dark-surface variants.
- Regenerated the macOS app icon, plugin icons, PNG fallbacks, and GitHub social
  preview from the corrected source artwork.

## 0.9.14 — 2026-10-23

- Added an original two-color Codex Pulse identity built around the task loop,
  quota heartbeat, recovery handoff, and a restrained Meiqiu-inspired ear peak.
- Added light and dark SVG plugin icons that meet Codex package requirements,
  plus GitHub, PNG fallback, and macOS ICNS exports from one vector master.
- Gave the native notifier its own app icon so system alerts no longer use the
  default executable artwork.

## 0.9.13 — 2026-10-23

- Fixed the first-run review flow so the consent dialog brings Terminal forward
  and clicking “Open CLI and continue trust” activates the actual CLI window.
- After the user presses `t`, the installer now observes Codex's own six
  `trusted_hash` records, closes only the review CLI it launched, and restarts
  Codex without a second dialog. Existing trusted installs skip the review.
- Kept the already-reviewed 0.9.12 Hook definition unchanged, so this installer
  UX patch does not manufacture or silently replace Codex's trust decision.

## 0.9.12 — 2026-10-23

- Made first-run Hook setup explicitly guided: Finder-launched installs always
  show the native review prompt, open the correct CLI, and offer an explicit
  one-click ChatGPT restart after the user completes Codex's required trust
  review.
- Fixed the missed recovery path where the five-hour quota crossed the 10%
  reserve after the turn's last tool call: the Stop hook now pauses the active
  Goal and persists the checkpoint even without another tool event.
- Increased the timeout only for tool/turn lifecycle hooks that may need to
  start Codex App Server while preserving a Goal; lightweight startup and
  prompt-planning hooks remain at three seconds.
- Added regression and full-chain coverage for the exact late-crossing failure,
  including exactly-once recovery under concurrent watchers.

## 0.9.11 — 2026-10-22

- Preserved the exact user-approved Goal across quota pauses, combined it with
  the structured 10% checkpoint for continuation, and refused to overwrite a
  Goal the user changed or completed while paused.

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
- Added an explicit current-Desktop-thread acceptance canary so release evidence
  cannot substitute an App-Server-owned thread for the user's real chat.

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
