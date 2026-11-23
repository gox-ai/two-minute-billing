-- Billy, the in-app assistant: answer feedback, follow-ups/questions/proposals on a message,
-- image attachments, and actions the member confirms (off until an owner turns them on).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE assistant_messages
  ADD COLUMN IF NOT EXISTS extras jsonb,
  ADD COLUMN IF NOT EXISTS feedback text CHECK (feedback IN ('up', 'down')),
  ADD COLUMN IF NOT EXISTS feedback_comment text,
  ADD COLUMN IF NOT EXISTS feedback_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_messages_feedback_idx ON assistant_messages (feedback_at DESC) WHERE feedback IS NOT NULL;
--> statement-breakpoint
ALTER TABLE assistant_settings
  ADD COLUMN IF NOT EXISTS actions_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS money_actions_enabled boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Screenshots only (PNG, JPEG, WebP; checked by their bytes), 10 MB at most. Deleted with the
-- conversation, and in any case after 90 days.
CREATE TABLE IF NOT EXISTS assistant_attachments (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  name text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size integer NOT NULL CHECK (size > 0 AND size <= 10485760),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS assistant_attachments_public_id_uq ON assistant_attachments (public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_attachments_created_idx ON assistant_attachments (created_at);
--> statement-breakpoint
-- A change the assistant prepared and the member confirmed (or not). The request is stored as
-- sent, so what the member saw is what ran.
CREATE TABLE IF NOT EXISTS assistant_actions (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES assistant_conversations(id) ON DELETE SET NULL,
  user_id uuid NOT NULL,
  operation text NOT NULL,
  method text NOT NULL CHECK (method IN ('POST', 'PATCH', 'DELETE')),
  path text NOT NULL,
  body jsonb,
  tier smallint NOT NULL CHECK (tier IN (1, 2, 3)),
  status text NOT NULL CHECK (status IN ('proposed', 'running', 'done', 'failed', 'cancelled', 'expired')),
  idempotency_key text NOT NULL,
  summary jsonb NOT NULL,
  result jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  decided_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS assistant_actions_public_id_uq ON assistant_actions (public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_actions_org_created_idx ON assistant_actions (organization_id, created_at DESC);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_attachments, assistant_actions TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE assistant_attachments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_actions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_attachments', 'assistant_actions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I USING (organization_id = current_setting(''app.org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.org_id'', true)::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;
