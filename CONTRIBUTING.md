# Contributing

Thanks for helping improve Two Minute Billing. Issues and pull requests are welcome.
Everyone taking part follows our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Before you start

- **Security problems** go to security@ — see [`SECURITY.md`](./SECURITY.md), never a public issue.
- For anything larger than a small fix, open an issue first so we can agree the approach.
- Read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (the locked decisions) and
  [`docs/GUIDE.md`](./docs/GUIDE.md) (conventions, and how a feature is added end to end). Each
  module under `src/modules/` has its own README; add a line to its changelog when you change it.

## Setting up

Follow the quick start in the [README](./README.md#quick-start). Use `pnpm` — npm, yarn and bun
are not supported.

## Rules the code depends on

- Money is integer minor units plus a currency code. Never floats.
- The ledger is append-only: post a compensating entry, never update or delete a row.
- Everything is tenant-scoped, and every API write takes an `Idempotency-Key`.
- The engine reaches payment providers only through the adapter interface in
  `src/providers/types.ts`.

## Before you open a pull request

```bash
pnpm typecheck && pnpm typecheck:dashboard
pnpm lint
pnpm test
```

Run the `verify:*` suites that cover what you changed (listed in
[`scripts/README.md`](./scripts/README.md)), for example `pnpm verify:coupons`. They run against
the real Postgres in `DATABASE_URL` and write test data to it, so point `DATABASE_URL` at a
database you can throw away. Dashboard changes must also pass `pnpm verify:ui`. We run the full
suite before we merge.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) — the commit
hook checks them.

## Contributor License Agreement

Before we can merge your first pull request, you need to sign our
[Contributor License Agreement](./CLA.md). A bot comments on the pull request with instructions;
signing takes one comment and covers all your future contributions.
