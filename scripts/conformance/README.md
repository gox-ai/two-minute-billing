# Gateway conformance (`verify:gateway-conformance`)

One set of scenarios (S1–S14) runs against every payment gateway adapter. It runs through the
real adapter, which talks to a fake API, and through the real engine and the real webhook route.
It checks the ledger after each scenario. The suite proves two things: a gateway books money the
way its docs say, and every open defect is written down.

```
pnpm verify:gateway-conformance            # every fixture module (in verify:all)
pnpm verify:gateway-conformance -- square  # one gateway
pnpm gateway-docs:recheck                  # before a release: re-read the documented status lists
```

## The verdict

The suite **passes only when the failing rows equal `src/providers/conformance/known-gaps.json`
exactly**:

- A failing row that is not listed fails the suite. Fix it, or list it with a `planRef`.
- A listed row that now passes, is `n/a`, or no longer exists fails the suite with
  "remove them from known-gaps.json". So a fix must also delete its gap.
- **Coverage gate.** Every gateway in `src/providers/gateway-catalog.ts` must have a fixture
  module, or an entry with a reason in `src/providers/conformance/exclusions.json`. A catalog
  gateway with neither fails the suite, so a new adapter cannot land without fixtures.

`conformanceGaps(gatewayKey)` (`src/providers/conformance`) reads the same two files. It returns
the open rows, or one `fixtures` row for a gateway that has no fixture module. The availability
flag uses it: a gateway with open gaps is not offered. The files live under `src/` for that reason.

## The availability flag

A gateway, or one of its methods, is offered only after its whole lifecycle passed in the
sandbox, real webhooks included.

- **Gateway.** Any open gap (a `known-gaps.json` row, a `pending` exclusion, no fixture module)
  hides it: `GET /v1/gateways` says `available: false`, the dashboard shows "Coming soon", and
  `POST …/gateway_accounts` refuses it. The test gateway has no gaps. Existing accounts keep
  booking webhooks, refunds and renewals.
- **Method.** `src/providers/conformance/live-proof-pending.json` lists methods that pass here
  offline but are not proven live: gateway → method → `{ reason, planRef }`. A listed method
  leaves the checkout and portal lists, new setups and hosted Apple Pay. Saved ones keep
  charging. Keys are catalog keys (`advertisedMethods`, or `apple_pay` where `applePayHosted`);
  the coverage gate fails on one the catalog does not have. Remove the entry once it is proven
  live, and restore any "coming soon" copy in the catalog (a unit test pins the two together).
- The hosted Apple Pay rows here pass `pendingMethods: {}`, so the offline proof still runs.
- `pnpm verify:gateway-availability` proves the flag on Adyen's fake with injected entries.

## Layout

| File | What it is |
|---|---|
| `types.ts` | `GatewayFixture`, `GatewayDriver`, `SCENARIOS`: the contract a fixture module fills in |
| `scenarios.ts` | S1–S14, written once. Each check is a row such as `S3.second-at-own-amount` |
| `harness.ts` | One world per scenario: its own business, a gateway account on the fake, `bill()`, `deliver()`, ledger checks |
| `fake-http.ts` | One `fetch` replacement that routes by host to each fake. It records calls and injects faults |
| `verdict.ts` | Pure: rows against the known gaps, and the coverage gate (unit-tested in `test/unit/gateway-conformance.test.ts`) |
| `registry.ts` | The list of fixture modules |
| `fixtures/<gateway>.ts` | One per adapter: documented statuses with sources, the fake API, the driver, `n/a` reasons, extra rows |
| `docs-recheck.ts` | `pnpm gateway-docs:recheck`. Needs the network, so it is not in verify:all |

Exemplars: `stripe.ts` (an SDK on its own host; event versions), `gocardless.ts` (an async debit
with batched events; a 409 that names the existing resource), `square.ts` (a sync card; every row
passes, so it shows a finished gateway: refund records, `locateCharge`, location ownership).

## Add a gateway

1. **Start from the closest exemplar.** A sync card gateway: copy `square.ts`. An async debit
   gateway: copy `gocardless.ts`. A gateway with an SDK: copy `stripe.ts`.
2. **Point the adapter at the fake.** Pass an `api_base` credential when the adapter takes one,
   and use a private host (`https://<gateway>.conformance.invalid`). Otherwise the fake owns the
   gateway's real host, which is never reached.
