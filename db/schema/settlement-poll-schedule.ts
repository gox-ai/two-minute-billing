import { pgTable, uuid, text, integer, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { organizations } from "./tenancy";
import { transactions } from "./transactions";

/**
 * When each settlement sweep may next ask a gateway about a transaction (0227).
 *
 * The three sweeps in `payments/stale-pending.ts` record NOTHING when the gateway's answer
 * changes nothing — the gateway's opinion outranks the clock's — which also meant they
 * remembered nothing and re-asked every 60 seconds forever. 342 rows answering the same way
 * for days were 98% of the billing clock. This table is the memory between attempts.
 *
 * It changes the poll INTERVAL only. No verdict is stored here and none is inferred from it.
 *
 * Keyed per (transaction, PASS) rather than per transaction, because the sweeps select
 * overlapping rows while asking different questions: one shared schedule would let the
 * stale-pending sweep hide a row from the zero-due sweep, which exists to release a live
 * debit on an invoice that owes nothing. See the migration for the full reasoning.
 *
 * No row = due now. That is why `next_at` is NOT NULL: absence already carries that meaning.
 */
export const settlementPollSchedule = pgTable(
  "settlement_poll_schedule",
  {
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    /** 'stale_pending' | 'afa_recheck' | 'zero_due' — see SETTLEMENT_POLL_PASSES. */
    pass: text("pass").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.transactionId, t.pass] }),
    index("settlement_poll_schedule_due_idx").on(t.pass, t.nextAt),
  ],
);
