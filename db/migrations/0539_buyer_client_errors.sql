-- One row per payment or setup error the storefront showed a buyer, reported by the browser.
-- `leak` = the text is not made only of our payer wording. Written and read by the system role
-- only (ops), so the app role holds no privilege; RLS keeps the tenant rule anyway.
CREATE TABLE buyer_client_errors (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  created_at timestamptz NOT NULL DEFAULT now(),
  surface text NOT NULL,
  session_public_id text NOT NULL,
  organization_id uuid NOT NULL,
  business_id uuid NOT NULL,
  customer_id uuid,
  step text,
  page text,
  gateway text,
  gateway_type text,
  gateway_code text,
  decline_code text,
  gateway_message text,
  text text NOT NULL,
  field_error boolean NOT NULL DEFAULT false,
  leak boolean NOT NULL
);
--> statement-breakpoint
CREATE INDEX buyer_client_errors_created_idx ON buyer_client_errors (created_at);
--> statement-breakpoint
CREATE INDEX buyer_client_errors_session_idx ON buyer_client_errors (session_public_id, created_at);
--> statement-breakpoint
CREATE INDEX buyer_client_errors_business_idx ON buyer_client_errors (business_id, created_at);
--> statement-breakpoint
ALTER TABLE buyer_client_errors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY org_isolation ON buyer_client_errors
  USING (organization_id = current_setting('app.org_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
--> statement-breakpoint
REVOKE ALL ON buyer_client_errors FROM tmbilling_app;
