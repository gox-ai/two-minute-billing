# tax — component vector + place-of-supply resolution

> Source: `src/modules/tax/` · Routes: `src/api/tax-routes.ts` · Schema: `db/schema/tax.ts`
> Layer: catalog (see docs/architecture/architecture.json)

## Purpose
Determines and computes tax from a manual, per-business configuration. Tax is a **component
vector** resolved by **place of supply**, not a single rate — the minimum shape India GST needs
(CGST + SGST/UTGST intra-state, IGST inter-state, optional Cess on both). A pluggable
`TaxProvider` interface leaves room for automated tax (Stripe Tax / Avalara) later; today the
configured regions are the provider.

## Responsibilities
- CRUD for tax profiles, regions, rate components and per-state seller registrations.
- **Determine** which components apply to a supply (regime · seller state vs place of supply ·
  customer treatment · exemption), and say WHY when the answer is zero.
- Compute per-line, per-component tax for an invoice — exemptions, tax-inclusive pricing,
  discounts and withholding aware — allocating so the rows reconcile exactly.
- Resolve the active tax provider.

## Data model
`db/schema/tax.ts` — four config tables plus the per-line breakdown:

| table | holds |
|---|---|
| `tax_profiles` | the rates for one CLASS of product; `is_default` is what products fall back to (`products.tax_profile_id`). One default per business, enforced by a partial unique index. |
| `tax_regions` | one country under one profile: `regime`, `price_type`, `home_state_code` (the SELLER's state), the seller's registration, reverse-charge config, and the SEZ/export gates + notes. |
| `tax_rate_components` | the vector. `applies_to` ∈ `intra` \| `inter` \| `both`; `state_code` null = region default, set = that state's override. Rates in **basis points**. |
| `tax_state_registrations` | the seller's registration per state (India: one GSTIN per state). Separate from a rate override — a state may have one without the other. |
| `applied_taxes` | one row **per component per invoice line**, with `name`/`rate_bps` snapshotted and a `taxability_reason`. |

Customer-side inputs live on the customer (`tax_exempt`, `tax_treatment`,
`tax_registration_number`, `state_code`, `country`); the price still carries `is_taxable` and
`tax_behavior`.

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `TaxProvider.resolve` | the DETERMINATION → a `TaxResolution` (components + why + snapshot fields) |
| `computeInvoiceTax` | per-line, per-component tax for an invoice |
| `taxMinorFor` | total exclusive tax for a flat base (the estimate path) |
| `allocateTaxAcrossLines` / `splitByWeight` | largest-remainder allocation, exact by construction |
| `createTaxProfile` / `listTaxProfiles` / `ensureDefaultTaxProfile` | profile CRUD |
| `createTaxRegion` / `listTaxRegions` / `getTaxRegion` / `updateTaxRegion` / `setTaxRegionEnabled` | region CRUD |
| `setTaxRateComponents` | replace one state scope's vector (wholesale, not per row) |
| `upsertTaxStateRegistration` / `deleteTaxStateRegistration` | per-state registrations |
| `createFlatTaxRate` | fixture/seed helper: one flat `both` component for a country |
| `configureIndiaGst` | one call → a `gst` region with CGST/SGST/IGST (+ Cess) and the home-state GSTIN |
| `allowedTreatments` | which treatments a customer in this region may take (drives the customer form) |
| `getTaxProvider` | resolve the active tax provider (region table today) |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET`/`POST` `/v1/businesses/:biz/tax_profiles` | list / create profiles |
| `GET`/`POST` `/v1/businesses/:biz/tax_regions` | list (with components + registrations) / create |
| `GET`/`PATCH`/`DELETE` `/v1/businesses/:biz/tax_regions/:txg` | retrieve / edit settings / archive |
| `PUT` `/v1/businesses/:biz/tax_regions/:txg/components` | replace one state scope's vector |
| `PUT` `/v1/businesses/:biz/tax_regions/:txg/state_registrations` | upsert a state registration |
| `DELETE` `…/state_registrations/:txs` | delete a state registration |

## Events emitted
None.

## Dependencies
- **Upstream (calls into):** none.
- **Downstream (called by):** invoicing, subscriptions (estimates), transfer (config copy).

## The determination, in order
1. customer exempt → zero, `customer_exempt`
2. no country, or no enabled region → zero, `no_rate`
3. treatment `sez_zero_rated` / `export_zero_rated` → zero, `zero_rated` + the region's note
4. treatment `reverse_charge` → zero, `reverse_charge` + the note (only when `show_reverse_charge_note`)
5. treatment `sez_igst` / `export_igst` → force **inter**-state components
6. otherwise: a `gst` region is **intra** when seller state === place of supply, else **inter**;
   non-GST regimes take their `both` components

A per-state override vector (keyed on the **place of supply**) wins over the region default.

## Invariants & gotchas
- Tax is computed **per line, post-discount, pre-credit** in the invoice pipeline (see invoicing).
- **Components are pooled per (resolution, price type) and allocated by largest remainder**, so the
  per-line rows sum EXACTLY to the pooled figure. Summing independently-rounded per-line amounts
  would drift from the tax shown.
- **Inclusive tax is backed out of ONE combined rate**, then split among components by rate.
  Backing each component out separately overstates the total, because each component's gross
  already contains the others' tax (₹1180 at 9+9 → 180, not 194.86).
- `applies_to` is only honoured by a `gst` regime; `setTaxRateComponents` **refuses** to store
  intra/inter on a non-GST region rather than silently ignoring it.
- **IGST is derived as CGST + SGST** by `configureIndiaGst` and by the dashboard form — the law
  makes an inter-state supply attract the same total, so a separate input would only allow the two
  branches to disagree.
- The seller's state is **snapshotted onto every invoice** (`invoices.seller_state_code`). Never
  re-derive it from current config: a re-registration would restate historical tax.
- A treatment is honoured even if the region has since disabled it — write-time validation is what
  prevents the inconsistent state. Silently re-taxing a classified SEZ customer because a toggle
  flipped would change money without anyone asking.
- Place of supply compares **subdivision CODES** (`customers.state_code`), never the free-text
  `state` name the old scalar engine used.
- Automated tax adapters (Stripe Tax / Avalara) are deferred — the interface exists, no live adapter.
- **Not built** (deliberately — logged in PROGRESS): effective-dated rates ("Transitional
  Taxation"), bulk tax import, per-invoice tax display currency.

## Changelog
- **2026-11-03** — `deleteTaxStateRegistration` takes the region public id and deletes only when the registration belongs to that region. The route ignored `:txg` before.
- **2026-08-25** — `taxComponentLabel(name, rateBps)` exported: the single spelling of a tax component
  on a printed document, `IGST (18.00%)`. It existed as a template literal duplicated at the two
  invoice tax-line writers (`invoicing/service.ts`); the credit-note memo now needs the same string
  (`credit-notes/document.ts` names its derived tax after the credited invoice's components), and a
  customer holding an invoice and the credit note that reverses it must not see two spellings of one
  tax. Both invoice call sites now call it and emit a byte-identical string — no label changed.
  Two decimals ALWAYS: rates are basis points, so 2.25% and 18.5% occur, and trimming trailing zeros
  would print `IGST (18%)` beside `Cess (2.25%)` on one ladder. See the credit-notes README entry
  of the same date.
- **2026-08-24** — **Tax rounded DOWN where it must round to nearest.** BigInt division truncates,
  so `taxMinorFor`'s `(base × rateBps) / 10000n` floored every component: `10965 × 18% = 1973.7`
  became **1973** instead of **1974** — a systematic 1-minor-unit shortfall on every taxed
  invoice, in the merchant's favour and therefore wrong.
  Switched to half-up (`+ 5000n`) at all three sites that compute a component total —
  `taxMinorFor`, the exclusive branch of the per-line pass, and `invoicing/service.ts`'s
  `taxBaseForLines` — because they must agree or `applied_taxes` drifts from the invoice total.
  `allocateTaxAcrossSignedLines` needed no change: it takes the total as input and redistributes
  remainders to match it exactly. The INCLUSIVE branch (backing tax out of a gross via
  `base × r / (10000 + r)`) is deliberately untouched — it is a different formula and would need its
  own measurement. Half-up matches the convention already used in `catalog/pricing.ts` and the MRR
  maths. ⚠ The evidence is a single `.7` case, which any nearest-rounding satisfies; distinguishing
  half-up from half-even needs a case landing exactly on `.5`.
- **2026-08-23** — **New `allocateTaxAcrossSignedLines`** — the sibling of
  `allocateTaxAcrossLines` for an invoice that both charges and credits. The original drops
  non-positive lines on purpose (on a period invoice a negative row is a discount or a rounding
  delta, which classify no supply), but a PRORATION invoice's negative line is a real supply being
  reversed — "Unused time on …" — and owes NEGATIVE tax. Two meanings for a negative line, so two
  functions rather than a boolean the caller has to reason about; `allocateTaxAcrossLines` and its
  `computeInvoiceTax` caller are untouched.
  It also differs in BASIS: each line is taxed at its own `rateBps` and any drift is then swept onto
  the largest |remainder|, rather than each line taking a proportional slice of the header total.
  A tax invoice has to state what each line was taxed (`IGST @18 on 27,918.00 = 5,025.24`).
  Slicing the header instead inherits the header's own
  rounding loss and redistributes it: lines +8,732.90 / −7,277.42 at 18% come out 1,571.88 /
  −1,309.90 by slicing and 1,571.92 / −1,309.94 by rate. Both sum to 261.98; only the second is
  defensible on a document.
- **2026-08-06** — **State codes are a closed set.** `src/platform/subdivisions.ts` is the authority
  (India 36, US 56) and every write that stores a state validates against the region's own country:
  customer addresses, `home_state_code`, component `state_code`, state registrations. Some sources
  use non-ISO codes for four Indian states (`CG`/`OD`/`TS`/`UK` vs ISO `CT`/`OR`/`TG`/`UT`) and the
  importer copies them verbatim, so an alias map folds them on read and write — without it an
  imported Odisha customer never matched a locally-configured rate and was taxed at zero. Tax-region
  creation is scoped to **India and the US**, with the regime DERIVED from the country; other
  countries keep their existing flat regions. New gate: `verify:tax-subdivisions` keeps the
  dashboard's copy of the list identical to this one.
- **2026-08-05** — **Reworked from a single scalar rate into a component vector resolved by place
  of supply** (migrations `0146`, `0147`). Was: `tax_rates(country, state, rate_bps)`, one rate,
  matched on a free-text state name. Now: profiles → regions → components (+ state registrations),
  with intra/inter resolution, SEZ/export/reverse-charge treatments, per-state overrides and
  per-component `applied_taxes` rows. Invoices carry the determination snapshot
  (`seller_state_code`, `place_of_supply_code`, `tax_treatment`, `tax_note`) and one tax LINE ITEM
  per component. Gates: `verify:tax` (32), `verify:tax-matrix` (31),
  `verify:tax-lines`, `test/unit/tax-compute.test.ts` (25).
  - `0147` fixed a real bug in `0146`'s data carry-forward: it turned every legacy `tax_rates` row
    into its own component, and the new engine SUMS components — 59 duplicate `GB/VAT/1000bps` rows
    would have taxed GB at 590%. Deduped, and a unique index on
    `(region, coalesce(state_code,''), name)` now makes it unrepresentable.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).

- **2026-08-27** — **`taxLinesForBase` + `taxLinesFromRows`**: the tax ROWS a preview should print,
  labelled by the same `taxComponentLabel` the invoice uses — CGST + SGST intra-state, one IGST row
  inter-state, a single row elsewhere. Estimates carried `tax_minor` alone, so every buyer-facing
  preview rendered one row called "Tax" while the invoice it predicted itemised GST components: the
  buyer was quoted ₹6,531.12 and later sent CGST and SGST lines with nothing connecting them.
  * `taxLinesForBase` is exact by construction rather than by re-splitting a total — the per-component
    half-up rounding moved into one private `componentTaxMinor`, which `taxMinorFor` now also calls, so
    the rows and the total cannot drift (that rounding already cost a systematic 1-minor-unit shortfall
    once; see the note on `taxMinorFor`).
  * `taxLinesFromRows` groups a computed `InvoiceTax` by component and drops **inclusive** rows, which
    are already inside the line amounts and must never become a row of their own.

- **2026-08-29** — **`no_configured_rate` is `error`, and now carries an `event` key.** Of the
  three reasons a taxable line can resolve to zero tax, this is the one that costs the merchant
  money: the invoice went out with zero tax on a line that should have been taxed, and unlike
  the others it is already delivered and possibly paid. It was the only one of the four
  money-integrity findings with no `event` field, so nothing could have filtered for it even
  after the level change; it is now `tax_no_configured_rate` and pinned by `verify:logging`.
- **2026-10-09 (0334)** — `liveTaxRegimes` / `liveTaxRegimesTx`: regimes of each business's enabled regions under active profiles. Drives the address field locks (country required with any region, state with GST).
- **2026-11-01 (Tier 3 PR 2)** — `TaxableLine.preTaxCreditMinor`: credit grants drawn before tax lower that line's base, after the coupon share and before the promotional bucket's share (`promoMinor`). No credit on any line = the previous arithmetic exactly. New reason `prepaid_credit` (`prepaidCreditResolution`) zero-rates a money voucher taxed at use. Gate: `test/unit/credits-planner.test.ts` C8 cases.
- **2026-11-03 (0489)** — Tax settings (`settings.ts`, pure resolver over `businesses.tax_settings`; absent = today).
  `rounding`: `per_invoice_total` (today: each component rounded once on the pool base, then allocated) or
  `per_line` (each line rounded on its own share of the base via `perLineBases`, rows = the line figures,
  inclusive backed out per line). `taxMinorFor` / `taxLinesForBase` take the line amounts so an estimate
  rounds as the invoice does. `TaxResolution` gains `rounding` and `customerBehavior`; `TaxInput.customerTaxBehavior`
  carries `customers.tax_behavior`, and `lineIsInclusive` is the one precedence rule (customer, then a
  tax-inclusive region, then the price). `priceType` on the resolution, snapshotted onto the invoice, states the
  customer's override when set. Gates: `verify:tax-settings` (31), `test/unit/tax-settings.test.ts`.
- **2026-11-03 (0489, review)** — `seller_tax_ids` keys must be ISO countries; the VAT prefixes UK and EL
  are refused naming GB / GR (`VAT_PREFIX_ISO`), since `customers.country` never holds them.
- **2026-11-03 (0489, browser check)** — `inclusiveTaxMinorFor`: the tax inside a gross, backed out as
  `computeInvoiceTax` does (floored, combined rate; per line under per-line rounding), for estimates.
