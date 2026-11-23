-- The assistant's monthly allowance per plan.
--  · organizations.assistant_allowance_usd_cents: the allowance on the platform's model, in US
--    cents, written by account billing from the organization's plan. NULL = no allowance.
--  · assistant_settings.allowance_warned_month: the month ("2026-11") of the last 80% email to
--    the owners and admins, so it is sent once a month.
SET LOCAL lock_timeout = '5s';

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS assistant_allowance_usd_cents integer
  CHECK (assistant_allowance_usd_cents IS NULL OR assistant_allowance_usd_cents >= 0);
ALTER TABLE assistant_settings ADD COLUMN IF NOT EXISTS allowance_warned_month text;
