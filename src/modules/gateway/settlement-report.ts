/**
 * Settlement-report polling: outcomes some gateways report ONLY in a report, never by
 * webhook — an eCheck return after settlement, a reversal, a dispute on a charge we
 * already booked.
 *
 * Not the stale-pending sweeps' job: those ask about a PENDING charge by id. This reads a
 * time window of the gateway's report from a per-account cursor
 * (`gateway_settlement_cursors`) and feeds each event through the same
 * `handleProviderEvent` webhooks use, so dedupe and the money handlers are shared.
 *
 * The cursor moves only when every event in the window was handled. A failed window is
 * read again on the next due pass; dedupe makes the re-read safe.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { gatewayAccounts, gatewaySettlementCursors } from "@db/schema";
import { resolveAdapter } from "@/providers/registry";
import type { PaymentProvider } from "@/providers/types";
import { createLogger } from "@/platform/logger";
import { handleProviderEvent } from "@/modules/webhooks/inbound";
import type { TickError } from "@/modules/subscriptions/renewal";
import { distinctEventIds } from "./inbound";

const log = createLogger("gateway.settlement-report");

/** Each window re-reads this much before the cursor, for events stamped on the boundary. */
export const SETTLEMENT_POLL_OVERLAP_MS = 15 * 60 * 1000;

export interface SettlementReportResult {
  /** Active accounts in scope whose adapter declares `settlementReport`. */
  capable: number;
  /** Of those, polled this pass (due by `intervalMinutes`). */
  polled: number;
  events: number;
  processed: number;
  duplicates: number;
  /** Accounts whose cursor moved. */
  advanced: number;
  /** Accounts whose window failed (poll threw, or an event errored); cursor kept. */
  failed: number;
  /** Active accounts whose adapter could not be built (credentials). */
  unresolvable: number;
  errors: TickError[];
}

/** `handleProviderEvent`, replaceable only so a suite can force a handler error. */
type Handle = typeof handleProviderEvent;

export async function pollGatewaySettlementReports(
  now: Date,
  opts: { handle?: Handle } = {},
): Promise<SettlementReportResult> {
  const handle = opts.handle ?? handleProviderEvent;
  const out: SettlementReportResult = {
    capable: 0,
    polled: 0,
    events: 0,
    processed: 0,
    duplicates: 0,
    advanced: 0,
    failed: 0,
    unresolvable: 0,
    errors: [],
  };
  // Config rows, counted in tens: no scan cap. Never-polled first, then the most behind.
  const rows = await systemDb
    .select({ acc: gatewayAccounts, cursor: gatewaySettlementCursors.polledUntil })
    .from(gatewayAccounts)
    .leftJoin(
      gatewaySettlementCursors,
      eq(gatewaySettlementCursors.gatewayAccountId, gatewayAccounts.id),
    )
    .where(
      and(eq(gatewayAccounts.status, "active"), scanBusinessFilter(gatewayAccounts.businessId)),
    )
    .orderBy(sql`${gatewaySettlementCursors.polledUntil} asc nulls first`, asc(gatewayAccounts.id));

  for (const { acc, cursor } of rows) {
    let adapter: PaymentProvider;
    try {
      adapter = resolveAdapter(acc);
    } catch (e) {
      // Broken credentials break every path for this account, and those report it; we
      // cannot even tell whether it reads a report. Counted, not raised every minute.
      out.unresolvable++;
      log.debug("settlement report: cannot build this account's adapter", {
        account: acc.publicId,
        error: String(e),
      });
      continue;
    }
    try {
      const cap = adapter.capabilities.settlementReport;
      if (!cap || !adapter.pollSettlements) continue;
      out.capable++;

      if (cursor && now.getTime() - cursor.getTime() < cap.intervalMinutes * 60_000) continue;
      const maxWindowMs = cap.maxWindowHours * 3_600_000;
      const since = cursor ?? new Date(now.getTime() - maxWindowMs);
      const until = new Date(Math.min(now.getTime(), since.getTime() + maxWindowMs));
      const readFrom = new Date(since.getTime() - SETTLEMENT_POLL_OVERLAP_MS);
      out.polled++;

      const events = distinctEventIds(await adapter.pollSettlements({ since: readFrom, until }));
      const requestUrl =
        `poll:settlement_report?account=${acc.publicId}` +
        `&since=${readFrom.toISOString()}&until=${until.toISOString()}`;
      let erroredEventId: string | null = null;
      for (const ev of events) {
        out.events++;
        const result = await handle(acc.gatewayKey, ev, {
          businessId: acc.businessId,
          payload: ev.raw,
          requestUrl,
          polled: true,
        });
        if (result === "processed") out.processed++;
        else if (result === "duplicate") out.duplicates++;
        else if (result === "error") {
          // Stop: a later event in the window may depend on this one's outcome.
          erroredEventId = ev.providerEventId;
          break;
        }
      }
      if (erroredEventId) {
        out.failed++;
        out.errors.push({
          organization: acc.organizationId,
          business: acc.businessId,
          step: "settlement_reports",
          message: `settlement report event ${erroredEventId} errored; cursor kept`,
        });
        log.warn("settlement report window not fully handled — it is read again next pass", {
          event: "settlement_report_window_failed",
          account: acc.publicId,
          providerEventId: erroredEventId,
        });
        continue;
      }

      // Compare-and-swap on the cursor we read: an overlapping tick must not move it back.
      const moved = await withTenant(acc.organizationId, (tx) =>
        cursor
          ? tx
              .update(gatewaySettlementCursors)
              .set({ polledUntil: until, updatedAt: now })
              .where(
                and(
                  eq(gatewaySettlementCursors.gatewayAccountId, acc.id),
                  eq(gatewaySettlementCursors.polledUntil, cursor),
                ),
              )
              .returning({ id: gatewaySettlementCursors.gatewayAccountId })
          : tx
              .insert(gatewaySettlementCursors)
              .values({
                gatewayAccountId: acc.id,
                organizationId: acc.organizationId,
                polledUntil: until,
                updatedAt: now,
              })
              .onConflictDoNothing()
              .returning({ id: gatewaySettlementCursors.gatewayAccountId }),
      );
      if (moved.length) out.advanced++;
    } catch (e) {
      // A throwing adapter, report or handler: cursor kept, and the other accounts still run.
      out.failed++;
      out.errors.push({
        organization: acc.organizationId,
        business: acc.businessId,
        step: "settlement_reports",
        message: (e as Error)?.message ?? String(e),
      });
      log.error(e, { event: "settlement_report_poll_failed", account: acc.publicId });
    }
  }
  return out;
}
