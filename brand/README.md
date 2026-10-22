# Codex Pulse brand assets

The mark combines four product ideas in one continuous shape:

- the open loop is a task lifecycle rather than an endless background process;
- the center pulse is local quota observation and early warning;
- the cyan arc is the handoff from quota recovery back to useful work;
- the small upper peak is a restrained cat-ear detail inspired by Meiqiu.

The gap in the loop is intentional. Codex Pulse protects a reserve instead of
trying to consume every last token.

## Files

- `codex-pulse-mark.svg`: primary transparent mark for light backgrounds.
- `codex-pulse-mark-dark.svg`: transparent mark for dark backgrounds.
- `codex-pulse-app-icon.svg`: macOS and product-listing master.
- `codex-pulse-app-icon.png`: generated 1024 px raster master.
- `codex-pulse-64.png`: generated small raster fallback.
- `github-social-preview.svg` and `.png`: 2:1 repository preview.

The SVG files are the editable source of truth. Run `npm run brand:build` on
macOS to regenerate PNG and ICNS outputs after changing a master.

## Colors

- Ink: `#17191F`
- Pulse cyan: `#08A9D6`
- Dark-theme ink: `#F5F7FA`
- Dark-theme pulse: `#2CC8F5`
- Soft surface: `#F7F8FA`

Do not add gradients, shadows, eyes, whiskers, or extra cat details. The mark is
a quota and task-continuity symbol first; the personal detail should be noticed
only on a second look.
