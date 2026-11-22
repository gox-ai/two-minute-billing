import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { paymentAttempts, paymentIntents, providerEvents } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";

export interface EventLink {
  paymentIntentId: string | null;
  paymentAttemptId: string | null;
}

const NONE: EventLink = { paymentIntentId: null, paymentAttemptId: null };

export type LinkableEvent = Pick<
  NormalizedProviderEvent,
  "providerIntentId" | "providerChargeId" | "gatewayIntentId" | "ownershipRef"
>;

/**
 * The payment intent and attempt a gateway event is about, for `provider_events`. Display
 * only: no handler reads it.
 *
 * Intent: an attempt addressed by an id the event names, else `intent_at_gateway`, else our
 * public id read back off the gateway object (`ownershipRef`). Attempt: the one addressed by
 * an id the event names, else the latest one created by `receivedAt`, else the current one.
 * More than one candidate intent answers no link, never a guess.
 */
export async function resolveEventLink(
  ev: LinkableEvent,
  businessId: string | null,
  receivedAt: Date,
): Promise<EventLink> {
  const ids = [
    ...new Set(
      [ev.providerIntentId, ev.gatewayIntentId, ev.providerChargeId].filter(
        (x): x is string => !!x,
      ),
    ),
  ];
  const attemptScope = businessId ? [eq(paymentAttempts.businessId, businessId)] : [];
  const intentScope = businessId ? [eq(paymentIntents.businessId, businessId)] : [];

  if (ids.length) {
    const byId = await systemDb
      .select({
        id: paymentAttempts.id,
        paymentIntentId: paymentAttempts.paymentIntentId,
        createdAt: paymentAttempts.createdAt,
      })
      .from(paymentAttempts)
      .where(and(inArray(paymentAttempts.idAtGateway, ids), ...attemptScope))
      .orderBy(desc(paymentAttempts.attemptNumber))
      .limit(10);
    const intents = new Set(byId.map((a) => a.paymentIntentId));
    if (intents.size > 1) return NONE;
    if (intents.size === 1) {
      // Several attempts of one intent can share a gateway id (a retry on the same object).
      const at = byId.find((a) => a.createdAt <= receivedAt) ?? byId[0]!;
      return { paymentIntentId: at.paymentIntentId, paymentAttemptId: at.id };
    }
  }

  let intentId: string | null = null;
  if (ids.length) {
    const rows = await systemDb
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(and(inArray(paymentIntents.intentAtGateway, ids), ...intentScope))
      .limit(2);
    if (rows.length > 1) return NONE;
    intentId = rows[0]?.id ?? null;
  }
  if (!intentId && ev.ownershipRef) {
    const rows = await systemDb
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(and(eq(paymentIntents.publicId, ev.ownershipRef), ...intentScope))
      .limit(2);
    if (rows.length !== 1) return NONE;
    intentId = rows[0]!.id;
  }
  if (!intentId) return NONE;

  const latest = (until?: Date) =>
    systemDb
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(
        and(
          eq(paymentAttempts.paymentIntentId, intentId),
          ...(until ? [lte(paymentAttempts.createdAt, until)] : []),
        ),
      )
      .orderBy(desc(paymentAttempts.attemptNumber))
      .limit(1);
  // A test clock can put every attempt after the delivery: then the current one.
  const attempt = (await latest(receivedAt))[0] ?? (await latest())[0];
  return { paymentIntentId: intentId, paymentAttemptId: attempt?.id ?? null };
}

/**
 * Link stored events that have no link yet (rows from before 0540), by the same rules.
 * Reads the ids off `normalized`; a row without one is skipped. Writes only with `apply`,
 * and only rows still unlinked, so a rerun changes nothing.
 */
export async function backfillEventLinks(opts: {
  since: Date;
  apply: boolean;
  businessId?: string | null;
  /** Gateway keys to read; all when absent. */
  gateways?: readonly string[];
  batchSize?: number;
  onBatch?: (p: { scanned: number; linked: number }) => void;
}): Promise<{
  scanned: number;
  linked: number;
  written: number;
  byGateway: Record<string, { scanned: number; linked: number }>;
}> {
  const out = {
    scanned: 0,
    linked: 0,
    written: 0,
    byGateway: {} as Record<string, { scanned: number; linked: number }>,
  };
  let after: string | null = null;
  for (;;) {
    const rows = await systemDb
      .select({
        id: providerEvents.id,
        providerKey: providerEvents.providerKey,
        businessId: providerEvents.businessId,
        receivedAt: providerEvents.receivedAt,
        normalized: providerEvents.normalized,
      })
      .from(providerEvents)
      .where(
        and(
          gte(providerEvents.receivedAt, opts.since),
          isNull(providerEvents.paymentIntentId),
          isNotNull(providerEvents.normalized),
          ...(opts.businessId ? [eq(providerEvents.businessId, opts.businessId)] : []),
          ...(opts.gateways ? [inArray(providerEvents.providerKey, [...opts.gateways])] : []),
          ...(after ? [gt(providerEvents.id, after)] : []),
        ),
      )
      .orderBy(asc(providerEvents.id))
      .limit(opts.batchSize ?? 500);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const row of rows) {
      out.scanned++;
      const gw = (out.byGateway[row.providerKey] ??= { scanned: 0, linked: 0 });
      gw.scanned++;
      const n = row.normalized as Record<string, unknown>;
      const str = (k: string) => (typeof n[k] === "string" ? (n[k] as string) : undefined);
      const link = await resolveEventLink(
        {
          providerIntentId: str("providerIntentId"),
          providerChargeId: str("providerChargeId"),
          gatewayIntentId: str("gatewayIntentId"),
          ownershipRef: str("ownershipRef"),
        },
        row.businessId,
        row.receivedAt,
      );
      if (!link.paymentIntentId) continue;
      out.linked++;
      gw.linked++;
      if (!opts.apply) continue;
      const written = await systemDb
        .update(providerEvents)
        .set(link)
        .where(and(eq(providerEvents.id, row.id), isNull(providerEvents.paymentIntentId)))
        .returning({ id: providerEvents.id });
      out.written += written.length;
    }
    opts.onBatch?.({ scanned: out.scanned, linked: out.linked });
  }
  return out;
}
