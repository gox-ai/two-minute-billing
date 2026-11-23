-- Late usage after a cancellation (billing_rules_config.late_usage_invoices): an opt-in invoice
-- for usage of an invoiced period that arrives after a cancelled subscription's last invoice.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- The last time the late-usage pass checked this row and raised nothing (below the minimum, or
-- nothing to bill). The pass re-checks only when events were received after it. Nullable, no
-- default: catalog-only.
ALTER TABLE customer_meter_billing ADD COLUMN IF NOT EXISTS late_checked_at timestamptz;
--> statement-breakpoint
-- `late_usage` joins the purposes an engine-made invoice can carry.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_purpose_ck;
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_purpose_ck
  CHECK (purpose IS NULL OR purpose IN ('usage_interim', 'credit_purchase', 'late_usage')) NOT VALID;
--> statement-breakpoint
ALTER TABLE invoices VALIDATE CONSTRAINT invoices_purpose_ck;
--> statement-breakpoint
SET LOCAL lock_timeout TO DEFAULT;
