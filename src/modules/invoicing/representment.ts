/**
 * May this instrument be presented again?
 *
 *  - NPCI rail rules, on every path (manual included), for the invoice being collected:
 *    at most 1 + `networkRetryCap(rail)` presentations of it on one mandate, and on NACH
 *    no re-presentation within `RAIL_MIN_RETRY_GAP_DAYS` of a return. When the schedule's
 *    deadline attempt would break either, it is refused here and dunning ends at the
 *    period's close without it.
 *  - Per-card caps, checked before an automatic charge:
 * re-attempts stop at CARD_CAP_24H declines in 24h and CARD_CAP_30D in 30 days on the same
 * card, across all invoices and every saved copy of it (same fingerprint). Mastercard fines
 * 10 consecutive declines in 24h; Visa's current rules allow 20 reattempts in 30 days (15
 * in its 2021 rules) — 15 is kept for margin.
 *
 * A decline code alone never blocks a card: gateways' "do not retry" signals proved
 * unreliable (the same card declined generically on the next attempt).
 */
import { and, desc, eq, gt, inArray, isNull, ne, notInArray, or, sql } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { payments, paymentMethods } from "@db/schema";
import { networkRetryCap, RAIL_MIN_RETRY_GAP_DAYS } from "@/modules/subscriptions/dunning-schedule";
import type { Pm } from "./collection";
import {
  MANDATE_EXPIRED_CODE,
  MANDATE_MISSING_CODE,
  MANDATE_PENDING_CODE,
  MANDATE_SPENT_CODE,
} from "./collection";
import { PRE_DEBIT_NOTICE_FAILED_CODE } from "./pre-debit";
import { PRE_DEBIT_NOT_DUE_CODE } from "@/providers/types";
import { CARD_LIMIT_CODE } from "./card-limit";
import {
  MANDATE_REVOKED_CODES,
  loadBillingRulesRow,
  resolveBillingRulesConfig,
} from "@/modules/subscriptions/billing-rules-config";

export const CARD_CAP_24H = 10;
export const CARD_CAP_30D = 15;
const DAY_MS = 86_400_000;

export type PresentationBlock =
  | { reason: "card_cap"; until: Date; declines24h: number; declines30d: number }
  | { reason: "mandate_revoked" }
  | { reason: "rail_limit"; rail: string; presented: number }
  | { reason: "rail_spacing"; rail: string; until: Date };
type RailBlock = Exclude<PresentationBlock, { reason: "card_cap" }>;

/** Refusal codes for a rail block, booked with `provider_key = 'none'`. */
export const RAIL_LIMIT_CODE = "network_retry_limit";
export const RAIL_SPACING_CODE = "network_retry_too_soon";

// Refused by our own pre-flight (`chargeWithMethod`): booked, but never sent to the network.
const NOT_PRESENTED = [
  MANDATE_MISSING_CODE,
  MANDATE_EXPIRED_CODE,
  MANDATE_PENDING_CODE,
  MANDATE_SPENT_CODE,
  "mandate_ceiling_exceeded",
  RAIL_LIMIT_CODE,
  RAIL_SPACING_CODE,
  // Above the business's card limit (0482).
  CARD_LIMIT_CODE,
  // The gateway refused the notice, so the debit itself was never sent.
  PRE_DEBIT_NOTICE_FAILED_CODE,
  // Refused as too early, before the network saw it.
  PRE_DEBIT_NOT_DUE_CODE,
];

/**
 * The payer revoked this instrument's mandate on its last presentation, and the business
 * chose to act on that (`billing_rules_config.mandate_revoked` other than `follow_dunning`,
 * which keeps today's behaviour). Every path, manual included: a second debit on a revoked
 * mandate is an unauthorised one. Cleared by a later success or a re-vault.
 */
async function revokedMandateBlock(
  organizationId: string,
  pm: Pick<Pm, "id" | "businessId" | "credentialsChangedAt" | "authorizedAt">,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    // The rule first: `follow_dunning`, the default, needs no history read.
    const rule = resolveBillingRulesConfig(
      await loadBillingRulesRow(organizationId, pm.businessId, tx),
    ).mandateRevoked;
    if (rule === "follow_dunning") return false;
    const [last] = await tx
      .select({
        status: payments.status,
        code: payments.failureCode,
        reversalCode: payments.reversalCode,
        at: payments.createdAt,
      })
      .from(payments)
      .where(
        and(
          eq(payments.paymentMethodId, pm.id),
          ne(payments.providerKey, "none"),
          inArray(payments.status, ["succeeded", "failed"]),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1);
    // A reversal keeps `late_failure` as its code; the decline it carried is `reversalCode`.
    const code = last?.reversalCode ?? last?.code;
    if (last?.status !== "failed" || !code || !MANDATE_REVOKED_CODES.has(code)) return false;
    // Fresh authority since: a re-vault (new card number or token) or a mandate gone live.
    const since = (d: Date | null | undefined) => d != null && d > last.at;
    return !(since(pm.credentialsChangedAt) || since(pm.authorizedAt));
  });
}

