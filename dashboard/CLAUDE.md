@AGENTS.md

## Design system (R2, 2026-09-07)
Visual identity is ours: **cards on a cool tinted ground**, one brand hue carrying links AND the
primary action, semantic colour only for things needing action, terminal states neutral. Six type steps with
a 12px floor. Every form control is a styled primitive — native `<select>`/checkbox/radio are build
failures, enforced by `pnpm verify:ui` (five metrics at 0, budgets ratchet down only).

**`--card` and `--background` are DIFFERENT colours now** (they were both `#ffffff` until R2). Anything
meaning "the surface I sit on" must say `bg-card` — `bg-background` paints the page ground and will show
through a card. That single assumption produced 16 latent bugs the day the tokens changed. A filled button
is `--solid`, which R2 sets to the brand blue: this REVERSES the earlier "a filled button is ink" rule, and
it is one token if you want it back. Full rules + the CDP verification recipe: the `ui` skill.
