-- Re-arm `payment_due` invoices that no clock pass can select.
--
-- WHY THESE ROWS EXIST
-- Three passes can charge an invoice, and each one excludes this exact shape:
--
--   runInvoiceDueTransitions   status = 'posted'                                     (invoicing/due.ts)
--   runDunningPass             status = 'payment_due' AND next_attempt_at IS NOT NULL (subscriptions/dunning.ts)
--   sweepStrandedRetries       status = 'payment_due' AND next_attempt_at IS NULL
--                                                     AND dunning_status = 'in_progress'
--
-- So `payment_due` + next_attempt_at NULL + dunning_status NULL is reachable by none of them.
-- `importArchivalInvoice` produced it whenever an imported book reported a ladder position
-- (`dunning_attempts[]` non-empty) but no `next_retry_at` — that field is routinely unset
-- between ladder steps, and `mapInvoiceDunning` passed both through faithfully.
--
-- The invoice is then never charged again. No attempt, no transaction, and — in a shadow run —
-- no parked gateway charge, so the upstream `payment_succeeded` arrives to find nothing to
-- settle and returns `noop` ("no parked charge awaiting a verdict", shadow/payments.ts). The
-- result is an invoice already collected upstream sitting at Payment Due on our side
-- indefinitely, with an empty Transactions tab.
--
-- `importArchivalInvoice` is fixed; this is the data that predates the fix.
--
-- WHY IT IS SAFE
-- The `NOT EXISTS (pending payment)` guard is the whole thing, and it is the same guard
-- `sweepStrandedRetries` already applies. An invoice PARKED on an async rail — a UPI/ACH
-- mandate, or the shadow gateway waiting on the upstream verdict — carries exactly these three
-- column values and must NOT be re-armed: its outcome is still coming, and re-arming would
-- assert the attempt was abandoned. A pending `payments` row is precisely what separates
-- "waiting" from "orphaned", which is why it is the guard and not a heuristic on age.
--
-- This re-arms; it never settles. The next tick's dunning pass takes one ordinary swing. Under
-- the shadow gateway that swing cannot invent an outcome — the adapter reports the real
-- upstream verdict or parks again, so a wrongly-armed row costs a park, not a fabricated payment.
--
-- `dunning_status` is set alongside because `sweepStrandedRetries` only rescues a crashed retry
-- when it reads `in_progress`. Arming `next_attempt_at` alone would leave these rows falling
-- straight back into the same unreachable state after any crash between claim and outcome.
--
-- `dunning_status IS NULL` is load-bearing for the same reason, not just a shape match. A ladder
-- the merchant PAUSED reads `stopped`, a spent one reads `exhausted`, a recovered one `success` —
-- all three legitimately carry no next retry, and re-arming any of them would resume collection
-- somebody deliberately ended. Only "never dunned by us, and no schedule" is in scope.
--
-- `not_paid` is deliberately untouched: terminal in our model, and nothing auto-retries those.
-- `posted` is untouched: the due pass already scans it.
--
-- Idempotent — re-running it touches nothing.
--
-- Usage: psql "$DATABASE_URL" -f scripts/sql/backfill-orphaned-dunning-invoices.sql

\set ON_ERROR_STOP on

BEGIN;

-- Before: what we are about to change, and what we must not.
SELECT
  count(*) FILTER (
    WHERE status = 'payment_due' AND next_attempt_at IS NULL AND dunning_status IS NULL
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending')
  ) AS to_fix,
  count(*) FILTER (
    WHERE status = 'payment_due' AND next_attempt_at IS NULL AND dunning_status IS NULL
      AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending')
  ) AS parked_must_not_touch,
  count(*) FILTER (WHERE status = 'payment_due' AND next_attempt_at IS NOT NULL) AS already_armed,
  count(*) FILTER (WHERE status = 'not_paid')                                    AS terminal_untouched
FROM invoices i;

-- The rows themselves, so the run leaves a record of exactly what it re-armed.
SELECT i.public_id, i.status, i.attempt_count, i.due_date, i.created_at, i.imported
FROM invoices i
WHERE i.status = 'payment_due'
  AND i.next_attempt_at IS NULL
  AND i.dunning_status IS NULL
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending')
ORDER BY i.created_at;

UPDATE invoices i
SET next_attempt_at = now(),
    dunning_status  = 'in_progress'
WHERE i.status = 'payment_due'
  AND i.next_attempt_at IS NULL
  AND i.dunning_status IS NULL
  -- A live async attempt owns this invoice. Never re-arm it.
  AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending');

-- After: to_fix must be 0, parked_must_not_touch unchanged.
SELECT
  count(*) FILTER (
    WHERE status = 'payment_due' AND next_attempt_at IS NULL AND dunning_status IS NULL
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending')
  ) AS to_fix_remaining,
  count(*) FILTER (
    WHERE status = 'payment_due' AND next_attempt_at IS NULL AND dunning_status IS NULL
      AND EXISTS (SELECT 1 FROM payments p WHERE p.invoice_id = i.id AND p.status = 'pending')
  ) AS parked_must_not_touch
FROM invoices i;

COMMIT;