/** Why this card must not be charged now, or null when it may be. */
export async function presentationBlock(input: {
  organizationId: string;
  pm: Pick<
    Pm,
    | "id"
    | "instrumentFingerprint"
    | "mandateRail"
    | "businessId"
    | "credentialsChangedAt"
    | "authorizedAt"
  >;
  now: Date;
  /** Apply the per-card caps too (automatic re-attempts only). */
  applyCaps?: boolean;
  /** The invoice being collected; enables the NPCI rail rules. */
  invoiceId?: string;
}): Promise<PresentationBlock | null> {
  const { organizationId, pm, now } = input;
  if (await revokedMandateBlock(organizationId, pm)) return { reason: "mandate_revoked" };
  if (input.invoiceId) {
    const rail = await railBlock({ organizationId, pm, now, invoiceId: input.invoiceId });
    if (rail) return rail;
  }
  if (!input.applyCaps) return null;
  return withTenant(organizationId, async (tx) => {
    // Every saved copy of this card counts: the networks count the card, not our row.
    const ids = pm.instrumentFingerprint
      ? (
          await tx
            .select({ id: paymentMethods.id })
            .from(paymentMethods)
            .where(eq(paymentMethods.instrumentFingerprint, pm.instrumentFingerprint))
        ).map((r) => r.id)
      : [pm.id];
    // Timestamps only, counted here: a Date bound inside a raw `sql` fragment is not
    // serialised by the driver, which took down every retry that reached this.
    const declines = presentations(
      await tx
        .select({
          at: payments.createdAt,
          request: payments.paymentRequestId,
          attempt: sql<string | null>`${payments.metadata} ->> 'payment_request_attempt'`,
        })
        .from(payments)
        .where(
          and(
            inArray(payments.paymentMethodId, ids.length ? ids : [pm.id]),
            eq(payments.status, "failed"),
            // A refusal booked without asking a gateway was never presented.
            ne(payments.providerKey, "none"),
            gt(payments.createdAt, new Date(now.getTime() - 30 * DAY_MS)),
          ),
        ),
    );
    const in24 = declines.filter((t) => t > now.getTime() - DAY_MS);
    const d24 = in24.length;
    const d30 = declines.length;
    const reopen: number[] = [];
    if (d24 >= CARD_CAP_24H) reopen.push(Math.min(...in24) + DAY_MS);
    if (d30 >= CARD_CAP_30D) reopen.push(Math.min(...declines) + 30 * DAY_MS);
    if (!reopen.length) return null;
    return {
      reason: "card_cap",
      until: new Date(Math.max(...reopen)),
      declines24h: d24,
      declines30d: d30,
    };
  });
}

/**
 * Failed rows as gateway presentations, in ms. A payment request's attempt books one child
 * per invoice for ONE charge (`metadata.payment_request_attempt`; older children by their
 * shared `created_at`): those count once. Every other row is its own charge.
 */
export function presentations(
  rows: Array<{ at: Date; request: string | null; attempt?: string | null }>,
): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (const r of rows) {
    if (r.request) {
      const key = `${r.request}@${r.attempt ?? r.at.getTime()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r.at.getTime());
  }
  return out;
}

async function railBlock(input: {
  organizationId: string;
  pm: Pick<Pm, "id" | "mandateRail">;
  now: Date;
  invoiceId: string;
}): Promise<RailBlock | null> {
  const rail = input.pm.mandateRail?.toLowerCase();
  const cap = networkRetryCap(rail);
  const gapDays = rail ? RAIL_MIN_RETRY_GAP_DAYS[rail] : undefined;
  if (!rail || (cap == null && gapDays === undefined)) return null;
  return withTenant(input.organizationId, async (tx) => {
    const presentedOn = (invoiceOnly: boolean) =>
      tx
        .select({ at: payments.createdAt })
        .from(payments)
        .where(
          and(
            eq(payments.paymentMethodId, input.pm.id),
            invoiceOnly ? eq(payments.invoiceId, input.invoiceId) : undefined,
            eq(payments.status, "failed"),
            ne(payments.providerKey, "none"),
            or(isNull(payments.failureCode), notInArray(payments.failureCode, NOT_PRESENTED)),
          ),
        )
        .orderBy(desc(payments.createdAt));
    if (cap != null) {
      const presented = (await presentedOn(true)).length;
      if (presented >= 1 + cap) return { reason: "rail_limit" as const, rail, presented };
    }
    if (gapDays !== undefined) {
      const [last] = await presentedOn(false).limit(1);
      const until = last ? new Date(last.at.getTime() + gapDays * DAY_MS) : null;
      if (until && until > input.now) return { reason: "rail_spacing" as const, rail, until };
    }
    return null;
  });
}

/**
 * The card collection would present first, skipping — with `applyCaps` — cards at their
 * attempt limit, so a capped primary hands over to a backup. `pm` null means nothing is
 * presentable now; `capped` is then the soonest cap to lift, or null when there is no card.
 */
export async function firstPresentable(input: {
  organizationId: string;
  candidates: Array<Pm | null>;
  now: Date;
  applyCaps: boolean;
  /** The invoice being collected; enables the NPCI rail rules. */
  invoiceId?: string;
}): Promise<{ pm: Pm | null; capped: Extract<PresentationBlock, { reason: "card_cap" }> | null }> {
  let soonest: Extract<PresentationBlock, { reason: "card_cap" }> | null = null;
  for (const pm of input.candidates) {
    if (!pm) continue;
    const block = await presentationBlock({
      organizationId: input.organizationId,
      pm,
      now: input.now,
      applyCaps: input.applyCaps,
      invoiceId: input.invoiceId,
    });
    if (block?.reason === "card_cap") {
      if (!soonest || block.until < soonest.until) soonest = block;
      continue;
    }
    // A rail block is not deferred: past it, the next presentation would break the rule.
    if (block) continue;
    return { pm, capped: null };
  }
  return { pm: null, capped: soonest };
}
