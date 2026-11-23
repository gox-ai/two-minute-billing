-- Embeddings of the docs sections, for hybrid search (keyword + meaning). Keyed by a hash of the
-- model and the embedded text, so a rebuilt index re-embeds only the sections that changed.
-- Platform-wide reference data like assistant_doc_chunks: the app role has no privilege on it.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS assistant_doc_vectors (
  hash text PRIMARY KEY,
  model text NOT NULL,
  dims integer NOT NULL,
  -- float32, little-endian
  vector bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app_now()
);
--> statement-breakpoint
ALTER TABLE assistant_doc_chunks ADD COLUMN IF NOT EXISTS embed_hash text;
--> statement-breakpoint
-- Rebuild so every section gets its embed_hash on the next API start.
DELETE FROM assistant_doc_index;
