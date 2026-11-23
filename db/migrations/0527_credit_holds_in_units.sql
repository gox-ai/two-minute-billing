-- Holds and the automatic top-up in a credit unit with no money rate. A hold on a meter with
-- a credit cost reserves units: credit_unit_balances.held_steps is the sum of the open holds,
-- and the gate offers available_steps - held_steps. An automatic top-up for such a unit buys
-- a pack when the balance in units is at or below its threshold.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- Metadata-only: no rewrite.
ALTER TABLE credit_unit_balances ADD COLUMN IF NOT EXISTS held_steps bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_unit_balances_held_ck') THEN
    ALTER TABLE credit_unit_balances ADD CONSTRAINT credit_unit_balances_held_ck
      CHECK (held_steps >= 0) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_unit_balances VALIDATE CONSTRAINT credit_unit_balances_held_ck;
--> statement-breakpoint
-- A hold is in money (amount_minor, as before) or in units, never both.
ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES credit_units(id);
--> statement-breakpoint
-- In the unit's smallest step.
ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS amount_units bigint;
--> statement-breakpoint
ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS captured_units bigint;
--> statement-breakpoint
-- The amount rule moves from "amount_minor > 0" to "money or units".
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'credit_holds'::regclass AND contype = 'c'
      AND conname <> 'credit_holds_amount_ck'
      AND pg_get_constraintdef(oid) ~ 'amount_minor > 0'
  LOOP
    EXECUTE format('ALTER TABLE credit_holds DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_holds_amount_ck') THEN
    ALTER TABLE credit_holds ADD CONSTRAINT credit_holds_amount_ck
      CHECK (CASE WHEN unit_id IS NULL
        THEN amount_minor > 0 AND amount_units IS NULL AND captured_units IS NULL
        ELSE amount_minor = 0 AND amount_units > 0
          AND (captured_units IS NULL OR captured_units >= 0) END) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_holds VALIDATE CONSTRAINT credit_holds_amount_ck;
--> statement-breakpoint
-- Open holds of a customer in a unit, by expiry: the gate's probe and the expiry pass.
CREATE INDEX IF NOT EXISTS credit_holds_unit_held_idx
  ON credit_holds (customer_id, unit_id, expires_at) WHERE status = 'held' AND unit_id IS NOT NULL;
--> statement-breakpoint
-- An automatic top-up for a unit with no rate: a threshold in units and the pack it buys.
ALTER TABLE credit_auto_topups ADD COLUMN IF NOT EXISTS threshold_units bigint;
--> statement-breakpoint
ALTER TABLE credit_auto_topups ADD COLUMN IF NOT EXISTS pack_price_id uuid REFERENCES prices(id);
--> statement-breakpoint
ALTER TABLE credit_auto_topups ADD COLUMN IF NOT EXISTS pack_quantity integer;
--> statement-breakpoint
-- "Recharge to N units": a run buys whole packs to reach at least this, in the unit's step.
ALTER TABLE credit_auto_topups ADD COLUMN IF NOT EXISTS target_units bigint;
--> statement-breakpoint
-- {hour|day|week|month: {count, amount_minor}}: the most a config may buy in each window.
ALTER TABLE credit_auto_topups ADD COLUMN IF NOT EXISTS purchase_limits jsonb;
--> statement-breakpoint
-- Charge tries of a run: a soft decline is tried again, 3 tries in 24 hours at most.
ALTER TABLE credit_auto_topup_runs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- A threshold top-up has a threshold in money or in units.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_auto_topups_threshold_ck'
      AND pg_get_constraintdef(oid) !~ 'threshold_units'
  ) THEN
    ALTER TABLE credit_auto_topups DROP CONSTRAINT credit_auto_topups_threshold_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_auto_topups_threshold_ck') THEN
    ALTER TABLE credit_auto_topups ADD CONSTRAINT credit_auto_topups_threshold_ck
      CHECK (("trigger" = 'threshold') = (threshold_minor IS NOT NULL OR threshold_units IS NOT NULL))
      NOT VALID;
  END IF;
  -- A target top-up has a target in money or in units.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'credit_auto_topups_target_ck'
      AND pg_get_constraintdef(oid) !~ 'target_units'
  ) THEN
    ALTER TABLE credit_auto_topups DROP CONSTRAINT credit_auto_topups_target_ck;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_auto_topups_target_ck') THEN
    ALTER TABLE credit_auto_topups ADD CONSTRAINT credit_auto_topups_target_ck
      CHECK ((method = 'target') = (target_minor IS NOT NULL OR target_units IS NOT NULL))
      NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_auto_topups_pack_ck') THEN
    ALTER TABLE credit_auto_topups ADD CONSTRAINT credit_auto_topups_pack_ck
      CHECK ((pack_price_id IS NOT NULL) = ((pack_quantity IS NOT NULL) <> (target_units IS NOT NULL))
        AND (pack_price_id IS NOT NULL OR (pack_quantity IS NULL AND target_units IS NULL))
        AND (pack_quantity IS NULL OR pack_quantity >= 1)
        AND (target_units IS NULL OR target_units > 0)
        AND (threshold_units IS NULL
          OR (threshold_units >= 0 AND threshold_minor IS NULL AND pack_price_id IS NOT NULL)))
      NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_auto_topups VALIDATE CONSTRAINT credit_auto_topups_threshold_ck;
