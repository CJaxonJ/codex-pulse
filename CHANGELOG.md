# Changelog

## Unreleased

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
