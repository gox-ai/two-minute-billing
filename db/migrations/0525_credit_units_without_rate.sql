-- A credit unit may have no money rate: its credits are counted in units only, and each
-- grant carries its own money as its cost basis. Existing units keep their rate (no backfill).
-- credit_unit_balances is the real-time balance of such a unit, one row per customer and
-- unit: the sum of what is left on the customer's grants in it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- NULL = no rate. The > 0 CHECK still holds for every unit that has one.
ALTER TABLE credit_units ALTER COLUMN minor_per_unit_e12 DROP NOT NULL;
--> statement-breakpoint
-- Copied from the unit at insert, so the face CHECK needs no join. Metadata-only: no rewrite.
ALTER TABLE credit_grants ADD COLUMN IF NOT EXISTS unit_rated boolean NOT NULL DEFAULT true;
--> statement-breakpoint
-- The face rule moves from "always > 0" to "0 exactly when the unit has no rate".
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'credit_grants'::regclass AND contype = 'c'
      AND conname <> 'credit_grants_face_rated_ck'
      AND pg_get_constraintdef(oid) ~ 'face_minor > 0'
  LOOP
    EXECUTE format('ALTER TABLE credit_grants DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_grants_face_rated_ck') THEN
    ALTER TABLE credit_grants ADD CONSTRAINT credit_grants_face_rated_ck
      CHECK (CASE WHEN unit_rated THEN face_minor > 0 ELSE face_minor = 0 END) NOT VALID;
  END IF;
  -- Money always has a rate.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_grants_unrated_unit_ck') THEN
    ALTER TABLE credit_grants ADD CONSTRAINT credit_grants_unrated_unit_ck
      CHECK (unit_rated OR unit_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- Validated apart: the scan then holds a lock that lets reads and writes go on.
ALTER TABLE credit_grants VALIDATE CONSTRAINT credit_grants_face_rated_ck;
--> statement-breakpoint
ALTER TABLE credit_grants VALIDATE CONSTRAINT credit_grants_unrated_unit_ck;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_unit_balances (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES credit_units(id),
  -- In the unit's smallest step. Moved in the transaction that writes the grant movement.
  available_steps bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_unit_balances_customer_unit_uq
  ON credit_unit_balances (customer_id, unit_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_unit_balances_business_idx ON credit_unit_balances (business_id);
--> statement-breakpoint
-- Never deleted by the app: a balance of 0 stays as a row.
REVOKE ALL ON credit_unit_balances FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON credit_unit_balances TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE credit_unit_balances ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_unit_balances' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_unit_balances
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
