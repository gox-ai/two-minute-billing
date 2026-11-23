-- Embedding calls on the platform key: docs index runs (no organization) and search queries
-- (the asking organization when known, else none). Kept apart from assistant_usage so it never
-- counts toward an organization's allowance or its per-member limits.
-- Written and read by the system connection only; RLS hides it from the app role regardless.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_embedding_usage (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('index', 'query')),
  provider text NOT NULL,
  model text NOT NULL,
  -- Texts embedded: sections in an index run, 1 for a query.
  inputs integer NOT NULL,
  input_tokens integer NOT NULL,
  -- USD minor units in Fixed12 (× 10^12), from the model price list; null when unpriced.
  cost_fixed12 numeric(38, 0),
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_embedding_usage_created_idx ON assistant_embedding_usage (created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_embedding_usage_org_created_idx ON assistant_embedding_usage (organization_id, created_at);
--> statement-breakpoint
ALTER TABLE assistant_embedding_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'assistant_embedding_usage' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON assistant_embedding_usage
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
