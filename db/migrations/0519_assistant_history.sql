-- A member's chat history: archive, pin and share (read-only, same organization). All three are
-- nullable stamps; RLS (org_isolation, row level) already covers the new columns.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE assistant_conversations
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS shared_at timestamptz;
--> statement-breakpoint
-- The history list: one member, one business, pinned first, then the newest activity.
CREATE INDEX IF NOT EXISTS assistant_conversations_history_idx ON assistant_conversations
  (organization_id, user_id, business_id, pinned_at DESC NULLS LAST, updated_at DESC, id DESC)
  WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_conversations_archived_idx ON assistant_conversations
  (organization_id, user_id, business_id, pinned_at DESC NULLS LAST, updated_at DESC, id DESC)
  WHERE archived_at IS NOT NULL;
