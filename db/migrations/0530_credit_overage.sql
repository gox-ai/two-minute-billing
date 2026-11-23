-- Usage beyond the credits of a unit with no money rate. A unit of such usage is in one of
-- three states: paid by credits (a part with source balance or grace), billed in money
-- (units_uncovered, with overage_basis), or an overshoot that no one has billed (a part with
-- source overdraft: the balance row is below zero by it until a grant repays it, an invoice
-- bills it or it is forgiven). A voided event that was settled gets a correcting settlement.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- How units_uncovered is billed: by the meter's usage price (the invoice rates it) or by the
-- unit's price per credit (an unbilled charge). NULL: recorded only (before 0530).
ALTER TABLE credit_usage_events ADD COLUMN IF NOT EXISTS overage_basis text;
--> statement-breakpoint
-- Money per credit at the gate, fixed-12 minor units, for overage_basis = 'unit'.
ALTER TABLE credit_usage_events ADD COLUMN IF NOT EXISTS overage_rate_e12 bigint;
--> statement-breakpoint
-- overage_basis = 'meter': the meter price that bills units_uncovered, fixed at the gate.
ALTER TABLE credit_usage_events ADD COLUMN IF NOT EXISTS overage_price_id uuid
  REFERENCES prices(id);
--> statement-breakpoint
ALTER TABLE credit_usage_events ADD COLUMN IF NOT EXISTS overage_charge_id uuid
  REFERENCES unbilled_charges(id) ON DELETE SET NULL;
--> statement-breakpoint
-- The one-off invoice that billed an overshoot part (status billed).
ALTER TABLE credit_usage_events ADD COLUMN IF NOT EXISTS overage_invoice_id uuid
  REFERENCES invoices(id) ON DELETE SET NULL;
--> statement-breakpoint
-- Why a part was zeroed out or forgiven (a reason code).
ALTER TABLE credit_usage_events ADD COLUMN IF NOT EXISTS zero_reason text;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_usage_events_status_ck' AND pg_get_constraintdef(oid) !~ 'forgiven'
  ) THEN
    ALTER TABLE credit_usage_events DROP CONSTRAINT credit_usage_events_status_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_usage_events_status_ck') THEN
    ALTER TABLE credit_usage_events ADD CONSTRAINT credit_usage_events_status_ck
      CHECK (status IN ('taken', 'pending', 'settled', 'refused', 'skipped', 'billed', 'forgiven'))
      NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_usage_events_source_ck' AND pg_get_constraintdef(oid) !~ 'overdraft'
  ) THEN
    ALTER TABLE credit_usage_events DROP CONSTRAINT credit_usage_events_source_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_usage_events_source_ck') THEN
    ALTER TABLE credit_usage_events ADD CONSTRAINT credit_usage_events_source_ck
      CHECK (source IN ('balance', 'grace', 'overdraft')) NOT VALID;
  END IF;
  -- One state per unit of usage: an overshoot part is never also billed at the gate, only an
  -- overshoot part is billed later or forgiven, and a billed part names its invoice.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_usage_events_overage_ck') THEN
    ALTER TABLE credit_usage_events ADD CONSTRAINT credit_usage_events_overage_ck
      CHECK ((source <> 'overdraft' OR units_uncovered = 0)
        AND (status NOT IN ('billed', 'forgiven') OR source = 'overdraft')
        AND (status <> 'billed' OR overage_invoice_id IS NOT NULL)
        AND (status <> 'forgiven' OR zero_reason IS NOT NULL)
        AND (overage_basis IS NULL OR overage_basis IN ('meter', 'unit'))
        AND (overage_basis IS NULL OR units_uncovered > 0)
        AND (coalesce(overage_basis = 'meter', false) = (overage_price_id IS NOT NULL))
        AND (coalesce(overage_basis = 'unit', false) = (overage_rate_e12 IS NOT NULL))
        AND units_uncovered <= units_due) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_usage_events VALIDATE CONSTRAINT credit_usage_events_status_ck;
--> statement-breakpoint
ALTER TABLE credit_usage_events VALIDATE CONSTRAINT credit_usage_events_source_ck;
--> statement-breakpoint
ALTER TABLE credit_usage_events VALIDATE CONSTRAINT credit_usage_events_overage_ck;
--> statement-breakpoint
-- Overshoot parts that wait: for the gate's block and the overage invoice pass.
CREATE INDEX IF NOT EXISTS credit_usage_events_overdraft_idx
  ON credit_usage_events (customer_id, unit_id)
  WHERE source = 'overdraft' AND status IN ('taken', 'billed');
--> statement-breakpoint
-- Uncovered units that the unit's price bills and no charge carries yet.
CREATE INDEX IF NOT EXISTS credit_usage_events_unit_overage_idx
  ON credit_usage_events (customer_id, received_at)
  WHERE overage_basis = 'unit' AND overage_charge_id IS NULL;
--> statement-breakpoint
-- A correction gives back what a settlement drew for an event that was voided later. A redraw
-- pays again, from other grants, usage that a fully refunded pack paid.
ALTER TABLE credit_usage_settlements ADD COLUMN IF NOT EXISTS corrects_event_id uuid;
--> statement-breakpoint
-- The settlement whose draws the correction gives back.
ALTER TABLE credit_usage_settlements ADD COLUMN IF NOT EXISTS corrects_settlement_id uuid
  REFERENCES credit_usage_settlements(id);
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_usage_settlements_kind_ck' AND pg_get_constraintdef(oid) !~ 'redraw'
  ) THEN
    ALTER TABLE credit_usage_settlements DROP CONSTRAINT credit_usage_settlements_kind_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_usage_settlements_kind_ck') THEN
    ALTER TABLE credit_usage_settlements ADD CONSTRAINT credit_usage_settlements_kind_ck
      CHECK (kind IN ('usage', 'late', 'correction', 'redraw')
        AND ((kind = 'correction') = (corrects_event_id IS NOT NULL))
        AND ((kind IN ('correction', 'redraw')) = (corrects_settlement_id IS NOT NULL))) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_usage_settlements VALIDATE CONSTRAINT credit_usage_settlements_kind_ck;
--> statement-breakpoint
-- One correction per voided event, meter and settlement: a second void writes nothing.
CREATE UNIQUE INDEX IF NOT EXISTS credit_usage_settlements_correction_uq
  ON credit_usage_settlements (corrects_event_id, meter_id, corrects_settlement_id)
  WHERE kind = 'correction';
