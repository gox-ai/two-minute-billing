-- Operator notifications: per-member settings (push, email, the in-app bell), organization-level
-- destinations (Google Chat spaces, outside email addresses), daily and weekly summaries.
-- Replaces team alerts; `team_alert_recipients` and `businesses.team_alerts_config` stay until
-- the deprecated API is removed. Contract: src/modules/notifications/README.md.
CREATE TABLE IF NOT EXISTS notification_preferences (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  kinds jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_default_uq
  ON notification_preferences (organization_id, user_id) WHERE business_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_preferences_business_uq
  ON notification_preferences (organization_id, user_id, business_id) WHERE business_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_settings_org (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_filter jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  daily jsonb NOT NULL DEFAULT '{"enabled":true,"channels":["email"]}'::jsonb,
  weekly jsonb NOT NULL DEFAULT '{"enabled":false,"channels":["email"]}'::jsonb,
  send_empty boolean NOT NULL DEFAULT false,
  notice_dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_settings_org_uq
  ON notification_settings_org (organization_id, user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'UTC',
  summary_hour integer NOT NULL DEFAULT 8,
  weekly_day integer NOT NULL DEFAULT 1,
  quiet jsonb NOT NULL DEFAULT '{"enabled":false,"from":22,"to":7,"disputes_through":true}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT notification_settings_hour_ck CHECK (summary_hour BETWEEN 0 AND 23),
  CONSTRAINT notification_settings_day_ck CHECK (weekly_day BETWEEN 1 AND 7)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  public_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  label text,
  user_agent text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT push_subscriptions_endpoint_https_ck CHECK (endpoint LIKE 'https://%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_uq ON push_subscriptions (endpoint);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_public_id_uq ON push_subscriptions (public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  tone text NOT NULL,
  timing text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  url text,
  record jsonb,
  amount_minor bigint,
  currency text,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_id uuid,
  group_key text,
  group_count integer NOT NULL DEFAULT 1,
  group_totals jsonb,
  test boolean NOT NULL DEFAULT false,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT notifications_tone_ck CHECK (tone IN ('destructive', 'warning', 'neutral')),
  CONSTRAINT notifications_timing_ck CHECK (timing IN ('instant', 'summary'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notifications_public_id_uq ON notifications (public_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_user_feed_idx ON notifications (user_id, organization_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id, organization_id)
  WHERE read_at IS NULL AND timing = 'instant';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_summary_idx ON notifications (organization_id, business_id, created_at)
  WHERE timing = 'summary';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_queue (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  event_id uuid,
  dedupe_key text NOT NULL,
  kinds text[] NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT app_now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT notification_queue_status_ck CHECK (status IN ('pending', 'done', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_queue_dedupe_uq ON notification_queue (dedupe_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_queue_pending_idx ON notification_queue (next_attempt_at)
  WHERE status = 'pending';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid,
  channel text NOT NULL,
  user_id uuid,
  destination_id uuid,
  push_subscription_id uuid,
  kind text NOT NULL,
  notification_id uuid,
  group_key text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT app_now(),
  last_error text,
  sent_at timestamptz,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT notification_deliveries_channel_ck CHECK (channel IN ('push', 'email', 'chat', 'outside_email')),
  CONSTRAINT notification_deliveries_status_ck CHECK (status IN ('pending', 'sent', 'failed', 'skipped', 'held'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_deliveries_dedupe_uq ON notification_deliveries (dedupe_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_deliveries_pending_idx ON notification_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'held');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_deliveries_destination_idx ON notification_deliveries (destination_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_groups (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid,
  key text NOT NULL,
  kind text NOT NULL,
  opened_at timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 1,
  totals jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_notification_ids uuid[] NOT NULL DEFAULT '{}',
  closed_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_groups_open_uq ON notification_groups (key) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_groups_open_idx ON notification_groups (opened_at) WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_destinations (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL,
  name text NOT NULL,
  url_enc text,
  url_hint text,
  email text,
  status text NOT NULL,
  token_hash text,
  token_expires_at timestamptz,
  send_count integer NOT NULL DEFAULT 0,
  send_window_start timestamptz,
  last_sent_at timestamptz,
  business_filter jsonb NOT NULL DEFAULT '{"mode":"all"}'::jsonb,
  kinds jsonb NOT NULL DEFAULT '{}'::jsonb,
  daily boolean NOT NULL DEFAULT false,
  weekly boolean NOT NULL DEFAULT false,
  hide_names boolean NOT NULL DEFAULT false,
  failure_streak integer NOT NULL DEFAULT 0,
  last_error text,
  legacy_business_id uuid,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT app_now(),
  updated_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT notification_destinations_type_ck CHECK (type IN ('chat', 'email')),
  CONSTRAINT notification_destinations_status_ck CHECK (status IN ('active', 'pending', 'not_working', 'removed')),
  -- A chat space carries an encrypted URL; an email destination carries an address.
  CONSTRAINT notification_destinations_target_ck CHECK (
    (type = 'chat' AND url_enc IS NOT NULL) OR (type = 'email' AND email IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_destinations_public_id_uq ON notification_destinations (public_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_destinations_token_uq ON notification_destinations (token_hash)
  WHERE token_hash IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_destinations_org_idx ON notification_destinations (organization_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS notification_destinations_email_sent_idx ON notification_destinations (email, last_sent_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS notification_digests (
  id uuid PRIMARY KEY DEFAULT public.uuid_v7(),
  public_id text NOT NULL,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  period text NOT NULL,
  period_start date NOT NULL,
  parts jsonb NOT NULL,
  built_at timestamptz NOT NULL DEFAULT app_now(),
  CONSTRAINT notification_digests_period_ck CHECK (period IN ('daily', 'weekly'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_digests_period_uq ON notification_digests (business_id, period, period_start);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS notification_digests_public_id_uq ON notification_digests (public_id);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_preferences, notification_settings_org,
  notification_settings, push_subscriptions, notifications, notification_queue,
  notification_deliveries, notification_groups, notification_destinations, notification_digests
  TO tmbilling_app;
--> statement-breakpoint
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_settings_org ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_queue ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_destinations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE notification_digests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification_preferences', 'notification_settings_org', 'notifications',
    'notification_queue', 'notification_deliveries', 'notification_groups',
    'notification_destinations', 'notification_digests']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY org_isolation ON %I USING (organization_id = current_setting(''app.org_id'', true)::uuid) WITH CHECK (organization_id = current_setting(''app.org_id'', true)::uuid)',
        t);
    END IF;
  END LOOP;
  -- Personal tables: visible while the person is a member of the active organization, as user_mfa.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'notification_settings' AND policyname = 'member_isolation') THEN
    CREATE POLICY member_isolation ON notification_settings
      USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = notification_settings.user_id))
      WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = notification_settings.user_id));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'push_subscriptions' AND policyname = 'member_isolation') THEN
    CREATE POLICY member_isolation ON push_subscriptions
      USING (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = push_subscriptions.user_id))
      WITH CHECK (EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = push_subscriptions.user_id));
  END IF;
END $$;
--> statement-breakpoint
-- Wake the fan-out and the sender on commit. No arguments, for the reason 0201 gives.
CREATE OR REPLACE FUNCTION public.app_nudge_notifications() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM graphile_worker.add_job(
    'notification_queue_nudge',
    queue_name => 'notifications',
    max_attempts => 1,
    job_key => 'notification_queue_nudge'
  );
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.app_nudge_notifications() FROM public;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.app_nudge_notifications() TO tmbilling_app;
