---
name: codex-pulse-setup
description: Help install and verify the local macOS Codex Pulse monitor, inspect saved continuation plans, and explain quota alerts or optional expiring-credit settings.
---

# Set up Codex Pulse

1. Verify that `~/Library/Application Support/Codex Pulse/app/bin/codex-pulse.mjs`
   exists. If missing, link to https://github.com/CJaxonJ/codex-pulse/releases/latest
   and have the user download and verify the macOS ZIP, then double-click
   `安装 Codex Pulse.command`. Requires Node.js 20+, Apple Command Line Tools,
   and an already-signed-in Codex. Installing a directory skills package alone
   does not install a background monitor or enable Hooks. Never silently download
   and execute unverified code.
2. Run the installed `status` command and report only plan type, percentage
   remaining, reset time, weekly percentage, and reset-card count. Never print
   authentication material or opaque reset-card ids.
3. Explain that Codex intentionally skips new or changed non-managed hooks until
   the user reviews them. The interactive installer offers to open Codex CLI for
   the user. In that CLI, have them run `/hooks`, verify that the Codex Pulse
   commands point inside the installed plugin, press `t` to trust, confirm that
   `Active` becomes `1`. Before starting review, explain that the interactive
   installer will close its own CLI and restart Codex automatically after trust,
   stopping active tasks; the user should finish tasks first or choose Later.
   No second trust/restart dialog is expected. Already-trusted Hooks skip review.
   If installation was non-interactive, deferred or timed out, explain how to
   launch CLI and reopen Codex manually when convenient. `/hooks` is not a
   desktop composer command. Ordinary use needs no developer verification or
   API payment setup.
4. For saved next steps, open `~/Applications/Codex Pulse.app` with `--preview`,
   or run the installed CLI's `preview` command. This is read-only and makes no
   model call. Preserve task separation and the original Goal. Earliest personal
   quota recovery is not a promise of execution; stale/unknown windows or missing
   duration estimates must stay unknown. Do not restart a task just to preview it.
   Checkpoints/Goals may contain private project context: do not include full
   preview text in a public diagnostic report. Original prompts are not stored.
5. Explain the three quota policies. `strict_reserve` is the default and blocks
   new work at 10%; `finish_current` lets the current bounded result finish;
   `deadline` delays draining for one
   bounded high-priority result. Show the installed `policy --mode` command if
   the user wants to change it.
6. Explain critical/red, warning/orange, and informational events. Tibo previews
   are not confirmed personal resets; ordinary five-hour recovery and using a
   credit are not public gifts. System banner colors are controlled by macOS.
7. Auto-redemption defaults OFF and supports personal Plus/Pro only. The status
   app's “临期自动用卡” screen explains consent and binds it to the current
   personal account. Only when the user explicitly requests enablement may you
   run installed `credits-policy --enable --yes`; use `--disable` to revoke.
   This can consume a real credit later. Never enable it as an installation test,
   never consume a real card as a test, and never issue consume RPCs ad hoc.
   Sleep/offline time can miss expiry. Pending uncertain redemption records must
   not be deleted to force a new attempt.
8. Do not bypass Hook trust, change sandbox permissions, auto-approve commands,
   or install a replacement Hook without the required user review. With trusted
   current Hooks, a quota-paused chat without an existing Goal can bootstrap a
   recovery-scoped Goal; an existing user Goal remains authoritative. Unknown
   execution state, changed files/Goals, approvals and user interruption prevent
   unsafe automatic continuation. Read `doctor` before claiming setup works.
