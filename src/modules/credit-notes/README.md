# credit-notes — adjustment + refundable CNs, allocations

> Source: `src/modules/credit-notes/` · Routes: `src/api/credit-note-routes.ts` · Schema: `db/schema/credit-notes.ts`
> Layer: customer (see docs/architecture/architecture.json)

## Purpose
Issues and manages credit notes in two kinds: **adjustment** (reduces an *unpaid* invoice's balance)
and **refundable** (against a *paid* invoice → a customer refundable-credit balance that can be
allocated to invoices or refunded). Also the mechanism through which invoice write-off is routed.

## Responsibilities
- Issue adjustment CNs (allocate against open invoices; can zero → invoice `paid`).
- Issue refundable CNs (credit the refundable balance); refund (partial ok); auto-allocate at invoice
  generation; enforce `total = allocated + refunded + available`.
- Route write-off through an adjustment CN (reason `write_off`) → invoice paid + `written_off`.
- Void a credit note (compensating ledger entries), with guards.

## Data model
`db/schema/credit-notes.ts` — `credit_notes` (`kind` adjustment|refundable, `status`
adjusted|refund_due|refunded|voided, `reason_code`) + `credit_note_allocations` (cn_id, invoice_id,
amount_minor). Ledger accounts: `credit_adjustments`, refundable-credit balance, bad-debt (for write-off).

## Public surface (service entry points)
| Function | What it does |
|---|---|
| `issueAdjustmentCreditNote` | reduce an unpaid invoice's balance |
| `issueRefundableCreditNote` / `createRefundableCreditNote` | credit the refundable balance |
| `refundableCreditCeilingForInvoice` | the cumulative ceiling on an invoice's refundable notes (cash collected − Σ non-voided refundable totals) |
| `refundableCapacityForInvoice` / `creditableCapacityForInvoice` / `remainingCreditableAgainstInvoice` | the three capacity questions — payout, credit, documented invariant |
| `refundCreditNote` / `sweepOutstandingCnPayouts` | refund (partial) + payout sweep |
| `allocateRefundableDraw` | allocate refundable credit to invoices |
| `refundInvoiceViaCreditNote` | refund path via CN |
| `voidCreditNote` | reverse with compensating entries (guarded) |
| `creditNoteAvailable` / `listCreditNotes` / `listCreditNotesByBusiness` | read |

## API routes
| Method · Path | Purpose |
|---|---|
| `GET /v1/businesses/:biz/credit_notes` | list (detail/refund/void wired via subscription/invoice + this module; no single-GET route — a known gap) |

## Events emitted
`credit_note.created/allocated/refunded/voided`, `invoice.written_off`, `customer.credits_restored`.

## Dependencies
- **Upstream (calls into):** customers, events, invoicing, ledger, refunds, webhooks.
- **Downstream (called by):** invoicing, subscriptions.

## Invariants & gotchas
- **Adjustment** requires an OPEN invoice (`posted/payment_due/not_paid`), capped at amount_due —
  more precisely at `owed` (amount_due net of cash), because value past `owed` is the customer's own
  cash and cash comes back as a REFUNDABLE note.
- **Refundable** requires a `paid` / partially-paid invoice and is capped TWICE, whichever is tighter:
  - `refundableCapacityForInvoice` — the PAYOUT question, "is this money still a claim on cash?" It
    nets out what a note has since had ALLOCATED or REFUNDED. The payout path depends on it.
  - `refundableCreditCeilingForInvoice` — the CREDIT question, cumulative and NOT netted: the cash
    collected less every non-voided refundable note at its FULL total.
  Only the first existed until 2026-09-01, and on its own it re-opened the ceiling: allocate a
  full-value note onto a later invoice and its outstanding claim falls to 0, so the source invoice
  reports its whole cash as available again and a second full-value note is accepted. Pinned by
  `scripts/probe-cn-writer-ceiling.ts`.
- **⚠ The bound is the PAID amount, not the invoice total — stricter than the schema comment used to
  say.** On a 7.00 invoice with 3.50 collected a 7.00 refundable note is refused (*"total : It should
  not be more than USD 3.50"*) and a 3.50 one accepted; a second full-value note is refused both
  BEFORE and AFTER the first is allocated (*"the creditable amount is USD 0.00"*). ADJUSTMENT notes
  are bounded separately, by the debt: a 3.50 adjustment and then a 3.50 refundable are both fine on
  that same invoice — cumulative 7.00 from two notes with two different bounds. The two bounds are disjoint (debt + cash = total), so
  "cumulative ≤ invoice total" still holds; it is just no longer the binding rule.
- Invariant `total = allocated + refunded + available` is enforced; void is forbidden if credits are
  already spent/refunded beyond available.
- No single-GET CN route yet (detail resolves via filtered list) — backlog item.
- **Note tax** (`note-tax.ts`): a note whose every item names an invoice line reverses each
  line's own tax (amounts read as tax-inclusive); any amount-only item puts the whole note on
  the invoice's average rate. The note that fully credits the taxed gross reverses all
  remaining tax.
- **Per-line cap** (`line-cap.ts`): items that name a line cannot, with every non-voided note's
  items on that line, pass the line's tax-inclusive value (amount − discount, + tax when added;
  a tax line is its own amount). Checked under `lockInvoiceCredit` in both writers; skipped for
  `taxAtInvoiceRate` (pre-tax items spread by the engine). Exclusive tax sits in its supply
  line AND on the tax line, so both draw on one pool: a tax line takes only the tax not yet
  reversed through supply lines, and tax-line credits come off each exclusive supply line pro
  rata to its tax. The note being written counts, so both in one note are netted too.

## Changelog

- **2026-11-03** — A payout refund the gateway accepted but has not settled counts as paid out
  (`succeededRefundTotal` reads `pending` too, and `gatewayRefundableForInvoice` no longer offers
  that money again). The earmark of a pending refund was reversed, so a refund that later landed
  paid the customer twice. A failed one is given back by `releaseFailedCnPayoutTx` from `reverseRefund`
  (gateway-confirmed failures only). `refundableCapacityForInvoice` counts pending refunds too. A
  refund only not found sets `refunds.not_found_state = open` and adds to `payout_unconfirmed_minor`
  (0491). `resolveUnconfirmedRefundTx` settles one refund once (claimed on its state): `mark_paid`
  (refund and transaction `succeeded`, cash out booked), `return_as_credit`, or `late_paid` (a gateway
  success after a return as credit: booked and added to `payout_duplicated_minor`, credit kept).
  `POST …/resolve_payout` applies the operator's answer to every open refund of the note. States:
  open → paid | credited (person) | gateway_failed (gateway); a later success → credited_then_paid
  (`payout_duplicated_minor`) or gateway_failed_then_paid (`payout_out_of_order_minor`); a bounce
  after either reverses the cash posting and lowers the flag.
- **2026-11-03** — `refundCreditNote({ gatewayOnly })` and `gatewayRefundableForInvoice(…, { gatewayOnly })`
  leave out offline payments; `refundableNowMinor` is what one gateway-only call can refund (0 =
  keep as credit). Used by `downgrade_credit: refund`; every other caller is unchanged.
* **2026-11-03** — **A credit-note item naming a line of another invoice is refused (400).** `resolveCreditedLines` used to skip it, and `assertLineCaps` cannot cap a line it cannot find, so the item was bounded only by the invoice total.
* **2026-11-02** — The document prints the exchange rate it inherited from its invoice when the
  business shows exchange rates (0482, `printedExchangeRate`).
* **2026-10-24** — **A credit-note item cannot credit more than its line has left.** An item
  naming `invoice_line_item` was checked only against the invoice ceilings, so a note could put
  the whole invoice on one line. `assertLineCaps` now refuses it with a 400 naming the line,
  in both `issueAdjustmentCreditNote` and `createRefundableCreditNote`, under the invoice lock
  (two concurrent 7000 notes on a 12000 line: one passes). Invoice detail lines expose
  `creditable_minor`; the dashboard form posts line ids, shows each line's maximum and blocks
  over-entry. Gate: `verify:credit-notes` (17 new checks, 15 fail on the old code; the six tax-pool checks also fail without the netting).

* **2026-10-24** — **Note tax follows the credited lines, and a full credit leaves no tax.**
  Both writers took `total × bookedTax / taxedGross`, the invoice's average rate, so on a
  mixed-rate invoice a note for an untaxed line reversed tax that line never carried (17000
  invoice, 2000 tax on one line: crediting the untaxed 5000 reversed 588). And because every
  note rounds on its own, a fully credited invoice could keep tax booked (1000 incl. 153 tax in
  four notes of 250 reversed 152). Now one helper, `noteTaxShare` + the pure `note-tax.ts`:
  * **Line rule** when EVERY item names a line of the invoice: the amount is read as
    tax-inclusive and each line backs its tax out of its own combined rate
    (`amount × R / (10000 + R)`, half up, once per line, capped at the line's booked tax); a
    `kind = 'tax'` line is all tax. One rounding per line, not per component: the ledger books
    one `tax_payable`, and the memo still splits note tax by the invoice's component weights.
  * **Invoice rule**, unchanged, for any note with an amount-only item.
  * **Last note settles**: the note that brings Σ non-voided note totals up to the taxed gross
    reverses all remaining tax (capped at its own total). This also clears legacy residue on
    invoices partly credited before this change.
  * `proration.ts`'s `creditOneInvoice` passes `taxAtInvoiceRate`: its linked items are PRE-tax
    with the tax on a separate item, so it stays on the invoice rule it round-trips with.
  Not a backfill: notes already issued keep their postings. Gates: `verify:credit-notes`
  (10 new checks, 5 fail on the old code), `test/unit/credit-note-tax.test.ts`.
* **2026-10-13** — **Voiding an imported note.** `voidCreditNote` mirrored only `credit_note`
  postings, but an import opens a note's credit under `import` — so a void left the refundable
  balance in place, and a note that opened no credit was refused because the check compared the
  bucket with the note's TOTAL. It now mirrors both source types and checks the bucket against what
  the note actually contributed. Regression: `verify:migration-history`.
* **2026-10-07** — `invoice_number` on every credit note (list, detail, webhook snapshot): the credited invoice's human-readable number, alongside `invoice`. Null on invoices that never got one.

* **2026-10-03** — A credit note now names the same seller as the invoice it credits: with `invoice_issuer = organization` the organization's legal name, address and tax id head the note (business keeps logo and contact), with the same empty-entity fallback. Shared via `resolveDocumentIssuer` + `documentSeller` in `invoicing/document.ts`; the invoice stores no issuer, so both follow the current setting. Covers the PDF route and the emailed attachment. Gate: `verify:invoice-pdf`.

* **2026-09-30** — `subscription` filter (the credited invoice's `sub_…`, a scalar subquery) + the shared list grammar (`list-query.ts`/`parseListQuery`): set/range values also take a JSON array, date operators take unix seconds (an exact instant for before/after/on_or_*/between bounds; `on=<unix>` is the business-zone day holding it), `offset`/`next_offset` alias `starting_after`/`next_cursor`, and `include_deleted` is accepted (a no-op: notes are never deleted). No `updated_at` column exists, so it is not filterable.

* **2026-09-15** — `customer_credits_restored` and `refund_failed` now name their own
  resource. Both used a raw `data:` literal whose key did not match `resourceTypeOf(type)`,
  so `deriveResourceId` found nothing and `buildEventContent` returned before its switch —
  the events shipped with no customer, no invoice and no subscription. `refund_failed`
  carries an `invoice` ref rather than leaning on its own id, because the minted `re_…`
  names a refund that never existed. Flat keys unchanged; the resource key is ADDED.

- **2026-09-08** — **The credit note is customizable too, and it came almost free.** Because
  `CreditNoteDocument` IS `InvoiceDocument` and both go through `renderInvoicePdf`, the 0239
  customization column (`businesses.invoice_customization`, resolver in
  `modules/invoicing/customization.ts`) reaches this document by wiring the resolved values into
  `assembleCreditNoteDocument` — no renderer change, no second settings surface. What a merchant
  can now set: the title (`CREDIT NOTE` / `REFUND`), the status chip, the service period, the
  credited invoice's date, a business-wide note, and the number FORMAT (dynamic prefix +
  separators + increment; `nextCreditNoteNumber` mirrors `nextInvoiceNumber` exactly).
  * **Where it maps DIFFERENTLY from the invoice, and why.** "Service period" gates the per-line
    `period` here rather than a subscription band — a credit note has `subscription: null`, so
    the period it shows is the one on each credited line. "Invoice date" is the date of the
    invoice being credited (`meta.relatedInvoiceDate`, a new field), not this note's own date,
    which is `issuedDate`.
  * **The business note is ADDITIVE, not a replacement.** `meta.notes` was `cn.reason`; it is now
    `reason` then the business note, separated by a blank line. They answer different questions —
    why THIS note exists versus standing text for every one. A merchant setting one does not lose
    the other.
  * Custom fields and payment instructions are deliberately EMPTY here: both live on the Invoices
    tab with no credit-note counterpart, so borrowing the invoice's setting would be a control the
    merchant never saw. Payment instructions would also be wrong on the document —
    the money is going the other way.

- **2026-09-04** — 🔴 **Voiding an invoice released its credit in the LEDGER and left the credit
  note claiming it was spent (#57), which REFUSED to refund the customer their own money.**
  `voidInvoice` posts a flawless compensating entry (`invoice_void` mirroring `credit_applied`, so
  the bucket gets the money back) and left every denormalised satellite behind: the
  `credit_note_allocations` row still pointed at the voided invoice, `allocated_minor` still read
  the whole draw, and the status had been flipped `refund_due` → **`refunded`** with
  `refunded_minor` and `paid_out_minor` both 0 — a status that was simply false.
  * **The money it blocked:** `creditNoteAvailable` is `total − allocated − refunded`, so it read
    **0** while the ledger said ₹9,661.13 was spendable. Both refund paths gate on that figure and
    the LEDGER read sits on the very next line: a full refund died on *"Refund amount must be
    positive"*, an explicit one on *"exceeds available 0"*.
  * **And the funding record diverged, measured not predicted:** `allocateRefundableDraw` skips a
    note whose `avail <= 0`, so the customer's next invoice applied ₹9,661.13 of credit
    (ledger-driven) while recording **no allocation row** (note-driven).
  * `releaseAllocationsForVoidedInvoice` now runs in the void's own transaction: it DELETES the
    rows, decrements `allocated_minor` by exactly what it summed from them, and reverses the
    allocation loop's own status rule (`refunded` → `refund_due` when the note is no longer fully
    consumed; a `voided` note stays voided, a cleared payout keeps `refunded`).
  * **Delete, not a negative reversal row.** The compensating-entry style belongs to the LEDGER,
    which is append-only by locked decision; `credit_note_allocations` is a satellite with no such
    contract, and the house style for those is to rewrite them (`invoicing/service.ts` deletes
    `applied_taxes` + `invoice_line_items` on re-derivation; `reverseCnRefundEarmark` decrements
    `refunded_minor`). A negative row has nowhere to say it is a reversal — no `kind` column — so it
    would serialise as `{"object":"credit_note_allocation","amount_minor":-966113}` and render as
    *"Allocated −₹9,661.13 was allocated to invoice …"*: a surface that lies, for an API + openapi +
    dashboard change far larger than the defect. The release stays auditable in the ledger
    (`credit_applied` + `invoice_void`, both stamped with the invoice's public id) and in the
    `invoice.void` audit row, whose `after` now carries `credit_released_minor`.
  * **Only REFUNDABLE notes are released**, and that is the same principle: an adjustment note books
    `credit_adjustments`/`bad_debt` → AR, which `voidInvoice` does NOT mirror, so its credit was
    never given back and freeing it would invent availability on a note whose money lives in no
    bucket. 41 of the 42 live allocation rows pointing at a voided invoice are that shape.
  * `verify:apply-credits` §9 (13 checks). **9G is the load-bearing one** — the note's available must
    equal the LEDGER's balance — because `total = allocated + refunded + available` HELD throughout
    the live defect (966113 = 966113 + 0 + 0), so only a cross-check against the ledger can catch
    this class. Mutation-tested: skipping the delete kills 9A + the reconcile check, skipping the
    counter decrement kills 8 checks including the refund, skipping the status restore kills 9D,
    dropping the `kind` filter kills 9M (and hands an adjustment note `available=5000`).

- **2026-09-02** — **A credit note INHERITS its invoice's exchange rate (0228)** rather than
  resolving a fresh one: a reversal converted at today's rate would not net to zero against the
  document it reverses, which is the one thing it has to do in a converted book. `invoice_id` is
  NOT NULL, so there is always a rate to inherit — including its absence. Found while proving it:
  the CREATE receipt is hand-built rather than run through `serializeCreditNote`, so the row
  inherited correctly and the 201 reported nothing; every field the schema promises has to be added
  to that payload separately, or it becomes one that appears on some responses and not others.

- **2026-09-01** — **The cumulative credit ceiling is now enforced at the WRITERS, and it is
  stricter than the one our schema documented.** `db/schema/credit-notes.ts` claimed
  *"cumulative credit notes can never exceed the invoice total (enforced in the service)"*. It was
  enforced at four READERS (`creditAcrossInvoices`, `termInvoiceCanAbsorb`, two sites in
  `estimate.ts`) and at neither writer. `issueRefundableCreditNote` capped only at
  `refundableCapacityForInvoice`, which deliberately subtracts a note's OUTSTANDING claim
  (`total − allocated − refunded`) — correct for the payout question it exists for, wrong as the
  only cap on the credit question.
  * **Measured** (`scripts/probe-cn-writer-ceiling.ts`, all writes through public service
    functions): INV-1 billed and paid 10,000 in cash; CN-1 refundable for 10,000 (a second note
    attempted THERE is correctly refused, *"exceeds refundable paid amount 0"*); CN-1 then allocated
    onto INV-2 by ordinary invoice generation; capacity reads 10,000 again and CN-2 for another
    10,000 is ACCEPTED. INV-1 ends carrying **20,000 of non-voided credit on a 10,000 invoice**, CN-2
    sitting `refund_due` — 10,000 collected produced 10,000 of free supply plus 10,000 of open cash
    liability. Reachable from `POST /v1/businesses/:biz/credit_notes` behind only
    `authenticate` + `requirePerm("manager")` + `idempotency`.
  * **Three questions settle the rule.** (Q1) The cap is CUMULATIVE, not netted: a second
    full-value note is refused both before and after allocation. (Q2) The basis is the PAID amount,
    not the invoice total: 7.00 invoice, 3.50 collected, *"total : It should not be more than USD
    3.50"*. (Q3) ADJUSTMENT notes do not consume it: a 3.50 adjustment and then a 3.50 refundable
    are both accepted on that invoice. This makes us **stricter than our own schema docblock**,
    which has been corrected rather than left asserting the looser rule.
  * New `refundableCreditCeilingForInvoice(tx, invoiceId, paidMinor)` = cash collected − Σ
    non-voided **refundable** note totals. `kind === "refundable"` because of Q3, and therefore NOT
    `creditableCapacityForInvoice`, which subtracts every non-voided note and would have refused
    the Q3 shape. No `gatewayRefunded` term: cash handed back through a note is already in that
    note's total, and a refund taken directly against the payment is what
    `refundableCapacityForInvoice` subtracts — two caps, each subtracting the thing it owns.
    `paidMinor` is PASSED IN from `refundableCapacityForInvoice` rather than re-derived, because a
    second definition of "paid" is how this class of bug started.
  * Both writers assert inside the `lockInvoiceCredit` they already take, so the check is serialised
    with the INSERT rather than read outside it. The four reader clamps become an optimisation
    instead of the enforcement. `issueAdjustmentCreditNote` keeps `owed` as its real bound (Q3)
    and gains `remainingCreditableAgainstInvoice` as a backstop that should never bind —
    there so the documented invariant is enforced rather than inferred from two other rules holding,
    which is precisely what was true of the refundable writer and was wrong.
  * `refundableCapacityForInvoice` is **untouched** — the change is purely additive (two guards and
    one new function; no existing line edited), so the payout path is byte-identical.
  * Idempotent replay cannot double-count: `platform/idempotency.ts` replays a finished key's stored
    response from the preHandler (`case 'replay'`) and never re-enters the route, and an in-flight
    duplicate gets a 409. A retry therefore never re-executes the writer, so it can never see its own
    prior note consuming the ceiling.

- **2026-08-31 (later)** — **A credit-note item can now be told which period it credits, and a
  credit settle no longer claims a payment succeeded.** Two contract changes:
  * `CreditNoteItemInput` gains `periodStart` / `periodEnd`. They take precedence over the period
    inherited from the source invoice line, because the two differ on every mid-term credit: the
    line's window is what was BILLED, the item's is what came BACK. Omitted, behaviour is exactly as
    before (inherit, or NULL) — which stays right for a manual full-invoice waiver. Both writers
    (`issueAdjustmentCreditNote`, `createRefundableCreditNote`) apply the same rule; each half of the
    window falls back independently, since half a window is not the source line's window.
  * **`dunningFieldsOnCreditSettle`** (in `invoicing/status.ts`) replaces `dunningFieldsOnSettle` at
    the one site where an adjustment drives `amount_due` to zero. `success` was a lie there and had
    shipped as one: ten live invoices on `sub_XXXXXXXXXXXXXXXXXXXXXX01` read
    `status: paid, dunning_status: success` while their only payment attempt had **failed** — every
    one was zeroed by an adjustment note. The right answer for an invoice driven to zero by a full
    adjustment: `status: paid` and `paid_at` = the ADJUSTMENT's timestamp (so our `paid` was
    right), but `amount_paid` stays **0**, `next_retry_at` is dropped, and `dunning_status` becomes
    **`stopped`**. The chase ended; it did not succeed. Deliberately a second named function rather
    than a flag on the first — the cash and credit paths answer the same question differently, and a
    boolean is how a caller silently picks the wrong one.

- **2026-08-31** — **The pre-tax / post-tax application rule is settled, not merely inferred.**
  No code change; recording the rule, because the `D-cn-cap` denominator argument rests entirely on
  this premise and until now it was held up by measurement plus reasoning:
  - adjustment credits — applied AFTER tax; they do not reduce the recorded tax.
  - refundable credits — applied AFTER tax; they do not reduce the recorded tax.
  - promotional credits — applied BEFORE tax; they reduce the taxable amount.
  That is verbatim `db/schema/invoices.ts:85`, and it is what licenses
  `taxedGross = invoiceTotal − promotionalCreditsApplied` as the denominator in
  `createRefundableCreditNote`'s tax split — the fix that stopped stranding 103561 of `tax_payable`
  on a promo-funded invoice. It can now be relied on structurally rather than empirically.
  Two further rules, both already enforced here: adjustment notes apply only to an OPEN
  invoice (`service.ts:300`) and refundable notes only where a payment succeeded — payment due
  → adjust only, paid → refundable only; and on a PARTIALLY paid invoice both are available at once
  (adjust the due amount for the unpaid part, or credit against the paid part), which is the shape
  `creditOneInvoice`'s open branch books and `verify:proration` § E4 now gates.
- **2026-08-31 (later still)** — **Full-depth filters on the credit-notes list.** `LIST_FILTERS`
  went from 10 fields to 20: `reason`, `channel`, `imported`, `voided_at`, the three customer fields
  (`customer` / `customer_name` / `customer_email`) and the two money figures the list PRINTS but does
  not store — `subtotal_minor` (coalesced to `total_minor`, the pre-0186 convention) and
  `available_minor` (`total - allocated - refunded`). Both are filtered through the SAME expression
  the serializer reports, so `?subtotal_minor[gt]=0` cannot answer a question about a number no caller
  saw. `customer_name` uses `accountHolderNameSql`, never the deprecated `customers.name`. Sorts
  added: `number`, `kind`, `voided_at`, `refunded_minor`, `available_minor`. The count query picked up
  the page read's `customers` LEFT JOIN — a filter field the count cannot see is a 500, not a wrong
  total. Route now passes `CREDIT_NOTE_FILTER_KINDS` as `filterKinds`, so a malformed value is a 400
  naming the shape instead of a Postgres cast 500. **Not added, no column:** `updated_at` and a
  document `date` (`credit_notes` has only `created_at`).
- **2026-08-31 (later)** — **A credit note now says WHICH PERIOD it reversed.** Every credit-note
  item was written with `period_start`, `period_end` and `invoice_line_item_id` NULL — the three
  columns added for exactly this — so neither a customer reading the document nor a report could tell
  what period was credited. `CreditNoteItemInput.invoiceLineItemPublicId` and `resolveCreditedLines`
  had existed since 2026-08-01 and did the whole job already; the gap was upstream, in
  `creditAcrossInvoices` (`subscriptions/proration.ts`), which spells each note out from the source
  invoice's own lines and then dropped those lines' ids on the way. `InvoiceCreditPart.lines` now
  carries the `il_…` and both parts builders pass it. Eight lines of plumbing, no money logic touched.
  - **The TAX line stays without a period**, deliberately: "Tax reversal on credited time" reverses a
    proportional slice of the whole invoice rather than any one line, so it inherits nothing. Same for
    the item-specific path with no attribution, which credits the newest live invoice from a
    caller-supplied item list and has no source line to name.
  - **Why this matters**: the credited period can be spelled out in the line TEXT, or carried
    structurally. We keep our own wording and carry it structurally — which is only the better
    choice if it is actually carried, and it wasn't.
  - **Guarded in `verify:credit-notes`**, on the block that bills a term, forces a reset and then
    removes an add-on: every credited SUPPLY line must carry both the period and the line id.
    Mutation-tested — `withPeriod=0 withLineId=0` of 3 supply items against the old code, 3 of 3
    with the fix.
  - ⚠ **It could NOT be guarded in `verify-proration-matrix`**, where the sibling reset assertions
    live: that suite's `mkSub` raises no first invoice, so its term is never billed, so there is
    nothing to credit and no note is produced at all. A billed term is the precondition for having
    a credit note to inspect at all.
  - **Still NULL, and out of scope here: `credit_note_items.kind`.** Migration 0188 added the column
    and defined its vocabulary, but **no code writes it** — all four item writers
    (`issueAdjustmentCreditNote`, `createRefundableCreditNote`, the card-refund document, and the
    importer) omit it. That is a new behaviour to design (which value per line), not a pass-through,
    so it is left alone rather than smuggled in here.
- **2026-08-31** — **The credit-note LINE wording is settled.**
  - **Our `"Unused time on <label>"` stays**: it names the quantity and says which side of the
    proration the line is. The alternative — a `<item label> - Prorated Credits for <DD-Mon-YYYY> -
    <DD-Mon-YYYY>` suffix carrying the service period in the TEXT — is not how we write documents.
  - **What that settles** is the standing of our NULL `credit_note_items.period_start` /
    `period_end` / `invoice_line_item_id`. If the period is not in the line text it has to be in the
    columns that exist for it — and those were NULL on all 8,206 rows bar the 08-22→08-24 window, so
    a customer reading one of our credit notes could not tell what period was credited **by either
    route**. Previously filed as a pre-existing backlog item; this upgrades it to a documents gap.
- **2026-08-30** — **`credit_notes.status` is enforced by Postgres** (`0218`:
  `adjusted | refund_due | refunded | voided`), and the `refunded` chip now explains itself in the
  dashboard. Both came from reading a real subscription whose three credit notes sat at
  `status: refunded` with `allocated_minor = total_minor` and `refunded_minor = 0` — applied to an
  invoice, no cash returned.
  - **The status is correct.** A note goes `refund_due → refunded` on pure ALLOCATION with
    `amount_refunded: 0`, and partial allocation stays `refund_due` — exactly
    `allocateRefundableDraw`'s `fullyConsumed` gate. ⚠️ The importer cannot serve as evidence here:
    `migration/import.ts:2236` DERIVES status from `amount_available` instead of copying the
    source's `cn.status` (which the importer does carry through), so imported rows
    only prove we agree with ourselves. That circularity was nearly reported as proof.
  - So `refunded` means SETTLED, not "cash returned" — 2,201 of the 3,770 engine-created `refunded`
    notes in the local DB have `refunded_minor = 0`. Both chip components now carry a hover
    explanation (the LIST renders `StatusBadge`, the DETAIL renders `StatusChip`; the strings are
    asserted byte-identical), and `refunded`/`adjusted` are spelled out as neutral rather than
    falling through `patterns/chip.tsx`'s `?? "gray"` default.
  - Gates: `verify:credit-notes`, `verify:credit`, plus the invoicing suites listed in that module's
    entry for the shared migration.
- **2026-08-28** — `CreditNoteError` carries an optional `code: 'not_found'`, set only at the six
  credit-note lookup misses in `refundCreditNote`, `recordOfflineCnRefund` and `voidCreditNote`.
  `credit-note-routes.ts` maps that one code to 404 through a shared `creditNoteError` helper; every
  other `CreditNoteError` stays a 400 ("Only refundable credit notes can be refunded", "Credit note
  is voided", "Refund N exceeds available M", …). Same convention gap `verify:bola` measured on the
  payment refund: `/refund`, `/record_refund` and `/void` answered 400 for a foreign credit-note id
  where their siblings — including `GET …/credit_notes/{cn}` right next to them — answered 404. The
  OpenAPI spec already documented 404 on all three, so this is the implementation catching up.
  `No such invoice: …` deliberately stays a 400: on `POST …/credit_notes` the invoice arrives in the
  BODY, so it is a bad field, not a missing addressed resource.
- **2026-08-25** — **An adjustment credit past the invoice's taxed base now FREES promotional credit,
  and the cancellation credit is prorated off the same basis as the change credit** (D-cn-cap, the two
  gaps b4dc962 recorded). One cause, two symptoms: an adjustment reduces amount DUE and returns nothing
  to the promotional bucket, so the promo goes on funding the RETAINED supply and every credited unit
  comes off the TAXED slice — true, but only while the credit fits inside the taxed base.
  Both probes build the same unpaid IGST-18% term: supply 2791800, promo 1000000 applied PRE-tax ⇒
  taxable base 1791800, tax 322524, total 3114324, **unpaid**, due 2114324.
  - **Past the taxed base there is no retained supply left for the promo to fund**
    (`scripts/probe-adjust-over-taxed-base.ts`). A day-2 downgrade credits 2701742 of supply against a
    1791800 base; the note's tax line caps at 322524, the note totals 3024266 > the 2114324 due, and
    the overflow fell into `creditOneInvoice`'s excess branch → `issueRefundableCreditNote` → *"Refundable
    credit notes require a paid invoice (no succeeded payment to refund)"*. **The whole subscription
    change was refused.** The overflow is not cash and never was: it is `discountedTotal − taxedBase` =
    909942 of supply the PROMOTIONAL CREDIT paid for, and the customer keeps only 90058 of supply, which
    the promo covers on its own. So it goes BACK TO THE BUCKET. After: change applies, invoice due **0**,
    `tax_payable` standing **0**, **909942** posted to `promotional_credit_balance`, one note reading
    gross 3024266 / `promotional_credits` discount 909942 / total 2114324.
  - **The cancellation credit was prorated off the GROSS** (`scripts/probe-cancel-unpaid-promo-basis.ts`).
    The gross contains the untaxed promo slice, so a mid-term cancel credited 15/31 × 3114324 = 1506931
    and left **607393** due where the retained 1440929 of supply owes 440929 of base + 79367 of tax =
    **520296** — 87097 short, exactly `rate × promo × unused/term`, the same residual the CHANGE path
    shed a commit earlier. An open invoice now prorates the SUPPLY and grosses it up at the STATUTORY
    `bookedTax / (netBase − promo)`, the identical basis `creditOneInvoice` uses, which is what makes a
    cancel and a change land on the SAME figure for the same unused time. After: credit **1594028**, due
    **520296**, `tax_payable` 63157→**79367** = 18% of the retained base. Cancelling on day 2 instead
    clamps at the due as before, but the 819884 the clamp used to swallow is now freed to the bucket.
  - **WHY THE BUCKET AND NOT A RESTATED INVOICE.** `promotional_credits_applied_minor` is deliberately
    NOT reduced. Reducing it would restate a finalized tax document — `total − promo` is what the API and
    the PDF print as `total_minor`, and under GST an invoice is corrected by a credit note, never by
    changing its own total. So the movement is booked through `restoreBucketFundedSlices`, the mechanism
    the PAID path already uses (one mechanism, not two), and DECLARED on the note as a
    `promotional_credits` discount row — gross `due + freed`, discounts `freed`, total
    `due`, so `total = sub_total − discounts + tax` still holds. `issueAdjustmentCreditNote` grew the
    same optional `subtotalMinor` + `discounts` `createRefundableCreditNote` has carried since 0186;
    omit them and it behaves byte-identically. Declaring the row is also load-bearing, not decorative:
    it is what `planCancellationCredit`'s `alreadyReturned` reads to see the time was already handed
    back, so leaving it off would let one term be credited twice.
  - **Not a promo special case.** Every new branch is gated on `promotionalCreditsAppliedMinor > 0` on an
    OPEN invoice; with promo = 0 the overflow is zero and the two proration bases are the same fraction
    of the same money, so the cash path (`excess → refundable CN`) and `prorate(inv.totalMinor)` are
    reached unchanged and no fixture moved. Where an open invoice IS part-paid in cash, only the
    non-cash remainder is routed to the bucket — the cash slice still becomes a refundable CN, and it is
    now strictly smaller than what used to be sent, so nothing that passed before can start failing.
  - **Still open**: voiding an adjustment note that freed promotional credit reopens the invoice's due
    but does not re-draw the freed slice from the bucket, so the customer holds both. Pre-existing and
    identical on the PAID path — `voidCreditNote` reverses a note's own postings and never the
    `*_credit_restore` entry beside it — so it is one fix for both, tracked with D1.
  - Gates: `pnpm test` 490/490; root `tsc --noEmit` clean; `verify:credit-notes|credit|proration|
    proration-matrix|invoices-v2|subscriptions-v2|estimates|tax|refund|offline-refund|audit|
    change-atomicity|update-for-items|subscription-ops` all PASS. Every `scripts/probe-*.ts` keeps its
    verdict: `probe-adjust-unpaid-promo-tax` RESIDUAL 0, `probe-change-promo-tax-retention` ends
    with `tax_payable` 0, `probe-cancel-after-change-credit` (invoice #1 left alone),
    `probe-cancel-multi-invoice` shortfall ₹0.00, `probe-change-credit-funded`,
    `probe-change-refundable-funded`, `probe-remove-item-unbilled-orphan`, `probe-lifecycle`,
    `probe-change-line-dayalign`, `probe-trial-change`. No fixture edited. (`verify:invariants` fails
    ~5 runs in 6 on `invoice_not_overpaid: the sample names the offending row` — its `scan()` samples
    `limit 20` with no ORDER BY against leaked fixture rows — identically before and after this change.)
- **2026-08-25** — **A credit note printed a flat "Tax" where the invoice it reverses names the
  component.** Our own invoice already reads `IGST (18.00%)` (`invoice-pdf.ts` prints `tx.label` per
  tax line), so the credit note was the only document in the product that would not say WHICH tax it
  reversed — and a GST credit
  note that cannot name its components is not a usable GST document.
  - **Where the names came from.** A credit note stores no tax column and no component names, but it
    always references an invoice, and that invoice's `applied_taxes` snapshotted the `name` and
    `rate_bps` of every component it charged. `creditedTaxComponents` (document.ts) groups those rows
    back up per `(name, rate_bps)`. `applied_taxes` rather than the invoice's synthetic `kind:'tax'`
    LINE ITEMS, which already carry the composed label: those exist for EXCLUSIVE tax only, so an
    inclusive-priced business would have got nothing.
  - **Signed sum, then drop non-positives.** Rows are summed WITH their sign before the filter,
    because a proration invoice's negative line carries negative tax — on INV-4 a component's rows are
    +1,571.92 and −1,309.94 and its real weight is the 261.98 they net to. The filter then removes a
    component that charged nothing (a zero-rated/exempt row, written only to record the REASON).
  - **The split.** The note usually credits only PART of its invoice, so the derived total is re-cut
    across the components in the proportion the invoice booked them, with `splitByWeight` — the same
    largest-remainder helper `computeInvoiceTax` uses to divide an inclusive pool between components.
    No second rounding convention: 322525 over two equal weights comes out 161263 / 161262, Σ exact.
  - **Order** is the resolver's own (`tax_rate_components.sort_order`, ties by name), read back through
    the snapshotted `tax_component_id`. `applied_taxes.created_at` is the transaction clock (every row
    of an invoice shares it) and the ids are random, so neither orders anything; a component archived
    since the invoice issued (`SET NULL`) sorts last by name, still deterministic.
  - **Wording.** We keep `IGST (18.00%)`, and the single
    spelling now lives in `taxComponentLabel` (`tax/service.ts`) which BOTH invoice writers and this
    file call, so the two documents cannot drift. Reasons: (1) a customer holding an invoice and the
    credit note reversing it must not see two spellings of one tax, and the invoice's form is the one
    already printed on live documents; (2) rates are basis points, so 2.25% and 18.5% occur, and a
    format that trims trailing zeros would print `IGST (18%)` beside `Cess (2.25%)` on one ladder.
    The invoice's label was NOT changed — the two call sites now produce a byte-identical string.
  - **Fallback**, detected as `creditedTaxComponents` returning EMPTY — no `applied_taxes` rows on the
    credited invoice at all (a row predating per-line tax, or an untaxed business), or none of them
    charged anything: one unnamed "Tax" row, exactly what this file printed before. A NEGATIVE derived
    total falls back too, because `splitByWeight` returns zeros for a non-positive total and would
    silently drop money off the ladder.
  - **API + page.** New detail-only `credit_note.taxes[]` (`object`, `description`, `amount_minor`),
    derived in `credit-note-routes.ts` by the SAME two exported functions the PDF uses
    (`creditNoteTaxTotal` + `creditNoteTaxLines`), so the memo, the REST read and the dashboard cannot
    name the tax three ways — that consistency was the whole point of 824f570. The credit-note detail
    page renders `taxes[]` row-per-component and keeps its own derivation only as the older-engine
    path. OpenAPI documented; `pnpm sdk:generate` re-run (additive: +7 lines in `schema.d.ts`).
  - **Rendered proof** (not asserted). Rebuilt `probe-change-promo-tax-retention`'s shape inside the
    dashboard's own org. PDF via `pdftotext -layout`: `Subtotal ₹27,918.00 / Promotional Credits
    -₹10,000.00 / IGST (18.00%) ₹3,225.24 / Total ₹21,143.24`, and the credited invoice's tax line
    item is the same string `IGST (18.00%)`. Intra-state (TN→TN) variant prints `CGST (9.00%)
    ₹1,612.62` + `SGST/UTGST (9.00%) ₹1,612.62`, Σ = 322524 exactly. Dashboard DOM measured over CDP
    on both notes shows the same rows at 14px. Deleting the credited invoice's `applied_taxes` row and
    re-rendering the SAME note gives a flat `Tax ₹3,225.24` in both the PDF and the DOM.
  - Gates: `pnpm test` 490/490; root `tsc` clean except two pre-existing errors in an untracked
    scratch file under `scripts/`; dashboard `tsc` clean; `verify:ui` five metrics at 0;
    `verify:credit-notes|invoices-v2|tax|tax-lines|india-invoice|invoicing-parity|proration` all PASS.
    No assertion moved, no fixture touched.
- **2026-08-25** — **An ADJUSTMENT CN reversed too little tax on an unpaid promo-funded invoice**
  (D-cn-cap, the last denominator gap). `issueAdjustmentCreditNote` was deliberately left on the GROSS
  denominator a day earlier because it **round-trips by construction** with the tax line
  `proration.ts`'s `creditOneInvoice` builds: that helper grosses a pre-tax credit `c` up at
  `bookedTax / netBase` and the note then divides by `netBase + bookedTax` (= the invoice total), so
  the ledger's `taxShare` recovers exactly the note's own `Tax reversal on credited time` item and
  `net = c`. The round-trip is real — the two denominators are the two halves of one identity — which
  is why the pair had to move **together**, and why changing one side alone would have made the
  document and the ledger disagree.
  What was wrong was the BASIS both halves used. An adjustment note reduces amount **DUE**, and it
  hands nothing back to the promotional bucket: `promotional_credits_applied_minor` is untouched, so
  the promo goes on funding the supply the customer KEEPS and every unit credited comes off the TAXED
  slice. Reversing at the blended `bookedTax / netBase` (11.5525% on the probe's invoice, where the
  statutory rate is 18%) therefore retained output tax on cancelled time. Measured
  (`scripts/probe-adjust-unpaid-promo-tax.ts`, kept as before/after evidence): supply 2791800, promo
  1000000 pre-tax ⇒ base 1791800, IGST 322524, total 3114324, **unpaid**, due 2114324; a mid-term
  downgrade credits 1440929 of supply → tax item 166464, `tax_payable` left standing **156060** where
  the retained base of 350871 owes only **63157** — a residual of **92903**, exactly
  `rate × promo × credited/supply`.
  Both halves now use the invoice's **taxable** basis for an open invoice:
  `creditOneInvoice` builds the tax line at `bookedTax / (netBase − promotional_credits_applied)` on
  the base actually released (capped at that base), and `issueAdjustmentCreditNote` divides by the
  **taxed gross** `total − promotional_credits_applied` — the same denominator
  `createRefundableCreditNote` took on 2026-08-24, reached from the other direction. The identity
  composes the same way, so the round-trip is preserved: open notes use
  `(netBase − promo, bookedTax, taxedGross)`, paid ones keep `(netBase, bookedTax, invoiceTotal)` for
  the funding split. After: tax item 259367 (= 18% of 1440929), ledger reversal 259367 (document and
  ledger agree), `tax_payable` **63157** = 18% of the retained 350871, and amount due 414028 =
  350871 + 63157. **Residual 0.**
  Not a promo special case — with promo = 0 the two bases are the same number, so every non-promo
  invoice (i.e. every existing fixture) books byte-identically; the `remainingTax` cap still bounds a
  note larger than the taxed slice. *(Two gaps were listed here as still open — an adjustment credit
  bigger than the taxed base overflowing into a refundable CN that throws on an invoice with no cash,
  and the cancellation-adjustment credit prorated off the invoice's GROSS while applied against the
  smaller DUE. **Both were CLOSED on 2026-08-25**; the entry above this one says how, and both probes
  are kept.)*
  Gates: `test` (490), `tsc`, `verify:credit-notes|credit|proration|proration-matrix|invoices-v2|
  subscriptions-v2|estimates|tax|refund|offline-refund|audit|change-atomicity` all pass; probes
  `probe-cancel-multi-invoice` (shortfall ₹0.00), `probe-change-credit-funded`,
  `probe-change-refundable-funded`, `probe-change-promo-tax-retention` (still ends with
  `tax_payable` 0) and `probe-remove-item-unbilled-orphan` all keep their verdicts.
- **2026-08-24** — **A refundable CN reversed too little tax on a promo-funded invoice** (D-cn-cap).
  `createRefundableCreditNote`'s tax split divided by the invoice's GROSS total, which is only right
  when every minor unit of the invoice bore tax. Promotional credit is applied PRE-tax (it shrinks the
  taxable base; refundable + excess are post-tax — `db/schema/invoices.ts`), so that denominator
  spread the tax across a slice that was never taxed and under-reversed it. Measured: subtotal
  2791800, promo 1000000 ⇒ base 1791800, IGST 322524, total 3114324, cash 2114324; a same-day
  full-term change issues a refundable CN of exactly the cash-funded slice, 2114324 (= 1791800 base +
  322524 tax), yet reversed only `322524 × 2114324/3114324 = 218963` and stranded **103561** on
  `tax_payable` — output-tax liability the business does not owe. The denominator is now the invoice's
  **taxed gross**, `total − promotional_credits_applied_minor` (= `taxableBase + bookedTax` for both
  price types), so `taxShare = round(total × bookedTax / taxedGross)`: tax proportional to the taxable
  base actually being credited, not to the gross. Not a promo special case — the general statement,
  and with promo = 0 the denominator *is* the total, so every non-promo invoice books byte-identically.
  The `remainingTax` cap still bounds a note larger than the taxed slice. Probe
  `probe-change-promo-tax-retention` now ends on `tax_payable = 0` with the customer still holding
  2202524 (shortfall 0). Same correction reaches the cancellation split
  (`cancellation-credit.ts`) and `refundInvoiceViaCreditNote`, which credit tax-inclusive amounts off
  the same invoice. Gates: `test`, `tsc`, `verify:credit-notes|proration|proration-matrix|invoices-v2|
  subscriptions-v2|estimates|tax|refund|offline-refund|audit|wallet|india-invoice|invoice-ops` all
  pass; `probe-cancel-multi-invoice` / `probe-change-credit-funded` / `probe-change-refundable-funded`
  byte-identical (ids aside). *(The gap listed here — `issueAdjustmentCreditNote` keeping the gross
  denominator, because it round-trips by construction with the blended-rate tax line `proration.ts`'s
  `creditOneInvoice` builds, so the pair had to move together — was **CLOSED on 2026-08-25**: the pair
  moved together, and the entry above says how.)* *(The second gap listed here — the change path's own
  `Tax reversal` ITEM reading 218963 against this ledger reversal of 322524 — was CLOSED the same day:
  `creditOneInvoice` now carries the tax line whole into the cashable slice and rescales only the supply
  lines, so the item is 322524 and the note reads 1791800 time + 322524 tax. See the subscriptions
  module Changelog.)*
- **2026-08-24** — `refundableCapacityForInvoice(tx, invoiceId)` extracted and **exported**. The cap
  (`paid − gatewayRefunded − (refundableCNsTotal − refundableCNsPaidOut)`) was inline inside
  `issueRefundableCreditNote`, so callers could only discover it by being refused — and a refusal
  mid-change rolls the whole change back. `issueRefundableCreditNote` now enforces it *through* this
  function and `proration.ts` allocates term credit *using* it, so the allocator and the guard cannot
  drift. Same one-definition rule as `gatewayRefundableForInvoice` below.
- **2026-08-24** — **"the gateway declined the payout" was reported about a gateway we never called.**
  `payOutRefundsPayable` builds its work list from the CN invoice's succeeded payments; when that list
  is empty the loop never runs, so `lastError` stays `null` and `refundCreditNote`'s throw fell through
  to its generic fallback. Measured on `cn_XXXXXXXXXXXXXXXXXXXXXX01` (CN-10, ₹40,042.12, reason
  Subscription Cancellation): its invoice `inv_XXXXXXXXXXXXXXXXXXXXXX04` is `Paid` with **Credits
  applied −₹40,042.12 and no payment rows at all**, and the CN timeline recorded no failed refund
  transaction — proof no leg was attempted. Cost: an operator debugging RazorPay for a decline that
  never happened. Fixes: `payOutRefundsPayable` now returns `legsAttempted`, and `legsAttempted === 0`
  throws "nothing to refund through a gateway … settled by applied credit" instead. The funding scan is
  extracted into exported `gatewayRefundableForInvoice(tx, invoiceId)`, which `getCreditNoteDetail` also
  reports as `gatewayRefundableMinor` → `gateway_refundable_minor` on the detail route, so the dashboard
  gates the gateway-refund control on a real precondition rather than failing after the earmark
  round-trip. **One scan, two consumers, on purpose.** What this does NOT change is that a cancellation
  can still produce a fully-`available` refundable note with no cash behind it — and that is **correct**:
  a refundable CN is how refundable balance returns to the customer (this module credits
  `REFUNDABLE_CREDIT` in `createRefundableCreditNote`), so the note must exist even when nothing is
  cashable. A gateway refund there fails with "Refund operation failed. No refundable payments
  present" and the workaround is the offline refund — so hiding the gateway control and naming the
  reason beats failing after the earmark. Remaining question (`D-cn-cap` in `docs/PROGRESS.md`):
  persist a `cash_backed_minor` on the note instead of deriving it per read.
- **2026-08-22** — **A credit note was addressed to the wrong person** (same defect as the invoice —
  see `invoicing/README.md`). `document.ts` kept its own copies of
  `customerDisplayName`, `addressLines` and `customerAddressLines`; all three are deleted. The name
  now comes from `customers/names.ts` (`invoiceContactName`) and the address builders are imported
  from `invoicing/document.ts`, for exactly the reason this module already shares `InvoiceDocument`:
  the copies had drifted, and the drift was silent data loss — the credit-note snapshot builder
  omitted `line3`, so an operator who set it on the source invoice's address saw it on the invoice
  and not on the credit note reversing it. The address block also prints the contact name and
  company now, which neither document did. The SOURCE INVOICE's address snapshot outranks the
  customer's current row for the printed NAME as well as the street: a credit note has to be
  addressed to whoever the invoice it reverses was addressed to, or the two cannot be reconciled.
  Gated by `verify:credit-notes` and `test/unit/invoice-billto.test.ts`.
- **2026-08-04** — The offline-refund dialog (`RecordOfflineRefundButton`) now exposes the `reason`
  field the route already accepted (2026-08-01 entry above only wired the two routes + the gateway
  refund dialog; the offline dialog was missed). Also fixed `recordOfflineCnRefund` itself: it took
  `reason` as a parameter but never stored it anywhere — no ledger memo, no event, no audit row — so
  a value posted through the API silently vanished. `reason` now rides on `credit_note_refunded`'s
  event data (alongside `reference`) and on the `credit_note.record_refund` audit row's `after`
  snapshot (alongside `method`/`reference`), matching how `reference` was already handled.
- **2026-08-03** — **`issueAdjustmentCreditNote` / `issueRefundableCreditNote` accept an optional
  `tx`** (via the new `withTenantTx` in `platform/db.ts`: reuse the caller's handle, or open one).
  Both bodies were already fully tx-parameterized — `loadInvoice`, `postEntries`, `emitEvent`,
  `auditCn` all take the handle — only the outer `withTenant` forced a transaction of their own,
  and a nested `db.transaction` is a SAVEPOINT, so a caller could never make a credit note commit
  or roll back **with** its own write. `changeSubscription` needs exactly that: it applies the item
  change and issues the downgrade credit as one unit, because a refused credit used to leave the
  subscription downgraded with nothing credited (see `subscriptions/README.md`). Omit the field and
  behaviour is byte-identical; the cap and eligibility guards are untouched. Callers that pass a
  handle inherit its RLS context, so it must belong to the same organization.
- **2026-08-01** — **P4: every credit-note op is audited.** `credit_note.create` (all three creation
  primitives — adjustment, refundable, and the `refunded` document a gateway refund produces),
  `credit_note.refund`, `credit_note.record_refund` and `credit_note.void`, each with a changed-field
  before/after diff, written by the module-local `auditCn` helper **inside the caller's transaction**
  (the `invoice.void` pattern), so a rolled-back op leaves no row claiming it happened. The write-off
  path also writes `invoice.write_off` here, because `writeOffInvoice` routes through
  `issueAdjustmentCreditNote` precisely so the credit note and the invoice's abandonment commit
  together. `credit_note.refund` audits the **earmark** (step 1, the only atomic step); the payout leg
  is a gateway outcome already on the CN timeline, and a decline is recorded by the compensating
  entry `reverseCnRefundEarmark` posts. Auditing `createRefundableCreditNote` rather than its public
  wrapper means the clock-driven cancellation-credit split is logged too — those rows correctly show
  `source=scheduled_job` with a NULL `actor_ip`.
- **2026-07-30** — **Paginated credit-notes list.** `listCreditNotesPage` behind
  `GET /v1/businesses/:biz/credit_notes` (keyset + index `credit_notes_business_created_idx`,
  migration 0131), with `q`, `sort_by` over `created_at|total_minor|status`, `<field>[<op>]` filters,
  and `?invoice=` / `?customer=` scoping. **The N+1 is gone**: items for the whole page load in one
  `inArray` query instead of one query per note. The customer and subscription detail pages now pass
  `?customer=` instead of reading every credit note in the business and filtering client-side.
  Verify: `verify:list-pagination`.
- **2026-07-21** — Audit M2 follow-up: `createRefundableCreditNote` now reverses proportional output
  tax on its ledger booking, mirroring `issueAdjustmentCreditNote` — derives `bookedTax` from the source
  invoice's `tax_payable` entries (drift-proof), applies the `remainingTax` cap over prior CN reversals,
  and books `dr credit_adjustments(net) + dr tax_payable(taxShare) + cr REFUNDABLE_CREDIT(total)`. Previously
  it booked the full `total` to `credit_adjustments` and never touched `tax_payable`, so refunding a taxed
  amount left output-tax liability overstated. Untaxed invoices → `bookedTax=0` → `net=total` → byte-identical.
  CN row/total/allocations/available/refundable unchanged (only ledger `lines`). Fresh-context review SOUND.
- **2026-07-15** — The refundable-CN paid-amount guard
  (`issueRefundableCreditNote`, caps new refundable credit at the target invoice's cash paid) is
  correct — the `Refundable credit 4900 exceeds refundable paid amount 500` failure was a
  *wrong-target-invoice* bug in the caller, not a guard bug. Fixed in `subscriptions/proration.ts`
  (`issueCurrentTermCredit` gained `targetInvoicePublicId`) so an item-removal credit books against
  the invoice that actually charged that item. Guard left untouched (not weakened).
- **2026-07-15** — New `createRefundedCreditNote(tx, …)` — the
  INVERSE of `refundCreditNote`. When a paid invoice's payment is refunded, `refunds/service.ts`
  calls this to record a `refunded` credit note (kind `refundable`, `total = refunded = paidOut =
  amount`, `allocated = available = 0`) documenting the money returned, and emits `credit_note_created`
  + `invoice_updated`. Books **no ledger entries** — the caller (`refundPayment`) already booked
  dr `refunds` / cr `cash`, so money is booked once and the refundable bucket is untouched. Not
  emitted for a refund that is itself a CN payout (caller guards on `contraAccount`/`creditNoteId`)
  → no loop. No `customer_changed` (no credit balance moved).
- **2026-07-14** — Credit-balance and invoice events:
  - emit `customer_updated` (canonical `customer_changed`) whenever a customer's credit balance
    moves — `createRefundableCreditNote` (balance up) + `allocateRefundableDraw` (available down),
    via `emitCustomerChanged`. The balance summary rides on the customer object.
  - emit `invoice_updated` when a CN is issued against an invoice / credits are allocated to it,
    via `emitInvoiceUpdated`.
  - a refundable CN fully consumed by allocation transitions `refund_due → refunded` (settled). Status-only — the `total = allocated + refunded + available` invariant is unchanged.
- **2026-07-06** — As-built baseline documented (post clone-program phases 0→H).
- **2026-07-13** — `payOutRefundsPayable`'s per-leg catch now also emits a CN-scoped `refund_failed`
  event (in addition to the existing `console.error`) so a stranded `refunds_payable` payout leg is
  durable/visible from the credit note's own timeline, not console-only.
- **2026-07-13** — Refund semantics: a payout leg the gateway REFUSES no longer consumes
  the credit note. The un-paid earmark is reversed (compensating `credit_note_refund_reversal`
  ledger entry, `refunded` wound back, `available` re-inflates); a fully-declined
  `refundCreditNote` throws with the gateway's reason (API 400). Failed attempts are recorded as
  failed refund transactions on the CN timeline (with `error_text` in the detail API). The sweep
  now also reverses gaps it cannot pay out — healing earmarks stranded before this change. New
  event: `credit_note_refund_reversed`.

- **2026-08-01** — `voided_at`, `channel`, and item `period_start`/`period_end`/
  `invoice_line_item_id` so a credit note says which service period it reversed (inherited from the
  credited invoice line via the new optional `invoice_line_item` on create). Serializer now emits the
  customer (`customer_id` had always existed and was never exposed, so nothing could get from a credit
  note to the payer). `reason` exposed on BOTH refund routes — the service had always accepted it.
  New **`GET /v1/businesses/:biz/credit_notes/:cn/pdf`**: `document.ts` builds an `InvoiceDocument`
  and reuses `renderInvoicePdf` with a `DocumentLabels` override, so the two documents share one
  layout and cannot drift.
- **2026-08-19** — Module logger adopted (`createLogger`): failure paths that previously swallowed their error now log it with the execution's `traceId`. Lines also reach Google Cloud Logging when `CLOUD_LOGGING=TRUE` (`src/platform/cloud-logging.ts`).
- **2026-08-22** — **The Customer column on the list AND the detail header now resolve the name**
  (`accountHolderName`) instead of reading `customers.name`, which is null for every customer created
  through the API with first/last — the two most recently added surfaces in this module both showed a
  blank where the payer should be. Both reads select the whole chain off the join they already do, so
  the row and the header it opens can never disagree. `CreditNoteView.customerName` keeps its
  undefined-vs-null distinction (absent = not loaded, null = loaded and genuinely nameless).
- **2026-08-24** — **Schema only: the credit note gains a GROSS subtotal and a typed discount
  table (migration `0186_credit_note_discounts`). NOTHING POPULATES EITHER YET** — the 2026-08-25
  entry below does. The gap between a note's gross line total and its cashable total is represented
  as a typed DISCOUNT, not as an applied-credits field — there is no `*_credits_applied` field on a
  credit note. The shape (`docs/PROGRESS.md` § `D-cn-cap`): `sub_total` 4189900 / `total` 0 with
  `discounts[0] = { entity_type: "promotional_credits", description: "Promotional Credits
  Returned", amount: 4189900 }`, i.e. `total = sub_total − discounts + tax`.
  We had only `total_minor` and items with `amount_minor`, so "gross 41899.00, 41899.00 returned to
  the promotional bucket, 0.00 cashable" was inexpressible — which is why `creditOneInvoice` writes
  no note at all when the cashable slice is zero.
  - `credit_notes.subtotal_minor` (bigint, **nullable, no default**) — the `sub_total`, the gross
    reversal. Nullable because nothing writes it yet: `DEFAULT 0` would make every new note assert a
    gross of zero against a non-zero cashable total (false, and printable), and Postgres cannot
    express the honest `DEFAULT total_minor`. NULL therefore reads as "gross not recorded; equals
    `total_minor`" — the convention `channel` and `number` already use here. Tighten to NOT NULL once
    every writer sets it. All 918 pre-existing rows were backfilled to `total_minor` (no discount
    rows exist, so gross **is** cashable for them — a fact, not a guess).
  - `credit_note_discounts` — `(id, organization_id, business_id, credit_note_id, type, amount_minor,
    description, created_at)`, index on `credit_note_id`, RLS `org_isolation` + `tmbilling_app`
    grants. `type` is CHECK-constrained to `promotional_credits | excess_payments |
    item_level_coupon | document_level_coupon | prorated_credits` (the last three reserved for the
    importer, so an imported note carrying one is recorded rather than dropped). `amount_minor` is always
    POSITIVE — the amount taken off the gross, same sign discipline as `invoice_line_discounts`.
    A table rather than columns because a note may carry several discounts, each typed.
  - **`total_minor` is unchanged and was NOT repurposed.** It stays the CASHABLE claim — what
    `createRefundableCreditNote` credits to `REFUNDABLE_CREDIT` and what the
    `total = allocated + refunded + available` invariant rests on. Sizing it gross would hand the
    customer the returned promotional slice a second time. Purely additive: no invariant, ledger
    posting or caller moved. The invoice-side twin of this shape is `0169_invoice_line_discounts`.
  - Gates: root + dashboard `tsc --noEmit` clean; `pnpm test` 490/490; `verify:rls` (45 tenant
    tables, PASS), `verify:credit-notes`, `verify:invoices-v2`, `verify:proration` all PASS.
- **2026-08-25** — **The 0186 shape is now POPULATED, and a zero-cashable note is WRITTEN instead
  of skipped.** `createRefundableCreditNote` takes two new OPTIONAL inputs — `subtotalMinor`
  (`sub_total`: the gross reversal) and `discounts[]` (`{ type, amountMinor, description }`, written
  to `credit_note_discounts`). Callers that pass neither behave exactly as before: subtotal stays
  NULL ("gross not recorded; equals `total_minor`") and no discount rows appear. The relation every
  writer must satisfy, e.g. 2162529 − 973140 + 214090 = 1403479:

      total_minor = subtotal_minor − Σ credit_note_discounts + Σ tax lines on the note

  - **Who populates it**: `creditOneInvoice` (`subscriptions/proration.ts`) and the split path of
    `issueProratedCreditForUnusedTerm` (`subscriptions/cancellation-credit.ts`) — the only two
    places a credit is split by how the invoice was funded. Everything else (`issueRefundableCreditNote`,
    `issueAdjustmentCreditNote`, `refundInvoiceViaCreditNote`'s restore note, the importer) still
    writes NULL, unchanged.
  - **The zero-cashable note.** `creditOneInvoice`'s `if (split.refundable <= 0n) return null` is
    gone: a reversal funded entirely from the promotional / excess buckets is now written as a note
    with the gross in `subtotal_minor`, the returned slice as a `promotional_credits` discount, and
    `total_minor` 0. Measured on `scripts/probe-change-credit-funded.ts`: `subtotal
    61935`, one discount `promotional_credits 61935`, `total 0`, and 61935 − 61935 + 0 = 0. It is
    inert by construction — `total = 0` ⇒ `available = 0`, so it is skipped by
    `allocateRefundableDraw` (`avail <= 0 → continue`), adds 0 to `refundableCapacityForInvoice`,
    and satisfies `total = allocated + refunded + available` trivially. A note is still refused
    when NOTHING moved (no cashable slice *and* no bucket slice).
  - **It posts NOTHING to the ledger.** The ledger block is guarded by `if (total > 0n)`: a
    zero-total note would otherwise ask `postEntries` to credit `REFUNDABLE_CREDIT` with 0, which it
    rejects outright (every line must be positive). The discount rows are DOCUMENTARY — the
    promotional/excess movement they describe was already posted by `restoreBucketFundedSlices`
    before the note is created, and nothing here posts it again (verified: the probe's ledger holds
    exactly one `change_credit_restore` transaction of 61935 and zero rows sourced at the note).
    `customer_updated` is skipped with the postings (no balance of this customer moved because of
    this note); `credit_note_created` and `invoice_updated` still fire. `voidCreditNote` already
    tolerated a note with no postings (`if (lines.length > 0)`), so it stays voidable.
  - **Status**: a note that opens with nothing available is `refunded` (settled), not `refund_due` —
    the same rule the importer applies (`amount_available > 0 ? refund_due : refunded`) and that
    `allocateRefundableDraw` applies when allocation consumes a note entirely. `refund_due` on a
    note with nothing to pay out would advertise a payout that can never happen.
  - **Items stay the CASHABLE lines** (Σ items = `total_minor`, unchanged), so a wholly bucket-funded
    note has none. The alternative — GROSS line items with a per-line `discount_amount` — belongs
    with the document layer, which still prints `subtotalMinor: cn.totalMinor` and reads neither new
    column (`document.ts`).
  - Gates: `pnpm test` 490/490; root + dashboard `tsc --noEmit` clean; `verify:credit-notes`,
    `verify:credit`, `verify:change-atomicity`, `verify:proration`, `verify:proration-matrix`,
    `verify:invoices-v2`, `verify:subscriptions-v2`, `verify:estimates`, `verify:tax`,
    `verify:refund`, `verify:offline-refund`, `verify:audit`, `verify:rls` — all PASS. All five
    probes keep their verdicts.
- **2026-08-25** — **The DOCUMENT, the API and the SDK now state the note's gross** (0186 phase 4a).
  Phases 2–3 recorded `credit_notes.subtotal_minor` and `credit_note_discounts`; nothing read them.
  `assembleCreditNoteDocument` still printed `subtotalMinor: cn.totalMinor`, so a note that reversed
  ₹27,918.00 and returned ₹10,000.00 to promotional credit rendered as a document of ₹21,143.24 with
  no trace of where the rest went — and a zero-cashable note rendered as a credit note for nothing
  at all.
  - **Document** (`document.ts`): reads both, and fills the `InvoiceDocument` slots the invoice
    renderer already has — `totals.subtotalMinor`, `discountLines`, `taxLines`,
    `totals.discountTotalMinor` / `taxTotalMinor`. Nothing new was invented for the layout: the
    summary ladder in `invoice-pdf.ts` renders `Sub Total → one row per discountLine (negated) →
    one row per taxLine → Total`, and both documents now go through the same rows. Verified end to
    end on `cn_WFnGDSIhPOmGreQqeG4tPjjw` (`scripts/probe-change-promo-tax-retention.ts`), text
    extracted from the rendered PDF: `Sub Total ₹27,918.00 / Promotional Credits Returned
    −₹10,000.00 / Tax ₹3,225.24 / Total ₹21,143.24 / Amount Available ₹21,143.24`.
  - **TAX IS DERIVED, not stored.** A credit note has no tax column, so the document rearranges the
    identity: `tax = total − subtotal + Σ discounts`. It is exact by construction, because the
    writers size `subtotal_minor` net of the tax the note carries (`creditOneInvoice`:
    `Σ cashable + bucketReturned − taxOnNote`). A cancellation credit carries no tax line, so this
    comes out 0 and no Tax row prints.
  - **NULL `subtotal_minor` renders exactly as before**: subtotal = total, no discount rows, no tax
    row. The whole ladder is gated on the COLUMN, not on the discount rows — a discount printed
    without the gross it came off would not add up. Verified on `cn_OhUI2P7KIltSQZRUlBblWLT5`
    (subtotal NULL, total 2791800): `Sub Total ₹27,918.00 / Total ₹27,918.00 / Payments −₹27,918.00
    / Amount Available ₹0.00`, and its summary rows still advance exactly 18pt apart.
  - **Item table untouched, deliberately.** The note's items are its CASHABLE lines, so they sum to
    `total_minor`, not to `subtotal_minor` — the gap IS the discount rows, which is what makes the
    document add up. On the change path the tax the ladder states is also one of those items ("Tax
    reversal on credited time"): `credit_note_items` records no line kind and that item carries no
    `invoice_line_item_id`, so telling a tax item from a supply item would mean guessing at its
    amount or its wording, and a guess that misfires mislabels a supply line on a legal document.
    Both blocks tie to the same bottom line either way. A `kind` column on `credit_note_items` is
    what would let the table exclude tax the way the invoice's does.
  - **A wrapped summary label used to be drawn over the row beneath it** (`invoice-pdf.ts`). The
    advance was a fixed 18pt whatever the label measured; "Promotional Credits Returned" wraps, and
    its second line (y 372.1–383.2) overlapped the "Tax" row at 379.1. Only the overflow past the
    first line is now added, so every single-line row keeps its exact 18/22pt advance and any
    document without a wrapping label renders byte-identically. Long invoice discount descriptions
    had the same latent collision.
  - **API**: `subtotal_minor` on `serializeCreditNote` — so LIST, retrieve, the create receipt and
    the event snapshot all carry it (it is a column on a row already selected; a list row showing
    only `total_minor` is the same misstatement). NULL reports `total_minor`, per the column's own
    convention, so `total = subtotal − Σ discounts + tax` holds for every row a consumer sees.
    `discounts[]` (`type`, `amount_minor`, `description`) is **DETAIL-ONLY** — it costs its own
    table read, and `Invoice.discounts` draws the line in the same place.
  - **OpenAPI/SDK**: the `CreditNote` component was a stub that declared a REQUIRED `credit_method`
    the API had stopped returning, and omitted `status`, `kind`, `available_minor`, the items and the
    timeline. Documenting the new fields inside an envelope that misstated the rest would have been
    the same class of error, so it now mirrors `serializeCreditNote` plus the detail-only extras
    (`discounts`, `allocations`, `refunds`, `gateway_refundable_minor`), marked the way `Invoice`
    already marks its single-read fields; `required` is the intersection of the three responses that
    point at it. SDK regenerated with `pnpm sdk:generate` (writes `sdk/openapi.json`, then
    openapi-typescript emits `sdk/schema.d.ts`) — both are generated, never hand-edited.
  - Gates: `pnpm test` 490/490; root + dashboard `tsc --noEmit` clean; `verify:credit-notes`,
    `verify:credit`, `verify:invoices-v2`, `verify:proration`, `verify:audit` — all PASS, plus
    `verify:invoicing-parity` (it renders both PDFs through the shared renderer). No assertion moved.
- **2026-08-25** — **Schema only (0187 + 0188): the historical gross was tax-inclusive, and the
  item table gains the `kind` that would have made the repair unnecessary.** Two migrations, one
  defect each; no engine code moved, and nothing writes the new column yet.
  - **0187 — the 0186 backfill was wrong for every note carrying tax.** 0186 set
    `subtotal_minor = total_minor` for all 918 pre-existing notes, justified as "for them gross IS
    cashable, no discount rows exist". True only where there is no tax. `subtotal_minor` is the
    **PRE-TAX** gross (`total = subtotal − Σ discounts + tax`), and a change-path note carries its
    own tax as an item ("Tax reversal on credited time"), so its `total_minor` is tax-INCLUSIVE.
    Those rows asserted `tax = total − subtotal + Σ discounts = 0` on a note that demonstrably
    reversed tax — off by exactly the tax, and the document's Tax row silently disappears.
  - **Identified by the IDENTITY FAILING, never by a date.** `total <> subtotal − Σ discounts +
    Σ tax items` cannot select a row whose figures already add up, so a correctly-written note is
    untouchable by construction. Description-matching only nominates a candidate; the write is
    authorised by five arithmetic guards — identity broken, **no** `credit_note_discounts` rows
    (nothing else competing to explain the gap), exactly **one** tax-described item,
    `0 < tax < total`, and `Σ items = total_minor` (the tax item provably IS one of the lines that
    summed to the figure 0186 copied). All five holding, `total − tax` is arithmetic on the note's
    own recorded lines. Anything failing a guard is set back to **NULL** ("gross not recorded;
    equals `total_minor`") rather than given a figure nobody derived — absent beats wrong on a
    document a customer can hold up in court. Locally: **21 repaired, 0 left NULL**, and 0 identity
    failures across all 1595 notes afterwards. Notes with **no** tax item are out of scope and
    deliberately untouched — none of them failed the identity.
  - **Why the description is the only handle.** `applied_taxes` is INVOICE-scoped (`invoice_id` +
    `invoice_line_item_id`, no `credit_note_id`), so a credit note's tax is not recorded there, and
    the tax item carries no `invoice_line_item_id` and no price. Nothing structural distinguished it
    — which is the argument for 0188.
  - **0188 — `credit_note_items.kind`**, the invoice's vocabulary verbatim (`recurring | proration |
    usage | one_time | discount | tax | rounding`) and its constraint style verbatim too: plain
    `text`, no CHECK, values documented in the schema. A second vocabulary would stop `kind ===
    'tax'` — the one test both documents need — from being the same test on both.
  - **Nullable, no default**, the same call 0186 made for `subtotal_minor`: nothing writes it yet, so
    NOT NULL would reject every insert the engine makes, and the only defaultable value (the supply
    one) would label every future note's TAX line as supply — the exact falsehood the column exists
    to prevent. Backfill: **36 → `tax`** by description, **1734 → `one_time`**.
  - **Why `one_time` for supply lines** and not `proration`, despite the "Unused time on …" wording:
    on a credit note the item is a one-off credited amount — it does not recur, is not metered, and
    is not itself a proration of a future period. It is also what every credit-note item that links
    back to an invoice line already points at (all 6 resolve to `kind = 'one_time'`). Reading the
    kind off each description would be guessing from wording — the thing this column removes — and
    would guess wrong on the ad-hoc lines ("Write-off (bad debt)", "goodwill", "service credit").
  - **Nothing writes `kind`, by design.** A follow-up populates it and moves `document.ts` off
    description-matching; until then new rows land NULL and every reader must keep falling back.
    Proved live: a note created by another session minutes after the migration has both its items at
    `kind IS NULL` while its figures still satisfy the identity via the description handle.
  - No GRANT or RLS change: `credit_note_items` already holds TABLE-level DML for `tmbilling_app`
    (table grants extend to later columns, and no column-level grants exist to re-issue), and
    `org_isolation` tests `organization_id`, which a new column cannot affect.
  - Gates: root + dashboard `tsc --noEmit` clean; `pnpm test` 490/490; `verify:credit-notes`,
    `verify:invoices-v2`, `verify:rls` (45/45 tenant tables), `verify:proration` — all PASS.

- **2026-08-26 — voiding a credit note corrupted `amount_due_minor`, and the test pinned it.**
  `amount_due_minor` is the ISSUE-TIME collectible, net of **credits only**; cash is subtracted when
  the invoice is served (`invoiceOutstanding`, `invoicing/document.ts`, and the note in
  `customers/collect.ts` that writes the column). `voidCreditNote` computed
  `total − cashPaid − bucketApplied − otherAdjustments` and stored it, folding cash into a
  credits-only column — so **cash was subtracted twice**. Voiding a 2000 adjustment on a 5000 invoice
  carrying 3000 of cash left the column at 2000, and the invoice then served `2000 − 3000` clamped to
  **0**: the void reopened a debt nobody could be shown or charged for. The fix separates the two
  questions the one figure was answering — `collectible = total − bucketApplied − otherAdjustments`
  goes to the column, and the cash-net figure decides only `status`/`paidAt` (an invoice already
  covered by cash must not be dragged back to `payment_due` because a note was voided). The column is
  now written on both branches; previously the "fully covered" branch left a stale credit-reduced
  value behind.
  `verify:invoices-v2`'s "W: void adj reopens only the 2000 the CN covered" had been asserting
  `amountDueMinor === 2000n` off the raw row — the right intent asked of the wrong place, and it
  passed for as long as the bug existed. It now goes through `invoiceOutstanding` and expects stored
  5000 with outstanding 2000, so it cannot pass while the served figure is 0.
  Sixty invoices already carried the corruption; `scripts/repair-void-corrupted-amount-due.ts`
  recomputes the column (dry-run by default). The ledger was never wrong — the void reverses AR
  correctly — so nothing is posted, and `repair-overpaid-invoices.ts` must NOT be pointed at these
  rows: it detaches surplus payments, which would remove correctly-collected cash.

- **2026-08-26 — the payout sweep was re-sending refunds that were still in flight.** Found in a
  production-shaped log export, one occurrence, and it is a duplicate-gateway-call race rather than
  an accounting error:
  ```
  07:37:57.453  payment pay_XXXXXXXXXXXXXXXXXXXXXX24   350.07 succeeded
  07:38:01.218  refund  re_XXXXXXXXXXXXXXXXXXXXXX01    350.07 SUCCEEDED, recorded
  07:38:02.664  billing_clock → Stripe: "Charge ch_XXXXXX… has already been refunded."
  ```
  `refundCreditNote` earmarks (`refunded_minor`) → calls the gateway → settles (`paid_out_minor`).
  `sweepOutstandingCnPayouts` selects exactly `refunded_minor > paid_out_minor`, which is true for a
  STRANDED payable **and** for one mid-gateway-call — the sweep could not tell them apart. Our record
  was never lost; the note was simply 1.4 seconds from settling.
  It survived because that refund was for the FULL payment, so Stripe had nothing left to send and
  refused. **A partial payout would have gone out twice.** The settle-before-reverse fix of
  2026-08-25 made the ACCOUNTING safe under this interleaving — it could not stop the duplicate call,
  because nothing in the schema said "someone is already doing this".
  `payout_attempt_at` (migration 0190) is that missing state: stamped in the same write as the
  earmark, cleared by `settleCnPayout` and `reverseCnRefundEarmark`. A **lease, not a lock** — it
  EXPIRES after `CN_PAYOUT_LEASE_MS` (5 min), because a process that dies mid-payout must not strand
  the payable forever; reclaiming exactly that is the sweep's purpose, and a lock would defeat it.
  The sweep also takes the lease itself, by a conditional claim on the value it read, so two ticks
  cannot race each other the same way. The OFFLINE refund path writes `refundedMinor` and
  `paidOutMinor` together, never opens the window, and takes no lease.
  Covered by `verify:credit-notes` GB3 (skips a fresh lease / reclaims an expired one / clears it on
  reclaim), confirmed to FAIL when the lease filter is removed.
- **2026-09-27** — Time Travel stamps: event timestamps written here (`paid_at`, `voided_at`, `settled_at`, …) use `stampNow()` (platform/clock.ts), and `created_at`/`updated_at` default to `app_now()` (0296), so a time-travelled business records its simulated instant. Unpinned writes are unchanged. `verify:time-travel-stamps`.
- **2026-09-30** — `POST /credit_notes` takes `customer_notes` (new `credit_notes.customer_notes`, 0309; returned by create, retrieve and list) and per-item `period_start`/`period_end` (the credited window, already supported by `CreditNoteItemInput`). `allocateRefundableDraw` accepts `creditNoteIds` to draw named notes in order (explicit apply-credits); omitted = oldest first as before.
- **2026-10-11** — `creditNoteSpendable` (serialize.ts): a `refunded` note has 0 left whatever its amounts say. The engine sets `refunded` only when a note is fully consumed, but notes imported already settled arrived `refunded` with allocated + refunded short of the total (prod: 38 imported USD notes, 346747). Used by the allocator (so a draw lands on a live `refund_due` note, not a settled one), both refund guards, apply-credits note selection, invoice refund capacity, the cancel-time refund sweep and its estimate, the API's `available_minor` and the list's `available_minor` filter. `creditNoteAvailable` stays the raw invariant term (invariant check, status decisions). Gate: `verify:collect-credit-first` "settled" case (fails without it).
- **2026-10-16** — Credit note `number` sort orders by the numeric suffix (`documentNumberSortKey`), so CN-10 follows CN-9. Proof: `verify:list-pagination`.
- **2026-10-21** — Credit notes list total counts up to 10,000 and stops (`cappedTotal`, `total_capped`; `total=exact` opts in): an exact count over a large book cost seconds per page.
- **2026-11-01 (Tier 3 PR 2)** — A pack line (a line that sold a credit grant) credits at most its unused cost, with that share of its tax; the note voids the units and posts Dr `credit_grants_paid` / Cr `revenue` (`line-cap.ts`, `voidPackLines`). A write-off voids the pending grants its invoice sold. `refundInvoiceViaCreditNote` gives credit-grant draws back (`restoreGrantDraws`), never as cash. The taxed gross nets pre-tax grants like promo. New discount type `credit_grants` (0466). Gate: `verify:credit-grants` §5–6.
- **2026-11-02 (Tier 3 PR 2)** — `issueRefundableCreditNote` on a credit-grant-funded invoice: the grants' share (`total × grant applied ÷ invoice total`, capped at what is still drawn) goes back through `restoreGrantDraws` and is documented as a `credit_grants` discount; only the rest is cash and meets the paid-amount caps. A fully grant-paid invoice takes a note of total 0. The customer lock is taken before the invoice lock. Gate: `verify:credit-grants` §8.
- **2026-11-02 (Tier 3 follow-up)** — A note that gives credit back to credit grants prints its credited lines at their gross (`createRefundableCreditNote`'s `documentItems`); the `credit_grants` discount takes the returned part off, so a fully returned note is no longer blank. `items` stay the cashable lines for total, tax, ledger and caps. Paths: `issueRefundableCreditNote`, the cancellation credit, the change credit (when its lines add up to the gross). The dashboard page shows the totals ladder even without lines, and a zero-total header names the returned amount. Gate: `verify:credit-grants` §8.
- **2026-11-02 (0481)** — `POST /credit_notes` refuses without `reason_code`, and `…/refund` and `…/record_refund` without `reason`, when `billing_rules_config.required_reasons` says so. Gate: `verify:settings-billing-rules`.
- **2026-11-03 (0487)** — `credit_notes.refund_id`: the refund a `refunded` note documents (`createRefundedCreditNote({refundId})`); used by `declined_refund = issue_credit`.
- **2026-11-03 (slice F re-review)** — `refundableCapacityForInvoice`: a reopened declined-refund note (`refund_declined`, `refund_id`) claims `total − refunded` even after its credit is allocated.
- **2026-11-03** — `settled_by` (`creditNoteSettledBy`) on every serialized note: `refund`,
  `allocation` or `mixed` on a `refunded` note, else null. The stored status is unchanged; the dashboard
  shows an allocation-settled note as "Applied to invoices". Gate: `verify:credit-notes` (settled_by).
- **2026-11-04** — `serializeCreditNote` drops `metadata.source_payload` the same way
  (`publicMetadata`); the stored row keeps it. Gate: `verify:migration-history`.
- **2026-11-05** — `invoiceRefundGatewayAccount`: the one gateway account a refund of an invoice goes
  through (each payment `gatewayRefundableForInvoice` scans, resolved by `refundGatewayAccount`).
  Served as `GET …/invoices/:inv/refund_gateway_account`; the refund dialogs read its balance.
