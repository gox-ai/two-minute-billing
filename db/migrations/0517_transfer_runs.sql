-- Transfer runs: a persisted plan, then an asynchronous apply on the engine's job queue.
-- A `transfer_configurations` row with run_kind 'async' is the plan and its run; its items live
-- in `transfer_items`, one per object or setting, each with its own status. Legacy synchronous
-- runs keep run_kind 'sync' and the old columns.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE transfer_configurations
  ADD COLUMN IF NOT EXISTS run_kind text NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS conflict_policy jsonb,
  ADD COLUMN IF NOT EXISTS validation jsonb,
  ADD COLUMN IF NOT EXISTS counts jsonb,
  ADD COLUMN IF NOT EXISTS planned_by text,
  ADD COLUMN IF NOT EXISTS started_by text,
  ADD COLUMN IF NOT EXISTS started_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS queued_at timestamptz,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cancel_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS notified_at timestamptz;
--> statement-breakpoint
ALTER TABLE transfer_configurations DROP CONSTRAINT IF EXISTS transfer_configurations_status_ck;
--> statement-breakpoint
ALTER TABLE transfer_configurations ADD CONSTRAINT transfer_configurations_status_ck CHECK (
  status IN ('planned', 'queued', 'running', 'succeeded', 'partially_failed', 'failed', 'cancelled', 'superseded')
);
--> statement-breakpoint
ALTER TABLE transfer_configurations DROP CONSTRAINT IF EXISTS transfer_configurations_run_kind_ck;
--> statement-breakpoint
ALTER TABLE transfer_configurations ADD CONSTRAINT transfer_configurations_run_kind_ck CHECK (run_kind IN ('sync', 'async'));
--> statement-breakpoint
-- One active async run per destination; the service also checks the twin destination.
CREATE UNIQUE INDEX IF NOT EXISTS transfer_configurations_one_active_uq
  ON transfer_configurations (destination_business_id)
  WHERE run_kind = 'async' AND status IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfer_configurations_source_status_idx
  ON transfer_configurations (source_business_id, status, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transfer_items (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  transfer_id uuid NOT NULL REFERENCES transfer_configurations(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  pair text NOT NULL DEFAULT 'main' CHECK (pair IN ('main', 'twin')),
  section text NOT NULL,
  kind text NOT NULL,
  key text NOT NULL,
  label text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'unchanged', 'skip', 'blocked', 'delete')),
  excluded boolean NOT NULL DEFAULT false,
  depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
  diff jsonb,
  messages jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_ref text,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  error text,
  skip_reason text CHECK (skip_reason IN ('unchanged', 'excluded', 'dependency', 'cancelled', 'drift')),
  result_ref text,
  replaced jsonb,
  attempts integer NOT NULL DEFAULT 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
-- The item's idempotency key: one row per run, pair and natural key.
CREATE UNIQUE INDEX IF NOT EXISTS transfer_items_key_uq ON transfer_items (transfer_id, pair, key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transfer_items_run_seq_idx ON transfer_items (transfer_id, seq);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON transfer_items TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE transfer_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'transfer_items' AND policyname = 'org_isolation') THEN
    CREATE POLICY org_isolation ON transfer_items
      USING (organization_id = current_setting('app.org_id', true)::uuid)
      WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid);
  END IF;
END $$;
--> statement-breakpoint
-- The member path runs as `tmbilling_app`, which cannot call graphile_worker.add_job (0201 says
-- why). This wrapper queues only the run job of a queued async run in the caller's organization.
create or replace function public.app_queue_transfer_run(p_run uuid, p_trace text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.transfer_configurations t
     where t.id = p_run
       and t.run_kind = 'async'
       and t.status = 'queued'
       and t.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
  ) then
    raise exception 'app_queue_transfer_run: no queued transfer % in this organization', p_run;
  end if;
  perform graphile_worker.add_job(
    'transfer_run',
    json_strip_nulls(json_build_object(
      'run', p_run::text,
      '_trace', case when p_trace is null then null else json_build_object('traceId', p_trace) end
    )),
    max_attempts => 5,
    job_key => 'transfer_run:' || p_run::text
  );
end
$$;
--> statement-breakpoint
revoke all on function public.app_queue_transfer_run(uuid, text) from public;
--> statement-breakpoint
grant execute on function public.app_queue_transfer_run(uuid, text) to tmbilling_app;
