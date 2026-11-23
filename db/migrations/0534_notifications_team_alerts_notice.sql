-- One-time notice: team alerts became notifications. Enqueues the job once; it emails owners and
-- admins of organizations where a business had a team alert on (src/modules/notifications/notice.ts).
-- A database without the job queue yet (fresh install) has no team alerts to tell anyone about.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'graphile_worker') THEN
    PERFORM graphile_worker.add_job(
      'notifications_team_alerts_notice',
      max_attempts => 5,
      job_key => 'notifications_team_alerts_notice'
    );
  END IF;
END
$$;
