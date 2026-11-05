-- Clear `cancel_at_period_end` left standing on already-cancelled subscriptions.
--
-- WHY THESE ROWS EXIST
-- Every terminal cancel path set `status = 'cancelled'` without clearing the end-of-term flag:
-- `cancelSubscription` (immediate), `renewSubscription` (the clock honouring the flag at the
-- boundary) and `sweepDunningExhausted`. The specific-date column was always cleared — hence 0
-- stale rows there — but the flag was not, so a cancelled subscription kept advertising a
-- cancellation that had already happened. The dashboard renders `Cancelled` alongside
-- `Cancellation scheduled — cancels on <date>` plus a "Remove scheduled cancellation" button
-- that calls `removeScheduledCancellation`, which throws on any non-active subscription.
--
-- The three code paths are fixed; this is the data that predates the fix.
--
-- WHY IT IS SAFE
-- `status = 'cancelled'` is the whole guard. A subscription legitimately holding a pending
-- cancellation is by definition NOT cancelled yet — it is `active` and reads `non_renewing`
-- through `apiSubscriptionStatus`. Those rows are untouched, and the SELECTs below prove it
-- both before and after.
--
-- `remaining_billing_cycles` is deliberately NOT reset: a spent cycle count records what
-- happened rather than a pending intent, and nulling it would assert "renews forever" on a dead
-- subscription. See the comment in `cancelSubscription`.
--
-- Idempotent — re-running it touches nothing.
--
-- Usage: psql "$DATABASE_URL" -f scripts/sql/backfill-stale-cancel-at-period-end.sql

\set ON_ERROR_STOP on

BEGIN;

-- Before: what we are about to change, and what we must not.
SELECT
  count(*) FILTER (WHERE status = 'cancelled' AND cancel_at_period_end)     AS to_fix,
  count(*) FILTER (WHERE status <> 'cancelled' AND cancel_at_period_end)    AS must_not_touch,
  count(*) FILTER (WHERE status = 'cancelled' AND cancel_scheduled_at IS NOT NULL) AS stale_specific_date
FROM subscriptions;

UPDATE subscriptions
SET cancel_at_period_end = false,
    -- A terminal cancel also supersedes a pending specific-date one. Currently always NULL on
    -- these rows, but included so the backfill matches what the code now guarantees rather than
    -- what today's data happens to look like.
    cancel_scheduled_at = NULL
WHERE status = 'cancelled'
  AND (cancel_at_period_end OR cancel_scheduled_at IS NOT NULL);

-- After: to_fix must be 0, must_not_touch unchanged.
SELECT
  count(*) FILTER (WHERE status = 'cancelled' AND cancel_at_period_end)  AS to_fix_remaining,
  count(*) FILTER (WHERE status <> 'cancelled' AND cancel_at_period_end) AS must_not_touch
FROM subscriptions;

COMMIT;
