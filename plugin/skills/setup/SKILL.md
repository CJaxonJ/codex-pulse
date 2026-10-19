---
name: codex-pulse-setup
description: Verify the local Codex Pulse monitor and explain how to review and trust its quota-aware hooks.
---

# Set up Codex Pulse

1. Verify that `~/Library/Application Support/Codex Pulse/app/bin/codex-pulse.mjs`
   exists. If it does not, tell the user to run `node scripts/install-macos.mjs`
   from the Codex Pulse release first.
2. Run the installed `status` command and report only plan type, percentage
   remaining, reset time, weekly percentage, and reset-card count. Never print
   authentication material or opaque reset-card ids.
3. Explain that Codex intentionally skips new or changed non-managed hooks until
   the user reviews them. The interactive installer offers to open Codex CLI for
   the user. In that CLI, have them run `/hooks`, verify that the Codex Pulse
   commands point inside the installed plugin, press `t` to trust, confirm that
   `Active` becomes `1`, then exit and restart the desktop app. If the installer
   was non-interactive or they chose Later, explain how to launch Codex CLI from
   Terminal. `/hooks` is not a desktop composer command.
4. Explain the privacy boundary: Prompt text is inspected in memory to estimate
   task size and priority, but is never stored. Local observations contain only
   session/turn ids, model, inferred size and priority, timestamps, quota-window
   identity, and percentage before/after.
5. Explain the three quota policies. `finish_current` is the safe default;
   `strict_reserve` blocks new work at 10%; `deadline` delays draining for one
   bounded high-priority result. Show the installed `policy --mode` command if
   the user wants to change it.
6. Do not bypass hook trust, change sandbox permissions, approve commands, or
   consume reset credits.
