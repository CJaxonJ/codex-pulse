# Distribution and directory status

The complete Codex Pulse product is distributed through this repository's
[macOS releases](https://github.com/CJaxonJ/codex-pulse/releases/latest).
It is an independent local utility, not an official OpenAI product.

The separate **Codex Pulse Guide** package is a setup/status helper, not the
background utility or its installer. It does not contain lifecycle Hooks,
install a background process, grant trust, or redeem credits. The complete local
utility requires its own installation and the user's explicit protection review.

The Guide has **not been submitted, approved, or published** in the official
directory. Availability here must not be described as official marketplace
availability. Changes to this status will be announced only after verification.

Maintainers can prepare and validate the separate helper archive with:

```bash
node scripts/package-plugin-submission.mjs
```

This produces a local artifact, not proof of an accepted submission. No developer
identity documents, account details, private review correspondence, or live
credentials belong in this repository or either distribution archive.

For installation see [开始使用.md](./开始使用.md). For data and permission boundaries
see [PRIVACY.md](./PRIVACY.md) and [SECURITY.md](./SECURITY.md).
