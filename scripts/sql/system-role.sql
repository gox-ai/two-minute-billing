-- The app's database login, `tmbilling_system`: not a superuser and owner of nothing, so the
-- tenant policies apply whenever `withTenant` switches to `tmbilling_app`, and an injected
-- statement cannot run DDL or superuser-only functions. It bypasses RLS for `systemDb` work
-- (sign-in, token lookups, the clock's scans, the back-office).
--
-- Run as the table owner after migrations; safe to re-run. Create the login first:
--   CREATE ROLE tmbilling_system LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS PASSWORD '…';
-- Migrations keep running as the owner (MIGRATION_DATABASE_URL).

-- withTenant's `set local role tmbilling_app`.
GRANT tmbilling_app TO tmbilling_system;

DO $$ BEGIN
  EXECUTE format('GRANT CONNECT, TEMP ON DATABASE %I TO tmbilling_system', current_database());
END $$;

GRANT USAGE ON SCHEMA public, graphile_worker TO tmbilling_system;

-- MAINTAIN covers REFRESH MATERIALIZED VIEW (PG17) on the metric views.
GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON ALL TABLES IN SCHEMA public TO tmbilling_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graphile_worker TO tmbilling_system;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public, graphile_worker TO tmbilling_system;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, graphile_worker TO tmbilling_system;

-- The ledger is append-only for this login too.
REVOKE UPDATE, DELETE ON ledger_entries FROM tmbilling_system;

-- Tables later migrations create (as the owner running this file).
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON TABLES TO tmbilling_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tmbilling_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA graphile_worker
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tmbilling_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA graphile_worker
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tmbilling_system;
ALTER DEFAULT PRIVILEGES IN SCHEMA public, graphile_worker
  GRANT EXECUTE ON FUNCTIONS TO tmbilling_system;

-- The private back-office schema, where it exists (a self-hosted database has none).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'backoffice') THEN
    GRANT USAGE ON SCHEMA backoffice TO tmbilling_system;
    GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON ALL TABLES IN SCHEMA backoffice TO tmbilling_system;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA backoffice TO tmbilling_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA backoffice
      GRANT SELECT, INSERT, UPDATE, DELETE, MAINTAIN ON TABLES TO tmbilling_system;
    ALTER DEFAULT PRIVILEGES IN SCHEMA backoffice
      GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tmbilling_system;
  END IF;
END $$;
