-- Usage paid in credits of a unit with no money rate. A meter states what one unit of it costs
-- in credits (meter_credit_costs, with a plan and a subscription override). Ingest takes the
-- credits from credit_unit_balances as each event arrives (credit_usage_events); settlement
-- then draws them from the grants (credit_usage_settlements). A grant that closes keeps what
-- is left for late events until its grace window ends (credit_grant_grace).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS meter_credit_costs (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  meter_id uuid NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES credit_units(id),
  -- Credits for one unit of the meter.
  credits_per_unit numeric(20, 6) NOT NULL,
  -- Both NULL = the meter's own cost. A row names a plan or a subscription, never both.
  product_id uuid REFERENCES products(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT meter_credit_costs_positive_ck CHECK (credits_per_unit > 0),
  CONSTRAINT meter_credit_costs_one_layer_ck CHECK (product_id IS NULL OR subscription_id IS NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS meter_credit_costs_meter_uq
  ON meter_credit_costs (meter_id) WHERE product_id IS NULL AND subscription_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS meter_credit_costs_product_uq
  ON meter_credit_costs (meter_id, product_id) WHERE product_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS meter_credit_costs_subscription_uq
  ON meter_credit_costs (meter_id, subscription_id) WHERE subscription_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS meter_credit_costs_business_idx ON meter_credit_costs (business_id);
--> statement-breakpoint
REVOKE ALL ON meter_credit_costs FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON meter_credit_costs TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE meter_credit_costs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'meter_credit_costs' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON meter_credit_costs
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- One row per settled window of a customer and meter. Append-only for the app role.
CREATE TABLE IF NOT EXISTS credit_usage_settlements (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  public_id text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  meter_id uuid NOT NULL REFERENCES meters(id),
  unit_id uuid NOT NULL REFERENCES credit_units(id),
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  -- 1, 2, 3… per customer and meter, counted under the customer lock.
  seq integer NOT NULL,
  -- usage: events received in the window. late: late events paid by one closed grant.
  kind text NOT NULL DEFAULT 'usage',
  grace_grant_id uuid REFERENCES credit_grants(id) ON DELETE SET NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  events integer NOT NULL DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  -- In the unit's smallest step.
  units_due bigint NOT NULL DEFAULT 0,
  units_drawn bigint NOT NULL DEFAULT 0,
  quantity_uncovered numeric NOT NULL DEFAULT 0,
  currency char(3) NOT NULL,
  -- Cost of the paid credit drawn: the revenue this settlement posted.
  revenue_minor bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'settled',
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT credit_usage_settlements_kind_ck CHECK (kind IN ('usage', 'late')),
  CONSTRAINT credit_usage_settlements_window_ck CHECK (window_end >= window_start),
  CONSTRAINT credit_usage_settlements_units_ck
    CHECK (units_due >= 0 AND units_drawn >= 0 AND units_drawn <= units_due AND revenue_minor >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_usage_settlements_public_id_uq
  ON credit_usage_settlements (public_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_usage_settlements_seq_uq
  ON credit_usage_settlements (customer_id, meter_id, seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_usage_settlements_customer_idx
  ON credit_usage_settlements (customer_id, window_end DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_usage_settlements_business_idx
  ON credit_usage_settlements (business_id);
--> statement-breakpoint
REVOKE ALL ON credit_usage_settlements FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON credit_usage_settlements TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE credit_usage_settlements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_usage_settlements' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_usage_settlements
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- What the gate decided for one usage event on a meter with a credit cost. A late event may
-- be paid in two parts: by a closed grant in its grace window, then by the balance.
CREATE TABLE IF NOT EXISTS credit_usage_events (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  -- NULL: the event matched no customer when it arrived.
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  meter_id uuid NOT NULL REFERENCES meters(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES credit_units(id),
  -- usage_events is partitioned: no foreign key.
  event_id uuid NOT NULL,
  event_key text NOT NULL,
  event_timestamp timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  part smallint NOT NULL DEFAULT 0,
  -- The event's quantity on the meter and what it costs; on part 0 only.
  quantity numeric NOT NULL DEFAULT 0,
  credits_per_unit numeric(20, 6) NOT NULL,
  cost_source text NOT NULL DEFAULT 'meter',
  units_due bigint NOT NULL DEFAULT 0,
  units_uncovered bigint NOT NULL DEFAULT 0,
  -- Taken by this part, in the unit's smallest step.
  units bigint NOT NULL DEFAULT 0,
  source text NOT NULL DEFAULT 'balance',
  grace_grant_id uuid REFERENCES credit_grants(id) ON DELETE SET NULL,
  -- taken: awaits settlement. pending: awaits the end of the grant's grace window.
  -- refused and skipped spend nothing and are never settled.
  status text NOT NULL,
  reason text,
  covered_by_hold boolean NOT NULL DEFAULT false,
  settlement_id uuid REFERENCES credit_usage_settlements(id),
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT credit_usage_events_status_ck
    CHECK (status IN ('taken', 'pending', 'settled', 'refused', 'skipped')),
  CONSTRAINT credit_usage_events_source_ck CHECK (source IN ('balance', 'grace')),
  CONSTRAINT credit_usage_events_cost_source_ck
    CHECK (cost_source IN ('meter', 'plan', 'subscription')),
  CONSTRAINT credit_usage_events_grace_ck CHECK ((source = 'grace') = (grace_grant_id IS NOT NULL)),
  CONSTRAINT credit_usage_events_units_ck
    CHECK (units >= 0 AND units_due >= 0 AND units_uncovered >= 0),
  -- Nothing is taken for a refused or skipped event, and it carries its reason.
  CONSTRAINT credit_usage_events_unbilled_ck
    CHECK (status NOT IN ('refused', 'skipped') OR (units = 0 AND reason IS NOT NULL)),
  CONSTRAINT credit_usage_events_settled_ck CHECK ((status = 'settled') = (settlement_id IS NOT NULL)),
  CONSTRAINT credit_usage_events_customer_ck
    CHECK (customer_id IS NOT NULL OR status IN ('refused', 'skipped'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS credit_usage_events_event_uq
  ON credit_usage_events (event_id, meter_id, part);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_usage_events_open_idx
  ON credit_usage_events (customer_id, unit_id) WHERE status = 'taken';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_usage_events_pending_idx
  ON credit_usage_events (grace_grant_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_usage_events_due_idx
  ON credit_usage_events (received_at) WHERE status = 'taken';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_usage_events_customer_received_idx
  ON credit_usage_events (customer_id, meter_id, received_at);
--> statement-breakpoint
-- A replay of a key answers as the first time did.
CREATE INDEX IF NOT EXISTS credit_usage_events_key_idx ON credit_usage_events (business_id, event_key);
--> statement-breakpoint
REVOKE ALL ON credit_usage_events FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON credit_usage_events TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE credit_usage_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_usage_events' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_usage_events
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- What a closed grant still has for late events dated inside its life. Out of the balance row
-- from the close on; booked out of the grant when the window ends (locked_at).
CREATE TABLE IF NOT EXISTS credit_grant_grace (
  grant_id uuid PRIMARY KEY REFERENCES credit_grants(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES credit_units(id),
  available_steps bigint NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz NOT NULL,
  locks_at timestamptz NOT NULL,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT credit_grant_grace_available_ck CHECK (available_steps >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grant_grace_open_idx
  ON credit_grant_grace (customer_id, unit_id) WHERE locked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grant_grace_due_idx
  ON credit_grant_grace (locks_at) WHERE locked_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grant_grace_business_idx ON credit_grant_grace (business_id);
--> statement-breakpoint
REVOKE ALL ON credit_grant_grace FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON credit_grant_grace TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE credit_grant_grace ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'credit_grant_grace' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON credit_grant_grace
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- A draw made by a settlement names it, as an invoice draw names its invoice.
ALTER TABLE credit_grant_movements
  ADD COLUMN IF NOT EXISTS settlement_id uuid REFERENCES credit_usage_settlements(id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grant_movements_settlement_idx
  ON credit_grant_movements (settlement_id) WHERE settlement_id IS NOT NULL;
--> statement-breakpoint
-- NOT VALID: checked on every new row, with no scan of the rows already there.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'credit_grant_movements_draw_source_ck') THEN
    ALTER TABLE credit_grant_movements ADD CONSTRAINT credit_grant_movements_draw_source_ck
      CHECK (kind <> 'draw' OR invoice_id IS NOT NULL OR settlement_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
-- A grant in a unit with no rate whose units are not in credit_unit_balances: it has not
-- started, or it ended and its renewal has not closed it yet. The gate at ingest moves a
-- grant in and out at the instant it runs, so the row offers only what may pay now.
ALTER TABLE credit_grants ADD COLUMN IF NOT EXISTS out_of_balance boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS credit_grants_out_of_balance_idx
  ON credit_grants (customer_id, unit_id) WHERE out_of_balance AND status = 'active';
--> statement-breakpoint
-- The gate's probe: active grants of a customer and unit with no rate, by expiry.
CREATE INDEX IF NOT EXISTS credit_grants_unit_expiry_idx
  ON credit_grants (customer_id, unit_id, expires_at)
  WHERE status = 'active' AND NOT unit_rated AND expires_at IS NOT NULL;
