# Changelog

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