3. **Write the fake API** (`class … extends FakeGateway`, `route(req)`):
   - Wrap every create and lookup in `this.guarded("<op>", req, () => …)`. Faults are injected
     by op name: `charge`, `refund`, and a lookup op such as `lookup`. Name them in the driver
     (`chargeOp`, `refundOp`, `lookupOp`).
   - Copy the gateway's idempotency rule exactly: a replay of a key returns the first object,
     or the documented conflict error. S7 depends on it.
   - Make every id with `this.id(prefix)`. It is a same-shape fake, unique to the run. The
     engine looks up refunds by gateway and refund id across the whole database, so a reused id
     reads an earlier run's row.
4. **Write the driver** (`GatewayDriver` in `types.ts`). Each event method changes the fake's
   state AND returns what the gateway would deliver. A read made while normalizing then sees the
   same world the event describes.
5. **Document every status.** `docs` names each source (`url`, `read` date, and how the re-check
   reads it). `statuses` lists every documented payment, refund and dispute status (or event
   action) and the normalized events the route must record. Use `{ none: "<why>" }` only for a
   reviewed decision to take no action. Prefer a machine-readable source (an OpenAPI spec) to a
   rendered page. Never copy a status from memory: fetch the page and record the date.
6. **Declare what does not apply.** In `na`, a key is a scenario (`S10`) or a row (`S5.lost`).
   The value is one line saying why, with the doc URL when the reason is a documented fact.
7. **Add audit findings as rows.** An audit finding that no generic scenario covers becomes an
   `extraRows` entry under the closest scenario (`S6.intent-id`, `S13.subscription-api-version`).
   Every audit finding is a row.
8. **S14 limits.** `limits` lists only documented maxima, each with its source. The scenario sends
   over-long text only where an operator or customer writes it (description, email, refund
   reason); engine-made keys and refs keep their real shape. `currencyAmounts` lists every
   currency where the gateway's unit differs from ISO 4217.
8b. **Signatures inside the body.** When the gateway signs inside the payload (Adyen's
   per-item HMAC, Braintree's `bt_signature`), implement `signBody` on the driver: it returns the
   body as posted, and `sign()` then signs that body.
8c. **XML Schema status lists.** When the only complete status list is an XSD, use
   `{ kind: "xsd-enum", type: "<simpleType name>" }` as the doc check.
9. **Register it.** Add the module to `registry.ts`. Add `"<key>": {}` to `known-gaps.json`.
   Remove the gateway from `exclusions.json`.
10. **Run it and settle every failing row.** Fix the adapter, or list the row in
    `known-gaps.json` with a `reason` and a `planRef` (`3f <Gateway>`, or `3f new` for a defect
    the plan does not list yet). Never list a row because the fixture is wrong: fix the fixture.
11. **Gates.** `pnpm gateway-docs:recheck -- <key>` must pass. `pnpm publish:oss -- --dry-run`
    must end "all five guards passed".

## Recording and scrubbing payloads

Take shapes from the gateway's sandbox or test account, or from an existing offline suite
(`scripts/verify-<gateway>.ts`, `test/unit/fixtures/`). Before anything is checked in:

- Replace every gateway id with a same-shape fake (`pay_XXXXXXXXXXXX01`, or `this.id()` at run
  time). Never check in a live-looking id with a mixed-case random tail.
- Emails use `@example.com`. Names are generic ("Conformance Payer"). Remove business names,
  statement descriptors, hostnames, IPs, tokens and signature keys.
- `publish:oss` guard 4 (private data) checks this, because `scripts/conformance/**` ships.

## Things that bite

- A charge that throws a plain error is booked by `recordFailedPayment` as a failed `payments`
  row with no transaction. `outcomeOf(billed)` reads both records. Judge an attempt with it.
- The route is posted at `/v1/gateway_webhooks/<key>?id=<account>`. Sign with
  `world.notificationUrl`: it is the URL the route verifies against, and it can carry a path prefix.
- A lost answer (S7) needs the lookup to fail too (`lookupOp`). Otherwise the adapter finds the
  charge inside the call, and the row tests the replay, not the lost answer.
- An SDK retries by itself (Stripe: 2 retries on 409, 5xx and network errors, with backoff).
  Faults are injected 6 deep, so they outlast the retries.
