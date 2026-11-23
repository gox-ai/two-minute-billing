-- Email open and click tracking. A business turns it on in its email settings
-- (`email_config.trackEngagement`); only then do we add a pixel and link redirects at send time.
-- Stored: the time, a device/browser/OS family and the link (host, masked path, label).
-- Never stored: the IP address, the full user agent, the recipient address, a query string.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE email_messages
  ADD COLUMN IF NOT EXISTS engagement_tracked_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_opened_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_clicked_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_messages_tracked_idx
  ON email_messages (business_id, engagement_tracked_at) WHERE engagement_tracked_at IS NOT NULL;
--> statement-breakpoint
-- The original URL of each tracked link. The redirect reads it from here, never from the request.
CREATE TABLE IF NOT EXISTS email_links (
  email_message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  url text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  PRIMARY KEY (email_message_id, position)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_links_org_idx ON email_links (organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_links_business_idx ON email_links (business_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_links_created_idx ON email_links (created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS email_engagements (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  email_message_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  kind text NOT NULL,
  machine boolean NOT NULL DEFAULT false,
  link_position smallint,
  link_label text,
  link_host text,
  link_path text,
  device_category text,
  browser text,
  os text,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  resource_version bigint NOT NULL DEFAULT 1,
  CONSTRAINT email_engagements_kind_ck CHECK (kind IN ('open', 'click')),
  CONSTRAINT email_engagements_device_ck
    CHECK (device_category IS NULL OR device_category IN ('desktop', 'mobile', 'tablet'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_engagements_business_idx
  ON email_engagements (business_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_engagements_email_idx ON email_engagements (email_message_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_engagements_org_idx ON email_engagements (organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_engagements_created_idx ON email_engagements (created_at);
--> statement-breakpoint
REVOKE ALL ON email_links, email_engagements FROM tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON email_links, email_engagements TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE email_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE email_engagements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_links' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON email_links
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'email_engagements' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON email_engagements
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bump_row_version ON email_engagements;
--> statement-breakpoint
CREATE TRIGGER bump_row_version BEFORE UPDATE ON email_engagements
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
