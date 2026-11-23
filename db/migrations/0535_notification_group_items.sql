-- A burst group keeps the events after the first (up to 20), so the closing message can list them.
ALTER TABLE notification_groups ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb;
