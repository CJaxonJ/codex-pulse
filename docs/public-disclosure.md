# Public disclosure policy

## Keep public

- Product behavior, installation/uninstallation, dependencies and MIT licensing.
- Permission scopes, user-confirmed trust, optional credit use, and revocation.
- Data retention, network destinations, and who receives each kind of data.
- Source, tests, architecture, verified release evidence and known limitations.
- The distinction between this independent utility and official directory status.

The implementation is not a secret. Do not obscure safety limits or third-party
dependencies for marketing. A local utility is not necessarily an offline one.

## Keep private

- Credentials, tokens, cookies, identity documents and payment details.
- Employer source/data, internal URLs or screenshots, and proprietary materials.
- Real user chats, task objectives, checkpoints, logs and credit-operation data.
- Personal contact details, machine home paths and internal submission notes.
- Unpublished commercial plans or reviewer/account correspondence.

Use `private/` for local maintainer notes, never for plaintext credentials.
Ignore rules protect untracked files only; they do not remove existing history.
Public support should contain minimal, reviewed diagnostics and synthetic repros.

## Checks and their limits

`npm run privacy:check` checks tracked working files and reachable Git objects for
selected patterns. Reports include only a file/object reference, rule and line,
not the suspected value. Existing non-noreply commit email counts are warnings,
not permission to rewrite history. Future local and GitHub merges should use
GitHub's private noreply identity.

Release verification checks the extracted archive too, including unexpected
credential/runtime files and symlinks. Private notes and maintainer submission
instructions are not shipped. CI runs the same repository check with full history.
GitHub secret scanning and push protection remain separate complementary layers.

Pattern checks cannot identify every secret, business-sensitive paragraph, image
or metadata leak. They do not fully audit old release assets, CI logs, PR comments,
forks or caches. Review new screenshots and support reports manually.

If a credential leaks, revoke/rotate it first and use private security reporting.
History rewrites or release replacement require an explicit, coordinated decision;
deleting the current file is not proof that old copies disappeared.
