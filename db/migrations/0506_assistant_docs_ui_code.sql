-- The docs index also holds the dashboard map (`ui`: one section per screen) and the published
-- source (`code`: one section per top-level function or component), searched by the assistant
-- only to check how the product behaves. `terms` carries words the body hides from full-text
-- search: identifiers split at camelCase and snake_case, and the labels a screen shows.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks DROP CONSTRAINT IF EXISTS assistant_doc_chunks_source_check;
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks ADD CONSTRAINT assistant_doc_chunks_source_check
  CHECK (source IN ('help', 'api', 'engine', 'ui', 'code'));
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks ADD COLUMN IF NOT EXISTS terms text;
--> statement-breakpoint
DROP INDEX IF EXISTS assistant_doc_chunks_search_idx;
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks DROP COLUMN IF EXISTS search;
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(terms, '')), 'B') ||
  setweight(to_tsvector('english', body), 'C')
) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_doc_chunks_search_idx ON assistant_doc_chunks USING gin (search);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_doc_chunks_source_idx ON assistant_doc_chunks (source);
--> statement-breakpoint
-- Force a rebuild with the new sources on the next API start.
DELETE FROM assistant_doc_index;
