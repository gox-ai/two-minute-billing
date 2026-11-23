-- Usage grace window that holds only the invoice. A renewal of a metered subscription runs on
-- time and writes its invoice as a held pending draft; the draft finalizes at `hold_until`.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Up to 30 days (43,200 minutes). smallint stops at 32,767, so the column widens to integer.
-- The rewrite is of `businesses` only, a small table.
ALTER TABLE businesses ALTER COLUMN usage_close_delay_minutes TYPE integer;
--> statement-breakpoint
ALTER TABLE businesses DROP CONSTRAINT IF EXISTS businesses_usage_close_delay_minutes_ck;
--> statement-breakpoint
ALTER TABLE businesses ADD CONSTRAINT businesses_usage_close_delay_minutes_ck
  CHECK (usage_close_delay_minutes BETWEEN 0 AND 43200) NOT VALID;
--> statement-breakpoint
ALTER TABLE businesses VALIDATE CONSTRAINT businesses_usage_close_delay_minutes_ck;
--> statement-breakpoint
-- When a held renewal invoice finalizes. Null on every other invoice. Nullable, no default:
-- catalog-only.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hold_until timestamptz;
--> statement-breakpoint
-- The close scan. No existing row matches, so the index starts empty.
CREATE INDEX IF NOT EXISTS invoices_hold_until_idx ON invoices (hold_until)
  WHERE status = 'pending' AND hold_until IS NOT NULL;
--> statement-breakpoint
-- drizzle runs a batch of migrations in one transaction: do not hand the timeout to the next one.
SET LOCAL lock_timeout TO DEFAULT;
