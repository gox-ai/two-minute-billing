-- A plan change held until its invoice is paid (`failed_change_charge: apply_when_paid`).
-- The invoice is raised and collected at the request; the change itself applies only when
-- that invoice is paid, priced as of `requested_at`. One live (pending) row per subscription.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS subscription_pending_changes (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  public_id text NOT NULL,
  -- The invoice that pays for the change. Its payment applies the change.
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  -- change = /change, update_for_items, checkout, portal; item_add = POST …/items.
  kind text NOT NULL,
  -- The request as the caller sent it (display, and to match a repeat of it).
  request jsonb NOT NULL,
  request_hash text NOT NULL,
  -- What applying writes, computed at the request; replayed only on an unchanged subscription.
  plan jsonb NOT NULL,
  -- The subscription's items, term and coupons at the request.
  fingerprint text NOT NULL,
  -- Credit notes the change raised at the request (unused time), voided with the invoice.
  credit_note_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- What a void puts back on the subscription (a hosted change's coupons, card, PO number).
  restore jsonb,
  source text NOT NULL DEFAULT 'api',
  requested_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  -- Why a pending change ended without applying.
  end_reason text,
  applied_at timestamptz,
  ended_at timestamptz,
  -- The invoice was paid but the change could not apply: the credit note that gave it back.
  kept_credit_note text,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  resource_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT subscription_pending_changes_kind_ck CHECK (kind IN ('change', 'item_add')),
  CONSTRAINT subscription_pending_changes_status_ck
    CHECK (status IN ('pending', 'applied', 'expired', 'cancelled')),
  CONSTRAINT subscription_pending_changes_reason_ck
    CHECK (end_reason IS NULL OR end_reason IN ('expired', 'replaced', 'cancelled', 'voided', 'moved')),
  CONSTRAINT subscription_pending_changes_source_ck
    CHECK (source IN ('api', 'dashboard', 'checkout', 'portal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscription_pending_changes_public_id_uq
  ON subscription_pending_changes (public_id);
--> statement-breakpoint
-- One pending change per subscription.
CREATE UNIQUE INDEX IF NOT EXISTS subscription_pending_changes_live_uq
  ON subscription_pending_changes (subscription_id) WHERE status = 'pending';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS subscription_pending_changes_invoice_uq
  ON subscription_pending_changes (invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS subscription_pending_changes_due_idx
  ON subscription_pending_changes (expires_at) WHERE status = 'pending';
--> statement-breakpoint
REVOKE ALL ON subscription_pending_changes FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON subscription_pending_changes TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE subscription_pending_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'subscription_pending_changes' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON subscription_pending_changes
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bump_row_version ON subscription_pending_changes;
--> statement-breakpoint
CREATE TRIGGER bump_row_version BEFORE UPDATE ON subscription_pending_changes
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
