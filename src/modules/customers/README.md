# customers — payer records, balances, contacts, ops

> Source: `src/modules/customers/` · Routes: `src/api/customer-routes.ts` · Schema: `db/schema/customers.ts`
> Layer: customer (see docs/architecture/architecture.json)

## Purpose
The payer identity + wallet + billing-policy container. Owns customer records, contacts, the
three-balance wallet, tax identity (VAT status, exemptions, withholding), the calendar billing anchor,
and money ops beyond CRUD (promotional credits, excess payments, ad-hoc collect, GDPR clear).

## Responsibilities
- Customer + contact CRUD; per-customer overrides (auto_collection, net_term_days, invoice_notes).
- Three derived balances: **promotional** (pre-tax), **refundable**, **excess payment** — read via
  `getCustomerBalances`; mutated via promotional-credit and excess-payment ops (ledger-backed).
- VAT status validation (pluggable), calendar billing-date, GDPR personal-data clear.
- Ad-hoc `collectPayment` (apply excess/refundable first, charge remainder, oldest-due-first).
- `planCreditApplication` — the pre-tax/post-tax balance application order consumed by invoicing.
- **Credits Flexibility** (`credits-flexibility.ts`) — the merchant control over whether, and up to how
  much, refundable credits and excess payments AUTO-apply. Pure resolver + one id-only loader.

