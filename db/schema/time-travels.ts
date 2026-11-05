import { pgTable, uuid, text, timestamp, bigint, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizations, businesses } from "./tenancy";

/**
 * H4 (TL-4) — Time Travel (test businesses only). DEFERRED: this table + the
 * `businessNow`/`scanBusinessFilter` clock seam are landed scaffolding; the
 * travel_forward/start_afresh orchestration + routes are not built yet (user
 * decision 2026-07-04 — a test-only sandbox tool, not a cutover blocker).
 *
 * One per business. Pins a
 * simulated clock (`simulatedNow`) that `travel_forward` advances in tick-sized
 * steps, running the real billing pipeline as-of each step. `genesisTime` is where
 * `start_afresh` set the clock (after wiping customer data).
 */
export const timeTravels = pgTable(
  "time_travels",
  {
    id: uuid("id")
      .default(sql`uuid_v7()`)
      .primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id, { onDelete: "cascade" }),
    // not_enabled | in_progress | succeeded | failed
    status: text("status").notNull().default("not_enabled"),
    genesisTime: timestamp("genesis_time", { withTimezone: true }),
    // The current simulated instant. Non-null ⇒ this business is time-travelled
    // (the real clock skips it; travel_forward drives it).
    simulatedNow: timestamp("simulated_now", { withTimezone: true }),
    // Travel serializer (finale review): a leased claim so two concurrent
    // travel_forward calls can't interleave ticks; self-expires after 15 min.
    travelLeaseUntil: timestamp("travel_lease_until", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    resourceVersion: bigint("resource_version", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
  },
  (t) => [uniqueIndex("time_travels_business_uq").on(t.businessId)],
);
