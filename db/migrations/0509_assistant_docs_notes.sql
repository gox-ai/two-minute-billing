-- Search notes per help section: one sentence placing the section in its page, and the words
-- people use when it is their answer. At the lowest weight they only bring a section into the
-- candidates; the search ranks it by its best matching phrase, not by every word in the notes.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks ADD COLUMN IF NOT EXISTS notes text;
--> statement-breakpoint
DROP INDEX IF EXISTS assistant_doc_chunks_search_idx;
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks DROP COLUMN IF EXISTS search;
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks ADD COLUMN search tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(terms, '')), 'B') ||
  setweight(to_tsvector('english', body), 'C') ||
  setweight(to_tsvector('english', coalesce(notes, '')), 'D')
) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_doc_chunks_search_idx ON assistant_doc_chunks USING gin (search);
--> statement-breakpoint
-- Force a rebuild with the notes on the next API start.
DELETE FROM assistant_doc_index;
