-- A coupon's item constraint can name billing periods: the line's price must bill on one of
-- them (e.g. yearly only). NULL = any period, which is every row today.
-- Shape: [{"interval": "year", "interval_count": 1}, ...]
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "coupon_item_constraints" ADD COLUMN IF NOT EXISTS "billing_periods" jsonb;
