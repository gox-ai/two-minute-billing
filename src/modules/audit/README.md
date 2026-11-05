# audit — append-only actor/diff log

> Source: `src/modules/audit/` · Routes: `src/api/audit-routes.ts` · Schema: `db/schema/audit-logs.ts`
> Layer: foundation (see docs/architecture/architecture.json)

## Purpose
Records **who did what**: an append-only log of write operations with actor, source, action, and a
changed-field diff. Complements events (which record *what happened to the domain*) — audit captures
the operator/API-key behind the change, including read-sensitive ops (key rotation) and no-op-visible
ones (settings changes).

## Responsibilities
- Write an audit row for a mutation (actor + source + before/after diff).
- Serve filtered audit queries (org-wide + business-scoped).

## Data model
`db/schema/audit-logs.ts` — `audit_logs`: `(organization_id, business_id?, actor, source, action,
resource_type, resource_id, before jsonb, after jsonb, actor_ip inet?, created_at)`. **Append-only**:
no UPDATE/DELETE grants; RLS read-scoped.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `writeAuditLog` | append an actor/diff row (rides the request `EventContext`) |
| `listAuditLogs` | filtered read (org + business) |
| `listAuditLogsPage` | cursor-paginated read (what the list routes serve) |
| `getAuditLog` | one row by uuid, business-scoped (the dashboard drill-in) |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/audit_logs` | org-wide audit list (filtered) |
| `GET /v1/businesses/:biz/audit_logs` | business-scoped audit list |
| `GET /v1/businesses/:biz/audit_logs/:id` | one entry: actor · source · `actor_ip` · before/after diff |

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** none.
- **Downstream (called by):** catalog, invoicing, metrics routes (raw export), subscriptions, tenancy, webhooks, transfer.

## Invariants & gotchas
- Append-only — never mutate a row.
- The diff stores changed fields only; **BigInt columns must be converted to number** before entering
  the jsonb diff (Drizzle `bigint` counters can't be `JSON.stringify`'d — caused a prior 500).
- Actor/source come from the request-scoped `platform/event-context`; jobs pass `scheduled_job`.
- `actor_ip` is **nullable and stays null** for every non-request writer (billing clock, importer,
  seeds, verify scripts). Never substitute a placeholder: a blank means "no request", and an invented
  address would be a claim about an origin that never existed.

## Changelog
- **2026-10-26** — New actions `dispute.record` (full snapshot) and `dispute.mark_won` /
  `dispute.mark_lost` (status + funds_withdrawn diff), written in the dispute's own transaction.- **2026-10-25** — **Security trail, part 2 + `category` filter.** New actions:
  `gateway_account.create|update|delete|set_webhook_secret|rotate_webhook_secret|provision_webhook`
  (written in `api/gateway-routes.ts` after the service call; credentials by field name only),
  `integration.hubspot.connect|disconnect`, `mail_transport.smtp.update|ses.update` (credentials as
  `changed`/`cleared`) and `organization.two_factor.enable|disable` (org-level, null business).
  `SECURITY_ACTION_PREFIXES` is the one list; `category` (`security` | `other`) is a virtual enum
  filter over it (`starts_with` OR-chain in a CASE), so `category[is]=security` works on both list
  routes. The dashboard Audit Log has a "Security" segment on it.
- **2026-10-24** — **Security trail** (B13). New actions: `api_key.create`, `api_key.revoke`,
  `api_key.rotate` (tenancy), `webhook_endpoint.create|update|delete|rotate_secret` (webhooks) and
  `data.export` (a raw-export CSV, `resource_type='raw_export'`, `resource_id` = dataset). Rows carry
  a key prefix or a URL origin, never a secret. Org-level rows have a null `business_id`.
- **2026-09-30** — `auditRowChange(tx, …)`: audit a row's create/update/archive from its before
  and after states (snapshots + diff derived once; `before: null` = creation; an update that
  moved only `updated_at`/`resource_version` writes nothing). Used by catalog and coupon writes.
- **2026-09-14** — **`customer=` on the business-scoped list.** `listAuditLogs` and
  `listAuditLogsPage` take a `customer` filter (a public id) and apply `ownedByCustomer` from
  `modules/events/resource-scope.ts` to `audit_logs.resource_id` — every row on that customer's
  records, not just the ones written against the customer itself. It is a bare `?customer=` param,
  not a `field[op]` filter, because the id set is a join rather than a column. The customer page's
  Activity Log needs both streams scoped the same way, or an act's audit row and its event stop
  pairing into one line.
- **2026-08-06** — **A dashboard action is attributed to the OPERATOR, not to a credential**
  (migrations 0150/0151, `api_keys.kind='dashboard'`; the mechanism is in `platform/auth`, the rationale
  in tenancy's README). Nothing in this module changed, but the trail finally answers its own question:
  `source='dashboard'` with the signed-in user's email in `actor` and their address in `actor_ip`,
  instead of `source='api'` + `actor='key_…'`. `actor='dashboard'` is the fallback when no session
  accompanied the request; `actor='system'` narrows to seeds and verify runs. The ops audit table's
  "Via API key" view now means genuine integration traffic, with a "System" view beside it, and
  `components/audit/labels.ts` `actorLabel` renders named actors as words ("Dashboard", "System",
  "Billing clock") while leaving opaque key ids in mono — an email is already a person's name.
- **2026-08-05** — **0149: an audit record is an ACTION, and it carries the whole record.** Two
  additions, both driven by what an Activity Log actually has to show.
  **`audit_logs.trace_id`** — one action can change several resources (activating a subscription also
  raises an invoice), and that must read as ONE record with a block per resource, surfaced on both
  records' Activity Log with `?source=` deciding which leads. We wrote independent rows with nothing
  tying them together, so the same act read as unrelated entries. The trace is not a new concept:
  `events.trace_id` and `gateway_request_logs.trace_id` already carry the same ambient `getTraceId()`,
  so an audit row now joins exactly to the events of its own execution — which also replaced the ±60s
  `created_at` window the Activity Log card used to pair on (that heuristic genuinely mispaired two
  collection attempts made inside a minute). New `getAuditRecord(org, biz, id, source?)` returns the
  record; `getAuditLog` is gone, superseded by it.
  **`audit_log_snapshots`** (separate table, `SELECT/INSERT/DELETE`, no `UPDATE`) — "Show Diff"
  renders the whole record on both sides with unchanged fields as context, and "Show Content" renders a
  created record's full body; neither was reconstructible from changed-field maps. It is a SEPARATE
  table because `audit_logs` is append-only **by grant**, and a full customer snapshot carries name,
  email and address — which `clearPersonalData` would then have been structurally unable to erase.
  Splitting it keeps the audit RECORD immutable and the snapshot BODY deletable: `clearPersonalData`
  now calls `eraseAuditSnapshotsForResource` for the customer and each of their subscriptions, records
  how many it dropped, and the surviving rows keep actor/source/IP/changed fields. After an erasure the
  UI says the snapshot is unavailable without claiming WHY — "never captured" and "erased" are
  indistinguishable in the data.
  **`writeAuditLog` gained `beforeFull`/`afterFull`** (`'beforeFull' in input` is the test, so an
  explicit `null` records a creation rather than an absent snapshot) and stamps `traceId` itself.
  `modules/audit/snapshot.ts` builds bodies mechanically from a Drizzle row — snake_case, `publicId`
  surfaced as `id`, internal FK uuids dropped, **bigint rendered as a minor-unit string** (plain
  `JSON.stringify` THROWS on bigint, so snapshotting a subscription would have crashed the very action
  it audited). Not the API serializers: those want financials / term conventions / items that most call
  sites don't have and would have to fetch only to audit.
  **Coverage went from 15 actions to 30.** New: `customer.create`, `.update`, `.archive`, `.restore`,
  `.change_billing_date`, `.clear_personal_data`, `.add_payment_method`, `.remove_payment_method`,
  `.payment_method_role`; `subscription.create`, `.activate`, `.renew`, `.change`, `.update`, `.pause`,
  `.resume`, `.reactivate`, `.remove_scheduled_cancellation`, `.change_term_end`, `.change_trial_end`,
  `.end_trial`. Customers had **zero** audit rows before this and subscriptions had only `.cancel`, so
  the Activity Log on those pages was events-only: no actor IP, no diff, and `Details` went to the
  developer event page. `modules/subscriptions/audit.ts` holds the wrapper the fourteen subscription
  call sites share, so the changed-field map and the snapshot are derived from each other and cannot
  drift. Payment-method actions are audited against the CUSTOMER, not the payment method: a deleted
  card has no page to drill into, and "who added a card to this account" is a fact about the account.
  `subscription.activate`/`.renew` are audited even though the billing clock, not a person, performs
  them — actor `billing_clock`, source `scheduled_job`, IP null, which is honest and is the row an
  operator most often needs.
  **`business_id` is now serialized** on both list routes, as the business PUBLIC id — it was declared
  on the dashboard's type and never emitted, so the org-level Audit Log rendered every row's Business as
  `—` and could not link a row to its own record page. Resolved once per page (`businessPublicIds`)
  instead of joining `businesses` into `listAuditLogsPage`, which three other screens share.
  `verify:audit` is **60 checks** (was 28), including trace grouping, `?source=` hoisting, the three
  snapshot states, bigint survival, snapshot immutability, and that erasure drops bodies while leaving
  every row and every changed-field diff intact.
- **2026-08-01** — **P4: `actor_ip` + a single-row read + wider op coverage** (the Activity Log
  drill-in). `audit_logs.actor_ip inet` (migration `0142`) is resolved ONCE per request from Fastify's
  own `request.ip` in `platform/event-context.ts` and carried on the ambient `EventContext`, so no
  service signature changed — same road `actor`/`source` already travel. `X-Forwarded-For` is never
  read directly: `req.ip` is `proxy-addr`-backed and walks the chain from the right under
  `trustProxy`, whereas trusting the header would let any caller forge the IP on their own audit row.
  Values are normalised for `inet` before the write (`::ffff:1.2.3.4` → `1.2.3.4`, `%zone` stripped,
  unparseable → null) so the type can never abort the money tx the row rides in.
  New `getAuditLog` + `GET /v1/businesses/:biz/audit_logs/:id` (non-uuid id → null → 404, not a 22P02
  500). Invoicing/credit-notes/dunning now audit **eleven more actions** — `invoice.close`,
  `invoice.collect`, `invoice.write_off`, `invoice.record_payment`, `invoice.regenerate`,
  `invoice.stop_dunning`, `invoice.pause_dunning`, `credit_note.create`, `credit_note.refund`,
  `credit_note.record_refund`, `credit_note.void` — all in the SAME tx as the state change except
  `invoice.collect` (documented at the call site: `collectInvoice` is shared with the clock's dunning
  pass, so auditing inside it would attribute machine retries to a person). `verify:audit` is 28
  checks: IP captured + normalised on an API op, NULL on a clock op, and a real diff per new action.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-10-21** — Audit log list total counts up to 10,000 and stops (`cappedTotal`, `total_capped`; `total=exact` opts in): an exact count over a large book cost seconds per page.
- **2026-10-25** — `role.` joins the security category (`category[is]=security`): `role.create`,
  `role.update` (with `added`/`removed`), `role.delete`.
