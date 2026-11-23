-- Coupons on every kind of invoice. A redemption now belongs to a customer and has a scope:
--   subscription — attached to a subscription (every row before this migration);
--   invoice      — redeemed on one invoice with no subscription; applies once;
--   customer     — attached to the customer, no subscription and no invoice.
-- `released` is a new status value (a voided one-off invoice gives its redemption back).
-- There is no status CHECK on this table, so no constraint changes for it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE applied_coupons ALTER COLUMN subscription_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE applied_coupons ADD COLUMN IF NOT EXISTS customer_id uuid
  REFERENCES customers(id) ON DELETE CASCADE;
--> statement-breakpoint
UPDATE applied_coupons ac
   SET customer_id = s.customer_id
  FROM subscriptions s
 WHERE s.id = ac.subscription_id AND ac.customer_id IS NULL;
--> statement-breakpoint
ALTER TABLE applied_coupons ALTER COLUMN customer_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE applied_coupons ADD COLUMN IF NOT EXISTS invoice_id uuid
  REFERENCES invoices(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE applied_coupons ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'subscription';
--> statement-breakpoint
ALTER TABLE applied_coupons DROP CONSTRAINT IF EXISTS applied_coupons_scope_ck;
--> statement-breakpoint
ALTER TABLE applied_coupons ADD CONSTRAINT applied_coupons_scope_ck
  CHECK (scope IN ('subscription', 'invoice', 'customer'));
--> statement-breakpoint
-- A subscription row names its subscription; an invoice row names none.
ALTER TABLE applied_coupons DROP CONSTRAINT IF EXISTS applied_coupons_scope_target_ck;
--> statement-breakpoint
ALTER TABLE applied_coupons ADD CONSTRAINT applied_coupons_scope_target_ck
  CHECK (
    (scope <> 'subscription' OR subscription_id IS NOT NULL)
    AND (scope <> 'invoice' OR subscription_id IS NULL)
  );
--> statement-breakpoint
-- Serves the per-customer limit count.
CREATE INDEX IF NOT EXISTS applied_coupons_coupon_customer_idx
  ON applied_coupons (coupon_id, customer_id);
--> statement-breakpoint
-- Serves the void release (rows that carry the voided invoice's id).
CREATE INDEX IF NOT EXISTS applied_coupons_invoice_idx
  ON applied_coupons (invoice_id) WHERE invoice_id IS NOT NULL;
--> statement-breakpoint
-- How the per-customer limit counts: by customer row, or by the customer's email
-- (trimmed, lower-cased), for stores that create a new customer on every purchase.
ALTER TABLE coupons ADD COLUMN IF NOT EXISTS per_customer_limit_by text NOT NULL DEFAULT 'customer';
--> statement-breakpoint
ALTER TABLE coupons DROP CONSTRAINT IF EXISTS coupons_per_customer_limit_by_ck;
--> statement-breakpoint
ALTER TABLE coupons ADD CONSTRAINT coupons_per_customer_limit_by_ck
  CHECK (per_customer_limit_by IN ('customer', 'email'));
--> statement-breakpoint
-- A customer row names neither a subscription nor an invoice.
ALTER TABLE applied_coupons DROP CONSTRAINT IF EXISTS applied_coupons_customer_target_ck;
--> statement-breakpoint
ALTER TABLE applied_coupons ADD CONSTRAINT applied_coupons_customer_target_ck
  CHECK (scope <> 'customer' OR (subscription_id IS NULL AND invoice_id IS NULL));
--> statement-breakpoint
-- At most one active application of a coupon to a customer. The subscription index cannot
-- catch it: its subscription_id is NULL here, and NULLs never conflict. Also serves the
-- read of a customer's active coupons on every invoice.
CREATE UNIQUE INDEX IF NOT EXISTS applied_coupons_customer_active_uq
  ON applied_coupons (customer_id, coupon_id)
  WHERE scope = 'customer' AND status = 'active';
--> statement-breakpoint
-- An unbilled charge booked net of the subscription's coupons (a deferred period). The
-- invoice that bills it takes no coupon off it again, so the coupon applies once.
ALTER TABLE unbilled_charges ADD COLUMN IF NOT EXISTS discounted boolean NOT NULL DEFAULT false;
