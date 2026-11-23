-- Postal code -> place lookup for the address forms (city and state fill in from the code).
-- Data: GeoNames postal codes, CC BY 4.0 (https://www.geonames.org), loaded by
-- `pnpm postal:seed`. Reference data like `countries`: platform-global, no RLS, never reset.
-- Read through the system connection only, so the app role gets no grant.
-- Empty until loaded; the lookup then answers "not found" and the forms skip the autofill.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS postal_codes (
  country text NOT NULL,
  postal_code text NOT NULL,
  place_name text NOT NULL,
  admin1_name text,
  state_code text,
  PRIMARY KEY (country, postal_code, place_name)
);
