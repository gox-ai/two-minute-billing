-- Media prices on the model price list: each row gets a unit (token, request, image, audio
-- second, …) and an optional quality / resolution tier ('' = none). Additive: every existing
-- row keeps its meaning, and the key, lookup indexes and the cost overlap rule gain the new
-- columns. Grants and RLS are unchanged (0455, 0456).
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'token';
--> statement-breakpoint
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE model_prices ADD COLUMN IF NOT EXISTS resolution text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE model_cost_overrides ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'token';
--> statement-breakpoint
ALTER TABLE model_cost_overrides ADD COLUMN IF NOT EXISTS quality text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE model_cost_overrides ADD COLUMN IF NOT EXISTS resolution text NOT NULL DEFAULT '';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE model_prices ADD CONSTRAINT model_prices_unit_ck
    CHECK (unit IN ('token', 'request', 'image', 'video_second', 'audio_second', 'character', 'page', 'pixel')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE model_prices ADD CONSTRAINT model_prices_tier_ck
    CHECK (quality ~ '^[a-z0-9_.x-]{0,40}$' AND resolution ~ '^[a-z0-9_.x-]{0,40}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE model_cost_overrides ADD CONSTRAINT model_cost_overrides_unit_ck
    CHECK (unit IN ('token', 'request', 'image', 'video_second', 'audio_second', 'character', 'page', 'pixel')) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE model_cost_overrides ADD CONSTRAINT model_cost_overrides_tier_ck
    CHECK (quality ~ '^[a-z0-9_.x-]{0,40}$' AND resolution ~ '^[a-z0-9_.x-]{0,40}$') NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE model_prices VALIDATE CONSTRAINT model_prices_unit_ck;
--> statement-breakpoint
ALTER TABLE model_prices VALIDATE CONSTRAINT model_prices_tier_ck;
--> statement-breakpoint
ALTER TABLE model_cost_overrides VALIDATE CONSTRAINT model_cost_overrides_unit_ck;
--> statement-breakpoint
ALTER TABLE model_cost_overrides VALIDATE CONSTRAINT model_cost_overrides_tier_ck;
--> statement-breakpoint
-- The sync stored a `_kcount` price per 1,000 and a `_mtok` price per 1,000,000; no other
-- divisor was ever written. So a divisor of 1,000 is a counted request. Cost rows stay `token`.
UPDATE model_prices SET unit = 'request' WHERE quantity_divisor = 1000 AND unit = 'token';
--> statement-breakpoint
DROP INDEX IF EXISTS model_prices_key_from_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS model_prices_key_from_uq
  ON model_prices (provider, model, token_type, unit, quality, resolution, currency, effective_from);
--> statement-breakpoint
DROP INDEX IF EXISTS model_prices_model_token_from_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_prices_model_token_from_idx
  ON model_prices (model, token_type, unit, quality, resolution, effective_from DESC);
--> statement-breakpoint
DROP INDEX IF EXISTS model_cost_overrides_lookup_idx;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS model_cost_overrides_lookup_idx
  ON model_cost_overrides (organization_id, model, token_type, unit, quality, resolution, effective_from DESC);
--> statement-breakpoint
-- One live cost per key at any instant; the key now includes the unit and the tier.
ALTER TABLE model_cost_overrides DROP CONSTRAINT IF EXISTS model_cost_overrides_no_overlap;
--> statement-breakpoint
ALTER TABLE model_cost_overrides ADD CONSTRAINT model_cost_overrides_no_overlap EXCLUDE USING gist (
  organization_id WITH =,
  (coalesce(provider, '')) WITH =,
  model WITH =,
  token_type WITH =,
  unit WITH =,
  quality WITH =,
  resolution WITH =,
  currency WITH =,
  tstzrange(effective_from, effective_to, '[)') WITH &&
);