--> statement-breakpoint
ALTER TABLE credit_auto_topups VALIDATE CONSTRAINT credit_auto_topups_target_ck;
--> statement-breakpoint
ALTER TABLE credit_auto_topups VALIDATE CONSTRAINT credit_auto_topups_pack_ck;
--> statement-breakpoint
-- A lease: a hold in units that is captured in steps. What it still reserves.
ALTER TABLE credit_holds ADD COLUMN IF NOT EXISTS remaining_units bigint;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_holds_remaining_ck') THEN
    ALTER TABLE credit_holds ADD CONSTRAINT credit_holds_remaining_ck
      CHECK (CASE WHEN unit_id IS NULL THEN remaining_units IS NULL
        ELSE remaining_units >= 0 AND remaining_units <= amount_units END) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_holds VALIDATE CONSTRAINT credit_holds_remaining_ck;
--> statement-breakpoint
-- A hold pins its grants: when a grant closes under open holds, the held units it backs stay
-- in its grace row (held_steps there) and count in pinned_steps here. The gate offers
-- available_steps - greatest(held_steps - pinned_steps, 0).
ALTER TABLE credit_unit_balances ADD COLUMN IF NOT EXISTS pinned_steps bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE credit_grant_grace ADD COLUMN IF NOT EXISTS held_steps bigint NOT NULL DEFAULT 0;
--> statement-breakpoint
-- The automatic top-up's threshold, copied here so the gate reads it with the row it locks,
-- and the mark the gate leaves when a take ends at or below it.
ALTER TABLE credit_unit_balances ADD COLUMN IF NOT EXISTS topup_threshold_steps bigint;
--> statement-breakpoint
ALTER TABLE credit_unit_balances ADD COLUMN IF NOT EXISTS topup_due_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_unit_balances_topup_due_idx
  ON credit_unit_balances (topup_due_at) WHERE topup_due_at IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_unit_balances_pinned_ck') THEN
    ALTER TABLE credit_unit_balances ADD CONSTRAINT credit_unit_balances_pinned_ck
      CHECK (pinned_steps >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_grant_grace_held_ck') THEN
    ALTER TABLE credit_grant_grace ADD CONSTRAINT credit_grant_grace_held_ck
      CHECK (held_steps >= 0 AND held_steps <= available_steps) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE credit_unit_balances VALIDATE CONSTRAINT credit_unit_balances_pinned_ck;
--> statement-breakpoint
ALTER TABLE credit_grant_grace VALIDATE CONSTRAINT credit_grant_grace_held_ck;
--> statement-breakpoint
-- Set by the gate when it refuses an event for credit, in the transaction that stores the
-- event. A refused event counts as cost and not as usage: usage reads and the rollup fold
-- leave it out; the daily cost fold keeps it. Metadata-only on every partition.
ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS refused_at timestamptz;
