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
3. In runtime 0.9.18+, open `~/Applications/Codex Pulse.app` with `--protection`
   or use “保护授权” in its settings. The native window explains purpose and
   boundaries; exact definitions are available in optional details. The user
   personally clicks “开启自动保护”. Do not submit `protection enable --yes` on
   their behalf, simulate the click, or turn opening the window into consent.
   Success requires Codex's actual trusted status. Authorization applies to new
   sessions; reopening Codex is optional until convenient, and restarting stops
   active tasks. Existing trust needs no repeated consent. Runtime 0.9.17 uses
   the older CLI review flow: consult its versioned setup document or upgrade;
   do not claim its installer already has this window. Ordinary use needs no
   developer verification or API payment setup.
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
