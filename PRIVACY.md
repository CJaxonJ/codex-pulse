# Privacy

Codex Pulse is a local macOS utility. It does not run a Codex Pulse account service and does not upload your prompts, authentication material, reset-credit identifiers, or workspace contents to the developer.

## Data processed locally

Codex Pulse reads the signed-in Codex account's rate-limit summary through the Codex App Server already installed on the Mac. It stores only the local state required for quota alerts and managed-task continuity, including:

- remaining-percentage observations and reset times;
- alert deduplication state;
- task status, model, size, priority, working-directory path, and thread/turn identifiers;
- workspace fingerprints used to prevent unsafe automatic resume;
- for an ordinary chat paused by strict-reserve mode, the final assistant
  checkpoint text (limited to 8,000 characters), but not the original user prompt;
- aggregate percentage consumption used for future estimates.

Prompt text may be inspected in memory to estimate task size, but the original
prompt is not written to Codex Pulse history. Checkpoint summaries can repeat
context the assistant included in its final response, so users should treat the
local application-support folder as potentially containing project-sensitive
text.

## Network requests

By default, Tibo monitoring requests the public feed and forecast endpoints at
`codex-reset.com`. The service receives ordinary network metadata such as the
caller's IP address. Codex Pulse never sends Codex credentials, prompts,
workspace contents, or local quota data to that service. If it is unavailable,
personal quota monitoring continues locally.

An optional direct-X mode requests Tibo's public posts and replies from the
official X API. Its bearer token is read from macOS Keychain into memory and is
never written to Codex Pulse state, support reports, or logs. Users can disable
Tibo monitoring entirely or switch between the two sources.

Communication with Codex uses the local Codex App Server and remains subject to the user's existing OpenAI/Codex account and policies.

## Retention and deletion

Local state is stored under:

```text
~/Library/Application Support/Codex Pulse
```

The normal uninstaller removes the program while preserving usage history for a later reinstall. Users who want full deletion can remove the `Codex Pulse` folder above after uninstalling.

## Support reports

The `doctor` command excludes authentication material, reset-credit IDs, prompt text, and absolute home paths. Users should still review diagnostic output before posting it publicly.

## Contact

Open a GitHub issue for ordinary questions. For a security or privacy concern, use the repository's private security-advisory form.
