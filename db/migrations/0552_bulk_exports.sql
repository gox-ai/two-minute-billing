-- Bulk export to files: one run per export, the files kept as compressed parts in
-- `export_parts`, so no object store is needed. Each CSV has the columns the file import
-- reads (bulk-import/templates.ts), so an export imports into another business as it is.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- An import's undo runs in the background too: email the member who asked for it, once.
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS undone_by_user_id uuid;
--> statement-breakpoint
ALTER TABLE import_runs ADD COLUMN IF NOT EXISTS undo_notified_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS export_runs (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'running', 'succeeded', 'failed', 'expired', 'deleted'
  )),
  entities jsonb NOT NULL DEFAULT '[]'::jsonb,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  include_related boolean NOT NULL DEFAULT true,
  -- Per entity: filename, rows, related rows, bytes, compressed bytes, crc32, parts.
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Rows left out, and why (a price the import cannot read, a draft invoice).
  skipped jsonb NOT NULL DEFAULT '[]'::jsonb,
  progress jsonb,
  size_bytes bigint NOT NULL DEFAULT 0,
  error text,
  created_by text,
  created_by_user_id uuid,
  notified_at timestamptz,
  snapshot_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz,
  deleted_at timestamptz,
  deleted_by text,
  heartbeat_at timestamptz,
  lease_token uuid,
  lease_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS export_runs_business_idx ON export_runs (business_id, created_at DESC);
--> statement-breakpoint
-- One export at a time per business.
CREATE UNIQUE INDEX IF NOT EXISTS export_runs_one_active_uq ON export_runs (business_id)
  WHERE status IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS export_runs_expiry_idx ON export_runs (expires_at)
  WHERE status = 'succeeded';
--> statement-breakpoint
-- A file of a run, in deflate-compressed parts of up to 8 MB, in order.
CREATE TABLE IF NOT EXISTS export_parts (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES export_runs(id) ON DELETE CASCADE,
  entity text NOT NULL,
  seq integer NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS export_parts_run_seq_uq ON export_parts (run_id, entity, seq);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON export_runs TO tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON export_parts TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE export_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE export_parts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'export_runs' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON export_runs
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'export_parts' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON export_parts
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- The member path runs as `tmbilling_app`, which cannot call graphile_worker.add_job (0201 says
-- why). This wrapper queues the export job for a queued run of the caller's organization.
create or replace function public.app_queue_export_job(p_run uuid, p_trace text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.export_runs r
     where r.id = p_run
       and r.status = 'queued'
       and r.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
  ) then
    raise exception 'app_queue_export_job: no queued export % in this organization', p_run;
  end if;
  perform graphile_worker.add_job(
    'export_run',
    json_strip_nulls(json_build_object(
      'run', p_run::text,
      '_trace', case when p_trace is null then null else json_build_object('traceId', p_trace) end
    )),
    max_attempts => 5,
    job_key => 'export_run:' || p_run::text
  );
end
$$;
--> statement-breakpoint
revoke all on function public.app_queue_export_job(uuid, text) from public;
--> statement-breakpoint
grant execute on function public.app_queue_export_job(uuid, text) to tmbilling_app;
