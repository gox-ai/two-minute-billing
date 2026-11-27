-- Embedded checkout and portal (Phase 1). One list of websites per business that may embed its
-- checkout, portal and usage widget. It starts as the usage widget's list; `usage_widget_origins`
-- is kept in step by the app until a later migration drops it.
-- `embed_origin` on a session is the one website that session may be framed by, checked
-- against the list when the session is created and again on every framed page load.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS embed_origins text[] NOT NULL DEFAULT '{}'::text[];
--> statement-breakpoint
UPDATE businesses SET embed_origins = usage_widget_origins
  WHERE usage_widget_origins <> '{}'::text[] AND embed_origins = '{}'::text[];
--> statement-breakpoint
ALTER TABLE checkout_sessions ADD COLUMN IF NOT EXISTS embed_origin text;
--> statement-breakpoint
ALTER TABLE portal_sessions ADD COLUMN IF NOT EXISTS embed_origin text;
