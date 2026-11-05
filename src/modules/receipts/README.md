# receipts

A numbered, immutable record of money received (0387). Not a tax invoice: no tax lines.

## When a receipt is created

- One per `payments` row that reaches `succeeded` and is not `imported` and not a
  payment-request child — created by an in-transaction event sink on `payment_succeeded`
  (`receiptSink`, registered by `sink.ts`, imported by `src/index.ts` and the worker), so all
  success sites are covered by one chokepoint and a rolled-back payment leaves none. Runs in a
  savepoint: a receipt failure is logged and never fails the payment.
- One per payment-request settlement (`createReceiptForRequestSettlement`), keyed on the
  settlement's transaction (`transaction_id`).
- `ON CONFLICT DO NOTHING` on `payment_id` / `transaction_id`: replays are safe.
- Only for payments made after deploy. There is no backfill.

`amount_minor` is the cash received: an offline overpay records the full amount with a second
allocation line "customer credit". `snapshot` freezes payer, business identity, method words
("Visa ···4242", "Cash") and allocations, so a later rename does not rewrite history.

## Numbering

One series per business, `businesses.receipt_prefix` (default `RCPT`) +
`receipt_next_number`, formatted by `composeDocumentNumber` with
`invoice_customization.receipt.numbering` (defaults as credit notes). Batch-numbered off the
payment transaction by the `number_receipts` job (`numberUnnumberedReceipts`, the
`number_invoices` pattern: advisory lock per business, one counter update per batch, oldest
first), which emits `receipt_created` with the number. The clock tick re-requests any business
holding unnumbered receipts. Why not in the payment transaction: a counter on `businesses`
updated by every settlement would lock the row the invoice numberer and credit notes update.

## Surfaces

- API: `GET /v1/businesses/:biz/receipts` (keyset; `customer`, `payment`, `payment_request`,
  `invoice`, `created_at[op]`…), `GET …/receipts/:rcpt`, `GET …/receipts/:rcpt/pdf`.
- Portal: `GET /portal/v1/receipts`, `GET /portal/v1/receipts/:rcpt/pdf` (numbered only,
  ownership in the query).
- Email: `email_config.attachReceiptPdf` (default false) attaches the numbered receipt PDF to
  `payment_receipt` (`emails/attachments.ts` `receiptPdfForEvent`).

Gate: `verify:receipts`.

## Changelog

- **2026-10-25** — Module created (0387): sink, batch numberer + job, snapshot, PDF, API,
  portal routes, optional email attachment.
