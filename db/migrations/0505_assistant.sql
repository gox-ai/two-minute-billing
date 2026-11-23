-- The in-app assistant: per-organization settings (on/off, an optional own model key, stored
-- encrypted), the member's conversations and messages, and an append-only usage ledger that
-- the monthly cap and the cost reports read. All tenant rows behind RLS.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  provider text CHECK (provider IN ('openai', 'anthropic', 'google')),
  model text,
  api_key_encrypted text,
  api_key_last4 text,
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS assistant_conversations_public_id_uq ON assistant_conversations (public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_conversations_member_idx ON assistant_conversations (organization_id, user_id, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_messages (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES assistant_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  steps jsonb,
  data jsonb,
  figures jsonb,
  page jsonb,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_messages_conversation_idx ON assistant_messages (conversation_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_usage (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  conversation_id uuid REFERENCES assistant_conversations(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  billed_to text NOT NULL CHECK (billed_to IN ('platform', 'organization')),
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  -- USD minor units in Fixed12 (× 10^12), from the model price book; null when unpriced.
  cost_fixed12 numeric(38, 0),
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_usage_org_created_idx ON assistant_usage (organization_id, created_at);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON assistant_settings, assistant_conversations, assistant_messages, assistant_usage TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE assistant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE assistant_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['assistant_settings', 'assistant_conversations', 'assistant_messages', 'assistant_usage'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I USING (organization_id = current_setting(''app.org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.org_id'', true)::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;
