# Security policy

## Reporting a vulnerability

Please use GitHub's **Report a vulnerability** form in the Security tab so details remain private. Do not include Codex credentials, reset-credit IDs, private prompts, or proprietary source code in a public issue.

For ordinary bugs, open an issue and include:

- Codex Pulse version;
- Plus or Pro plan;
- macOS version;
- the redacted output of `node bin/codex-pulse.mjs doctor`;
- the approximate time of the missed or incorrect alert.

## Security boundaries

Codex Pulse never auto-approves permission requests, widens sandbox access, or consumes reset credits. Managed tasks fail closed when Codex requests user input or when the workspace has changed since pausing.

The optional X API bearer token is stored in macOS Keychain. It is never accepted
as a command-line value, written to Codex Pulse state, or included in diagnostic
output. Users should revoke the token in the X developer console if they suspect
it has been exposed.
