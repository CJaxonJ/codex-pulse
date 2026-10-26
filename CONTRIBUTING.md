# Contributing to Codex Pulse

Thanks for helping improve Codex Pulse. Bug reports, documentation fixes, tests,
and focused pull requests are welcome.

## Before opening an issue

- Search existing issues first.
- For support, read [`SUPPORT.md`](./SUPPORT.md).
- For a security problem, follow [`SECURITY.md`](./SECURITY.md) and do not open
  a public issue.

## Development setup

Requirements: macOS, Node.js 20 or newer, a signed-in Codex installation, and
Apple Command Line Tools.

```bash
git clone https://github.com/CJaxonJ/codex-pulse.git
cd codex-pulse
npm test
```

Most tests are local and deterministic. `npm run package:macos` also runs isolated
native UI and Codex configuration acceptance. It does not request model work.
Set `CODEX_PULSE_RUN_LIVE_E2E=1` only when intentionally running the additional
live feed and real-model recovery checks; these spend a small amount of normal
Codex allowance but never consume a reset credit.

Run `npm run privacy:check` before pushing. It scans tracked files and reachable
Git history for selected secret/privacy patterns without printing matched values.
Use only synthetic fixtures and reserved example domains. See
[Public disclosure policy](./docs/public-disclosure.md) for what belongs here.

## Pull requests

1. Keep each pull request focused on one change.
2. Add or update tests for behavior changes.
3. Run `npm test` before submitting.
4. Explain user-visible behavior, privacy, permission, and quota implications.
5. Do not commit credentials, prompt contents, private source code, or local
   Codex state.

By contributing, you agree that your contribution is licensed under the MIT
License in this repository.
