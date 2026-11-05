## What and why

<!-- What this changes, and the problem it solves. Link the issue: "Closes #123". -->

## How you checked it

<!-- Tick what you ran. See CONTRIBUTING.md. -->

- [ ] `pnpm typecheck && pnpm typecheck:dashboard`
- [ ] `pnpm lint` (0 errors)
- [ ] `pnpm test`
- [ ] The `verify:*` suites for the code you changed: `pnpm verify:all:fresh -- --suite <name>`
- [ ] `pnpm verify:ui` (dashboard changes only)

## Checklist

- [ ] Money stays in integer minor units, and no ledger row is updated or deleted.
- [ ] New API writes take an `Idempotency-Key`.
- [ ] The module README changelog has a line for this change.
- [ ] No API keys, real customer data or production ids in code, tests or this description.
