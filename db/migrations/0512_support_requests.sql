-- Support requests (Cloud): the assistant drafts one, the member sends it, our staff answer it in
-- the back-office. The member reads the thread in the assistant panel. Tenant rows behind RLS;
-- the back-office reads and writes them through the system connection.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS support_request_number_seq START 1001;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS support_requests (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  number integer NOT NULL DEFAULT nextval('support_request_number_seq'),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  conversation_id uuid REFERENCES assistant_conversations(id) ON DELETE SET NULL,
  subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  status text NOT NULL CHECK (status IN ('open', 'waiting', 'resolved')),
  context jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key text NOT NULL,
  last_member_reply_at timestamptz,
  last_staff_reply_at timestamptz,
  member_unread_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  resource_version bigint NOT NULL DEFAULT 1
);
--> statement-breakpoint
ALTER SEQUENCE support_request_number_seq OWNED BY support_requests.number;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS support_requests_public_id_uq ON support_requests (public_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS support_requests_number_uq ON support_requests (number);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS support_requests_idempotency_uq ON support_requests (organization_id, user_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_requests_member_idx ON support_requests (organization_id, user_id, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_requests_status_idx ON support_requests (status, updated_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS support_messages (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES support_requests(id) ON DELETE CASCADE,
  author_kind text NOT NULL CHECK (author_kind IN ('member', 'staff', 'system')),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  attachments jsonb,
  staff_by text,
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS support_messages_public_id_uq ON support_messages (public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS support_messages_request_idx ON support_messages (request_id, created_at);
--> statement-breakpoint
-- The back-office's notify pass reads only messages it has not claimed yet.
CREATE INDEX IF NOT EXISTS support_messages_unnotified_idx ON support_messages (created_at) WHERE notified_at IS NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON support_requests, support_messages TO tmbilling_app;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE support_request_number_seq TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['support_requests', 'support_messages'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I USING (organization_id = current_setting(''app.org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.org_id'', true)::uuid)',
        t
      );
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS bump_row_version ON support_requests;
--> statement-breakpoint
CREATE TRIGGER bump_row_version BEFORE UPDATE ON support_requests
  FOR EACH ROW EXECUTE FUNCTION bump_row_version();
