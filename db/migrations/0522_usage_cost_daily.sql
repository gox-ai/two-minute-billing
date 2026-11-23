-- The daily cost fold: the cost of each customer's usage per business-local day, meter and
-- group values, from the same rule a usage invoice line uses (`lineCost`). Derived and restated
-- (the trailing 35 days nightly), so rows are replaced, never amended. The margin report takes
-- from it only the usage no usage invoice line covers (`usage-margin.ts`).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS usage_cost_daily (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- The business-local date and its [local midnight, next local midnight).
  day date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  meter_id uuid NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  -- In the meter's group_by order.
  group_values text[] NOT NULL DEFAULT '{}',
  -- The group value under the meter's model key; '' = none.
  model text NOT NULL DEFAULT '',
  -- The customer's subscription live that day (null = none): its plan is the plan row.
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  currency char(3) NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  -- Null when the cost is unknown; see cost_basis.
  cost_minor bigint,
  cost_basis text NOT NULL CHECK (cost_basis IN ('event', 'price_list', 'mixed', 'partial', 'none', 'no_rate')),
  computed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS usage_cost_daily_key
  ON usage_cost_daily (business_id, day, customer_id, meter_id, group_values, currency);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_cost_daily_read_idx ON usage_cost_daily (business_id, starts_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_cost_daily_customer_idx ON usage_cost_daily (customer_id, meter_id, starts_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON usage_cost_daily TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE usage_cost_daily ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'usage_cost_daily' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON usage_cost_daily
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
