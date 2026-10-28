# Privacy

Codex Pulse is a local macOS utility. It does not run a Codex Pulse account service and does not upload your prompts, authentication material, reset-credit identifiers, or workspace contents to the developer.

## Data processed locally

Codex Pulse reads the signed-in Codex account's rate-limit summary through the Codex App Server already installed on the Mac. It stores only the local state required for quota alerts and managed-task continuity, including:

- remaining-percentage observations and reset times;
- alert deduplication state;
- task status, model, size, priority, working-directory path, and thread/turn identifiers;
- workspace fingerprints used to prevent unsafe automatic resume;
- for an ordinary chat paused by strict-reserve mode, the final assistant
  checkpoint text (limited to 8,000 characters) and, when the user created a
  native Goal, that Goal's exact objective and the derived continuation plan,
  but not the original user prompt;
- aggregate percentage consumption used for future estimates.
- when the user explicitly enables expiring-credit redemption: a hash of the
  normalized personal-account email returned by official `account/read`, consent
  time, and local redemption state. The raw email is not saved or logged. The hash
  is a local binding, not a claim of irreversible anonymization. Business accounts
  are not auto-redeemed because this response does not identify their workspace.

An in-flight redemption must retain the exact opaque credit id and idempotency
key so a timeout or process restart can retry the same logical operation rather
than accidentally select another card. This metadata is saved only in
`credit-operations/` (directory mode 0700, operation files 0600), flushed before
the request, and excluded from notifications and diagnostics. After settlement,
the raw credit id and key are removed; the journal retains redeemed-credit hashes
for stale-response protection and up to 50 outcome/time entries. An uncertain
operation is retained until it can be safely resolved; the program does not
silently discard it on timeout or expiry.

Plan preview reads local checkpoint text on demand. It makes no model request
and does not start or modify a task. Its CLI output may contain private project
information and is not a public support report.

Public Tibo announcement history also keeps the post text or clearly labeled
source excerpt (up to 20,000 characters), source timestamp and exact X post/reply
and parent-post links locally. The rolling notification journal retains the last
50 general events plus the last 10 public announcement entries (at most 60 total),
so quota warnings do not evict every announcement. It does not store private chat
prompts in these fields. Opening a source link is a user action in the default
browser and is subject to X's normal login and privacy behavior.

The protection-consent window reads current local Hook metadata. An unconfirmed
review stores only a random review id, timestamp and definition/file fingerprint
under `protection-review/`, with private file permissions. Reviews expire after
15 minutes; cancelling does not write Codex trust. After an explicit click,
Pulse writes only its own reviewed Hook hashes and enabled state through Codex's
configuration interface and verifies the official trust result. It does not grant
trust to other plugins, enable reset-credit redemption or expand sandbox access.

Prompt text may be inspected in memory to estimate task size, but the original
prompt is not written to Codex Pulse history. Checkpoint summaries can repeat
context the assistant included in its final response, so users should treat the
local application-support folder as potentially containing project-sensitive
text. A native Goal objective can also contain project-sensitive text; it remains
local and is retained only as part of the continuity record.

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
When auto-redemption is explicitly enabled, the local App Server sends the
credit id and idempotency key to the official account service to redeem that
specific credit. None of those values are sent to `codex-reset.com` or to us.

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
