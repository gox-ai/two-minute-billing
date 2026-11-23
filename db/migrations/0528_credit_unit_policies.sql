-- Credit unit policies for usage past the credits (step 6 settings; the gate reads them later).
-- credit_unit_policies: an optional overage price per credit and what a plan reset does with an
-- unbilled negative balance. credit_overdraft_limits: how far below 0 a balance may go, per unit,
-- with a plan and a customer override. No row = today: no overage price, carry, limit 0.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_unit_policies (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES credit_units(id) ON DELETE CASCADE,
  -- Minor units of the unit's currency for one credit, × 10^12. NULL = no overage price.
  overage_minor_per_unit_e12 bigint,
  negative_at_reset text NOT NULL DEFAULT 'carry',
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  resource_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT credit_unit_policies_overage_ck CHECK (overage_minor_per_unit_e12 IS NULL OR overage_minor_per_unit_e12 > 0),
  CONSTRAINT credit_unit_policies_reset_ck CHECK (negative_at_reset IN ('carry', 'forgive'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_unit_policies_unit_uq ON credit_unit_policies (unit_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS credit_overdraft_limits (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES credit_units(id) ON DELETE CASCADE,
  -- Both NULL = the unit's own limit. A row names a plan or a customer, never both.
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  -- In the unit's smallest step.
  limit_steps bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  resource_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT credit_overdraft_limits_nonnegative_ck CHECK (limit_steps >= 0),
  CONSTRAINT credit_overdraft_limits_one_layer_ck CHECK (product_id IS NULL OR customer_id IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_overdraft_limits_unit_uq
  ON credit_overdraft_limits (unit_id) WHERE product_id IS NULL AND customer_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_overdraft_limits_product_uq
  ON credit_overdraft_limits (unit_id, product_id) WHERE product_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_overdraft_limits_customer_uq
  ON credit_overdraft_limits (unit_id, customer_id) WHERE customer_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_overdraft_limits_customer_idx ON credit_overdraft_limits (customer_id);
--> statement-breakpoint
REVOKE ALL ON credit_unit_policies FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_unit_policies TO tmbilling_app;
--> statement-breakpoint
REVOKE ALL ON credit_overdraft_limits FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON credit_overdraft_limits TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE credit_unit_policies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE credit_overdraft_limits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_unit_policies' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_unit_policies
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_overdraft_limits' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_overdraft_limits
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bump_row_version ON credit_unit_policies;
--> statement-breakpoint
CREATE TRIGGER bump_row_version BEFORE UPDATE ON credit_unit_policies
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
--> statement-breakpoint
DROP TRIGGER IF EXISTS bump_row_version ON credit_overdraft_limits;
--> statement-breakpoint
CREATE TRIGGER bump_row_version BEFORE UPDATE ON credit_overdraft_limits
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
