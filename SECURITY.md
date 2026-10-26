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

Codex Pulse never auto-approves permission requests or widens sandbox access.
Protection Hook trust requires the user's explicit review and confirmation.
Managed tasks fail closed when Codex requests user input or when the workspace
has changed since pausing.

Reset-credit auto-redemption is OFF by default and requires separate, explicit
consent bound to the current personal account. When enabled, Pulse may redeem
a verified available credit with less than ten minutes until expiry, only when
eligible quota has actually been used. It never buys credits or treats a public
reset forecast as permission to redeem. See [PRIVACY.md](./PRIVACY.md) for local
operation metadata, timeout reconciliation, and deletion boundaries.

Only the latest release is actively maintained. Report issues in older releases,
but upgrade before relying on subsequent fixes. This beta is not a guarantee of
an exact 10% stop, uninterrupted background operation, or successful redemption.

## Safe public disclosure

Use synthetic examples in bug reports. Do not upload the application-support
directory, a complete chat, raw logs, checkpoint previews, or credit-operation
files. Diagnostic output must still be reviewed before posting it publicly.

The repository checks tracked content and reachable Git history for selected
credential/privacy patterns, and checks extracted release contents. These are
bounded safeguards, not a certification that all sensitive data is detected.
GitHub secret scanning and push protection complement these checks.

The optional X API bearer token is stored in macOS Keychain. It is never accepted
as a command-line value, written to Codex Pulse state, or included in diagnostic
output. Users should revoke the token in the X developer console if they suspect
it has been exposed.
