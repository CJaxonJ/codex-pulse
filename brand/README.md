# Codex Pulse brand assets

The mark combines four product ideas in one compact shape:

- the open loop is a task that may pause without being abandoned;
- the two center bars are the protected reserve and the deliberate pause at 10%;
- the upper pulse is local quota observation and early warning;
- the green recovery stroke becomes a subtle cat tail inspired by Meiqiu.

The pulse and tail share one continuous recovery stroke: quota returns, then
useful work continues. The cat reference stays secondary to the product idea.

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

- Ink: `#171D1C` to `#29312F`
- Recovery green: `#2E8477` to `#67B7A8`
- Dark-theme ink: `#D8DED9` to `#F4F6F3`
- Dark-theme recovery green: `#3B9583` to `#7BC3B4`
- Soft surface: `#F3F5F2`

Keep gradients within the listed color families. Do not add shadows, eyes,
whiskers, or extra cat details. The mark is a quota and task-continuity symbol
first; the personal detail should be noticed only on a second look.