## Data model
`db/schema/customers.ts` — `customers` (identity, billing/shipping address, `autoCollection`,
`netTermDays`, `invoiceNotes`, `taxExempt`, `vatNumber` + `vatNumberStatus`, `withholdingRateBps`,
`billingDate`/`billingDateMode`, currency, locale, metadata, soft-archive, resource_version) and
`contacts`. Balances are **derived from the ledger** (accounts: promotional/refundable/excess), not
stored columns.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `createCustomer` / `updateCustomer` / `setCustomerActive` / `listCustomers` / `getCustomerByPublicId` | customer lifecycle |
| `listContacts` / `createContact` / `updateContact` / `deleteContact` | contacts |
| `getCustomerBalances` / `bucketBalancesForCurrency` / `customerCreditBalance` | derived balances |
| `addPromotionalCredits` / `deductPromotionalCredits` / `setPromotionalCredits` | promo ops |
| `recordExcessPayment` | offline overpayment (unapplied) |
| `planCreditApplication` | balance application order for invoicing (takes resolved Credits Flexibility ceilings) |
| `resolveCreditsFlexibility` / `creditApplicationLimits` / `loadCreditApplicationLimits` | Credits Flexibility: business config → per-invoice ceilings |
| `collectPayment` | ad-hoc collection |
| `validateCustomerVat` / `changeBillingDate` / `clearPersonalData` | tax/anchor/GDPR |
| `getTaxIdValidator` / `setTaxIdValidator` | pluggable VAT validation |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET/PATCH/DELETE /v1/businesses/:biz/customers[/:cus]` | customer CRUD |
| `.../customers/:cus/contacts[...]` | contact CRUD |
| `.../customers/:cus/{promotional_credits,record_excess_payment,collect_payment,change_billing_date,clear_personal_data}` | money/ops (15 routes total) |

## Events emitted
`customer.created/updated`, `customer.billing_info_updated`, `customer.promotional_credits_added/deducted`,
`customer.excess_payment_recorded`, `invoice.paid` (from ad-hoc collect).

## Dependencies
- **Upstream (calls into):** events, invoicing, ledger, payment-methods, webhooks.
- **Downstream (called by):** credit-notes, invoicing, migration, subscriptions, transfer, wallet.

## Invariants & gotchas
- Balance application order: **discounts → promotional (pre-tax) → tax → refundable → excess → charge**.
- Balances are derived; adding/removing credit = new ledger entries, never a mutated total.
- `clear_personal_data` scrubs PII + detaches/gateway-deletes payment sources but **keeps money records**.
- Multi-currency collect is limited to the primary due currency (collect body has no currency field — nit).

## Changelog
- **2026-11-03** — `collectPayment` settles open invoices in `payment_application.invoice_order` (2.66): oldest due first (unset: the same ORDER BY as before) or newest first (ties: creation, then id, descending).
- **2026-11-03** — `billing_cc_emails` / `billing_bcc_emails` (≤ 10 each; 0486) on create/update/read.

- **2026-11-02** — `marketing_opt_in` + `marketing_opt_in_at` (0479): the answer to the checkout's optional marketing opt-in, null when never asked. Read-only on the API; written by checkout completion.

- **2026-11-02** — `exclude_from_reporting` (bool, default false; 0482) on create/update/read and as a
  list filter: an internal or test account that metrics leave out (`metrics/reportable.ts`). A
  change restates the stored figures after commit (`restateReportingForBusiness`). Dashboard: a
  switch on the customer form, a "Reports" line on the detail page. Gate: `verify:settings-invoices-org` D.
- **2026-10-25** — `dunning_policy` (dpol_… | null; `customers.dunning_policy_id`, 0386) on create/update/read and in the list; null = the business dunning config. `dunning_excluded` still wins.
- **2026-10-24** — `dunning_excluded` (bool, default false; 0373) on create/update/read and as a list filter. true = dunning does not start for the customer's invoices and the dunning passes make no retry or reminder; the first collection at invoice creation still runs. Time is frozen while excluded: `dunning_excluded_at` (0373) records the start, and turning it off moves every remaining step of the customer's invoices in dunning later by the exclusion's length (`shiftHeldDunning`: `next_attempt_at`, the parked anchor and reminder, a standing pause, and `invoices.dunning_held_ms`). Recorded by the `customer.update` audit row. Dashboard: a switch on the customer form, a "Dunning" line on the detail page. Gate: `verify:dunning` K/M.

- **2026-10-27** — **Shipping address book** (`addresses.ts`, `customer_addresses`, 0360). A
  customer holds many shipping addresses (`addr_…`, optional `label`); at most one live row is the
  default (partial unique index). `customers.shipping_address` stays as a MIRROR of the default,
  re-derived by `syncShippingMirror` in the same transaction as every book write, so the PDF, list
  filters and the customer payload are unchanged. The legacy `shipping_address` write on
  create/update now goes through `setDefaultShippingFromLegacy` (replace the default's fields, or
  insert one; `null` unsets the default and keeps the row). Routes:
  `GET|POST /customers/:cus/shipping_addresses`, `PATCH …/:addr` (`is_default`), `POST …/:addr/archive`
  (409 while a live subscription ships to it — archiving must not silently re-route a delivery).
  Events `customer_shipping_address_added|updated|archived`. GDPR clear deletes the book. Migration
  backfills each existing blob as that customer's default. Gate: `verify:shipping-addresses`.
- **2026-10-08** — `updateCustomer` writes only the fields that change (`effectivePatch`); a re-save of the same values writes nothing and emits no `customer_updated`. Re-sending the same VAT number keeps its validation.
- **2026-10-07** — `email_notifications` (bool, default true; 0325) on create/update/read and as a list filter. false = no automatic billing emails to this customer (enforced in `emails/outbox.ts`); operator-sent emails still go out. Dashboard: a switch on the customer form, a line on the detail page.
- **2026-10-03** — `applyCreditOnFile` / `applyCreditBeforeCharge` (`collect.ts`) hold collect_payment's credit step (refundable then excess, under Credits Flexibility) so every charge path shares it. collect_payment's behaviour is unchanged. Gate: `verify:collect-credit-first`.
- **2026-09-30** — `collect_payment` refuses a `payment_method_id` that is not this customer's
  (400, `CollectError`) before applying credit or charging.
- **2026-09-30** — `subscription_count` list filter (number): every subscription the customer
  holds, any status; the per-status `*_subscription_count` fields stay for one status.
- **2026-09-30** — `include_deleted=true` widens like `include_archived=true` (DELETE archives); the `mrr` currency pin reads a one-member JSON array (`currency[in]=["USD"]`) like `USD`.

- **2026-09-29** — `payment_method_count` list filter (number): every saved payment method, any
  status, as a correlated count on `payment_methods_customer_idx`. Also a segment attribute.

- **2026-09-25** — `has_used_discount[is]=true|false` virtual filter: customers who have ever
  had a coupon or manual discount applied to one of their subscriptions (any status). Offered by
  the segment builder as "Coupon or discount used".
- **2026-09-24** — `GET …/customers/:cus/excess_payments` lists the payments behind a customer's
  excess credit (`held_minor`, `refundable_minor`); the Balances card lists them with a Refund
  action. `EXCESS_REFUND_PENDING` joins the bucket constants (`balances-read.ts`).

* **2026-09-23** — **The `mrr` filter compares in the business's default currency.** It summed
  each customer's live subscriptions in their OWN currencies, so on a mixed book ₹200 read as
  20,000 and outranked $150. `mrrColumn` (built per business in `customerFilterConditions`)
  converts each subscription at the business's stored rate, `round(mrr / rate)`, then sums;
  `currency is X` compares natively and counts only X's subscriptions; a held currency with no
  usable rate is refused by name (`CustomerFilterRefusedError`, a 400 on the list).

* **2026-09-23** — `customerPopulationSql` added: a filter set's customer ids as a subquery,
  from the same `customerFilterConditions` the list and `customerSegmentTotals` use. Segment
  analytics joins the movement ledger to it.

* **2026-09-15** — `loadCustomerPublicId` added. An event payload naming a customer's
  INTERNAL uuid enriches nothing (`loadCustomerSnapshot` matches `public_id`) and says so
  nowhere; mirrors `loadPaymentMethodCustomerPublicId` in `payment-methods/serialize.ts`.
- **2026-09-15** — **"Payment Method" and "Subscription count" filter groups, Tier 1+2.**
  Twelve EXISTS-backed instrument fields (`payment_method_id` / `_gateway` / `_brand` / `_last4` /
  `_exp_month` / `_exp_year` / `_issuer_country` / `_sub_type` / `_role` / `_gateway_account`, plus
  `primary_payment_method_type` and `backup_payment_method_type`), an `invoice_status` that takes the
  caller's status rather than the fixed set `has_unpaid_invoices` asks for, and six
  `<status>_subscription_count` numbers. The counts read `apiStatusSql`, NOT the stored column —
  `non_renewing` is derived at the API boundary, so counting the column would answer 0 for every
  customer while the list beside it renders "Non-renewing" on their rows. That expression moved to
  `subscriptions/status-sql.ts` (a leaf, like `customers/name-sql.ts`) so both modules share ONE
  definition without closing an import cycle; `existsFieldCondition` + `VirtualFilter` moved to
  `platform/list-query.ts` for the same reason.
  ⚠️ Every sub-query here rides an FK index **verified against the live schema**, not the schema
  file: `payment_methods_customer_idx`, `subscriptions_customer_idx`, `invoices_customer_idx`.
  **`ledger_entries` has NO `customer_id` index**, which is why the four balance filters
  (Promotional Credits, Excess Payments, Refundable Credits, Unbilled Charges) are NOT here — see
  `docs/PROGRESS.md`.
- **2026-09-01** — **The half of Credits Flexibility that was missing: a deliberate way to spend the
  credit.** `collect_payment` (this module's `collect.ts`) obeys the business's Credits Flexibility
  grid, which is right — from the customer's side it IS auto-application, since the caller says
  "settle these invoices" and the engine still chooses the buckets. But it meant a merchant on "Do
  not auto-apply" had no route to apply credit at all. That is now
  `POST /v1/businesses/:biz/invoices/:inv/apply_credits` — `applyCreditsToInvoice` in
  `modules/invoicing/ops.ts`, invoice-scoped because the operator names the invoice. It deliberately
  IGNORES the ceilings (the grid and the per-subscription maxima both govern AUTOMATIC application);
  the reasoning is written out on the function and in `modules/invoicing/README.md`. The `collect.ts`
  docblock that called this "the follow-up, not a reason to leave the setting half-enforced" now
  points at it. Gate: `pnpm verify:apply-credits`.
- **2026-08-31** — **Custom fields are filterable on the list, as `cf_<api_name>`.** A business that
  models its own segmentation in custom fields (plan tier, region, seat count) had to export to
  answer a question about it. The
  definitions are per-business and created at runtime, so they cannot join the static `FILTERS` map:
  `customerCustomFieldFilterSet(defs)` builds specs/ops/kinds from the `custom_fields` jsonb column,
  and `GET /v1/businesses/:biz/customers` merges its `ops`/`kinds` OVER `CUSTOMER_FILTER_OPS` /
  `CUSTOMER_FILTER_KINDS` for that one request — the exported maps are unchanged, because
  `modules/list-views/entities.ts` reads them. **One definitions read per request**: the route needs
  the ops before `parseListQuery` will accept `cf_tier[is]=gold` and the service needs the SQL specs
  while building the query, so the rows travel down as `CustomerListFilters.customFieldDefs` instead
  of being read twice (two reads could disagree if a definition were created between them, and it
  would double the queries on every page). The cf specs go through the SAME `filterConditions` call
  as the real columns, with the same business timezone — so a `date` custom field buckets by the
  business day like `created_at` does — and into the same `conds` array the first-page `count(*)`
  uses, so the footer total narrows with the page rather than reporting 40 above 3 rows.
- **2026-08-24** — **Promotional credit moves four ways; only two of them said so.** The manual grant,
  deduct and set paths in `balances.ts` emit `customer_promotional_credits_added` / `_deducted`
  inline, but the two AUTOMATIC movements posted their ledger entries straight from the flow that
  owns them and emitted nothing: an invoice DRAWING the bucket (`postCreditApplications`, invoicing)
  and a credit note RESTORING a funded slice (`restoreBucketFundedSlices`, subscriptions). A webhook
  consumer tracking the balance therefore saw the grant and the manual deduct and nothing else —
  eight movements went unannounced (two draws, three restores). Not a naming problem — both
  types were already mapped. New **`emitPromotionalCreditMovement(tx, …)`** here is the single place a bucket
  movement becomes an event, so the payload cannot drift between the manual and automatic paths: it
  resolves the customer's public id, reads the POST-movement bucket balance from the ledger, and
  emits the same `{ id, amount_minor, currency, balance_minor, description }` shape the manual paths
  build — plus a top-level `invoice` naming the document that caused the movement, which the manual
  paths have nothing to put there. Call it inside the posting transaction, after `postEntries`, or
  `balance_minor` reports the pre-movement figure. Refundable/excess get no twin: there is no
  per-bucket event type for either (`customer_excess_payment_recorded` means offline money RECEIVED,
  so reusing it for a restore would misreport it as income), and their movement is already reported
  by the `customer_changed` that `allocateRefundableDraw` emits. Proven end-to-end on a promo-funded
  invoice + mid-term prorated cancellation: draw → one `_deducted`, restore → one `_added`, and
  `customer_credits_restored` still fires exactly once (added, not duplicated).
- **2026-08-22** — **The customer pickers search the SERVER.** The manual-invoice and
  subscription-create pickers were each handed `listCustomers(biz, { limit: 1000 })` and filtered it
  in the browser, so customer 1001 was unfindable — and silently: no "showing 1000 of N", just a
  search that confidently returned nothing, so an operator concluded the customer did not exist.
  Both now seed from a 25-row first page and query `?q=` (free text over id/email/name/company/phone,
  run in SQL by `listCustomersPage`'s `search`) on every keystroke, and the dialog SAYS when more
  match than it shows. One shared `components/customers/customer-picker.tsx`; callers keep their own
  trigger. ⚠️ The picker row carries `effective_currency` and `auto_collection` rather than letting
  callers look them up: both forms read a real field off the chosen customer (the invoice form drives
  its money exponent, the subscription form names the auto-collection it will inherit), and with the
  bulk read gone `customers.find(...)` would silently resolve nothing for a searched-for customer.
  Gated by `verify:customers` D8, whose needle is created FIRST so the first page cannot contain it.
  ⚠️ Still an unindexed `ILIKE '%…%'` — `pg_trgm` remains open.
- **2026-08-22** — **A country-only billing address is a real address.** `serializeCustomer` gated the
  whole block on `line1`, so a customer carrying `country: 'IN'` and no street reported
  `"address": null` on every read — while the row held the country and the tax engine, which reads the
  COLUMN, correctly charged 18%. Now shares its sibling's rule (`normalizeShippingAddress`): null only
  when every field is null.
  **The read was the cheap half.** The operator edit form prefills from this value and `applyAddress`
  REPLACES the whole address, so an empty prefill posted `country: null` and WIPED the country —
  silently switching GST off for exactly the customers an API provisions. `requireCore` on that form
  is now keyed on `line1` rather than "any field set", or the fix would have forced an operator to
  invent a street address before they could save. Gated by `verify:customers` D7 (read, the
  re-post round trip, and "no address still serializes null").
  ⚠️ Do not "fix" the write path: the write works and the tax works — only the read lied. This is the
  inverse of the original ₹0 tax bug, which looked right and was wrong.
- **2026-08-07** — **`effective_currency` now ships on the customer LIST, batched — not N+1.**
  `serialize.ts` emitted the field only when an `extra` argument was passed, and the list route
  called `serializeCustomer(c)` bare, so every list consumer fell through to the business default.
  The dashboard's manual-invoice form had a live currency-resolution arm that could never fire.
  Fixed with **one** aggregate per page: `getCurrencyWeightsForCustomers(orgId, ids)` does a single
  `GROUP BY (customer_id, currency)` over the page's ids and the route zips it onto the rows —
  reusing the *same* `deriveEffectiveCurrency` the detail path uses, so list and detail cannot
  drift. A page costs a constant **+1 query** regardless of row count. Predicate matches
  `getCustomerFinancials` exactly (`active`/`in_trial`; a trial contributes a currency key at
  weight 0 via `coalesce(sum(mrr), 0)`). Tenant-scoped by `withTenant` → RLS `org_isolation` on
  `subscriptions` (0009), on top of an already business-scoped page.
  **`serializeCustomer`'s `extra` blocks are now independently gated** — `effective_currency` on the
  key being present, `mrr`/`balances` on their own data. The list deliberately does NOT emit
  `balances`/`mrr`: that would need a second aggregate, and an empty `balances: []` reads as "no
  credit", which is a lie rather than an omission.
- **2026-08-05** — **Audited for the first time (0149).** `createCustomer`, `updateCustomer`,
  `setCustomerActive` and `changeBillingDate` now write audit rows, and the first three carry full
  before/after record snapshots so the Activity Log can show a change in context. There were **zero**
  `customer.*` audit rows before this, so a customer's Activity Log was events-only — no actor IP, no
  field diff, and `Details` led to the developer event page. `clearPersonalData` additionally (a) drops
  the audit SNAPSHOT bodies for the customer and each of their subscriptions via
  `eraseAuditSnapshotsForResource`, because a snapshot carries exactly the name/email/address it just
  scrubbed, and (b) audits itself with the number of snapshots dropped — an action whose purpose is to
  destroy data must leave a record that it ran. The audit ROWS are never touched: append-only holds.
- **2026-08-04** — **The excess-payment bucket now also fills from an over-collected invoice.**
  `recordOfflinePayment` (invoicing) credits money above an invoice's outstanding balance to
  `excess_payment_balance` instead of over-applying it to the invoice, so the bucket is no longer
  fed only by the customer-level `recordExcessPayment` / wallet top-ups. `collect.ts` also stopped
  reading the stored `amount_due_minor` as the amount to settle — it goes through
  `invoiceOutstanding` (net of cash already collected) and only ever writes the CREDIT-driven
  decrement back to the column. Full story: `src/modules/invoicing/README.md` (2026-08-04).
- **2026-07-30** — **`shipping_address` is a structured address, not an untyped blob.** The route
  body was `z.record(z.string(), z.unknown())`, so anything could be stored and no form could be
  built against it. It now uses the same `addressBody` shape as billing, plus **`zip` accepted as an
  alias** for `postal_code`, folded in by `toShippingAddress` (which also collapses an all-empty
  address to null instead of an object of nulls). Safe to tighten because the importer calls
  `createCustomer` **directly**, bypassing route validation.
  `normalizeShippingAddress` (serialize.ts) normalizes on **READ**, so rows already written in the
  imported shape (spelling `zip`, carrying `object`/`validation_status`) serialize canonically with **no
  backfill** — keep new read paths going through it rather than touching `c.shippingAddress` raw.
- **2026-07-30** — **New derived `effective_currency` on the customer read.** Most customers have
  `currency` NULL (we never derive it on write), so
  consumers fell through to the BUSINESS default — showing an INR-only customer `$0.00` credits and
  preselecting USD in every money form, which mints balances their invoices can never consume.
  `deriveEffectiveCurrency(explicit, currencyWeight)` (serialize.ts) resolves explicit `currency` →
  the live subscriptions' currency (highest MRR wins on a tie) → null. Costs no extra query: the
  existing MRR query already selected each subscription's currency. **`currencyWeight` is tracked
  separately from `mrr`** because a trialing subscription pins the currency but has no MRR yet and
  must stay out of the MRR map. Returned by `getCustomerFinancials` and emitted by both read paths
  (`GET .../customers/:cus` and `loadCustomerSnapshot`). **Derived only — never write it back to
  `currency`**; persisting it is an open product call.
- **2026-07-30** — **`address` sub-fields now accept `null`, not just omission.** `addressBody`
  (`src/api/customer-routes.ts`) declared each sub-field `.optional()` without `.nullable()`, so a
  client that posts blank inputs as null — which the dashboard's operator "Edit billing address"
  drawer does — got `400 expected string, received null` for every empty field, and the address
  silently never saved unless all 12 were filled. `applyAddress` had always coerced both null and
  undefined with `?? null`, so the two were already equivalent downstream; only the zod gate
  disagreed. All sub-fields are now `.nullable().optional()` and `CustomerAddress` is widened to
  `string | null`. `min(1)`/`length(2)` retained — **null clears a field, `""` is still an error.**
  `portalMeBody`'s optional sub-fields got the same treatment (kept in lock-step per its comment),
  but `line1`/`country` stay required there for buyer edits.
- **2026-07-30** — **Paginated customers list** (rebuilt; the first implementation was lost when
  `e0cd616` backed out another session's WIP, leaving the dashboard calling a contract the engine no
  longer had — `limit` ignored and every filter a silent no-op). `listCustomersPage` behind
  `GET /v1/businesses/:biz/customers`: keyset on `(created_at DESC, public_id DESC)` (index
  `customers_business_created_idx`, migration 0126), `q` search in SQL, `sort_by[asc|desc]` over
  `created_at|name|email|company`, `<field>[<op>]` filters over an allow-list, and the **virtual
  `subscription_status`** field (EXISTS over the customer's subscriptions) that backs the dashboard's
  segments. Response carries `has_more`/`next_cursor`/`total` (filtered count, first page only).
  Built on `src/platform/list-query.ts`; `listCustomers` stays as the internal unpaginated read.
  Verify: `verify:list-pagination`.
- **2026-07-29** — **Customer `public_id` uniqueness is now PER BUSINESS (Bugs #11).** `customers_public_id_uq`
  was global, but the id-stable importer carries the source customer id verbatim and source ids are unique
  only per SITE — so the second tenant to migrate in collided and the failed insert cascaded away their
  subscriptions/invoices/transactions/credit notes. Migration `0127` replaces it with
  `customers_biz_public_id_uq` on `(business_id, public_id)`, matching the catalog tables.
  Consequence: **every lookup by `public_id` must also carry `business_id`** — RLS scopes to the
  ORGANIZATION, which may own several businesses, so an unscoped `.limit(1)` would return an arbitrary row.
  `loadCustomerSnapshot(tx, cusPublicId, businessId)` now takes the business id as a required argument.
- **2026-07-22** — **Live VIES VAT-ID validation** (parity #9). `vies.ts` implements the
  `TaxIdValidator` interface against the EU VIES REST API; selected by `TAX_ID_VALIDATOR=vies`
  (default `noop`). `getTaxIdValidator()` now resolves lazily from config (no boot wiring; both
  API + worker pick it up); `setTaxIdValidator()` remains a test/override hook. Graceful: non-EU
  numbers, member-state 5xx, and timeouts all → `undetermined` (never blocks create/invoice).
  GR→EL mapping + embedded-country-prefix handling. Verify: `verify:vat` (10).
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-05** — Two tax-determination inputs: `tax_treatment` (`default` \| `sez_igst` \|
  `sez_zero_rated` \| `export_igst` \| `export_zero_rated` \| `reverse_charge`, NOT NULL default
  `default`) and `tax_registration_number` (the customer's own GSTIN). Distinct from `tax_exempt`,
  which zero-rates unconditionally, and from `vat_number`, which has its own VIES lifecycle —
  `tax_registration_number` deliberately gets NO status column rather than one that never changes.
  Which treatments a customer may take comes from their region's gates (`allowedTreatments`), so the
  form offers exactly what the engine honours. Migration `0146`.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-22** — **`names.ts` — one precedence rule for three overlapping name sets.** A customer row
  carries `name` (ours), `first_name`/`last_name`/`company` (the account holder) and
  `billing_first_name`/`billing_last_name`/`billing_company` (the billing contact), and five places
  resolved them differently — `invoicing/document.ts`,
  `credit-notes/document.ts`, `emails/adhoc-service.ts`, `invoicing/serialize.ts` and the dashboard's
  `addressName`. The rule: the invoice PDF prints the **billing-address contact** ("Accounts
  Payable"), the account holder appears nowhere on the document, and there is no `customer.name` at
  all (posting one is silently dropped). We had it backwards — `customers.name` won
  every document and the `billing_*` columns were **write-only**, read by nothing, under a portal
  heading that read "Contact (shown on invoices)". Now: `invoiceContactName` (billing contact → account
  holder → `name` → email) for documents, PDFs, the invoice `billing_address` snapshot and the gateway
  billing name; `accountHolderName` (account holder → `name` → email) for tables, mail and the portal
  greeting — ⚠️ the `name` arm was removed from both on 2026-08-23, see the next entry — the two deliberately DISAGREE on the same row and must not be merged. `hasBillingName`
  replaces `Boolean(customer.name && …)` in the portal/checkout `billing_details_complete` gates, which
  had made our invented column a hard requirement for card setup. `billingContact` falls back as a whole
  unit, never mixing halves. No migration: the fallback chain covers every existing row.
  Tests: `test/unit/customer-names.test.ts` (16).
- **2026-08-22** — **`name-sql.ts`: `accountHolderName`, expressed in SQL.** The operator lists resolve
  their Customer column in TypeScript, but `customer_name` is also a FILTER, and a predicate runs in
  Postgres before any row reaches us — so the precedence chain now exists twice, deliberately, and the
  file says so in both directions. Only three of the four rungs: the email is left out because
  `customer_email` is its own filter field on every list that has this one, and folding it in would make
  `customer_name[is_present]=false` true for every row, i.e. unaskable. ⚠️ Change one chain, change the
  other, or a list shows a name the filter can't match — the operator can then see the row they are
  being told doesn't exist. Consumers: the `customer_name` filter on the invoices and subscriptions
  lists. Tests: `test/unit/customer-names.test.ts` (compiled predicate) +
  `scripts/verify-list-pagination.ts` (real rows).

- **2026-08-23** — **`customers.name` DEPRECATED — a customer is named by `first_name`/`last_name`/`company`.**
  The column was our own invention, it was already last in every chain, and no form had collected it
  since the portal dropped its
  "Full name" field. Measuring the local DB settled whether to keep it: of 4,007 customers, 464 had it
  set, **450 of those had no structured name at all** — i.e. it was populated almost entirely by our own
  seeds and verify scripts, which reached for it because it was the shortest path through
  `POST /v1/customers`. It duplicated the derived holder name in **zero** rows, and the only 7 rows where
  it disagreed were one fixture repeated. It carried no operator intent anywhere.
  · **Removed from:** all four chains in `names.ts`, the SQL mirror `name-sql.ts`, `CustomerFields`
  (so the compiler refuses it), the create/update API, the checkout body (`CheckoutCustomerInput`), the
  portal body (`portalMeBody`), the `SourceCustomer` importer shape, the import adapter (which used to
  SYNTHESISE it as `company ?? "first last"`), the free-text search column lists on the customers,
  invoices, subscriptions and transactions lists, and six dead `cusName: customers.name` selects.
  · **New helper `holderName()`** — `first last` → `company` → null, i.e. `accountHolderName` without the
  email fallback. It existed three times inline; the SQL mirror is its Postgres twin and must move with it.
  · **Reads are unchanged in shape:** `GET /v1/customers` still emits `name`, now DERIVED via `holderName`
  and marked `readOnly` in OpenAPI. Writes are **rejected with 400**, not ignored — both write bodies are
  `.passthrough()` (the `cf_<name>` params are read off the raw body), so deleting the key from the schema
  would have accepted the request and dropped the value silently.
  · The `name` FILTER and SORT now target `accountHolderNameSql`, so filtering or sorting by the name a
  list *shows* works; `customer_name[is_present]=false` finally means "no first/last and no company".
  · **The column is kept** (annotated in `db/schema/customers.ts`) so rows that only ever had this value
  are not destroyed. Nothing reads or writes it except the GDPR scrub, which still clears it. Dropping it
  later is a one-line migration.
  · **Stripe is the one place a flat upstream name is unavoidable** — `customer.name` there is documented
  as "full name OR business name" with no first/last to map from, so `stripe-billing.ts` puts it whole
  into `firstName` and deliberately does NOT split on whitespace: a split renders "Priya Raghunathan"
  correctly and mangles "Larkspur Foods Pvt Ltd", and nothing in the payload says which you have.
  · 52 fixture sites across 19 seed/verify scripts were rewritten to structured names (person-shaped →
  first/last, entity-shaped → `company`). **Three classes of caller are invisible to `tsc`** and were only
  caught by running the suites: SDK calls (`verify-customer-portal`), raw `fetch` bodies
  (`verify-events`, 5 cascading failures from one rejected create), and assertions reading `row.name`
  (`verify-subscription-ops`). Removing `name` from `NameFields` is what made the other 35 compile-time.
  Tests: `test/unit/customer-names.test.ts` (22, now pinning that the column is ignored even when
  present); `verify:list-pagination` grows a row written straight to the column via raw SQL and asserts
  both the display and the filter ignore it.

- **2026-09-01 · Credits Flexibility (0219).** Refundable credits and excess payments no longer
  auto-apply unconditionally and in full. `credits-flexibility.ts` is the new pure config layer —
  `businesses.credits_flexibility` (a 2×2 grid of credit kind × invoice class, each
  `do not auto-apply` / `auto-apply` / `apply up to a limit`) plus two per-subscription maxima
  (`max_refundable_credits_usage_minor`, `max_excess_payment_usage_minor`) carried as billing
  overrides. The tighter of the two ceilings wins, so a subscription cap can narrow the
  site setting but never re-enable a bucket the site switched off. `planCreditApplication` takes the
  resolved ceilings as an optional `limits` argument and stays pure — the preview path must resolve
  them identically to the booking path or the preview lies. **Defaults are the pre-feature behaviour
  exactly** (auto, unlimited, all four slots, no subscription cap) because a null stored config is
  what every existing business has; capping by default would stop applying credit customers have
  already been told is theirs, across every tenant at once.
  · Why: `planCreditApplication` was one unconditional chokepoint, and it is the mechanism behind
  INV-4705 — ₹69,521.79 of refundable credit drawn onto an open invoice that then 500'd.
  · `collectPayment` is gated too, deliberately: the setting reads as scoped to invoice generation,
  but from the customer's side an operator saying "settle these invoices" is still the engine
  deciding to spend a bucket. The cost is that auto-apply OFF leaves no deliberate way to
  apply credit — we have no explicit apply-credits endpoint yet; that is the follow-up.
  · Found while writing the suite: the ceiling is PER INVOICE, so `collectPayment` has to subtract
  what the invoice already drew. It did not, and a 2000 excess cap applied 2000 at generation and
  another 2000 on collection — 4000 on one invoice. `headroom()` in `collect.ts` is that fix.
  · Verified by `pnpm verify:credits-flexibility` (42 checks, on a scratch DB), with
  `verify:customers`, `verify:credit-notes`, `verify:invoices-v2`, `verify:concurrent-credit-apply`,
  `verify:proration` and `verify:estimates` re-run unchanged to prove the defaults are inert.
  both the display and the filter ignore it.- **2026-08-31** — **Customers list filters widened to ~40 fields + 4 EXISTS-backed virtuals**
  (from 13). Everything in `FILTERS` is a column
  verified against `db/schema/customers.ts`, keyed by the name `serializeCustomer` EMITS — nested values
  use the flattened path (`address.city` → `address_city`, `shipping_address.country` →
  `shipping_address_country`), because the query grammar is `<field>[<op>]` and `parseListQuery` matches
  a field id as `^[a-z_]+$`, so an id cannot carry brackets of its own.
  · New real-column fields: `locale`, `invoice_notes`, the whole billing address (`address_line1..3`,
  `address_city`, `address_state`, `address_state_code`, `address_postal_code` and the CP-2 contact
  sub-fields `address_first_name`/`address_last_name`/`address_company`/`address_phone`), the tax block
  (`tax_treatment`, `tax_registration_number`, `vat_number`, `vat_number_status`, `vat_validated_at`,
  `withholding_rate_bps`), the billing anchor (`billing_date`, `billing_date_mode`), `pii_cleared` and
  `updated_at`. `country` deliberately keeps its bare name (it shipped first, and it is the same column
  `address.country` serializes) — two ids for one column is how a saved segment and a filter panel start
  disagreeing about which is canonical.
  · **Shipping address is one untyped jsonb blob**, so `shipping_address_{city,state,country,postal_code}`
  go through a `shippingField()` helper: `jsonb_typeof(...) = 'object'` guards the extraction (the
  importer writes the source object verbatim through the service, bypassing the route's zod), and
  `postal_code` falls back to `zip` — the same fallback `normalizeShippingAddress` does on read. A filter reading a
  key the serializer renamed returns an empty page for a value the list is showing on screen.
  · **Virtuals** (`VIRTUAL_FILTERS`, EXISTS sub-queries): `subscription_status` (pre-existing),
  `payment_method_type`, `payment_method_status` and `has_unpaid_invoices`. The five-operator switch that
  `subscription_status` had inline is now ONE `existsFieldCondition` shared by all of them — a second copy
  is how `subscription_status[not_in]` and `payment_method_type[not_in]` would start disagreeing about the
  customer with no related row at all (they match both negations, because the `NOT` wraps the whole
  EXISTS). That switch now also lowercases both sides, matching `filterSql` on real columns, so
  `subscription_status[is]=Active` no longer answers empty while the filter beside it answers correctly.
  Every sub-query joins on an indexed `customer_id`; `has_unpaid_invoices` excludes `pending` invoices,
  which are still accreting metered lines and have not been asked for yet.
  · **`CUSTOMER_FILTER_KINDS` is new and the route now passes it as `filterKinds`** — without it a
  malformed value (`billing_date[between]=5`, `created_at[on]=31/08/2026`) reached Postgres as a cast
  error and surfaced as a **500 on a caller typo** instead of a 400 naming the shape.
  · Sorts gained `id` (index-served by `customers_biz_public_id_uq`) and `updated_at`. `created_at`
  remains the only keyset fast path.
  · **Not added, no backing column:** wallet/promotional-credit, refundable-credit and excess-payment
  balances (ledger-derived, `balances-read.ts` — there is no column to compare, and a filter over three
  `sum()`s per row is a different piece of work), `consolidated_invoicing`, `business_entity`, `channel`
  and `deleted_at`/`deleted` (`invoices`/`credit_notes` have `channel`; customers do not, and the archive
  flag is `active`, already scoped by the route's `include_archived`).
  Verified by rendering every new predicate through `PgDialect` — the local `.env` is unreadable from a
  worktree, so acceptance was checked as SQL text, not against a live database.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-28** — `payment_method_expiring[is]=true|false` virtual filter: customers holding a saved card
  that expires within ninety days, by the `cards_expiring` measure's own rule (good to the last instant
  of the printed month; status does not enter). It is the list behind the "Cards expiring" cell on both
  Homes. Checked against the measure on 42,801 cards: 0 instant mismatches, the same 131 cards and 101
  customers. `verify:customers` and `verify:list-views` pass.
- **2026-09-28** — `cannot_be_charged[is]=true|false` virtual filter: an active customer (an active or
  non-renewing, non-deleted subscription that collects automatically — subscription setting, else the
  customer's) with no payment method that still works (none, or every one expired by status or printed
  date, or invalid). A working backup rules them out; offline customers never count. The list behind the
  "Can't be charged" cell on both Homes. Dev check: 94 customers (92 bad card, 2 no method); its negation
  partitions all 3,365. `verify:customers` and `verify:list-views` pass.
- **2026-09-28** — `renewing[is]=true|false`: a customer with an ACTIVE, non-deleted subscription earning MRR
  (> 0), status read through `apiStatusSql`, so a subscription set to end at term (non-renewing, which the
  column stores as `active`) is out. `cannot_be_charged` now uses the same rule. "Cards expiring" on both
  Homes is `payment_method_expiring` + `renewing`, counted from the list. Dev: 2,921 renewing (= 2,981
  paying − 60 ending at term), 94 cannot be charged, all of them renewing.
- **2026-09-28** — `paying[is]=true|false`: an active or non-renewing, non-deleted subscription earning MRR
  (> 0) — the Paying customers figure's own population (dev: 2,981, equal to the tile). `renewing` narrows it
  to the ones that will be charged again.
- **2026-09-30** — API params, all optional (absent = unchanged): promotional credits take `credit_type` (general | referral_rewards | loyalty_credits) + `reference`, stored per movement in `promotional_credit_movements` (0312, annotation only — money stays in the ledger); `GET …/promotional_credits` (+ `/:id`) lists every bucket movement from the ledger with a derived `closing_balance_minor`, filterable by type/credit_type/currency/created_at. `record_excess_payment` takes flat `date`, `method`, `reference` (any of them) and then also writes an `offline_<method>` payment transaction (date backdates `occurred_at`, never future). `collect_payment` takes `invoice_allocations[]` (per-invoice ceilings, in the given order). Create takes a caller-chosen `id` (unique per business, 409 on reuse).
- **2026-10-05** — GET (detail) emits `lifetime_revenue[]` (`collectedRevenue`, payments module): cash collected net of refunds per currency, `paid_invoices_count`, `first_paid_at`.
- **2026-10-08 (0332)** — `createCustomer` / `updateCustomer` check `metadata` against the business's metadata rules (`modules/metadata-rules`) on the same transaction; `metadataRules` sets the scope per caller (importer and sample data `off`, checkout and HubSpot `supplied_only`).
- **2026-10-11** — `collectPayment`'s credit-first draw (`collect.ts`) allocates its refundable draw to the funding credit notes (`allocateRefundableDraw`), as every other draw site does. It drew the ledger bucket only, so the note kept `refund_due` and its full available while its money was already spent on the invoice — prod CN-3212 (₹5,640.18) offered a refund for credit INV-100245 had used. Gate: `verify:collect-credit-first` "note" case (fails without the fix).
- **2026-10-21** — Customer list total capped at 10,000 (`total=exact` opts in); search resolves trigram matches first (`customers_search_trgm_idx`, 0348) and plans per term. `loadCustomerSnapshot` reads payment roles under a savepoint of its transaction, not a second one: a nested transaction needs a second pool connection, and under load the pool deadlocked.
- **2026-10-25** — `clearPersonalData` also deletes the customer's API request log rows
  (`deleteCustomerRequestLogs`, same transaction); the audit row records `request_logs_erased`.
- **2026-11-01** — VIES is the default on Cloud: `TAX_ID_VALIDATOR` unset resolves to `vies` when
  `TMBILLING_EDITION=cloud`, `noop` otherwise (`taxIdValidatorChoice`). An explicit setting still wins.
- **2026-11-01 (0464, Tier 3 PR 2)** — `credit_settings` (policy override with `override_expires_at`, overdraft limit per currency) on create, update (needs `credits:manage` too) and the customer object. `applyCreditOnFile` activates pending credit grants when it pays an invoice.
- **2026-11-02** — `createCustomer` refuses past a test business's customer limit (`tenancy/test-limits.ts`, 400 `test_business_limit_reached`). Live businesses are not limited.
- **2026-11-02 (0481)** — `POST /customers` without `auto_collection` uses `billing_rules_config.new_customer_auto_collection` (default `on`). `createCustomer` itself is unchanged, so checkout, import and HubSpot customers stay `on`. Gate: `verify:settings-billing-rules`.
- **2026-11-03 (0489)** — `customers.tax_behavior` (`inclusive` | `exclusive` | null) on create, update (null
  clears) and the object. Set, every taxed line on the customer's invoices and estimates is that price type.
  Dashboard: customer form → Tax → Price type. Gate: `verify:tax-settings` B, E5–E6.
- **2026-11-05** — Customer filters `credit_balance`, `credit_runway_days` (balance ÷ last-7-day average use; null with no use), `next_credit_expiry_at`, `last_credit_purchase_at`. Segment starters "Low credit balance" (runway < 7) and "Credits expiring soon" (in next 30 days).
- **2026-11-05** — Customer filters `last_usage_at` and `days_since_last_usage` (from `usage_rollups`); segment starter "Usage stopped" (≥ 30 days). The segments `usage` refusal now points at them.
- **2026-11-05** — Customer filters `order_count`, `first_order_at`, `last_order_at`, `days_since_last_order` (`isOrder`). Starters "Repeat buyers", "One-time buyers", "No order in 90 days".
