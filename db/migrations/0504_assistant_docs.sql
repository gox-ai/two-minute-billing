-- The assistant's docs index: help pages, API reference pages and module READMEs, split into
-- sections and searched with Postgres full-text search. Platform-wide reference data, rebuilt
-- by the API when the published content changes; the app role has no privilege on it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_doc_chunks (
  id uuid PRIMARY KEY DEFAULT uuid_v7(),
  source text NOT NULL CHECK (source IN ('help', 'api', 'engine')),
  path text NOT NULL,
  url text,
  title text NOT NULL,
  heading text,
  body text NOT NULL,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(heading, '')), 'B') ||
    setweight(to_tsvector('english', body), 'C')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS assistant_doc_chunks_search_idx ON assistant_doc_chunks USING gin (search);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_doc_index (
  id smallint PRIMARY KEY CHECK (id = 1),
  content_hash text NOT NULL,
  chunks integer NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT app_now()
);
