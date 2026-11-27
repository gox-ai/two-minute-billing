# migration — import from another billing system

> Source: `src/modules/migration/` · Routes: none (CLI only, via `scripts/`) · Schema: `db/schema/migration.ts`
> Layer: tooling (see docs/architecture/architecture.json)


## Purpose
Imports an existing billing account into tmbilling — full-fidelity, idempotent, and **without
double-charging**: it takes over renewals from the current term end rather than re-billing. Every
source implements one interface (`MigrationSource` in `types.ts`); the engine (`import.ts`) and the
reconcile harness (`reconcile.ts`) never know which system the data came from. The public source is
the JSON file format (`json-file.ts`), below.

## Responsibilities
- Read a source, map its catalog, coupons, customers, payment sources, subscriptions, invoices and
  balances into our model.
- Preserve source ids where they are slugs (catalog/coupons) so re-import is idempotent + id-stable.
- **Id-stable entities: catalog/coupons, customers, subscriptions.** Gateway accounts are stable too
  but by a different mechanism — an operator **pin** rather than the source id, because a source may
  only have an id for gateways that were actually used. See "Which public id an imported gateway
  account gets" below; it matters because that id is embedded in a URL registered in the provider's
  dashboard.
- Compute cached MRR from effective (override-aware) amounts; carry archival invoices as settled.
- Reconcile imported data against the source (invoice math to the minor unit).

### Which public id an imported gateway account gets

**Two sources, and only two:**

| # | source | when it applies |
|---|---|---|
| 1 | **`GATEWAY_ACCOUNT_IDS`** — `stripe=gwa_…,paypal=gwa_…,razorpay=gw_…` | a pin exists for that gateway key |
| 2 | a fresh `gwa_…` | it does not |

**The pin is load-bearing.** The inbound webhook URL is `…?id=<this id>` and that URL is registered in
the provider's own dashboard, so an unpinned gateway gets a new id on every import and its registered
endpoint goes stale — silently, since the gateway just starts 404ing and that is indistinguishable
from it having stopped sending. The importer emits a loud warning naming the gateway whenever it falls
through to a fresh id. `scripts/setup-dev-gateways.ts` honours the same pin, so an account recreated
after a `db:reset` comes back under the id its endpoint is registered with.

**The source's gateway id is deliberately not used.** A source may have no gateway-accounts endpoint
and derive accounts from its payment sources and transactions, so only gateways that were actually
**used** have an id at all. Depending on it gives stability for some providers and not others; one
explicit rule beats a ladder that silently covers half the cases.

The pin is claimed by the **first** account for that gateway in a run — a site with two accounts on
one gateway gives the rest fresh ids, because `gateway_accounts_public_id_uq` is global and a second
copy would simply fail. For the same reason a pin belongs to one business: importing the same pinned
gateway into a second business is refused (warned and skipped), which matches the intended
one-source-account-to-one-business shape. `pnpm verify:import-id-stable`.

## Data model
`db/schema/migration.ts` — import bookkeeping. The import writes into the normal domain tables via each
module's services (catalog, coupons, customers, subscriptions, invoicing, ledger, wallet).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `importFromSource(...)` | run an idempotent import from any `MigrationSource` |
| `reconcileWithSource(...)` | diff an imported business against its source; every mismatch listed |
| `JsonFileSource` | a source backed by the JSON file format below |
| `FixtureSource` | an in-memory source for verify suites |
| (CLI) `pnpm migrate:json <file.json>` | import a JSON file (`scripts/migrate-json.ts`) |

## API routes
None — CLI only.

## Events emitted
None (import is a bulk load; it does not fan out lifecycle events).

## Dependencies
- **Upstream (calls into):** catalog, coupons, customers, invoicing, ledger, metrics, subscriptions, wallet.
- **Downstream (called by):** none (CLI-invoked).

## Invariants & gotchas
- **Idempotent**: re-running maps to the same rows (source-id preservation) and never re-charges.
- Payment continuity: only customers with a portable/default vaulted method keep auto-charging on
  renewal; others dun until a card is added.
- **`import_records.target_id` is a `uuid`** — record the row `id`, never a `xxx_…` publicId. The
  create commits before `recordImport`, so a bad id leaves an orphan row that re-imports forever.
- Imported gateway accounts are **credential-less placeholders, always `status: 'disabled'`**, and
  imported webhook endpoints are **always `enabled: 'false'`**: no billing system exports gateway API
  keys, and an enabled endpoint would start sending billing traffic to a receiver nobody chose.

## Import from a JSON file

Export your customers and subscriptions to one JSON file, then:

```bash
pnpm migrate:json my-export.json --dry-run               # check the file; writes nothing
pnpm migrate:json my-export.json --business biz_…        # import into an existing business
pnpm migrate:json my-export.json --org-name "My company" # or into a new org + business
```

Without `--business` (or `--org-id` + `--business-id`), the run creates an organization and a
business and prints their ids and an API key; no dashboard user is a member of it. A
complete example is `scripts/migration-example.json`; the schema is `migrationFileSchema` in
`json-file.ts`.

| Key | Fields |
|---|---|
| `plans[]` | `id`, `name`, `amountMinor` (integer minor units), `currency`, `interval` (`day`·`week`·`month`·`year`), `intervalCount?` |
| `customers[]` | `id`, `email?`, `name?`, `paymentMethod?` (`provider`, `providerCustomerId`, `providerPaymentMethodId`, `type?`, `brand?`, `last4?`, `expMonth?`, `expYear?`) |
| `subscriptions[]` | `id`, `customerId`, `planId`, `quantity?`, `status?` (`active`·`trialing`·`paused`·`canceled`·`non_renewing`), `currency?`, `currentTermEnd`, `currentTermStart?`, `trialEnd?` |

Every row also takes `createdAt` / `updatedAt` (ISO-8601), so imported rows keep their history.

**What the import guarantees**
- **No double charge.** Nothing is invoiced on import; the first charge is the renewal at
  `currentTermEnd`. Stop renewals in the old system for the same date.
- **Cards keep working.** A `paymentMethod` links the card already vaulted at your gateway (by its
  customer and payment-method ids); no card number is ever read. A card binds to the business's
  ACTIVE gateway account of the same provider, so connect it before importing — or re-run after,
  which binds cards left unbound. Customers without a card dun at renewal until they add one.
- **Re-runs are safe.** Rows are matched by their source id, so a second run maps to the same rows
  and never charges again.

**What the file format does not carry yet:** add-ons, coupons and discounts, more than one plan
per subscription, tiered or usage prices, addresses and tax ids, and invoice history. The engine
imports all of these from a richer source (`MigrationSource`); the file format is the part that
is still flat.


## Changelog
- **2026-11-26** — The engine, the reconcile harness, the JSON file source and its CLI
  (`pnpm migrate:json`) ship in the open-source repo. `discountScope` moved into `types.ts` so the
  engine no longer imports a source adapter.
- **2026-11-26 (0550)** — `ImportOptions.runId` is stamped on every import record the run writes
  (`import_records.run_id`), and `ImportOptions.onRecord` reports each source object's outcome
  (`created`, `skipped`, `failed` with the error). The file import (`modules/bulk-import`) uses
  both: per-row results, and an undo that deletes only what one run created.
