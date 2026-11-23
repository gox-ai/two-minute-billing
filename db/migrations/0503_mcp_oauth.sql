-- OAuth 2.1 for the MCP server. Clients and pending requests exist before an organization is
-- known, so they are platform tables the app role cannot reach; grants and tokens are tenant
-- rows behind RLS. Only hashes of codes and tokens are stored.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_clients (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  client_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('dcr', 'cimd')),
  client_name text,
  redirect_uris jsonb NOT NULL,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS oauth_clients_client_id_uq ON oauth_clients (client_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_requests (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  state text,
  code_challenge text NOT NULL,
  scope text NOT NULL,
  resource text,
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS oauth_requests_public_id_uq ON oauth_requests (public_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_grants (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  api_key_id uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  client_id text NOT NULL,
  client_name text,
  scope text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_grants_org_idx ON oauth_grants (organization_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS oauth_grants_public_id_uq ON oauth_grants (public_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  grant_id uuid NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('code', 'access', 'refresh')),
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  -- A code is bound to the request that produced it.
  redirect_uri text,
  code_challenge text,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS oauth_tokens_hash_uq ON oauth_tokens (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS oauth_tokens_grant_idx ON oauth_tokens (grant_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_grants, oauth_tokens TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE oauth_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'oauth_grants' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON oauth_grants
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'oauth_tokens' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON oauth_tokens
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
