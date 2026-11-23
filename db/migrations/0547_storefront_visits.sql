-- First-party, cookie-free analytics for the hosted checkout and the customer portal. One row
-- per buyer session, keyed by the session the buyer already has. No IP address and no full
-- user agent are ever stored: only the device category, browser and OS families, the
-- referrer HOST, the UTM tags and the edge's country code. Kept 13 months.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS storefront_visits (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  surface text NOT NULL,
  session_public_id text NOT NULL,
  checkout_session_id uuid REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  portal_session_id uuid REFERENCES portal_sessions(id) ON DELETE CASCADE,
  entered_at timestamptz,
  viewed_at timestamptz,
  referrer_host text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  device_category text,
  browser text,
  os text,
  country char(2),
  engaged_ms bigint NOT NULL DEFAULT 0,
  step_ms jsonb NOT NULL DEFAULT '{}'::jsonb,
  pdf_downloads integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  resource_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT storefront_visits_surface_ck CHECK (surface IN ('checkout', 'portal')),
  CONSTRAINT storefront_visits_device_ck
    CHECK (device_category IS NULL OR device_category IN ('desktop', 'mobile', 'tablet')),
  CONSTRAINT storefront_visits_session_ck CHECK (
    (surface = 'checkout' AND checkout_session_id IS NOT NULL AND portal_session_id IS NULL)
    OR (surface = 'portal' AND portal_session_id IS NOT NULL AND checkout_session_id IS NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS storefront_visits_session_uq
  ON storefront_visits (surface, session_public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS storefront_visits_business_idx
  ON storefront_visits (business_id, surface, viewed_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS storefront_visits_created_idx ON storefront_visits (created_at);
--> statement-breakpoint
-- Foreign-key lookups for the session cascades.
CREATE INDEX IF NOT EXISTS storefront_visits_checkout_session_idx
  ON storefront_visits (checkout_session_id) WHERE checkout_session_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS storefront_visits_portal_session_idx
  ON storefront_visits (portal_session_id) WHERE portal_session_id IS NOT NULL;
--> statement-breakpoint
REVOKE ALL ON storefront_visits FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON storefront_visits TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE storefront_visits ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'storefront_visits' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON storefront_visits
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bump_row_version ON storefront_visits;
--> statement-breakpoint
CREATE TRIGGER bump_row_version BEFORE UPDATE ON storefront_visits
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
