-- Bulk import from files: one run per upload, one row per file row. The file is parsed into
-- `import_rows` at upload, so no object store is needed. The run writes through the migration
-- engine; `import_records.run_id` marks what a run created, which is what undo deletes.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS import_runs (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN (
    'uploaded', 'checking', 'checked', 'queued', 'running', 'succeeded', 'partially_failed',
    'failed', 'undoing', 'undone', 'discarded'
  )),
  source_name text NOT NULL,
  files jsonb NOT NULL DEFAULT '[]'::jsonb,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary jsonb,
  result jsonb,
  error text,
  created_by text,
  created_by_user_id uuid,
  started_by text,
  started_by_user_id uuid,
  notified_at timestamptz,
  undone_by text,
  checked_at timestamptz,
  queued_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  undone_at timestamptz,
  heartbeat_at timestamptz,
  lease_token uuid,
  lease_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_runs_business_idx ON import_runs (business_id, created_at DESC);
--> statement-breakpoint
-- One run at a time writes into a business.
CREATE UNIQUE INDEX IF NOT EXISTS import_runs_one_active_uq ON import_runs (business_id)
  WHERE status IN ('queued', 'running', 'undoing');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS import_rows (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES import_runs(id) ON DELETE CASCADE,
  entity text NOT NULL,
  row_number integer NOT NULL,
  source_id text,
  raw jsonb NOT NULL,
  parsed jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  state text CHECK (state IN ('new', 'existing', 'invalid', 'excluded')),
  outcome text CHECK (outcome IN ('created', 'unchanged', 'failed', 'excluded')),
  outcome_message text,
  target_id uuid,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS import_rows_run_row_uq ON import_rows (run_id, entity, row_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_rows_run_source_idx ON import_rows (run_id, entity, source_id);
--> statement-breakpoint
ALTER TABLE import_records ADD COLUMN IF NOT EXISTS run_id uuid REFERENCES import_runs(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS import_records_run_idx ON import_records (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON import_runs TO tmbilling_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON import_rows TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE import_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'import_runs' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON import_runs
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'import_rows' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON import_rows
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- The member path runs as `tmbilling_app`, which cannot call graphile_worker.add_job (0201 says
-- why). This wrapper queues one of the three import jobs for a run of the caller's organization
-- in the matching status.
create or replace function public.app_queue_import_job(p_task text, p_run uuid, p_trace text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_task not in ('import_check', 'import_run', 'import_undo') then
    raise exception 'app_queue_import_job: unknown task %', p_task;
  end if;
  v_status := case p_task when 'import_check' then 'checking' when 'import_run' then 'queued' else 'undoing' end;
  if not exists (
    select 1 from public.import_runs r
     where r.id = p_run
       and r.status = v_status
       and r.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
  ) then
    raise exception 'app_queue_import_job: no % import % in this organization', v_status, p_run;
  end if;
  perform graphile_worker.add_job(
    p_task,
    json_strip_nulls(json_build_object(
      'run', p_run::text,
      '_trace', case when p_trace is null then null else json_build_object('traceId', p_trace) end
    )),
    max_attempts => 5,
    job_key => p_task || ':' || p_run::text
  );
end
$$;
--> statement-breakpoint
revoke all on function public.app_queue_import_job(text, uuid, text) from public;
--> statement-breakpoint
grant execute on function public.app_queue_import_job(text, uuid, text) to tmbilling_app;
