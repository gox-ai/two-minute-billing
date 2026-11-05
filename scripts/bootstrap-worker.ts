/**
 * Install graphile-worker's own schema (`graphile_worker`), so the Drizzle migration
 * chain can be applied to a FRESH database.
 *
 * Why this exists: migration `0130_worker_heartbeats.sql` grants the app role read
 * access to the queue tables —
 *   GRANT USAGE ON SCHEMA graphile_worker TO tmbilling_app;
 *   GRANT SELECT ON graphile_worker.jobs TO tmbilling_app;  (+ four _private_* tables)
 * — because the ops backoffice reads them directly. But that schema is created by
 * graphile-worker at RUNTIME (first `startWorker()` / `makeWorkerUtils()`), never by a
 * migration. So on an empty database `drizzle-kit migrate` dies at 0130 with
 * `schema "graphile_worker" does not exist`, and the chain cannot be replayed.
 *
 * Nobody noticed because **`pnpm db:reset` TRUNCATES** (see scripts/reset-db.ts) — it
 * keeps the schema and the migration history, so a from-zero replay effectively never
 * happened locally. Verified 2026-08-05 against a scratch database: 0130 is the first
 * and only such failure, and with this bootstrap the full chain applies cleanly.
 *
 * `runMigrations` is idempotent, so `db:migrate` calls this every time rather than
 * asking anyone to remember an ordering rule.
 *
 *   pnpm db:bootstrap
 */
import { runMigrations } from 'graphile-worker'
import { config } from '@/platform/config'

await runMigrations({ connectionString: config.DATABASE_URL })
console.log('graphile_worker schema ready')
