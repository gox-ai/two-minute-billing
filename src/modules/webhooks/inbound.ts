import { stampNow } from "@/platform/clock";
import { resolveBillingRulesConfig } from "@/modules/subscriptions/billing-rules-config";
import {
  loadEffectiveDunningConfig,
  priorFailedMethods,
} from "@/modules/dunning-policies/effective";
import { credentialsChanged } from "@/modules/payment-methods/credentials";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { setTransactionStatus } from "@/modules/transactions/service";
import { settleTransactionOutcome, settleAbandonedCapture } from "@/modules/payments/settlement";
import {
  DEBIT_CANCELLED_CODE,
  bookDebitCancelledAtGateway,
} from "@/modules/payments/pending-debit";
import {
  planFailureRearm,
  heldRetry,
  nextParkedReminderAt,
  retryDaysForMethod,
  dunningAppliesTo,
  dunningPeriodEndsAt,
  // The offline (auto-collect-off) half of the reversal rearm — see the `send_invoice`
  // branch in `reconcileChargeFailed`. Both are pure functions of the business's dunning
  // config; using `due.ts`'s own helpers is what keeps a reopened offline invoice in the
  // state the offline model would have put it in, rather than a second guess at it.
  nextOfflineReminderAt,
  offlineDunningApplies,
  dunningAnchor,
} from "@/modules/subscriptions/dunning-schedule";
import {
  collectOutstandingForNewPaymentMethod,
  isAutoCollectOn,
  dunningHoldFor,
  invoiceOutstanding,
} from "@/modules/invoicing/service";
import {
  DEAD_MANDATE_STATUSES,
  mandateBecameLive,
  AWAITING_AUTHENTICATION_CODE,
  authenticationWaitMayBeRecorded,
} from "@/modules/payment-methods/mandate-afa";
import { handleDisputeEvent } from "@/modules/disputes/service";
import {
  authorizePaymentIntent,
  consumePaymentIntent,
  failPaymentIntentFromGateway,
  findPaymentIntentByGatewayIntentId,
  getCurrentAttempt,
  repointAttemptAtGateway,
  markPaymentIntentVoidedFromGateway,
  PaymentIntentConflictError,
  PaymentIntentError,
} from "@/modules/payment-intents/service";
// The checkout a harvested SETUP intent may belong to — see `harvestSetupIntent`.
import { completeCheckoutForSetupIntent } from "@/modules/checkout/service";
import { createLogger } from "@/platform/logger";
import { applyGatewayNoticeUpdate } from "@/modules/invoicing/pre-debit";
import { isOpenInvoiceStatus } from "@/modules/invoicing/status";
import {
  providerEvents,
  events,
  payments,
  refunds,
  transactions,
  invoices,
  businesses,
  subscriptions,
  customers,
  paymentMethods,
  countries,
  paymentIntents,
  disputes,
  // #31: the accounts an unattributed capture may have been minted under — the only way
  // to get credentials for the ownership read (`resolveCaptureOwnership`).
  gatewayAccounts,
} from "@db/schema";
import type {
  IntentPurpose,
  NormalizedProviderEvent,
  ProviderMandate,
  ProviderRefundRecord,
} from "@/providers/types";
import { gatewayDefinition } from "@/providers/gateway-catalog";
import { refundUnappliedExcess } from "@/modules/refunds/excess";

const log = createLogger("webhooks.inbound");

export type HandleResult = "processed" | "duplicate" | "ignored" | "error";

/**
 * ── #31 · WHY THERE IS NO ROLLOUT DATE HERE ──────────────────────────────────────
 *
 * There was one: `OWNERSHIP_TAGGING_LIVE_AT`, a hand-set instant that `foreign` had to
 * clear, on the reasoning that before tagging deployed our OWN objects were untagged too,
 * so an absent tag proved nothing about them. **Removed 2026-09-04 on Vinay's decision**,
 * after production measurement made the trade concrete rather than theoretical:
 *
 *  · Exactly ONE production capture had ever reached the gate, and it sat 28 seconds on
 *    the pre-rollout side of it — so the gate's entire observed effect was suppressing a
 *    single genuine tag-read-absent verdict into `unclassified`.
 *  · The constant was a JUDGEMENT about a deploy, unverifiable by any gate, and a value
 *    left too late suppressed real verdicts indefinitely (the verdict is a function of the
 *    object's creation time, so objects born in the gap never heal).
 *
 * ⚠️ WHAT THIS COSTS, kept here because nothing else records it: an object created BEFORE
 * tagging shipped, whose capture arrives now, is untagged because our code was not
 * stamping yet — and it now reads `foreign`, i.e. "another product's money". That is
 * wrong for the legacy tail, and the tail is not short: a pre-tagging e-mandate keeps
 * charging for months. If a stranded capture of OURS from that tail is mislabelled, it
 * logs at `info` and nobody chases it. `providerObjectCreatedAt` is still normalized and
 * still logged, so the evidence to re-litigate any single verdict survives.
 *
 * If this needs restoring, the version to build is NOT another hand-set date: have the
 * deploy record its own rollout instant (boot-time env var, or a `platform_settings`
 * row), so the value cannot be a guess and cannot drift.
 */

/**
 * What a capture we hold no local row for actually IS (#31) — the three-way split that
 * replaced one WARN covering two unrelated things.
 *
 *  · `ours_unattributed` — the gateway object carries OUR tag and we have no record of
 *    it. Money we lost track of. The crash window is real and named:
 *    `createIntent` reaches the gateway BEFORE our row is written, so a process death
 *    in between leaves the gateway holding an object nothing here knows about. **This
 *    is the one that pages.**
 *  · `foreign` — the adapter READ the object's tags and ours was absent. Another product
 *    on a shared merchant account. Routine. Counted so it is visible, and never paged.
 *    ⚠️ This no longer carries an age condition: the rollout gate was removed 2026-09-04
 *    (see the note above), so a read absence is the verdict whatever the object's age.
 *  · `unclassified` — we learned nothing: the adapter could not read a tag at all
 *    (`ownership: 'unknown'` — a kind it does not tag, a rail it cannot query, a gateway
 *    that would not answer). Reported as a number, never paged. It used to ALSO cover a
 *    read absence on a pre-tagging object; that population now reads `foreign`.
 *
 * `unclassified` is deliberately a DIFFERENT word from the adapter's `ownership:
 * 'unknown'`, because it is the union of two sources: an unreadable tag, and a readable
 * absence on an object too old for absence to mean anything.
 */
export type CaptureProvenance = "ours_unattributed" | "foreign" | "unclassified";

/**
 * The LOG EVENT NAME each verdict is published under — a contract with everything
 * outside this process (#43).
 *
 * These three strings are what greps, log filters and alerts key on, and one of them is
 * named inside `unappliedGatewayMoney`'s own remediation sentence, which tells an
 * operator to grep it for the ownership ref. A rename is therefore a breaking change to
 * an interface no type checker can see, so the names live HERE rather than inline at the
 * three log calls, and `capture-verdict-events.test.ts` asserts the literal values, the
 * exhaustiveness of the keys, and that the call sites still index this map with the
 * verdict they computed.
 *
 * ⚠️ `unclassified` maps to a name ending `_unattributable`, and the mismatch is
 * DELIBERATE: that was the single event name before #31 split the verdict three ways,
 * and it was kept so that everything already grepping for it keeps working. Do not
 * "tidy" it into agreement with the verdict — that is precisely the silent break.
 *
 * Keyed by {@link CaptureProvenance}, so a fourth verdict cannot be added to the union
 * without giving it a name here.
 */
export const UNMATCHED_CAPTURE_EVENTS: Readonly<Record<CaptureProvenance, string>> = Object.freeze({
  ours_unattributed: "unmatched_capture_ours_unattributed",
  foreign: "unmatched_capture_foreign",
  unclassified: "unmatched_capture_unattributable",
});

/**
 * Classify a capture that matched nothing of ours — the single implementation of #31's
 * rule, used by the webhook path AND by `unappliedGatewayMoney` (`ops/alerts.ts`), which
 * re-reads the stored `provider_events.normalized` blob. One function on purpose: a
 * money classifier expressed twice is two classifiers that can disagree, and the SQL
 * copy is the one nobody would notice drifting.
 *
 * ⚠️ THE RULE THAT MUST NOT BE "SIMPLIFIED": `unknown` is never `foreign`. Only the
 * adapter's own `foreign` — "I read the tags and ours was not there" — can become
 * `foreign` here, and only for an object young enough for that absence to mean
 * something. The day a deploy stops stamping refs, every lost capture of ours would
 * otherwise turn silent, converting a tagging regression into invisible money loss.
 *
 * `providerObjectCreatedAt` and NOT `occurredAt`: a capture happening today can belong
 * to an order created weeks before tagging existed, and judging it on the event time
 * would date it to today and mark it foreign on no evidence at all. A MISSING date is
 * therefore `unclassified` too — an object whose age we cannot establish cannot clear
 * the rollout bar.
 *
 * Accepts a string date because both callers are real: the webhook path hands a `Date`
 * off the live event, the alert hands the ISO string `normalized->>'providerObjectCreatedAt'`
 * returns.
 */
export function classifyUnmatchedCapture(input: {
  ownership?: string | null;
  providerObjectCreatedAt?: Date | string | null;
}): CaptureProvenance {
  // A tag can only have come from us, so it needs no date check.
  if (input.ownership === "ours") return "ours_unattributed";
  // Everything that is not a READ absence (i.e. `unknown`, absent, or any value a future
  // adapter invents) learned us nothing. This is the load-bearing line, and it is the one
  // that survives: `unknown` may NEVER become `foreign`, whatever else changes here.
  if (input.ownership !== "foreign") return "unclassified";
  // The adapter read the tags and ours was absent. Since the rollout gate was removed
  // (see the note above the missing constant), that read IS the verdict — no date check.
  return "foreign";
}

/**
 * Encode a normalized event for `provider_events.normalized`.
 *
 * JSON has no bigint, and `NormalizedProviderEvent` carries several
 * (`amountRefundedMinor`, `disputeAmountMinor`) — an unconverted one makes
 * `JSON.stringify` THROW, which on the ingest path would mean losing the webhook
 * entirely. So the replacer walks the whole tree rather than converting the fields we
 * happen to know about today: a bigint added anywhere later keeps working instead of
 * breaking ingestion. Dates serialize to ISO via their own `toJSON`.
 *
 * Returns null on any failure — replayability is a nice-to-have, never a reason to drop
 * a delivery.
 */
export function encodeNormalizedEvent(ev: NormalizedProviderEvent): unknown | null {
  try {
    return JSON.parse(
      JSON.stringify(ev, (_k, v) =>
        typeof v === "bigint" ? { __t: "bigint", v: v.toString() } : v,
      ),
    );
  } catch (e) {
    // The normalized event could not be made JSON-safe — it will be stored without
    // its parsed form, so say which provider event lost it.
    log.warn("normalized provider event could not be encoded", {
      type: ev.type,
      providerEventId: ev.providerEventId,
      error: (e as Error)?.message,
    });
    return null;
  }
}

/** Reverse `encodeNormalizedEvent`: bigint envelopes back to bigints, ISO back to Dates. */
export function reviveNormalizedEvent(raw: unknown): NormalizedProviderEvent {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.__t === "bigint" && typeof o.v === "string") return BigInt(o.v);
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  const o = walk(raw) as Record<string, unknown>;
  const pdn = o.preDebitNotice as { executableAfter?: string } | undefined;
  return {
    ...o,
    occurredAt: new Date(o.occurredAt as string),
    ...(o.evidenceDueBy ? { evidenceDueBy: new Date(o.evidenceDueBy as string) } : {}),
    // #31: the third Date on the contract, and it was missing here — a replayed event
    // would have handed a plain ISO STRING to code the type promises a `Date`. The
    // classifier accepts both, deliberately, but every other reader of a replayed event
    // would have got a string where `.getTime()` does not exist.
    ...(o.providerObjectCreatedAt
      ? { providerObjectCreatedAt: new Date(o.providerObjectCreatedAt as string) }
      : {}),
    ...(pdn?.executableAfter
      ? { preDebitNotice: { ...pdn, executableAfter: new Date(pdn.executableAfter) } }
      : {}),
  } as NormalizedProviderEvent;
}

/** Optional inbound context (C8) — the log fields for the gateway-webhook inspector. */
export interface InboundContext {
  businessId?: string | null;
  /**
   * Read by the settlement-report poll, not delivered. A poll reads everything under the
   * API key, so an object that matches none of this business's records is not its own.
   */
  polled?: boolean;
  /** The gateway account the delivery came in on, when the route knows it. */
  gatewayAccountId?: string | null;
  payload?: unknown;
  /** Redacted inbound webhook request headers (LOG-1 stage 2). */
  headers?: Record<string, string> | null;
  /**
   * The URL the gateway posted to (P2). Omitted by every non-HTTP caller — verify
   * suites, internal replays — and those rows must stay NULL rather than acquire a
   * fabricated URL. The one exception is the settlement-report poll, which passes a
   * `poll:settlement_report?…` marker so the row says the event came from a report. The response status is written afterwards by the route, once
   * it knows what it actually answered (`recordGatewayWebhookResponse`).
   */
  requestUrl?: string | null;
  /**
   * Which outcomes of an EXISTING row run again, read under the per-event lock. Default:
   * `error` only, because the gateway (or our retry job) redelivers one.
   *
   * GW-7 replay widens it to `ignored`: that outcome conflates "redundant, not ours" with
   * "our code did not understand this yet", and only an operator can tell which. Safe because
   * an `ignored` row booked nothing — see `replayGatewayWebhook`. The retry job widens it to
   * NULL, the outcome of a row stored before processing (`webhook.processAfterAnswer`).
   */
  rerunIf?: (outcome: string | null) => boolean;
}

/**
 * The advisory-lock key for one event. Every re-run of an existing row holds it, so a gateway
 * redelivery, our retry job and an operator replay never apply one event twice.
 */
export function providerEventLockKey(
  providerKey: string,
  businessId: string | null | undefined,
  providerEventId: string,
): string {
  return `pe:${providerKey}:${businessId ?? ""}:${providerEventId}`;
}

/**
 * The dedup key: one row per (gateway, business, event). Scoped by business because a
 * gateway account shared by two businesses delivers the same event to both, and each must
 * apply it once. A NULL business is a scope of its own.
 */
export function providerEventKey(
  providerKey: string,
  providerEventId: string,
  businessId: string | null | undefined,
) {
  return and(
    eq(providerEvents.providerKey, providerKey),
    eq(providerEvents.providerEventId, providerEventId),
    businessId ? eq(providerEvents.businessId, businessId) : isNull(providerEvents.businessId),
  );
}

/**
 * Process one normalized provider webhook event idempotently:
 *  1. dedup by (provider_key, business_id, provider_event_id) — replays are a no-op,
 *  2. apply side effects (refunds, charge settlement, late-failure reversals),
 *  3. record the outcome (processed | ignored | error) on the log row.
 *
 * Uses the admin connection: a platform webhook arrives with no org context, so
 * we resolve the org from our own transaction/payment record and act there.
 */
export async function handleProviderEvent(
  providerKey: string,
  ev: NormalizedProviderEvent,
  ctx?: InboundContext,
): Promise<HandleResult> {
  const inserted = await systemDb
    .insert(providerEvents)
    .values({
      providerKey,
      providerEventId: ev.providerEventId,
      type: ev.type,
      businessId: ctx?.businessId ?? null,
      payload: (ctx?.payload ?? ev.raw) as object,
      headers: ctx?.headers ?? null,
      requestUrl: ctx?.requestUrl ?? null,
      normalized: encodeNormalizedEvent(ev) as object | null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted.length === 0) {
    // Only a SETTLED outcome makes a redelivery a duplicate. A prior attempt that ERRORED
    // must run again, or the redelivery we asked for (502) is swallowed by our own dedup.
    // A NULL outcome is a delivery still in flight, so it stays a duplicate by default.
    //
    // The re-run holds the per-event lock and reads the outcome under it: a gateway
    // redelivery and our retry job can arrive together, and only one may apply the event.
    // A first delivery takes no lock: no job or replay targets a row before it exists.
    // The lock's transaction only holds the lock; the handlers book on their own connections.
    const rerunIf = ctx?.rerunIf ?? ((o: string | null) => o === "error");
    return systemDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${providerEventLockKey(providerKey, ctx?.businessId, ev.providerEventId)}))`,
      );
      const [prior] = await tx
        .select({ outcome: providerEvents.outcome })
        .from(providerEvents)
        .where(providerEventKey(providerKey, ev.providerEventId, ctx?.businessId))
        .limit(1);
      if (!prior || !rerunIf(prior.outcome)) return "duplicate" as const;
      return applyProviderEvent(providerKey, ev, ctx);
    });
  }
  return applyProviderEvent(providerKey, ev, ctx);
}

/** Apply an event whose log row exists and is ours to run, then record its outcome. */
async function applyProviderEvent(
  providerKey: string,
  ev: NormalizedProviderEvent,
  ctx?: InboundContext,
): Promise<HandleResult> {
  let result: HandleResult = "ignored";
  let error: string | null = null;
  try {
    if (ev.unresolved) throw new Error(ev.unresolved);
    if (ev.type === "charge.refunded" && ev.providerChargeId) {
      result = await applyRefund(providerKey, ev, ctx?.businessId ?? null);
      if (result === "ignored") await nudgeSetupAuthRefundFor(providerKey, ev.providerChargeId);
    } else if (ev.type === "charge.succeeded" && ev.providerChargeId) {
      result = await reconcileChargeSucceeded(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type === "charge.failed" && ev.providerChargeId) {
      result = await reconcileChargeFailed(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type === "payment_method.updated" && ev.providerPaymentMethodId) {
      result = await applyPaymentMethodUpdate(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type === "payment_method.mandate_updated" && ev.providerPaymentMethodId) {
      result = await applyMandateUpdate(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type === "payment_method.detached" && ev.providerPaymentMethodId) {
      result = await applyPaymentMethodDetached(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type === "refund.failed") {
      result = await reverseFailedRefund(providerKey, ev, ctx?.businessId ?? null);
      // Not one of our payments: maybe a setup refund, whose watcher looks now.
      if (result === "ignored" && ev.providerChargeId)
        await nudgeSetupAuthRefundFor(providerKey, ev.providerChargeId);
      // ⚠️ BEFORE the generic `intent.` branch, and deliberately not inside
      // `applyIntentEvent`. That handler correlates only on
      // `payment_intents.intent_at_gateway`, and the case that matters most here has
      // no row in that table: an off-session India debit is made by `charge()`, which
      // mints a PaymentIntent at the gateway but records it as a TRANSACTION's
      // `id_at_gateway`. Routed through `applyIntentEvent` the pre-debit notification
      // would find no intent and be dropped — the same silent-miss shape as the
      // RazorPay netbanking `invoice_id` correlation bug.
      /**
       * RECORDED, deliberately not acted on.
       *
       * The row is the whole point: `sweepOrphanedIntents` reads `provider_events` later
       * to ask which of these intents never acquired a local transaction. Judging it here
       * would be wrong in the most expensive way — the event fires before our own
       * transaction commits, so an inline "no local row ⇒ orphan" test fires on nearly
       * every payment we make and would bury the real ones.
       *
       * `ignored` rather than `processed`, because that is what happened: nothing was
       * applied. It stays replayable either way (GW-7 now accepts an ignored row).
       */
    } else if (ev.type === "intent.created") {
      result = "ignored";
    } else if (ev.type === "intent.requires_action") {
      result = await applyActionRequired(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type.startsWith("intent.") && ev.providerIntentId) {
      result = await applyIntentEvent(ev, ctx?.businessId ?? null, providerKey);
    } else if (ev.type.startsWith("dispute.")) {
      result = await handleDisputeEvent(ev, {
        businessId: ctx?.businessId ?? null,
        providerKey,
        requirePayment: ctx?.polled === true,
      });
    } else if (ev.type === "charge.reversed") {
      result = await applyChargeReversal(providerKey, ev, ctx?.businessId ?? null);
    } else if (ev.type === "reserve.hold.updated") {
      result = await recordMoneyMovedAgainstUs(providerKey, ev);
    } else if (ev.type === "pre_debit_notice.updated" && ev.preDebitNotice) {
      result = await applyGatewayNoticeUpdate({
        providerKey,
        businessId: ctx?.businessId ?? null,
        gatewayAccountId: ctx?.gatewayAccountId ?? null,
        update: ev.preDebitNotice,
      });
    }
  } catch (e) {
    result = "error";
    error = e instanceof Error ? e.message : String(e);
    // The row keeps the message so the Gateway Webhooks screen can show it; the log
    // keeps the stack. This is inbound money reconciliation — a refund or a charge
    // outcome that failed to apply is a divergence between us and the gateway.
    log.error(e, { event: "inbound_event_apply_failed", type: ev.type, provider: providerKey });
  }

  // P2: which transaction did this callback affect? The Gateway Webhooks log's
  // Transaction column is what makes a row actionable — you jump straight from the
  // callback to the money it moved.
  //
  // The gateway's charge id is the only handle every provider gives us, and
  // `transactions.id_at_gateway` is indexed for exactly this lookup
  // (`transactions_gateway_charge_idx`). Resolved here, once, instead of inside each
  // handler: the rule is then uniform across refunds / settlements / reversals /
  // disputes, and it stays NULL — honestly — for an event with no charge at all
  // (`payment_method.updated`) or a charge that is not ours (a provider CLI test
  // event). Stored as the public id; see migration 0141 for why not a uuid FK.
  let transactionPublicId: string | null = null;
  if (ev.providerChargeId) {
    // Same resolver the money handlers use, so the row the inspector points at is the
    // row that was actually acted on. It was previously an unscoped `id_at_gateway`
    // match, which could label a delivery with ANOTHER provider's transaction —
    // cosmetic, but a Transaction column that links to the wrong money is worse than
    // an empty one. (`id_at_gateway` is not unique — an authorization and its capture
    // share it — so newest-first is the tiebreak, not an ambiguity.)
    const txn = await resolveTransactionByCharge(
      providerKey,
      ev.providerChargeId,
      ctx?.businessId ?? null,
    );
    transactionPublicId = txn?.publicId ?? null;
  }

  await systemDb
    .update(providerEvents)
    .set({
      processedAt: new Date(),
      outcome: result,
      error,
      transactionPublicId,
      // Also on the UPDATE path, so a redelivery backfills a row written before this
      // column existed — otherwise a legacy event could error, be redelivered, and
      // still end up un-replayable.
      normalized: encodeNormalizedEvent(ev) as object | null,
      // Only overwrite the URL when this delivery actually had one, so a
      // reprocessed event keeps the URL of the delivery that carried it.
      ...(ctx?.requestUrl != null ? { requestUrl: ctx.requestUrl } : {}),
    })
    .where(providerEventKey(providerKey, ev.providerEventId, ctx?.businessId));
  return result;
}

/**
 * charge.succeeded (async settlement of a timeout / in-progress attempt): settle
 * the matching transaction and its linked payment + invoice.
 */
/**
 * Failure codes a later `charge.succeeded` may legitimately OVERTURN — the cases where the
 * gateway is telling us we were wrong about a debit the buyer went on to authorise.
 *
 * `afa_not_completed` is written by the stale-pending sweep after 72 hours of waiting.
 * `requires_action` is the same event a step earlier and used to be UNREVIVABLE, which cost
 * real money: measured 2026-09-05, ₹17,736.11 on `pi_XXXXXXXXXXXXXXXXXXXXXX07`. An
 * off-session India debit answered `requires_action`, was booked as a terminal failure, the
 * buyer completed 3D Secure five minutes later, Stripe captured it and announced it TWICE —
 * and both `charge.succeeded` deliveries were dropped by the status gate below. The engine
 * held: no payment row at all, a failed transaction, and an invoice still `payment_due` for
 * the full amount. **Money taken and nothing anywhere to reconcile from** — and invisible to
 * `unapplied_gateway_money` too, because that alert counts payments the settlement path
 * TAGGED, and no payment was ever created.
 *
 * `collectClaimedInvoice` now books an off-session `requires_action` as PENDING — at ANY
 * amount, since 2026-09-09 — so this shape stops being produced. This set is the repair for
 * the ones already in it: a redelivery settles them instead of being ignored a second time.
 *
 * ⚠️ THREE CODES, AND ALL THREE ARE LOAD-BEARING.
 * `requires_action` is the raw gateway STATUS, which the failure path used to store as
 * though it were a decline code. It no longer writes it — the canonical token is
 * `authentication_required`, which the policy actually parks — but production rows already
 * carry the old string (`txn_XXXXXXXXXXXXXXXXXXXXXX03`, INV-100001). Dropping it to tidy up
 * would make exactly those rows unrevivable, which is the bug, on the very rows it was
 * written for. It stays until they are gone.
 *
 * ⚠️ Deliberately NOT "any failure". A hard decline that later reports success is a
 * contradiction worth investigating, not a settlement to wave through — these two codes are
 * the ones where waiting for a person is the DESIGNED outcome, so a late success is the
 * expected end of the story rather than a surprise.
 */
export const AFA_REVIVABLE_CODES = new Set([
  "afa_not_completed",
  "authentication_required",
  // Historical only — see the note above. Do not remove while such rows exist.
  "requires_action",
]);

async function reconcileChargeSucceeded(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const txn = await resolveChargeEventTransaction(providerKey, ev, deliveredByBusinessId);
  /**
   * ── MONEY WITH NO TRANSACTION BEHIND IT (2026-08-31) ────────────────────────────
   *
   * `return "ignored"` here was silent data loss. There are two routine ways for a real
   * capture to reach us with no `transactions` row of its own, and one of them was
   * measured on production data:
   *
   *   INV-5510 — the buyer pressed portal "Pay now" twice, our own route minted a SECOND
   *   RazorPay order while the first was still live, and both were paid. The first
   *   captured and settled the invoice. For the second (`pay_XXXXXXXXXXXX01`) RazorPay
   *   sent `intent.authorized` and then `charge.succeeded` TWICE — all three ignored. Real
   *   money, and the engine held no payment, no transaction and no ledger entry for it, so
   *   it could not be seen, reconciled or given back.
   *
   * The other is a late authorization: our own one-hour intent TTL expires, the bank
   * authorizes afterwards, and nothing ever revisits it (`probe-late-authorization.ts`).
   *
   * So an unmatched capture is now BOOKED rather than dropped — applied to the invoice it
   * was raised for if that invoice can still absorb the whole amount, otherwise held as
   * the customer's excess-payment credit, which is refundable. `settleUnmatchedGatewayCapture`
   * owns those rules (it delegates to `settleAbandonedCapture`, so there is one
   * implementation of "where does this money go").
   *
   * The intent is the only honest source for WHO and WHAT-FOR: the charge payload gives us
   * an amount but not our customer or our invoice. `providerIntentId` on a `charge.*` event
   * is what makes this reachable at all (see the RazorPay adapter's charge branch, changed
   * the same day). With no intent to correlate, we do NOT guess — attributing a payment to
   * the wrong customer is worse than the gap — but we no longer stay quiet about it.
   */
  if (!txn) {
    if (ev.type !== "charge.succeeded") return "ignored";
    return reconcileUnmatchedCapture(providerKey, ev, deliveredByBusinessId);
  }
  /**
   * A capture for a debit we had ALREADY GIVEN UP ON.
   *
   * `afa_not_completed` is written when an authentication-pending debit is abandoned —
   * by the 72-hour sweep, or by the buyer's "I won't approve this" in the portal — and
   * abandoning is local-only, because RazorPay cannot void a `created` recurring
   * payment. So the buyer approving it afterwards is a real capture, and this used to
   * fall through the status gate below and be dropped as `'ignored'`: no ledger entry,
   * no event, and a customer charged twice with nothing anywhere to reconcile from.
   * Handled BEFORE the gate, because it is the one case where the gateway is telling
   * us we were wrong.
   */
  if (txn.status === "failed" && AFA_REVIVABLE_CODES.has(txn.errorCode ?? "") && txn.paymentId) {
    return reconcileAbandonedCapture(txn, ev.occurredAt);
  }
  // A payment request's charge captured after we failed it. Its children failed and its
  // invoices stayed owed, so the money pays the ones still owed and only the rest is refunded.
  if (
    txn.status === "failed" &&
    AFA_REVIVABLE_CODES.has(txn.errorCode ?? "") &&
    txn.paymentRequestId &&
    txn.customerId &&
    ev.providerChargeId
  ) {
    // We book our own quoted amount; a capture known to differ is refused, not guessed at.
    const captured = ev.capturedAmountMinor;
    if (captured != null && captured !== txn.amountMinor) {
      await refuseMismatchedRequestCapture(txn, captured);
      return "ignored";
    }
    const late = await reconcileLateRequestCapture(txn, {
      providerKey,
      chargeId: ev.providerChargeId!,
      occurredAt: ev.occurredAt,
    });
    // A newer attempt on the same charge id is still pending: settling now would credit it with
    // this money. Fail the delivery so the gateway redelivers once that attempt resolves.
    if (late === "in_flight")
      throw new Error("A newer attempt on this payment request is in flight; retry later");
    return late;
  }
  /**
   * A capture after a failure the gateway itself reported — late authorisation, a payer
   * retry on UPI, a Direct Debit retried from the gateway's dashboard (also after a late
   * failure). Only on a gateway that declares it, and only for the same amount: the money
   * is real, so it is booked by the abandoned-capture policy (to the invoice if it still
   * owes it, else credit + refund) instead of being dropped.
   */
  // A capture on a charge the lost-answer sweep failed as never created: the money is real.
  if (txn.status === "failed" && txn.type === "payment" && txn.paymentId) {
    const { LOST_ANSWER_NOT_CREATED_CODE } = await import("@/modules/payments/lost-answer");
    const amount = ev.capturedAmountMinor ?? ev.amountMinor;
    if (
      txn.errorCode === LOST_ANSWER_NOT_CREATED_CODE &&
      (amount == null || amount === txn.amountMinor)
    ) {
      log.error(new Error("a charge the gateway said it never created was captured"), {
        event: "lost_answer_capture_after_not_found",
        provider: providerKey,
        transaction: txn.publicId,
        provider_charge_id: ev.providerChargeId ?? null,
      });
      return reconcileAbandonedCapture(txn, ev.occurredAt);
    }
  }
  if (
    (txn.status === "failed" || txn.status === "late_failed") &&
    txn.type === "payment" &&
    txn.paymentId &&
    gatewayDefinition(providerKey)?.settlement.lateCaptureAfterFailure &&
    ev.amountMinor != null &&
    ev.amountMinor === txn.amountMinor
  ) {
    const result = await reconcileAbandonedCapture(txn, ev.occurredAt);
    if (result === "processed")
      log.error(new Error("a capture arrived after the gateway reported the payment failed"), {
        event: "late_capture_after_failure",
        provider: providerKey,
        transaction: txn.publicId,
        provider_charge_id: ev.providerChargeId ?? null,
        failure_code: txn.errorCode ?? null,
        amount_minor: String(txn.amountMinor),
      });
    return result;
  }
  if (!["in_progress", "timeout", "needs_attention"].includes(txn.status)) return "ignored";
  await withTenant(txn.organizationId, async (tx) => {
    await setTransactionStatus(tx, txn.organizationId, txn.id, "succeeded", {
      settledAt: ev.occurredAt,
    });
    // Shared settlement path: books cash/AR, flips payment + invoice, emits events.
    await settleTransactionOutcome(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      outcome: "succeeded",
      occurredAt: ev.occurredAt,
      txn,
    });
  });
  return "processed";
}

/**
 * Ask the GATEWAY whose object this capture is (#31) — the extra call, and it is bought
 * only on a path that has already failed.
 *
 * ── Why the ask is needed at all ────────────────────────────────────────────────
 * Stripe and PayPal answer INLINE: Stripe's PaymentIntent copies its metadata onto the
 * charge at creation, and PayPal's capture carries `custom_id`. RazorPay does not —
 * `payment.captured` carries the PAYMENT entity's notes, and we do not stamp payments
 * (its two s2s payment-create calls deliberately send no notes). The tag lives on the
 * ORDER, so on RazorPay the common case arrives as `unknown` and stays unclassifiable
 * unless somebody fetches `GET /orders/{id}`. Without this call the three-way split
 * collapses to one bucket on the very gateway #31 is about.
 *
 * ── Why it is not on the happy path ─────────────────────────────────────────────
 * It is a SECOND round trip (`fetchIntent`'s own poll reads `/orders/{id}/payments`,
 * which returns payment entities and therefore neither the order's `notes` nor its
 * `created_at` — measured by G1b). Almost every capture matches a local row, so paying
 * for this on all of them would buy latency for information nobody wanted. Hence
 * `resolveOwnership` is opt-in on the contract, and this is its only engine caller.
 *
 * ── The rules it obeys ─────────────────────────────────────────────────────────
 *  1. **Never overwrite a definite answer.** An adapter that already said `ours` or
 *     `foreign` read a real tag field; asking again could only cost a call.
 *  2. **Never throw.** A gateway that is down, a revoked key, an account whose
 *     credentials will not decrypt — none of that is evidence about whose money this is,
 *     and none of it may fail a webhook that is otherwise handled. Every failure leaves
 *     `ownership` exactly as it was, which means `unclassified`: counted, never paged.
 *  3. **Try every account that could own it, stop at the first definite answer.** A
 *     business can hold more than one account for a gateway (live + test), and we cannot
 *     tell from the event which one minted the order. Reading with the WRONG account's
 *     keys cannot produce a false verdict — the ownership read answers 4xx for an order
 *     RazorPay has never heard of and `fetchOrderOwnership` turns any non-2xx into
 *     `unknown` — so
 *
 *     ⚠️ WHICH CALL does the 4xx was wrong here until 2026-09-04, corrected by measurement
 *     while gating this function (#39): `GET /orders/{id}` — the ownership read — answers
 *     `400 "The id provided does not exist"`, but `GET /orders/{id}/payments`, the poll
 *     `fetchIntent` makes FIRST, answers **200 with an empty collection** for a bogus id.
 *     The conclusion stands (the read that decides ownership does 4xx), but anyone reasoning
 *     from the old sentence would have expected the poll to refuse and it does not. Same
 *     measurement: a WRONG-KEY account costs ONE call, not two, because the poll 401s and
 *     `fetchIntent` early-returns before the ownership read is ever attempted.
 *     iterating is safe, and the cost is bounded by how many accounts exist.
 *
 * Mutates `ev` deliberately, and this is the mechanism the ALERT depends on:
 * `handleProviderEvent` re-encodes `ev` into `provider_events.normalized` after the
 * handler returns, so the resolved answer becomes the durable record that
 * `unappliedGatewayMoney` reads back later. There is no column for it and adding one is
 * not this change's to make — the normalized blob is already the row's "what we
 * understood this delivery to be".
 */
async function resolveCaptureOwnership(
  providerKey: string,
  ev: NormalizedProviderEvent,
  deliveredByBusinessId?: string | null,
): Promise<void> {
  // Rule 1 — a read tag, either way, is already the answer.
  if (ev.ownership === "ours" || ev.ownership === "foreign") return;
  // Nothing to ask ABOUT (no order id) or nobody to ask AS (no business, so no
  // credentials). Both leave the verdict `unclassified`, which is the honest one.
  if (!ev.providerIntentId || !deliveredByBusinessId) return;
  const intentId = ev.providerIntentId;
  try {
    const accounts = await systemDb
      .select()
      .from(gatewayAccounts)
      .where(
        and(
          eq(gatewayAccounts.businessId, deliveredByBusinessId),
          eq(gatewayAccounts.gatewayKey, providerKey),
          eq(gatewayAccounts.status, "active"),
        ),
      );
    if (accounts.length === 0) return;
    const { resolveAdapter } = await import("@/providers/registry");
    for (const acc of accounts) {
      try {
        const adapter = resolveAdapter(acc);
        // Capability-gated the same way every other poll in the engine is: an adapter
        // without `fetchIntent` has no way to be asked, and that is not a failure.
        if (!adapter.fetchIntent) continue;
        const fetched = await adapter.fetchIntent({
          intentId,
          purpose: "payment",
          resolveOwnership: true,
        });
        // An adapter that ignores `resolveOwnership` reports nothing here; `unknown` is a
        // real answer and still not a definite one, so keep asking the next account.
        if (!fetched.ownership || fetched.ownership === "unknown") continue;
        ev.ownership = fetched.ownership;
        if (fetched.ownershipRef) ev.ownershipRef = fetched.ownershipRef;
        if (fetched.providerObjectCreatedAt)
          ev.providerObjectCreatedAt = fetched.providerObjectCreatedAt;
        return;
      } catch (e) {
        // Rule 2, per account: one broken account must not stop the next one being asked.
        log.warn("gateway account could not be asked who owns a capture", {
          event: "capture_ownership_unresolvable",
          gatewayAccount: acc.publicId,
          intentAtGateway: intentId,
          reason: (e as Error)?.message,
        });
      }
    }
  } catch (e) {
    // Rule 2, for the lookup itself.
    log.warn("capture ownership could not be resolved", {
      event: "capture_ownership_unresolvable",
      provider: providerKey,
      intentAtGateway: intentId,
      reason: (e as Error)?.message,
    });
  }
}

/**
 * Whether a capture the delivering business could not match is accounted for anyway, read
 * with NO business scope. The scope is right for booking and wrong for this question: a
 * gateway account shared by two businesses delivers every event to each (`provider_events`
 * dedupes per business), so the business that does not own the charge always misses it.
 * Read only, never books: the answer only decides the log level.
 *
 *  · `booked` — a payment or transaction carries the charge id, or the consumed intent the
 *    gateway object is tagged with is ours (the booking may have landed after the first,
 *    scoped lookup).
 *  · `setup_authorization` — a mandate registration's auth amount: a `setup` intent with no
 *    amount, or an order tagged with a customer id (only vault setup stamps one). The
 *    vault path refunds it (`refund_setup_auth`).
 *
 * Same populations as `unappliedGatewayMoney`'s exclusions, so the log and the alert agree.
 */
async function captureAccountedFor(
  providerKey: string,
  ev: NormalizedProviderEvent,
): Promise<{ reason: "booked" | "setup_authorization"; bookedBusiness: string | null } | null> {
  const chargeId = ev.providerChargeId!;
  const [pay] = await systemDb
    .select({ businessId: payments.businessId })
    .from(payments)
    .where(and(eq(payments.providerKey, providerKey), eq(payments.providerChargeId, chargeId)))
    .limit(1);
  if (pay) return { reason: "booked", bookedBusiness: pay.businessId };
  const [txn] = await systemDb
    .select({ businessId: transactions.businessId })
    .from(transactions)
    .where(and(eq(transactions.gatewayKey, providerKey), eq(transactions.idAtGateway, chargeId)))
    .limit(1);
  if (txn) return { reason: "booked", bookedBusiness: txn.businessId };
  if (ev.providerIntentId) {
    const intents = await systemDb
      .select({
        businessId: paymentIntents.businessId,
        publicId: paymentIntents.publicId,
        purpose: paymentIntents.purpose,
        status: paymentIntents.status,
        amountMinor: paymentIntents.amountMinor,
      })
      .from(paymentIntents)
      .where(eq(paymentIntents.intentAtGateway, ev.providerIntentId))
      .limit(5);
    for (const pi of intents) {
      if (pi.purpose === "setup" && !pi.amountMinor)
        return { reason: "setup_authorization", bookedBusiness: pi.businessId };
      if (pi.status === "consumed" && ev.ownershipRef && pi.publicId === ev.ownershipRef)
        return { reason: "booked", bookedBusiness: pi.businessId };
    }
  }
  if (ev.ownershipRef?.startsWith("cus_")) {
    const [cust] = await systemDb
      .select({ businessId: customers.businessId })
      .from(customers)
      .where(eq(customers.publicId, ev.ownershipRef))
      .limit(1);
    if (cust) return { reason: "setup_authorization", bookedBusiness: cust.businessId };
  }
  return null;
}

/**
 * A CAPTURE we have no `transactions` row for — book it against the intent it belongs to.
 *
 * See the call site in `reconcileChargeSucceeded` for the two ways this happens and the
 * INV-5510 measurement. This function's whole job is attribution: find OUR intent from the
 * gateway's order id, then hand the money to `settleUnmatchedGatewayCapture`, which decides
 * applied-vs-excess and books it.
 *
 * WHAT IT REFUSES TO DO, deliberately:
 *  · guess the customer. No intent match ⇒ WARN and `ignored`. A payment attributed to the
 *    wrong customer is a worse outcome than an unbooked one, and the log line is what a human
 *    needs to find it at the gateway.
 *  · read the amount from the payload. The intent's own `amount_minor` is what our side
 *    quoted and what the order was created for; a payload amount would have to be trusted and
 *    unit-checked (RazorPay sends paise, PayPal decimal strings) for no gain here.
 *
 * ⚠️ It DOES auto-refund the excess, and this paragraph used to say the opposite. The two
 * policies — "hold it as the customer's credit and let a human look" here, "give it back"
 * on the abandoned-debit path — CONVERGED on 2026-09-01: the excess branch below calls the
 * same `refundUnappliedExcess`, and only the reason string differs. The stale comment
 * survived the convergence and cost a reading of this file on 2026-09-03, where it was used
 * to predict that a live capture would sit as credit — it had already been refunded.
 * A comment on a money path that contradicts the code 70 lines below it is a defect.
 */
async function reconcileUnmatchedCapture(
  providerKey: string,
  ev: NormalizedProviderEvent,
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const chargeId = ev.providerChargeId;
  if (!chargeId) return "ignored";
  const pi = ev.providerIntentId
    ? await findPaymentIntentByGatewayIntentId(ev.providerIntentId, {
        businessId: deliveredByBusinessId,
      })
    : null;
  // A setup intent's capture is the mandate's own zero-amount authorization, settled by
  // the vault-setup path. There is no money to book, and it is not a lost capture.
  if (pi?.purpose === "setup" && !pi.amountMinor) {
    log.info("a gateway capture is a setup intent's zero-amount authorization — nothing to book", {
      event: "setup_capture_ignored",
      charge: chargeId,
      intent: pi.publicId,
      deliveredBy: deliveredByBusinessId ?? null,
    });
    return "ignored";
  }
  if (!pi || !pi.customerId || !pi.amountMinor || !pi.currency) {
    /**
     * ── #31 · ONE WARN WAS COVERING TWO UNRELATED THINGS ─────────────────────────
     *
     * This single line used to be emitted for BOTH "another product's charge on a shared
     * merchant account" (routine — 124 of them had already arrived, none booked) and "our
     * own capture we failed to attribute" (a money incident). One event name for both
     * means the second can never be alerted on: it hides among 1,461 ignored RazorPay
     * deliveries, and the only way to find it is to read them all.
     *
     * So the outcome is split three ways HERE, at the one place that knows the local match
     * failed, and each way gets its own event name and its own counter in
     * `unappliedGatewayMoney`. The classification rule and its rationale live on
     * {@link classifyUnmatchedCapture} — including why `unknown` may never become
     * `foreign`.
     *
     * The gateway is asked only at this point, never on the happy path: see
     * `resolveCaptureOwnership`.
     */
    await resolveCaptureOwnership(providerKey, ev, deliveredByBusinessId);
    const accounted =
      ev.ownership === "foreign" ? null : await captureAccountedFor(providerKey, ev);
    if (accounted) {
      log.info("an unmatched gateway capture is already accounted for", {
        event: "unmatched_capture_accounted_for",
        charge: chargeId,
        intentAtGateway: ev.providerIntentId ?? null,
        deliveredBy: deliveredByBusinessId ?? null,
        ownershipRef: ev.ownershipRef ?? null,
        ...accounted,
      });
      return "ignored";
    }
    const provenance = classifyUnmatchedCapture(ev);
    const facts = {
      charge: chargeId,
      intentAtGateway: ev.providerIntentId ?? null,
      deliveredBy: deliveredByBusinessId ?? null,
      provenance,
      ownership: ev.ownership ?? null,
      ownershipRef: ev.ownershipRef ?? null,
      // Still logged though no longer used to classify: it is the evidence that would
      // let anyone re-litigate a single verdict if the rollout gate is ever restored.
      objectCreatedAt: ev.providerObjectCreatedAt?.toISOString() ?? null,
    };
    if (provenance === "ours_unattributed")
      // `error`, and it is the only one of the three that is: the gateway is holding an
      // object stamped with OUR ref that this engine has no record of. `ownershipRef`
      // is what makes it findable — it is the public id `createIntent` minted before it
      // crashed, so an operator can search for the row that was never written.
      log.error(
        new Error("a gateway capture carries OUR ownership tag but we hold no record of it"),
        {
          event: UNMATCHED_CAPTURE_EVENTS[provenance],
          ...facts,
        },
      );
    else if (provenance === "foreign")
      // Routine, and deliberately NOT a warning: on a shared merchant account this is a
      // sibling product's money and there is nothing for anyone to do about it. Logged at
      // `info` so the volume stays measurable without teaching anyone to ignore warnings.
      log.info("a gateway capture belongs to another product on this merchant account", {
        event: UNMATCHED_CAPTURE_EVENTS[provenance],
        ...facts,
      });
    else
      // The original event NAME is kept for this bucket on purpose: it is still "could not
      // be attributed", it is still a warning, and anything already grepping for it keeps
      // working. What changed is that it no longer swallows the two verdicts above.
      log.warn("a gateway capture could not be attributed to any intent — NOT booked", {
        event: UNMATCHED_CAPTURE_EVENTS[provenance],
        ...facts,
      });
    return "ignored";
  }
  /**
   * WHY this money cannot be applied — the cause an operator reads on the alert, and the
   * sentence the refund is worded from.
   *
   * The discriminator is whether WE closed the intent, not what its status happens to be.
   * The first cut asked `pi.status === "consumed"` and got it backwards: in the real
   * INV-5510 shape the duplicate intent was never consumed at all — it sat `in_progress`
   * while the FIRST payment settled the invoice — so a second checkout was reported as a
   * late authorization. Caught by `verify:stale-pending` § P asserting the value rather
   * than just the presence of the marker.
   *
   *   expired / voided ⇒ our clock or our void ended it, and the bank answered afterwards.
   *   anything else    ⇒ the intent was live; the money simply has no room on the invoice,
   *                      which is a duplicate payment however it came about.
   */
  const cause =
    pi.status === "expired" || pi.voidedAt != null ? "late_authorization" : "second_checkout";
  const { settleUnmatchedGatewayCapture } = await import("@/modules/payments/settlement");
  const res = await withTenant(pi.organizationId, (tx) =>
    settleUnmatchedGatewayCapture(tx, {
      organizationId: pi.organizationId,
      businessId: pi.businessId,
      customerId: pi.customerId!,
      invoiceId: pi.invoiceId ?? null,
      currency: pi.currency!,
      amountMinor: pi.amountMinor!,
      providerKey,
      providerChargeId: chargeId,
      paymentMethodId: pi.paymentMethodId ?? null,
      reason: cause,
      occurredAt: ev.occurredAt,
    }),
  );
  if (!res.booked) {
    // `already_recorded` is the ordinary redelivery and needs no noise. The others mean
    // the money is still unbooked, which does.
    if (res.reason !== "already_recorded")
      log.warn("an unmatched gateway capture could not be booked", {
        event: "unmatched_capture_not_booked",
        charge: chargeId,
        intent: pi.publicId,
        reason: res.reason,
      });
    return res.reason === "already_recorded" ? "duplicate" : "ignored";
  }
  // Applied to its invoice ⇒ the money is where it belongs. Held as excess ⇒ nothing can
  // ever apply it, so it goes back — the same policy the abandoned-debit path uses, via
  // the same function (see `refundUnappliedExcess`). A buyer who paid twice for one
  // invoice should not have to ask.
  if (res.disposition === "excess")
    await refundUnappliedExcess(
      { organizationId: pi.organizationId, businessId: pi.businessId },
      res,
      cause === "second_checkout"
        ? "Duplicate payment for an invoice that was already settled"
        : "Authorization captured after its intent had expired, with no invoice to apply it to",
    );
  /**
   * ── #26 · AND CLOSE THE INTENT THE MONEY CAME FROM ──────────────────────────
   *
   * Measured on a second failure test (2026-09-03): `pi_XXXXXXXXXXXXXXXXXXXXXX02`
   * was still `in_progress` with `authorized_at` NULL long after its charge
   * `pay_XXXXXXXXXXXX07` captured at 18:10:35 and was auto-refunded at 18:10:38. The
   * money was never at risk — the ledger is square and the net is ₹0 — but the INTENT
   * was left open by everything: A1's `closeIntentForReturnedCharge` fires on a late
   * `intent.authorized`, and no such event ever arrived here, because the CAPTURE came
   * instead and this function did not close anything.
   *
   * What an open intent costs after its money has been settled: it is still LIVE to
   * `liveIntentForInvoice`, so the buyer is told "a payment is already in progress" for
   * a payment that finished and was handed back; and `releaseZeroDueIntents`
   * (`payments/stale-pending.ts`) keeps offering the row to a gateway that cannot void
   * it, logging `zero_due_intent_uncancellable` each time.
   *
   * ── ONE WRITER, and it is A1's ──────────────────────────────────────────────
   * `closeIntentForReturnedCharge` already encodes every decision this needs — why
   * `consumed` and not `voided`, why `authorized_at` is coalesced, why no `transactions`
   * row (the payment and the refund already tell the money's story), and the
   * compare-and-set that makes two deliveries safe. A second closer here would be the
   * two-writers-of-one-fact failure #15 and #17 are both about.
   *
   * ⚠️ Scoped to `second_checkout`, i.e. to an intent that was still LIVE. The other
   * cause means the intent is `expired` or already `voided`: both are terminal, both are
   * already excluded from every live predicate (so neither carries the cost above), and
   * `expired` in particular is the one state `reviveIntentForLateAuthorization` claims
   * for its own policy — flipping it to `consumed` from here would rewrite why a
   * terminal row closed to fix a harm it does not have.
   */
  if (cause === "second_checkout") {
    // The refund facts come from the ONE implementation of "has this money come back?",
    // for the same reason A1's call site uses it; the payment id comes from the row we
    // just booked, which needs no re-read to be certain of. `refundedMinor: 0n` on the
    // `applied` disposition is not a gap — the money went to its invoice and the event
    // says so.
    const { chargeAlreadyReturned } = await import("@/modules/refunds/service");
    const returned = await chargeAlreadyReturned(pi.organizationId, chargeId);
    const { closeIntentForReturnedCharge } = await import("@/modules/payment-intents/service");
    const closed = await closeIntentForReturnedCharge(
      pi.organizationId,
      pi.businessId,
      pi.publicId,
      {
        providerChargeId: chargeId,
        refundedMinor: returned.refundedMinor,
        fullyReturned: returned.fullyReturned,
        providerRefundId: returned.providerRefundId,
        refundPublicId: returned.refundPublicId,
        paymentPublicId: res.paymentPublicId,
      },
    );
    // `info`: the two WARNs above (`unmatched_gateway_capture_booked` and, on the excess
    // branch, `unapplied_excess_refunded`) already carry the money. This is the
    // bookkeeping tail — and `closed: false` means a concurrent delivery got there
    // first, which is correct behaviour, not a problem.
    log.info("a checkout was closed by the capture it produced", {
      event: "unmatched_capture_closed_intent",
      intent: pi.publicId,
      charge: chargeId,
      payment: res.paymentPublicId,
      disposition: res.disposition,
      refundedMinor: String(returned.refundedMinor),
      closed: closed != null,
    });
  }
  return "processed";
}

/**
 * Book a capture of an abandoned debit, then give back whatever the invoice could not
 * take.
 *
 * Two steps, and the ORDER is forced by double-entry rather than chosen: you cannot
 * refund money you have not recorded, and cash with no receivable behind it is a
 * liability to the customer — which is what `excess_payment_balance` is. So the money
 * is always booked first, and the refund is an action on top of it.
 *
 * The refund runs OUTSIDE the settle transaction, deliberately: `refundPayment` opens
 * its own, and it reaches a gateway. A gateway call inside the transaction that holds
 * the invoice lock would hold it for the length of a network round trip.
 *
 * A refund that fails leaves the money as customer credit — a correct, already-built,
 * visible state (it shows on the customer's balances panel, draws down their next
 * invoice, and an operator can refund it by hand). That is why the failure is logged
 * and swallowed rather than rethrown: rethrowing makes the gateway redeliver the
 * webhook, and the claim inside `settleAbandonedCapture` means the redelivery would
 * book nothing and retry nothing. The money is safe either way; the log is how a human
 * finds it.
 */
export async function reconcileAbandonedCapture(
  /**
   * Structurally typed rather than `ReturnType<typeof resolveTransactionByCharge>`: this
   * policy reads four fields, and naming them means the SWEEP can pass its own row without
   * a cast. A cast there would compile happily and hide a shape change forever, which on a
   * money path is the wrong trade — see `recheckAbandonedAfaDebits`.
   */
  txn: { id: string; organizationId: string; businessId: string; paymentId: string | null },
  /**
   * When the gateway says the capture happened — NOT `new Date()`.
   *
   * Was the whole `NormalizedProviderEvent`, of which only this field was ever read.
   * Narrowed on 2026-08-31 so the STALE-PENDING SWEEP can call the same function: the
   * webhook is not the only way we find out about one of these captures (it was, and that
   * was the gap — see `sweepStalePendingCharges`'s AFA re-poll), and "book it, then give
   * back what the invoice could not take" is a money POLICY that must have exactly one
   * implementation. A sweep constructing a fake event to satisfy a signature is how the
   * second implementation starts.
   */
  occurredAt: Date,
): Promise<HandleResult> {
  const booked = await withTenant(txn.organizationId, async (tx) => {
    // The payment claim is the ONLY idempotency guard, so it runs before any write —
    // including the transaction's own status, which is why that is set second.
    const res = await settleAbandonedCapture(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      paymentId: txn.paymentId!,
      occurredAt: occurredAt,
    });
    if (!res.booked) return res;
    await setTransactionStatus(tx, txn.organizationId, txn.id, "succeeded", {
      // The failure is retracted, not kept alongside a success — a `success` row still
      // carrying `afa_not_completed` would re-enter this branch on the next delivery.
      errorCode: null,
      errorText: null,
      retriable: null,
      settledAt: occurredAt,
    });
    return res;
  });
  if (!booked.booked) return "duplicate";
  if (booked.disposition === "applied") return "processed";

  await refundUnappliedExcess(
    { organizationId: txn.organizationId, businessId: txn.businessId },
    booked,
    "Duplicate capture of a debit the customer had abandoned",
  );
  return "processed";
}

/** Not in {@link AFA_REVIVABLE_CODES}, so nothing books the capture automatically. */
const CAPTURE_AMOUNT_MISMATCH_CODE = "capture_amount_mismatch";

/**
 * Refuse a late request capture whose amount differs from our charge, and take the
 * transaction off the AFA codes so neither the recheck sweep (which has no amount to
 * compare) nor a redelivery books it at our quoted amount. An operator settles it by hand.
 */
async function refuseMismatchedRequestCapture(
  txn: {
    id: string;
    publicId: string;
    organizationId: string;
    amountMinor: bigint;
    currency: string;
  },
  capturedMinor: bigint,
): Promise<void> {
  const previous = await withTenant(txn.organizationId, async (tx) => {
    const [row] = await tx
      .select({ status: transactions.status, errorCode: transactions.errorCode })
      .from(transactions)
      .where(eq(transactions.id, txn.id))
      .for("update")
      .limit(1);
    // Booked or already re-coded by a concurrent path: nothing left to refuse.
    if (!row || row.status !== "failed" || !AFA_REVIVABLE_CODES.has(row.errorCode ?? ""))
      return null;
    await setTransactionStatus(tx, txn.organizationId, txn.id, "failed", {
      errorCode: CAPTURE_AMOUNT_MISMATCH_CODE,
      errorText:
        `The gateway captured ${capturedMinor} but this charge is ${txn.amountMinor} ` +
        `(${txn.currency} minor units). We did not book it. Previous code: ${row.errorCode}.`,
    });
    return row.errorCode;
  });
  log.error(new Error("late capture amount differs from the request charge — not booked"), {
    event: "payment_request_late_capture_amount_mismatch",
    txn: txn.publicId,
    capturedMinor: String(capturedMinor),
    expectedMinor: String(txn.amountMinor),
    currency: txn.currency,
    previousCode: previous,
  });
}

/**
 * A payment request's charge captured after we failed it (AFA): pay the request's invoices
 * still owed, refund the rest. One implementation for the webhook and the AFA recheck sweep;
 * the transaction's failed → succeeded flip is the claim, so the two never both book.
 * `in_flight`: a newer attempt on this request is pending; the caller retries later.
 */
export async function reconcileLateRequestCapture(
  txn: {
    id: string;
    organizationId: string;
    businessId: string;
    paymentRequestId: string | null;
    customerId: string | null;
    paymentMethodId: string | null;
    currency: string;
    amountMinor: bigint;
  },
  input: { providerKey: string; chargeId: string; occurredAt: Date },
): Promise<HandleResult | "in_flight"> {
  if (!txn.paymentRequestId || !txn.customerId) return "ignored";
  const { settleLateRequestCapture } = await import("@/modules/payment-requests/service");
  const late = await withTenant(txn.organizationId, (tx) =>
    settleLateRequestCapture(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      requestId: txn.paymentRequestId!,
      transactionId: txn.id,
      chargeId: input.chargeId,
      occurredAt: input.occurredAt,
    }),
  );
  if (late.kind === "duplicate") return "duplicate";
  if (late.kind === "refused") return "ignored";
  if (late.kind === "booked") {
    if (late.excess)
      await refundUnappliedExcess(
        { organizationId: txn.organizationId, businessId: txn.businessId },
        late.excess,
        "Payment request charge captured after it was marked failed",
      );
    return "processed";
  }
  if (late.reason === "attempt_in_flight") return "in_flight";
  // The request moved on to another charge: hold the money as credit and refund it.
  const { settleUnmatchedGatewayCapture } = await import("@/modules/payments/settlement");
  const res = await withTenant(txn.organizationId, (tx) =>
    settleUnmatchedGatewayCapture(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      customerId: txn.customerId!,
      invoiceId: null,
      currency: txn.currency,
      amountMinor: txn.amountMinor,
      providerKey: input.providerKey,
      providerChargeId: input.chargeId,
      paymentMethodId: txn.paymentMethodId,
      reason: "late_authorization",
      occurredAt: input.occurredAt,
    }),
  );
  if (!res.booked) return res.reason === "already_recorded" ? "duplicate" : "ignored";
  if (res.disposition === "excess")
    await refundUnappliedExcess(
      { organizationId: txn.organizationId, businessId: txn.businessId },
      res,
      "Payment request charge captured after it was marked failed",
    );
  return "processed";
}

/**
 * Does this `charge.failed` ask to reverse a succeeded charge? `lateReversal` is the
 * contract; `raw.data.reversal` is the deprecated form older adapters still set.
 */
export function asksForLateReversal(ev: NormalizedProviderEvent): boolean {
  if (ev.lateReversal === true) return true;
  return Boolean((ev.raw as { data?: { reversal?: boolean } } | undefined)?.data?.reversal);
}

/**
 * charge.failed: a reversal after a prior success → the transaction becomes a
 * late_failure, the invoice reopens for dunning, and the cash is reversed on the
 * ledger. A plain async failure just fails the in-progress transaction.
 */
async function reconcileChargeFailed(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const txn = await resolveChargeEventTransaction(providerKey, ev, deliveredByBusinessId);
  if (!txn) return "ignored";
  const isReversal = asksForLateReversal(ev);

  if (isReversal && txn.status === "succeeded") {
    // A late HARD decline (retriable=false) must not re-arm the retry schedule (G
    // backlog); unspecified reversals stay retriable (existing behavior).
    //
    // The adapter's normalized verdict wins when it has one — it read the gateway's
    // own decline code — and the `raw.data.retriable` probe stays as the fallback
    // for the test harnesses that set it directly.
    const reversalRetriable =
      ev.failureRetriable ??
      (ev.raw as { data?: { retriable?: boolean } } | undefined)?.data?.retriable !== false;
    const applied = await withTenant(txn.organizationId, async (tx) => {
      // Re-read under lock: a concurrent redelivery waits here, then finds it reversed.
      const [cur] = await tx
        .select({ status: transactions.status })
        .from(transactions)
        .where(eq(transactions.id, txn.id))
        .limit(1)
        .for("update");
      if (cur?.status !== "succeeded") return false;
      await setTransactionStatus(tx, txn.organizationId, txn.id, "late_failed", {
        errorCode: "reversal",
        settledAt: null,
      });
      // Reverse the cash the payment still holds (AR reopens).
      if (txn.paymentId) {
        // Row-locked: dispute transitions on this payment queue behind the reversal.
        const [pay] = await tx
          .select()
          .from(payments)
          .where(eq(payments.id, txn.paymentId))
          .limit(1)
          .for("update");
        if (pay) {
          await tx
            .update(payments)
            .set({
              status: "failed",
              failureCode: "late_failure",
              reversalCode: ev.failureCode ?? null,
            })
            .where(eq(payments.id, pay.id));
          const { postLateReversal } = await import("@/modules/payments/late-reversal");
          await postLateReversal(tx, {
            pays: [pay],
            sourceIdFor: () => txn.publicId,
            statedMinor: ev.reversalAmountMinor ?? null,
          });
        }
      }
      // A payment request's charge: reverse every child and reopen their invoices.
      if (txn.paymentRequestId) {
        const { reverseRequestCharge } = await import("@/modules/payment-requests/gateway-hooks");
        await reverseRequestCharge(tx, txn, ev.occurredAt, ev.reversalAmountMinor ?? null, {
          declineCode: ev.failureCode,
          retriable: reversalRetriable,
        });
      }
      // Reopen the invoice — but honour the merchant's dunning state (stop/pause)
      // and offline (auto-collect-off) invoices via planFailureRearm, exactly like
      // the other two failure writers. The naive path unconditionally set
      // payment_due + in_progress + attempt-1 retry, clobbering a stop/pause and
      // dragging offline invoices into auto-dunning (review blocker).
      if (txn.invoiceId) {
        const [inv0] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, txn.invoiceId))
          .limit(1);
        if (inv0) {
          const { inv, set } = await rearmReversedInvoice(tx, {
            organizationId: txn.organizationId,
            businessId: txn.businessId,
            invoice: inv0,
            paymentMethodId: txn.paymentMethodId,
            occurredAt: ev.occurredAt,
            declineCode: ev.failureCode,
            retriable: reversalRetriable,
            paymentId: txn.paymentId,
          });
          if (inv) {
            // `send_invoice` joins the open set when — and only when — it actually landed
            // on `payment_due`; its opted-out arm is `not_paid` and must announce that.
            // Read off `set.status` rather than off the action, so the event can never
            // describe a transition the row did not take.
            const openedForDunning = set.status === "payment_due";
            await emitEvent(tx, {
              organizationId: txn.organizationId,
              businessId: txn.businessId,
              type: openedForDunning ? "invoice_payment_due" : "invoice_not_paid",
              data: openedForDunning
                ? buildEventData(
                    "invoice_payment_due",
                    { id: inv.publicId, next_attempt_at: set.nextAttemptAt ?? null },
                    null,
                    { reopened: "late_failure" },
                  )
                : buildEventData("invoice_not_paid", { id: inv.publicId }, null, {
                    reopened: "late_failure",
                  }),
            });
          }
        }
      }
      await emitEvent(tx, {
        organizationId: txn.organizationId,
        businessId: txn.businessId,
        type: "transaction_late_failure",
        data: buildEventData("transaction_late_failure", {
          id: txn.publicId,
          amount_minor: Number(txn.amountMinor),
          currency: txn.currency,
        }),
      });
      await emitEvent(tx, {
        organizationId: txn.organizationId,
        businessId: txn.businessId,
        type: "payment_failed",
        data: buildEventData("payment_failed", {
          id: txn.publicId,
          code: "late_failure",
          message: "Charge reversed after settlement",
          retriable: reversalRetriable,
        }),
      });
      return true;
    });
    return applied ? "processed" : "ignored";
  }

  // Plain async failure of an in-progress attempt.
  if (["in_progress", "timeout", "needs_attention"].includes(txn.status)) {
    // Stopped at the gateway before the bank collected it (a void in the gateway's own
    // dashboard): booked like our own cancel, not as a decline that re-arms dunning.
    if (
      ev.failureCode === DEBIT_CANCELLED_CODE &&
      (await bookDebitCancelledAtGateway({
        organizationId: txn.organizationId,
        businessId: txn.businessId,
        transactionId: txn.id,
        now: ev.occurredAt,
      }))
    )
      return "processed";
    // The adapter's NORMALIZED decline, when it could classify one. This is the
    // whole outcome for RazorPay's UPI Autopay and netbanking e-mandate rails —
    // their debits are asynchronous, so `charge()` returned `pending` and this
    // webhook is the first and only verdict. `settlePaymentFailed` feeds this
    // straight to `planFailureRearm` as the smart-dunning decline code, so until
    // now every async decline arrived as the placeholder `async_failed`, which
    // `classifyDecline` does not recognise — smart mode silently degraded to fixed
    // retries on precisely the rails where the code carries the most information.
    //
    // The placeholder remains the fallback: an adapter that could not classify the
    // failure must not have one invented for it.
    const errorCode = ev.failureCode ?? "async_failed";
    const errorText = ev.providerFailureCode ?? null;
    await withTenant(txn.organizationId, async (tx) => {
      await setTransactionStatus(tx, txn.organizationId, txn.id, "failed", {
        errorCode,
        ...(errorText ? { errorText } : {}),
      });
      // Shared settlement: fails the payment AND re-enters dunning (or exhausts).
      await settleTransactionOutcome(tx, {
        organizationId: txn.organizationId,
        businessId: txn.businessId,
        outcome: "failed",
        occurredAt: ev.occurredAt,
        txn: { ...txn, errorCode, ...(errorText ? { errorText } : {}) },
        // Unknown stays retriable — treating an unclassified async failure as hard
        // would mark a working instrument `invalid` and burn the backup card.
        retriable: ev.failureRetriable ?? true,
      });
    });
    return "processed";
  }
  return "ignored";
}

/**
 * Payment-intent lifecycle (`intent.*`) — the callbacks that make a buyer
 * authorization REAL instead of force-passed by a test-mode route.
 *
 * ── Why this cannot ride on the charge handlers ──────────────────────────────
 * Every handler above correlates through `transactions.id_at_gateway`, and an
 * authorized-but-unconsumed intent has NO transaction row: nothing has moved. So
 * the correlation key here is `payment_intents.intent_at_gateway`, fed by the
 * adapters' `providerIntentId` (its own field because a RazorPay intent is keyed by
 * the ORDER id while the payment webhook carries a PAYMENT id).
 *
 * ── Replay / out-of-order safety ─────────────────────────────────────────────
 *  1. `handleProviderEvent` dedupes on (provider_key, provider_event_id) before we
 *     are called, so a redelivery of the SAME event never re-enters here.
 *  2. Distinct events can still say the same thing — PayPal sends both
 *     CHECKOUT.ORDER.APPROVED and PAYMENT.AUTHORIZATION.CREATED for one
 *     authorization — so every branch is state-guarded and answers `ignored` when
 *     the intent is already in (or past) the state the event announces.
 *  3. A callback naming an intent id that is no longer the CURRENT attempt's is
 *     ignored: `retryPaymentIntent` opens a NEW gateway intent, and letting stale
 *     news from attempt N-1 authorize or fail attempt N would corrupt the very
 *     history `payment_attempts` exists to keep.
 *  4. An intent id we don't know is a NO-OP (`ignored`), never a throw — same rule
 *     `reconcileChargeSucceeded` applies to an unknown charge id. A provider CLI
 *     test event, another system's intent, or a delivery that beat our own
 *     `createIntent` write must not answer non-2xx and put the gateway into an
 *     endless redelivery loop.
 *
 * All writes go through the payment-intents engine (`authorizePaymentIntent`,
 * `failPaymentIntentFromGateway`, `markPaymentIntentVoidedFromGateway`) so attempt
 * bookkeeping, tenant scoping and the `payment_intent_*` events stay in one place.
 */
/**
 * Harvest the INSTRUMENT from an authorized `setup` intent, from the webhook rather
 * than from the buyer's browser.
 *
 * ── The orphan this closes ────────────────────────────────────────────────────
 * A setup intent's product is a vaulted instrument, and the only thing that creates
 * one is `consumePaymentIntent`. That used to be driven exclusively by the client
 * returning from the challenge. When the buyer approves and then never comes back —
 * closes the tab, loses signal, or simply finishes on a rail where there is nothing
 * to come back to — the mandate is **live and chargeable at the gateway** while we
 * hold no `payment_methods` row at all. The intent then sits `authorized` until
 * `expirePaymentIntents` retires it, and the mandate outlives it silently.
 *
 * That is the worst shape a payments bug can take: money can be taken through an
 * instrument the engine cannot see, cannot charge deliberately, cannot show the
 * customer, and cannot delete on a GDPR erasure. It also breaks the mandate
 * lifecycle downstream — `applyMandateUpdate` correlates `token.confirmed` by token
 * id, so with no row to match, a netbanking mandate confirming T+1 lands `ignored`.
 *
 * ── Why it is safe to do here ────────────────────────────────────────────────
 *  - **Only for `setup`.** Consuming a `payment` intent captures money into an
 *    invoice; that is the engine's decision and needs a target. Setup moves nothing.
 *  - **Not a second vault writer.** It calls the same `consumePaymentIntent`, which
 *    ends at `persistVaultedPaymentMethod` — still the single writer of a
 *    `payment_methods` row, with its events and audit entry intact.
 *  - **Race-safe.** That function's `authorized → consumed` transition is an atomic
 *    claim; if the buyer's callback is consuming concurrently, one wins and the other
 *    gets `PaymentIntentConflictError`. Either way the instrument ends up recorded
 *    exactly once, so the conflict is reported as `processed`, not as an error.
 *  - **Gateway-resolvable.** RazorPay's setup consume derives everything from the
 *    order id (reads the order for its customer, finds the authorized payment on it,
 *    vaults the token) — it needs nothing the browser was holding.
 *
 * A refusal that is genuinely "not yet" — RazorPay throws when no authorized payment
 * exists on the order — answers `ignored` and leaves the intent `authorized`, so a
 * later delivery or the buyer's own callback can still complete it.
 */
async function harvestSetupIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<HandleResult> {
  try {
    const res = await consumePaymentIntent(organizationId, businessId, piPublicId);
    if (!res) return "ignored";
    /**
     * The instrument is recorded — now finish the CHECKOUT that was waiting on it, if any.
     *
     * On the netbanking e-mandate rail the buyer never comes back (RazorPay's auth-link
     * endpoint ignores `callback_url`), so this harvest is the only thing that will ever
     * happen: without it the mandate was vaulted and the subscription was never created.
     * Idempotent against the buyer who DOES return — `completeCheckout` claims the session
     * with an atomic compare-and-set — and it never throws, because an errored webhook would
     * make the gateway redeliver the whole event and re-run the vault above.
     */
    if (res.paymentMethod) {
      await completeCheckoutForSetupIntent({
        organizationId,
        businessId,
        intentPublicId: piPublicId,
        paymentMethodId: res.paymentMethod.id,
      });
    }
    return "processed";
  } catch (e) {
    // Someone else claimed it — the instrument is recorded, which is the outcome
    // this exists to guarantee.
    if (e instanceof PaymentIntentConflictError) return "processed";
    // Expected, recoverable states: the token has not been minted yet, the intent
    // moved on, the gateway account went inactive. The intent stays `authorized` and
    // a later delivery retries. Not an error — an errored delivery makes the gateway
    // redeliver the whole event, which would re-run the authorize half too.
    if (e instanceof PaymentIntentError) {
      log.warn("setup intent could not be harvested from its webhook yet", {
        intent: piPublicId,
        reason: (e as Error).message,
      });
      return "ignored";
    }
    throw e;
  }
}

/**
 * An authorization the invoice it names can NEVER absorb — release it, or say so loudly.
 *
 * Reached from `harvestInvoiceIntent` when the invoice's outstanding balance is already
 * smaller than the authorized amount: a duplicate checkout (INV-5510), or an invoice paid
 * or credited between the buyer starting their bank's flow and finishing it.
 *
 * Best outcome first: RELEASE the hold, so the money never leaves the buyer at all. That is
 * only possible where the gateway supports it — `voidPaymentIntent` reaches the adapter, and
 * `capabilities.intentVoid` is `false` on RazorPay, which refuses to void a payment it has
 * already authorized. On those gateways there is nothing to call, so the ONLY correct action
 * left is to make the money impossible to miss.
 *
 * A `needs_attention` transaction is that signal, chosen over a bare log line because it is
 * already the engine's word for "a gateway outcome a human must resolve": it emits
 * `transaction.needs_attention`, it appears in the Transactions money log next to the charge
 * it belongs to, and it is queryable — so an alert can count these rather than depending on
 * someone reading logs. Before this, the entire event was a single `provider_events` row
 * reading `ignored`, indistinguishable from thousands of legitimately ignored deliveries.
 *
 * We do NOT capture-then-refund here. Capturing money in order to hand it straight back
 * takes it out of the buyer's account for the length of a refund cycle, and on a rail that
 * cannot void it may also be unrefundable for days. If the capture arrives anyway — RazorPay
 * auto-captures some flows — `reconcileChargeSucceeded` books it as excess credit, which is
 * refundable. So the money is accounted for on both branches; this one just refuses to
 * *cause* the capture.
 */
async function reconcileUnappliableAuthorization(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  ctx: {
    invoice: typeof invoices.$inferSelect;
    remainingMinor: bigint;
    amountMinor: bigint;
    currency: string;
    customerId: string | null;
    /**
     * The gateway's charge id from the event that got us here — the one identifier the
     * intent, the payment and the refund all carry. Without it this row rendered Gateway
     * "—" and could not be linked by eye to the refund sitting six minutes above it in
     * the same Transactions list (#17, Fault C).
     */
    providerChargeId?: string | null;
  },
): Promise<HandleResult> {
  const { voidPaymentIntent, PaymentIntentError: PIError } =
    await import("@/modules/payment-intents/service");
  /**
   * ── IS THERE ACTUALLY A HOLD? (2026-09-03, #17) ─────────────────────────────────
   *
   * This function's whole output is a sentence claiming the gateway holds money. On
   * INV-7824 that sentence was false six minutes before it was written: we had captured
   * AND refunded the charge ourselves, and the row still said "The gateway holds 2218400
   * INR for this invoice, which now owes 0" — then offered an operator an irreversible
   * button to book it as cash. So the claim is CHECKED before it is made, against the one
   * implementation of "has this money come back?" (`refunds/service.chargeAlreadyReturned`
   * — two implementations that disagreed would be worse than none).
   *
   * When the money is already back there is nothing for an operator to do, so no
   * `needs_attention` row is written at all: `unapplied_gateway_money` counts exactly
   * these rows and would otherwise PAGE about money that is already with the customer.
   * A false page is worse than a silent one — it spends the credibility the real ones need.
   */
  const { chargeAlreadyReturned } = await import("@/modules/refunds/service");
  const returned = await chargeAlreadyReturned(organizationId, ctx.providerChargeId);
  if (returned.settled && returned.refundedMinor > 0n) {
    log.warn("an authorization its invoice could not absorb was ALREADY REFUNDED — nothing held", {
      event: "unappliable_authorization_already_returned",
      intent: piPublicId,
      invoice: ctx.invoice.publicId,
      charge: ctx.providerChargeId,
      payment: returned.paymentPublicId,
      refund: returned.refundPublicId,
      providerRefundId: returned.providerRefundId,
      refundedMinor: String(returned.refundedMinor),
      amountMinor: String(ctx.amountMinor),
      currency: ctx.currency,
    });
    return "processed";
  }
  try {
    const released = await voidPaymentIntent(organizationId, businessId, piPublicId);
    if (released) {
      log.warn("an authorization its invoice could not absorb was released at the gateway", {
        event: "unappliable_authorization_released",
        intent: piPublicId,
        invoice: ctx.invoice.publicId,
        amountMinor: String(ctx.amountMinor),
        remainingMinor: String(ctx.remainingMinor),
        currency: ctx.currency,
      });
      return "processed";
    }
  } catch (e) {
    // `intentVoid: false` (RazorPay), an already-terminal intent, an inactive gateway
    // account. None of them is retriable and none changes what we must do next — record
    // it. Rethrowing would make the gateway redeliver the whole event forever.
    if (!(e instanceof PIError)) throw e;
    log.warn("an authorization its invoice could not absorb could NOT be released", {
      event: "unappliable_authorization_release_failed",
      intent: piPublicId,
      reason: (e as Error).message,
    });
  }
  const { recordTransaction } = await import("@/modules/transactions/service");
  await withTenant(organizationId, (tx) =>
    recordTransaction(
      {
        organizationId,
        businessId,
        customerId: ctx.customerId,
        type: "authorization",
        status: "needs_attention",
        amountMinor: ctx.amountMinor,
        currency: ctx.currency,
        invoiceId: ctx.invoice.id,
        // The charge this row is written ABOUT. Fault C of #17: minted null, it rendered
        // Gateway "—" and Payment Method "—", so the pair of contradicting rows an
        // operator had to reconcile was unlinkable in the one view they would use.
        idAtGateway: ctx.providerChargeId ?? null,
        errorCode: "authorization_unappliable",
        errorText: returned.settled
          ? // Settled, nothing refunded: the money is not HELD, it arrived. Saying "holds"
            // here sent an operator to look for a hold that had already become a payment.
            `The gateway CAPTURED ${ctx.amountMinor} ${ctx.currency} for this invoice, which ` +
            `now owes ${ctx.remainingMinor}. It is booked on payment ` +
            `${returned.paymentPublicId ?? "(unknown)"}. Refund it, or apply it elsewhere.`
          : `The gateway holds ${ctx.amountMinor} ${ctx.currency} for this invoice, which now ` +
            `owes ${ctx.remainingMinor}. We could not release it at the gateway. Refund it ` +
            `after the capture, or let the authorization lapse.`,
        retriable: false,
      },
      tx,
    ),
  );
  log.warn("money is held at the gateway that no invoice can absorb — flagged for an operator", {
    event: "unappliable_authorization_held",
    intent: piPublicId,
    invoice: ctx.invoice.publicId,
    amountMinor: String(ctx.amountMinor),
    remainingMinor: String(ctx.remainingMinor),
    currency: ctx.currency,
  });
  return "processed";
}

/** Is the invoice open and owing exactly `amountMinor` — what consume will accept? */
async function invoiceTakesExactly(
  organizationId: string,
  invoiceId: string,
  amountMinor: bigint | null,
): Promise<boolean> {
  if (amountMinor == null) return false;
  const [inv] = await systemDb.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!inv || !isOpenInvoiceStatus(inv.status)) return false;
  const { invoiceOutstanding } = await import("@/modules/invoicing/service");
  const remaining = await withTenant(organizationId, (tx) => invoiceOutstanding(tx, inv)).then(
    (o) => o.remainingMinor,
  );
  return remaining === amountMinor;
}

/**
 * Capture an authorized `payment` intent into the invoice it names, from the webhook
 * rather than the buyer's browser. The money-side twin of `harvestSetupIntent`; see the
 * call site for the measurement that motivated it.
 */
async function harvestInvoiceIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  invoiceId: string,
  /** The intent row, for the "can this invoice still absorb it?" test below. */
  pi?: { amountMinor: bigint | null; currency: string | null; customerId: string | null },
  /** The gateway charge named by the event that got us here (#17) — may be absent. */
  providerChargeId?: string | null,
): Promise<HandleResult> {
  // `consumePaymentIntent` takes the invoice's PUBLIC id and will not read it off the
  // intent — passing none raises "a payment intent is consumed into an invoice".
  const [inv] = await systemDb.select().from(invoices).where(eq(invoices.id, invoiceId)).limit(1);
  if (!inv) return "ignored";
  /**
   * ── A PERMANENT REFUSAL IS NOT A "NOT YET" (2026-08-31) ─────────────────────────
   *
   * The catch below treats every `PaymentIntentError` as transient — it logs "could not be
   * captured from its webhook YET" and leaves the intent `authorized` for a later delivery.
   * For one class of refusal that is false, and it cost a real buyer real money:
   *
   *   INV-5510. Two "Pay now" presses minted two RazorPay orders; the first captured at
   *   16:17:46 and PAID the invoice. One second later `intent.authorized` arrived for the
   *   second order, `consumePaymentIntent` refused it (nothing left to collect — the amount
   *   cannot match an `amount_due` of zero), and this handler logged "yet" and returned
   *   `ignored`. There is no "yet": that invoice will never owe that money again. The
   *   authorization stayed live at RazorPay, unrecorded and unrefundable.
   *
   * So the question is asked BEFORE consuming, from the invoice's own outstanding balance
   * rather than by parsing an error message: if the invoice cannot absorb the intent's full
   * amount, the capture is unappliable and gets its own path. Everything else keeps the
   * existing transient handling byte for byte.
   *
   * Only when we know the amount. A caller that did not pass the intent row keeps the old
   * behaviour rather than guessing — the test is meaningless without the figure it compares.
   */
  if (pi?.amountMinor != null && pi.amountMinor > 0n) {
    const { invoiceOutstanding } = await import("@/modules/invoicing/service");
    const remaining = await withTenant(organizationId, (tx) => invoiceOutstanding(tx, inv)).then(
      (o) => o.remainingMinor,
    );
    if (remaining < pi.amountMinor) {
      return reconcileUnappliableAuthorization(organizationId, businessId, piPublicId, {
        invoice: inv,
        remainingMinor: remaining,
        amountMinor: pi.amountMinor,
        currency: pi.currency ?? inv.currency,
        customerId: pi.customerId,
        providerChargeId,
      });
    }
  }
  try {
    const res = await consumePaymentIntent(organizationId, businessId, piPublicId, inv.publicId);
    return res ? "processed" : "ignored";
  } catch (e) {
    // The buyer's own callback won the race and captured it first. The invoice is
    // settled, which is the outcome this exists to guarantee.
    if (e instanceof PaymentIntentConflictError) return "processed";
    // Not yet capturable (the gateway has not posted the authorization), or the intent
    // moved on. Leave it authorized so a later delivery or the client can finish it —
    // erroring would make the gateway redeliver the whole event and re-run the
    // authorize half too.
    if (e instanceof PaymentIntentError) {
      log.warn("payment intent could not be captured from its webhook yet", {
        intent: piPublicId,
        reason: (e as Error).message,
      });
      return "ignored";
    }
    throw e;
  }
}

/** A refund event for a charge we hold no payment for: a setup refund's watcher checks now. */
async function nudgeSetupAuthRefundFor(providerKey: string, providerChargeId: string) {
  const { nudgeSetupAuthRefund } = await import("@/modules/payment-methods/setup-auth-refund");
  await nudgeSetupAuthRefund(providerKey, providerChargeId);
}

/** `applyIntentEvent`'s refund of a refused registration's money (PayU E755). */
async function queueRefusedRegistrationFromEvent(
  providerKey: string,
  ev: NormalizedProviderEvent,
  pi: {
    organizationId: string;
    businessId: string;
    gatewayAccountId: string | null;
    publicId: string;
  } | null,
  deliveredByBusinessId: string | null,
): Promise<void> {
  let org = pi?.organizationId ?? null;
  const biz = pi?.businessId ?? deliveredByBusinessId;
  let account = pi?.gatewayAccountId ?? null;
  if (!biz) return;
  if (!org || !account) {
    const [acc] = await systemDb
      .select({ id: gatewayAccounts.id, organizationId: gatewayAccounts.organizationId })
      .from(gatewayAccounts)
      .where(and(eq(gatewayAccounts.businessId, biz), eq(gatewayAccounts.gatewayKey, providerKey)))
      .limit(1);
    if (!acc) return;
    org ??= acc.organizationId;
    account ??= acc.id;
  }
  const { queueRefusedRegistrationRefund } =
    await import("@/modules/payment-methods/setup-auth-refund");
  await queueRefusedRegistrationRefund({
    organizationId: org,
    businessId: biz,
    gatewayAccountId: account,
    providerKey,
    providerCustomerId: ev.ownershipRef ?? "",
    charge: ev.setupAuthCharge!,
    ...(pi ? { intent: pi.publicId } : {}),
  });
}

async function applyIntentEvent(
  ev: NormalizedProviderEvent,
  /** The business the webhook was DELIVERED by — the correlation scope, not the row's own. */
  deliveredByBusinessId?: string | null,
  providerKey?: string,
): Promise<HandleResult> {
  const pi = await findPaymentIntentByGatewayIntentId(ev.providerIntentId!, {
    businessId: deliveredByBusinessId,
  });
  // A refused registration that still took money is refunded, intent row or not.
  if (ev.type === "intent.setup_failed" && ev.setupAuthCharge && providerKey)
    await queueRefusedRegistrationFromEvent(providerKey, ev, pi, deliveredByBusinessId ?? null);
  if (!pi) return "ignored"; // not one of our intents (or it predates this delivery)

  const { organizationId, businessId, publicId: piPublicId } = pi;
  const attempt = await getCurrentAttempt(organizationId, pi.id);
  // Stale: this callback belongs to an attempt a retry has already superseded. An attempt
  // already re-pointed to the payment this event names is the same attempt.
  if (
    attempt?.idAtGateway &&
    attempt.idAtGateway !== ev.providerIntentId &&
    attempt.idAtGateway !== ev.gatewayIntentId
  )
    return "ignored";

  /**
   * ── "TERMINAL" WAS THREE FACTS WEARING ONE NAME (2026-08-31) ────────────────────
   *
   * Every authorize case below opened with `if (terminal) return "ignored"`, and for one
   * of the four states that made up `terminal` it was wrong — expensively.
   *
   *  · `consumed`   → the gateway is telling us something we already did. Ignore.
   *  · `voided` / `voided_at` → WE released the hold at the gateway. Reviving it would
   *    claim money we asked to be given back. Ignore, and let the charge path book any
   *    money that arrives anyway as excess credit.
   *  · `expired`    → **our own clock's opinion, not the gateway's.** The bank approved;
   *    the money is real. Measured (`scripts/probe-late-authorization.ts` A and B): the
   *    event was dropped in silence, leaving a live hold against an unpaid invoice, or a
   *    live mandate with no `payment_methods` row — a customer registered for debits we
   *    cannot see. The rail-aware TTL (`payment-intents/ttl.ts`) makes it rare; nothing
   *    can make it impossible, because no deadline outlasts a bank that is simply late.
   *
   * So an `expired` intent is REVIVED and then handled exactly like a live one — one
   * compare-and-set, so two redeliveries cannot both revive
   * (`reviveIntentForLateAuthorization` owns that rule and refuses `consumed`/`voided`).
   * If the revive loses its claim or is refused, we fall back to the old `ignored`, which
   * is the previous behaviour rather than a new failure mode.
   */
  const settledAlready = pi.status === "consumed";
  const closedByUs = pi.status === "voided" || pi.voidedAt != null;
  const revivable = pi.status === "expired" && pi.voidedAt == null;
  const terminal = settledAlready || closedByUs || pi.status === "expired";

  try {
    switch (ev.type) {
      // The hold exists / the vault challenge cleared. Both mean the same thing to
      // the engine — the current attempt is authorized and the intent is ready to be
      // consumed (captured, or harvested for its instrument).
      case "intent.authorized":
      case "intent.setup_succeeded": {
        if (settledAlready || closedByUs) return "ignored";
        /**
         * ── THE STALENESS GUARD COULD NOT SEE THE MONEY (2026-09-03, #17) ──────────
         *
         * Everything above reads the INTENT's own status, and on INV-7824 that was not
         * enough. RazorPay delivered `payment.authorized` LAST — their own event ids
         * carry their creation time and prove 21 minutes of reordering — so it arrived
         * after `payment.captured` AND after our own refund of that exact charge
         * (`rfnd_XXXXXXXXXXXX01`, our `POST /refund` at 12:16:00). The intent was
         * neither `consumed` nor `voided`, because the buyer's browser never posted the
         * second leg: nothing local tied the intent to the payment it produced
         * (`payments` has no `payment_intent_id`, and the capture recorded no
         * transaction). So the event was treated as live — it authorized an intent whose
         * money was already back, and the harvest then raised a `needs_attention`
         * claiming the gateway held ₹22,184.00 that RazorPay's own page calls Refunded.
         *
         * The fact that refutes it is on the event: RazorPay's `payment.authorized`
         * names the PAYMENT as well as the order (`providerChargeId: pay_XXXXXXXXXXXX04`
         * — measured on the real delivery). One question, one implementation of the
         * answer (`chargeAlreadyReturned`).
         *
         * ⚠ PAYMENT intents only. A `setup` intent's authorization is a registration
         * probe — on the India e-mandate rails a ₹1–5 debit that is routinely refunded
         * while the mandate goes LIVE — so "the money came back" says nothing about the
         * instrument, and skipping the harvest here would leave us holding no payment
         * method for a mandate the gateway will honour. That is the orphan
         * `harvestSetupIntent` exists to close; it must stay reachable.
         */
        if ((pi.purpose as IntentPurpose | null) !== "setup" && ev.providerChargeId) {
          const { chargeAlreadyReturned } = await import("@/modules/refunds/service");
          const returned = await chargeAlreadyReturned(organizationId, ev.providerChargeId);
          if (returned.settled && returned.refundedMinor > 0n) {
            const { closeIntentForReturnedCharge } =
              await import("@/modules/payment-intents/service");
            const closed = await closeIntentForReturnedCharge(
              organizationId,
              businessId,
              piPublicId,
              {
                providerChargeId: ev.providerChargeId,
                refundedMinor: returned.refundedMinor,
                fullyReturned: returned.fullyReturned,
                providerRefundId: returned.providerRefundId,
                refundPublicId: returned.refundPublicId,
                paymentPublicId: returned.paymentPublicId,
              },
            );
            log.warn("a late authorization arrived for money that has already been returned", {
              event: "late_authorization_for_returned_charge",
              intent: piPublicId,
              charge: ev.providerChargeId,
              payment: returned.paymentPublicId,
              refund: returned.refundPublicId,
              providerRefundId: returned.providerRefundId,
              refundedMinor: String(returned.refundedMinor),
              fullyReturned: returned.fullyReturned,
              closed: closed != null,
            });
            // `processed` either way: we understood the delivery and acted on it. A
            // concurrent delivery having closed it first (`closed === null`) is not a
            // reason to answer non-2xx and make the gateway redeliver forever.
            return "processed";
          }
        }
        /**
         * Money the gateway took at the buyer's confirm (`captureState`). There is no hold,
         * so the unappliable-authorization path (which voids) cannot apply. Consume books
         * only an exact match against the invoice; anything else is booked like any
         * capture with no row of its own — applied where it fits, the rest refunded.
         * Checked before a revive: an expired intent need not come back for this.
         */
        if (
          ev.captureState &&
          providerKey &&
          (pi.purpose as IntentPurpose | null) !== "setup" &&
          pi.invoiceId &&
          !(await invoiceTakesExactly(organizationId, pi.invoiceId, pi.amountMinor))
        ) {
          // In flight: nothing to book yet. The `succeeded` delivery comes back here.
          if (ev.captureState === "processing") {
            log.warn("a bank debit taken at confirm no longer matches its invoice", {
              event: "captured_on_confirm_unappliable_pending",
              intent: piPublicId,
              charge: ev.providerChargeId ?? null,
            });
            return "ignored";
          }
          return reconcileUnmatchedCapture(providerKey, ev, deliveredByBusinessId);
        }
        if (revivable) {
          const { reviveIntentForLateAuthorization } =
            await import("@/modules/payment-intents/service");
          const revived = await reviveIntentForLateAuthorization(
            organizationId,
            businessId,
            piPublicId,
            { occurredAt: ev.occurredAt },
          );
          // Lost the claim to a concurrent delivery (which is now doing this work), or the
          // row moved out of `expired` underneath us. Either way this delivery has nothing
          // left to do — the previous behaviour, reached deliberately rather than by
          // treating our clock as the gateway's truth.
          if (!revived) return "ignored";
        }
        // Someone may already have authorized it (the buyer's own callback beat this
        // delivery). That is not a reason to stop — a SETUP intent still has to be
        // harvested below, and the orphan this guards against happens precisely when
        // the client half never runs.
        // A hosted page's payment has its own id; consume captures and books by it.
        if (
          ev.type === "intent.authorized" &&
          ev.gatewayIntentId &&
          attempt &&
          attempt.idAtGateway === ev.providerIntentId
        )
          await repointAttemptAtGateway(
            organizationId,
            attempt.id,
            ev.providerIntentId!,
            ev.gatewayIntentId,
          );
        if (pi.status !== "authorized") {
          await authorizePaymentIntent(organizationId, businessId, piPublicId);
        }
        if ((pi.purpose as IntentPurpose | null) === "setup") {
          return await harvestSetupIntent(organizationId, businessId, piPublicId);
        }
        // A `payment` intent that NAMES an invoice is settled here too. Same orphan as
        // the setup one, on the money side: the buyer authorizes in the gateway's sheet
        // and the capture used to depend entirely on their browser coming back to
        // re-post the second leg. Measured 2026-08-14 — a buyer completed RazorPay
        // Checkout for a ₹20,000 "Pay now", this webhook authorized the intent and
        // returned, and the invoice stayed `payment_due` with the money held at the
        // gateway. Nothing retried it, because an authorized intent is not a failure.
        //
        // Safe precisely BECAUSE the intent carries an invoice: "capturing money needs
        // a target" was the objection to consuming payment intents here, and the target
        // is right there on the row. An intent with no invoice is still left alone.
        if (pi.invoiceId)
          return await harvestInvoiceIntent(
            organizationId,
            businessId,
            piPublicId,
            pi.invoiceId,
            pi,
            ev.providerChargeId,
          );
        return "processed";
      }
      // Refused. Never read a provider code out of `raw`: dunning expects a normalized one.
      // Stripe normalizes a setup refusal (`failureCode`, `failureMessage`); every other
      // intent refusal falls back to the event TERM, the one thing every gateway agrees on.
      /**
       * `intent.failed`: an authorization the gateway refused after our call returned, for an
       * intent not yet consumed (Adyen's AUTHORISATION false, Authorize.net's declined or
       * fraud-declined authorization). The only path to `authorization_failed`.
       */
      case "intent.failed":
      case "intent.setup_failed": {
        if (terminal) return "ignored";
        // The gateway's reason when the adapter carried one (a Stripe setup refusal does),
        // else the term — the same fallback the synchronous setup path uses.
        const code =
          ev.failureCode ??
          (ev.type === "intent.setup_failed" ? "setup_failed" : "authorization_failed");
        const res = await failPaymentIntentFromGateway(organizationId, businessId, piPublicId, {
          code,
          message: ev.failureMessage ?? "The gateway refused the authorization",
        });
        return res ? "processed" : "ignored";
      }
      // The hold was released at the gateway (cancel / void), by us or by the
      // merchant in the provider's own dashboard. No money moved, so nothing is
      // reversed — recording the release is the whole job.
      case "intent.voided": {
        if (terminal) return "ignored";
        const res = await markPaymentIntentVoidedFromGateway(
          organizationId,
          businessId,
          piPublicId,
          ev.occurredAt,
        );
        return res ? "processed" : "ignored";
      }
      default:
        return "ignored";
    }
  } catch (e) {
    // A state conflict (the intent moved under us between the guard and the write)
    // is not retriable: redelivering would hit the same wall forever. Anything else
    // — a DB error, a gateway timeout — propagates and marks the delivery `error` so
    // the provider retries it.
    if (e instanceof PaymentIntentError) return "ignored";
    throw e;
  }
}

/**
 * Automatic card updater: the network reissued a vaulted card (new expiry/last4/
 * brand). Refresh the stored non-secret display fields and mark the method valid
 * again (a reissued card supersedes an expiring/expired one). Idempotent — the
 * provider-event dedup at the top blocks replays; re-applying the same fields is
 * a harmless no-op regardless.
 */
async function applyPaymentMethodUpdate(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const [pm] = await systemDb
    .select()
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.providerKey, providerKey),
        eq(paymentMethods.providerPaymentMethodId, ev.providerPaymentMethodId!),
      ),
    )
    .limit(1);
  if (!pm) return "ignored"; // not one of our vaulted methods

  const set: Partial<typeof paymentMethods.$inferInsert> = { status: "valid" };
  if (ev.card?.brand != null) set.brand = ev.card.brand;
  if (ev.card?.last4 != null) set.last4 = ev.card.last4;
  if (ev.card?.expMonth != null) set.expMonth = ev.card.expMonth;
  if (ev.card?.expYear != null) set.expYear = ev.card.expYear;
  // When a card updater last changed the number or expiry.
  if (credentialsChanged(pm, ev.card ?? {})) set.credentialsChangedAt = stampNow();

  await withTenant(pm.organizationId, async (tx) => {
    await tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, pm.id));
    await emitEvent(tx, {
      organizationId: pm.organizationId,
      businessId: pm.businessId,
      type: "payment_source_updated",
      data: buildEventData("payment_source_updated", {
        id: pm.publicId,
        brand: set.brand ?? pm.brand,
        last4: set.last4 ?? pm.last4,
        exp_month: set.expMonth ?? pm.expMonth,
        exp_year: set.expYear ?? pm.expYear,
        status: "valid",
      }),
    });
  });
  return "processed";
}

/**
 * The instrument was detached AT THE GATEWAY, not by us (Stripe
 * `payment_method.detached`).
 *
 * Two arrivals share this event and they need opposite treatment:
 *
 *  - **The echo of our own delete.** `deletePaymentMethod` removes the token
 *    upstream and the local row, so the webhook lands for a row that is already
 *    gone: the lookup misses and this returns `ignored`, which is the whole
 *    handling. That path was already correct before this branch existed.
 *  - **An OUT-OF-BAND detach** — an operator deleting the card in the Stripe
 *    dashboard. Here we still hold the row, and it points at a token that can
 *    never be charged again. Left alone it stays `valid` and stays selectable, so
 *    the next renewal picks it, hard-declines, and arms dunning against a customer
 *    who did nothing wrong.
 *
 * So: mark the instrument `invalid`, exactly as a hard decline or a dead mandate
 * does. That is what takes it out of `resolveChargeCandidates` and moves collection
 * onto the customer's backup instead of burning a retry on a token the gateway no
 * longer has.
 *
 * The row is NOT deleted. A detach at the gateway says the token is dead, not that
 * the customer's payment history should lose the instrument it was collected on —
 * and the local delete is a deliberate operator action with its own event
 * (`payment_source_deleted`). Card fields are left untouched for the same reason:
 * the display of what died is still the truth of what died.
 *
 * Idempotent: the provider-event dedup at the top blocks replays, and re-applying
 * `invalid` is a no-op regardless.
 */
async function applyPaymentMethodDetached(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const [pm] = await systemDb
    .select()
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.providerKey, providerKey),
        eq(paymentMethods.providerPaymentMethodId, ev.providerPaymentMethodId!),
      ),
    )
    .limit(1);
  // The echo of our own delete — the row went with it. Nothing to reconcile.
  if (!pm) return "ignored";

  // Already unusable (a prior hard decline, a dead mandate, an expired card). The
  // status is the same either way, so don't emit a second event saying so.
  if (pm.status === "invalid") return "ignored";

  log.warn("a vaulted instrument was detached at the gateway, not by us", {
    event: "payment_method_detached_out_of_band",
    provider: providerKey,
    provider_payment_method_id: ev.providerPaymentMethodId,
    payment_method: pm.publicId,
    detail: "marked invalid so collection stops selecting it — the customer needs a new instrument",
  });

  await withTenant(pm.organizationId, async (tx) => {
    await tx.update(paymentMethods).set({ status: "invalid" }).where(eq(paymentMethods.id, pm.id));
    await emitEvent(tx, {
      organizationId: pm.organizationId,
      businessId: pm.businessId,
      type: "payment_source_updated",
      data: buildEventData("payment_source_updated", {
        id: pm.publicId,
        brand: pm.brand,
        last4: pm.last4,
        exp_month: pm.expMonth,
        exp_year: pm.expYear,
        status: "invalid",
      }),
    });
  });
  return "processed";
}

/**
 * Mandate states in which the instrument is NOT chargeable off-session.
 *
 * `rejected` / `cancelled` are terminal — the mandate is gone and only a fresh
 * registration brings it back. `paused` is reversible by the buyer, but until they
 * resume it every debit refuses, so the engine must stop attempting either way.
 *
 * `initiated` is deliberately absent: a netbanking e-mandate sits there for up to
 * T+1 before confirming, and treating it as broken would invalidate a mandate that
 * is merely young.
 */
/**
 * Resolve the gateway's charge id to OUR payment / transaction, provider-scoped.
 *
 * ── Why these are not org-scoped ──────────────────────────────────────────────
 * They cannot be. An inbound webhook arrives with **no org context** (see
 * `handleProviderEvent`) — this lookup *is* how we learn which tenant the money
 * belongs to. So `provider_key` / `gateway_key` is the only discriminator available
 * before the row is found, and it is a real one: it stops one provider's id space
 * being searched with another's, which is exactly how a `tmtest` synthetic id or a
 * reused sandbox id reached the wrong row.
 *
 * ── Why an ambiguous match refuses instead of picking ─────────────────────────
 * These used to be a bare `.limit(1)`, which silently chose a row when more than one
 * matched. On the money path that is the worst available behaviour: booking a refund
 * or settling a charge against **another tenant's** payment is not recoverable by
 * anyone reading a report. Two rows means we do not know whose money this is, so we
 * decline and say so loudly.
 *
 * It returns `ignored` rather than `error` deliberately. `error` makes the route
 * answer non-2xx so the gateway redelivers — and an ambiguity never resolves itself,
 * so that is an infinite redelivery loop. A missed reconciliation is a discrepancy an
 * operator can find from the log line; a cross-tenant booking is not.
 */
async function resolvePaymentByCharge(
  providerKey: string,
  providerChargeId: string,
  /**
   * The business the webhook was DELIVERED by, from the VERIFIED gateway account
   * (`gateway/inbound.ts`) — the one trustworthy fact about a delivery, so it belongs in
   * the WHERE clause. Provider key alone is not enough: two of our businesses pointing at
   * one shared gateway account produce colliding charge ids for free, and the row this
   * returns becomes the tenant every downstream write is booked against. Optional because
   * a delivery whose account cannot be resolved has no business to scope by; the predicate
   * is simply omitted then, which is exactly the previous behaviour.
   */
  deliveredByBusinessId?: string | null,
) {
  const rows = await systemDb
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.providerKey, providerKey),
        eq(payments.providerChargeId, providerChargeId),
        ...(deliveredByBusinessId ? [eq(payments.businessId, deliveredByBusinessId)] : []),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    log.error(new Error("ambiguous provider charge id — refusing to guess which payment it is"), {
      event: "inbound_charge_ambiguous",
      provider: providerKey,
      provider_charge_id: providerChargeId,
      detail:
        "two payments share this (provider_key, provider_charge_id); reconciliation declined rather than risk booking against the wrong tenant",
    });
    return null;
  }
  return rows[0] ?? null;
}

/** Same rules as {@link resolvePaymentByCharge}, against `transactions.id_at_gateway`. */
async function resolveTransactionByCharge(
  providerKey: string,
  providerChargeId: string,
  /** Same rule and same reason as `resolvePaymentByCharge`'s. */
  deliveredByBusinessId?: string | null,
) {
  const rows = await systemDb
    .select()
    .from(transactions)
    .where(
      and(
        ...(deliveredByBusinessId ? [eq(transactions.businessId, deliveredByBusinessId)] : []),
        // Nullable on the column, never null in practice (measured 0/585 on 2026-08-21).
        // Written by `recordTransaction` on every path, so an equality here is safe;
        // making the column NOT NULL is the follow-up that would let it be assumed.
        eq(transactions.gatewayKey, providerKey),
        eq(transactions.idAtGateway, providerChargeId),
      ),
    )
    // `id_at_gateway` is NOT unique — an authorization and its capture can share one —
    // so unlike the payments lookup, more than one row is EXPECTED here and is not an
    // ambiguity. Order deterministically and take the newest, the same rule the
    // inspector's own resolution uses, rather than letting the plan decide.
    .orderBy(desc(transactions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The transaction a `charge.*` event is about. Usually matched on the charge id; failing
 * that, a `timeout` debit recorded under the INTENT id the event names — a charge whose
 * create answer was lost is booked against the order it was made on (RazorPay), because
 * that was the only id we had. The real charge id is adopted onto the transaction and its
 * payment, so refunds and later events use it.
 */
async function resolveChargeEventTransaction(
  providerKey: string,
  ev: NormalizedProviderEvent,
  deliveredByBusinessId?: string | null,
) {
  const chargeId = ev.providerChargeId!;
  const txn = await resolveTransactionByCharge(providerKey, chargeId, deliveredByBusinessId);
  if (txn) return txn;
  const byRef = await resolveLostAnswerByRef(providerKey, ev, deliveredByBusinessId);
  if (byRef) return byRef;
  if (ev.ownership !== "foreign") {
    const { adoptLostAnswerByLookup } = await import("@/modules/payments/lost-answer");
    const byLookup = await adoptLostAnswerByLookup(
      providerKey,
      chargeId,
      deliveredByBusinessId,
      ev.capturedAmountMinor ?? ev.amountMinor,
    );
    if (byLookup === "raced")
      return resolveTransactionByCharge(providerKey, chargeId, deliveredByBusinessId);
    if (byLookup) return byLookup;
  }
  if (!ev.providerIntentId || ev.providerIntentId === chargeId) return null;
  const lost = await resolveTransactionByCharge(
    providerKey,
    ev.providerIntentId,
    deliveredByBusinessId,
  );
  if (!lost || lost.type !== "payment" || lost.status !== "timeout") return null;
  const intentId = ev.providerIntentId;
  await withTenant(lost.organizationId, async (tx) => {
    await tx
      .update(transactions)
      .set({ idAtGateway: chargeId })
      .where(and(eq(transactions.id, lost.id), eq(transactions.idAtGateway, intentId)));
    if (lost.paymentId)
      await tx
        .update(payments)
        .set({ providerChargeId: chargeId })
        .where(and(eq(payments.id, lost.paymentId), eq(payments.providerChargeId, intentId)));
  });
  log.info("a lost-answer charge was matched through its intent", {
    event: "lost_answer_charge_matched",
    transaction: lost.publicId,
    intent_at_gateway: intentId,
    provider_charge_id: chargeId,
  });
  return { ...lost, idAtGateway: chargeId };
}

/**
 * A charge whose create answer was lost (`timeout`, no gateway id), matched by the ownership
 * ref the gateway read back off the object. Also matches one the lost-answer sweep failed as
 * never created, so money that arrives after all is still booked. One candidate only, and
 * the amount must agree when the event carries one: never a guess. Adopts the gateway id.
 */
async function resolveLostAnswerByRef(
  providerKey: string,
  ev: NormalizedProviderEvent,
  deliveredByBusinessId?: string | null,
) {
  if (!ev.ownershipRef || ev.ownership === "foreign") return null;
  const { LOST_ANSWER_NOT_CREATED_CODE, adoptChargeId } =
    await import("@/modules/payments/lost-answer");
  const rows = await systemDb
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.gatewayKey, providerKey),
        eq(transactions.ownershipRef, ev.ownershipRef),
        eq(transactions.type, "payment"),
        or(isNull(transactions.idAtGateway), eq(transactions.idAtGateway, "")),
        or(
          eq(transactions.status, "timeout"),
          and(
            eq(transactions.status, "failed"),
            eq(transactions.errorCode, LOST_ANSWER_NOT_CREATED_CODE),
          ),
        ),
        ...(deliveredByBusinessId ? [eq(transactions.businessId, deliveredByBusinessId)] : []),
      ),
    )
    .limit(5);
  const amount = ev.capturedAmountMinor ?? ev.amountMinor;
  const candidates = amount == null ? rows : rows.filter((r) => r.amountMinor === amount);
  if (candidates.length !== 1) {
    if (candidates.length > 1)
      log.error(new Error("several lost-answer charges carry this ownership ref — not guessing"), {
        event: "lost_answer_ref_ambiguous",
        provider: providerKey,
        ownership_ref: ev.ownershipRef,
        provider_charge_id: ev.providerChargeId ?? null,
      });
    return null;
  }
  const lost = candidates[0]!;
  const chargeId = ev.providerChargeId!;
  const adopted = await withTenant(lost.organizationId, (tx) => adoptChargeId(tx, lost, chargeId));
  // The sweep adopted it first: the charge id now finds the row.
  if (!adopted) return resolveTransactionByCharge(providerKey, chargeId, deliveredByBusinessId);
  log.info("a lost-answer charge was matched through its ownership ref", {
    event: "lost_answer_charge_matched",
    transaction: lost.publicId,
    ownership_ref: ev.ownershipRef,
    provider_charge_id: chargeId,
  });
  return { ...lost, idAtGateway: chargeId };
}

// Was declared here. Moved to the leaf `payment-methods/mandate-afa`, which now also
// carries the LIVE and PENDING sets, so the charge-time guard in
// `invoicing/collection.ts` classifies a mandate status against the same words this
// handler writes rather than against a third private copy of them.

/**
 * The mandate behind a vaulted instrument changed state at the provider
 * (RazorPay `token.confirmed` / `.rejected` / `.cancelled` / `.paused`).
 *
 * Two directions, both load-bearing on the INR rails:
 *
 *  - **It went live.** A netbanking e-mandate token is `initiated` when the buyer
 *    finishes at their bank and confirms only T+1 (HDFC/SBI). This event is how
 *    the engine learns the instrument became chargeable at all.
 *  - **It died.** A buyer revoking a UPI Autopay mandate in their UPI app is the
 *    ONLY notice we get — RazorPay exposes no cancel/status route to poll
 *    (operator ask 5). Miss it and the engine charges a mandate that no longer
 *    exists, once per renewal, until dunning gives up on a customer who did
 *    nothing wrong.
 *
 * A PARTIAL update: only fields the event actually reported are written. An event
 * silent about the ceiling must not erase the stored one — a null there means
 * "unknown", and the charge pre-flight reads it as "no check possible".
 *
 * Idempotent: the provider-event dedup at the top of `handleProviderEvent` blocks
 * replays, and re-applying the same state is a no-op regardless.
 */
async function applyMandateUpdate(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const [pm] = await systemDb
    .select()
    .from(paymentMethods)
    .where(
      and(
        eq(paymentMethods.providerKey, providerKey),
        eq(paymentMethods.providerPaymentMethodId, ev.providerPaymentMethodId!),
      ),
    )
    .limit(1);
  if (!pm) {
    // Not one of our vaulted methods — but on a MANDATE rail that is worth saying out
    // loud rather than swallowing. A live mandate we hold no instrument for is
    // chargeable at the gateway and invisible here: it cannot be shown to the
    // customer, charged deliberately, or removed on a GDPR erasure.
    //
    // `harvestSetupIntent` is what should have prevented it (the setup intent is
    // consumed from its own webhook, so the buyer abandoning the tab no longer
    // strands the instrument). Reaching here means that did not happen — a mandate
    // registered outside our intent flow, or one whose intent had already expired —
    // so it is a signal about the flow, not a routine miss.
    if (ev.mandate?.status === "confirmed") {
      log.warn("a CONFIRMED mandate names a token we have no payment method for", {
        provider: providerKey,
        provider_payment_method_id: ev.providerPaymentMethodId,
        rail: ev.mandate?.rail,
        detail:
          "chargeable at the gateway with no local instrument — check for an unconsumed setup intent",
      });
    }
    return "ignored";
  }

  const m = ev.mandate;
  if (!m?.status) return "ignored"; // nothing classifiable — see the normalizer
  const current =
    ev.replacementPaymentMethodId || ev.paymentMethodDisplay
      ? await repointAndRefreshMandate(pm, ev, m.status)
      : pm;
  if (!current) return "ignored";
  // `status` is narrowed by the guard above; the cast carries that to the signature, which
  // requires it so the guarantee lives in the type rather than in a second runtime check.
  return applyMandateStatus(current, m as ProviderMandate & { status: string }, ev.occurredAt);
}

/**
 * A replaced mandate moves the stored method to the new mandate id (it is not a cancel),
 * and a transferred one refreshes the bank display. Returns the row the mandate status
 * applies to: the moved row, or the customer's existing row for the new id.
 */
async function repointAndRefreshMandate(
  pm: typeof paymentMethods.$inferSelect,
  ev: NormalizedProviderEvent,
  newStatus: string,
): Promise<typeof paymentMethods.$inferSelect | null> {
  const d = ev.paymentMethodDisplay;
  const display: Partial<typeof paymentMethods.$inferInsert> = {
    ...(d?.last4 != null ? { last4: d.last4 } : {}),
    ...(d?.issuerName != null ? { issuerName: d.issuerName } : {}),
    ...(d?.issuerCountry != null ? { issuerCountry: d.issuerCountry } : {}),
  };
  const to = ev.replacementPaymentMethodId;
  return withTenant(pm.organizationId, async (tx) => {
    if (to && to !== pm.providerPaymentMethodId) {
      const [taken] = await tx
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.customerId, pm.customerId),
            eq(paymentMethods.providerKey, pm.providerKey),
            eq(paymentMethods.providerPaymentMethodId, to),
          ),
        )
        .limit(1);
      if (taken) {
        // The new mandate is already saved: the old row is the replaced, dead one.
        await tx
          .update(paymentMethods)
          .set({ status: "invalid", mandateStatus: "cancelled" })
          .where(eq(paymentMethods.id, pm.id));
        log.info("replaced mandate already saved under its new id; old method retired", {
          event: "mandate_replaced_existing",
          paymentMethod: pm.publicId,
          replacement: taken.publicId,
        });
        if (!Object.keys(display).length) return taken;
        const [row] = await tx
          .update(paymentMethods)
          .set(display)
          .where(eq(paymentMethods.id, taken.id))
          .returning();
        return row ?? taken;
      }
      // The old mandate's failures belonged to it; a live replacement is chargeable again.
      const revive = pm.status === "invalid" && !DEAD_MANDATE_STATUSES.has(newStatus.toLowerCase());
      const [row] = await tx
        .update(paymentMethods)
        .set({ providerPaymentMethodId: to, ...display, ...(revive ? { status: "valid" } : {}) })
        .where(
          and(
            eq(paymentMethods.id, pm.id),
            eq(paymentMethods.providerPaymentMethodId, pm.providerPaymentMethodId),
          ),
        )
        .returning();
      log.info("mandate replaced — method moved to the new mandate", {
        event: "mandate_replaced_repointed",
        paymentMethod: pm.publicId,
        from: pm.providerPaymentMethodId,
        to,
      });
      return row ?? null;
    }
    if (!Object.keys(display).length) return pm;
    const [row] = await tx
      .update(paymentMethods)
      .set(display)
      .where(eq(paymentMethods.id, pm.id))
      .returning();
    return row ?? null;
  });
}

/**
 * The mandate-status POLICY, split out of `applyMandateUpdate` on 2026-09-05 so a SWEEP can
 * reach it.
 *
 * RazorPay will not deliver `token.resumed` — it answers 400 "Invalid event name/names",
 * recorded in `scripts/probe-razorpay-event-names.ts` — while `token.paused` IS delivered
 * and `paused` is in `DEAD_MANDATE_STATUSES`. So a mandate that pauses and later resumes is
 * marked dead here and nothing ever tells us it came back: the customer can pay and our
 * books say they cannot, forever. A webhook the gateway refuses to send can never be waited
 * for, so the recovery has to be a POLL.
 *
 * Split rather than reimplemented, deliberately. `reconcileAbandonedCapture` says it best:
 * "a sweep constructing a fake event to satisfy a signature is how the second implementation
 * starts". This function reads only the payment method and the normalized mandate — the body
 * had ZERO `ev.` references, which is what made the split mechanical — so both the webhook
 * and the poll run the same policy, including the un-pause revival and F-42's re-arm.
 */
export async function applyMandateStatus(
  pm: typeof paymentMethods.$inferSelect,
  /**
   * `status` is REQUIRED here, not optional as on `ProviderMandate`. Both callers already
   * guarantee it — the webhook returns `ignored` for an unclassifiable mandate and the
   * sweep only calls with what the gateway reported — so requiring it puts that guarantee
   * in the type instead of a second runtime guard that could drift from the first.
   */
  m: ProviderMandate & { status: string },
  /**
   * When the gateway says this state began. Events can arrive out of order (GoCardless
   * delivers a batch newest first), so an event older than the stored status is not
   * applied. Absent (a poll of the current state) = now.
   */
  at: Date = new Date(),
): Promise<HandleResult> {
  const set: Partial<typeof paymentMethods.$inferInsert> = {
    mandateStatus: m.status,
    mandateStatusAt: at,
  };
  if (m.maxAmountMinor != null) set.mandateMaxAmountMinor = m.maxAmountMinor;
  if (m.currency != null) set.mandateCurrency = m.currency;
  if (m.rail != null) set.mandateRail = m.rail;
  if (m.expiresAt != null) set.mandateExpiresAt = m.expiresAt;
  if (m.reference != null) set.mandateReference = m.reference;

  // A dead mandate makes the INSTRUMENT unusable, so it takes the same `invalid`
  // status a hard decline would apply — what moves the customer onto their backup and
  // what stops a new auto-collect subscription. A confirmation does NOT flip the
  // status back to `valid`: the mandate coming alive says nothing about whether the
  // card behind it expired, and blanket-revalidating here would undo a legitimate
  // `invalid` set by the card updater or a hard decline.
  const dead = DEAD_MANDATE_STATUSES.has(m.status.toLowerCase());
  if (dead) set.status = "invalid";

  /**
   * ── The whole update, under a row lock ───────────────────────────────────────────
   *
   * The pre-image is re-read inside the transaction with `SELECT … FOR UPDATE` rather
   * than reused from the unlocked read above, because two decisions now depend on it —
   * the un-pause revival and F-42's "did this mandate just become live" — and both are
   * TRANSITION tests. Two deliveries for the same instrument processed concurrently
   * would otherwise both observe the pre-transition status and both act on it: two
   * resume log lines, and two recovery collections racing over the same open invoices.
   * The lock makes the second one see what the first wrote.
   *
   * A row that vanished between the two reads (a concurrent detach or a customer
   * erasure) leaves nothing to update, so the handler reports `ignored` rather than
   * writing a resurrection.
   */
  const outcome = await withTenant(pm.organizationId, async (tx) => {
    const [locked] = await tx
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.id, pm.id))
      .for("update")
      .limit(1);
    if (!locked) return null;
    if (locked.mandateStatusAt && at < locked.mandateStatusAt) {
      log.info("mandate event older than the stored status — not applied", {
        event: "mandate_event_stale",
        paymentMethod: pm.publicId,
        stored: locked.mandateStatus,
        incoming: m.status,
      });
      return null;
    }

    // ── UN-PAUSING, the one revival that DOES restore the instrument ─────────────
    // The rule above is right in general: a mandate coming alive says nothing about the
    // card behind it, so a `confirmed` after a `rejected` must not undo an `invalid` set
    // by the card updater or a hard decline.
    //
    // A pause is the exception, because we know why the instrument was invalidated. The
    // ONLY thing that marked it invalid was the pause (`paused` is in
    // DEAD_MANDATE_STATUSES), so a resume removes the sole cause. Leaving it `invalid`
    // makes a pause a one-way door — collection never selects the method again and the
    // customer becomes permanently uncollectable, which is the failure a revived mandate
    // is supposed to end.
    //
    // Narrow on purpose: it fires only when the STORED status is `paused` and the incoming
    // one is live. It cannot resurrect a rejected or cancelled mandate, and it cannot
    // override a card-updater `invalid` on an instrument that was never paused.
    //
    // If the card really did expire meanwhile, the next debit hard-declines and dunning
    // re-invalidates it — recoverable. Staying invalid forever is not.
    const wasPaused = `${locked.mandateStatus ?? ""}`.toLowerCase() === "paused";
    if (!dead && wasPaused) {
      set.status = "valid";
      log.info("mandate resumed — restoring the instrument the pause invalidated", {
        event: "mandate_resume_revalidated",
        paymentMethod: pm.publicId,
        from: locked.mandateStatus,
        to: m.status,
      });
    }

    /** Did THIS delivery move the mandate into a live state? See {@link mandateBecameLive}. */
    const becameLive = mandateBecameLive(locked.mandateStatus, m.status);
    // A live mandate is fresh authority from the payer: clears a revoked-mandate block.
    // Dated by the event, so a delayed activation cannot count as authority given after
    // a later revocation.
    if (becameLive) set.authorizedAt = at;
    // The choice made when the method was added covers its first confirmation only; a later
    // resume follows the business rule.
    if (becameLive && locked.collectOpenInvoices != null) set.collectOpenInvoices = null;
    /**
     * The instrument status this write leaves behind — `set.status` when the mandate
     * changed it, otherwise whatever the locked row already held.
     *
     * The emitted event used to report `dead ? "invalid" : pm.status`, which on the
     * un-pause branch published the OLD `invalid` in the very same transaction that
     * wrote `valid`. A subscriber acting on `payment_source_updated` was told the
     * instrument was still dead by the event announcing its revival.
     */
    const effectiveStatus = set.status ?? locked.status;

    await tx.update(paymentMethods).set(set).where(eq(paymentMethods.id, pm.id));
    await emitEvent(tx, {
      organizationId: pm.organizationId,
      businessId: pm.businessId,
      type: "payment_source_updated",
      data: buildEventData("payment_source_updated", {
        id: pm.publicId,
        brand: pm.brand,
        last4: pm.last4,
        exp_month: pm.expMonth,
        exp_year: pm.expYear,
        status: effectiveStatus,
      }),
    });
    // Tell the customer, once, on the transition — a pause included.
    if (dead && locked.status !== "invalid") {
      await emitEvent(tx, {
        organizationId: pm.organizationId,
        businessId: pm.businessId,
        type: "payment_source_invalidated",
        data: buildEventData(
          "payment_source_invalidated",
          { id: pm.publicId, type: pm.type, brand: pm.brand, last4: pm.last4 },
          undefined,
          { invalid_reason: "mandate" },
        ),
      });
    }
    return { becameLive, effectiveStatus, collectOpenInvoices: locked.collectOpenInvoices };
  });
  if (!outcome) return "ignored";

  /**
   * ── F-42: a mandate confirming is a payment method becoming usable ───────────────
   *
   * The add-card routes (operator `POST /v1/customers/:c/payment_methods` and portal
   * `POST /portal/v1/payment_methods`) both collect the customer's open `payment_due`
   * invoices against a freshly usable instrument — Billing LogIQ's "Collect open
   * invoices when a payment method is added", ON by default. That behaviour was itself
   * a bug fix: measured 2026-08-17, operator add-card left an invoice `paid` while
   * portal add-card left the same invoice `payment_due` with the full amount owing.
   *
   * This webhook is the third door into the same state and it was wired to nothing. On
   * the netbanking rails the instrument is NOT usable when it is added — an e-mandate is
   * `initiated` until the bank confirms at T+1 — so the add-card collection runs against
   * something that cannot be charged, and the moment it CAN be charged nobody looks
   * again. F-11 sharpened that: the pending pre-flight now refuses the debit outright
   * and defers 12 hours, so a buyer whose bank confirms an hour later waits for the next
   * backoff tick instead of being collected when their bank says yes.
   *
   * Gated on a genuine TRANSITION into live, computed under the row lock above, so a
   * redelivery cannot re-collect. Provider-event dedup is NOT sufficient on its own: it
   * keys on `provider_event_id` (two different events both asserting `confirmed` both
   * pass), and it deliberately lets a delivery whose prior outcome was `error` run again
   * — which is exactly the redelivery this handler can cause. By then the stored status
   * is already `confirmed`, the transition test is false, and nothing re-collects.
   *
   * Also gated on the instrument being collectable at all. A mandate can confirm on a
   * method the card updater or a hard decline already invalidated, and `applyMandateUpdate`
   * deliberately does not revalidate on a confirmation — so collecting would debit an
   * instrument we have already written off. The two statuses excluded are the two
   * `assertChargeableForAutoCollect` excludes, deliberately the same rule.
   *
   * BEST-EFFORT, and the stakes are higher here than on the add-card routes. Those wrap
   * the call so a recovery charge that throws cannot fail the vault the buyer just
   * completed; here a throw would escape into `handleProviderEvent`, mark the delivery
   * `error`, answer the gateway non-2xx and have the WHOLE event redelivered — mandate
   * update and all. So it is swallowed to a warning, exactly as the portal route does it.
   */
  const collectable =
    outcome.effectiveStatus !== "invalid" && outcome.effectiveStatus !== "expired";
  if (outcome.becameLive && collectable) {
    try {
      const res = await collectOutstandingForNewPaymentMethod({
        organizationId: pm.organizationId,
        businessId: pm.businessId,
        customerId: pm.customerId,
        paymentMethodPublicId: pm.publicId,
        // The add-card call's choice, if it made one; null = the business rule.
        collectOpenInvoices: outcome.collectOpenInvoices ?? undefined,
      });
      if (res.collected.length)
        log.info("mandate confirmed — collected the customer's open invoices", {
          event: "mandate_confirmed_collect",
          paymentMethod: pm.publicId,
          collected: res.collected.map((c) => `${c.invoice}:${c.status}`).join(","),
        });
    } catch (e) {
      log.warn("collect-on-mandate-confirmation failed", {
        event: "mandate_confirmed_collect_failed",
        paymentMethod: pm.publicId,
        detail: (e as Error).message,
      });
    }
  }
  return "processed";
}

/**
 * Reconcile a charge.refunded webhook with our records. Three cases, not two:
 *  - This exact provider refund is recorded and still `pending` — the webhook is the
 *    SETTLEMENT. Flip it to `succeeded` and emit `refund_settled`. No ledger work: the
 *    lines were posted when the provider accepted it.
 *  - Recorded and already terminal (a replay) — do nothing, avoiding a double count.
 *  - Not recorded at all: an OUT-OF-BAND refund (e.g. from the provider dashboard).
 *    Record a refunds row + post the contra-revenue/cash ledger, capped at the
 *    payment's remaining refundable amount.
 */
/**
 * MONEY MOVED AGAINST US — name it, point at what it hit, and refuse to book it.
 *
 * `reserve.hold.updated` (the gateway withholds our funds), and a `charge.reversed`
 * that `applyChargeReversal` could not match to a settled payment, are where the gateway
 * moves money against us and we have nothing to book it against. Before they were mapped they normalized to `unknown`:
 * the row was persisted like every other delivery, but it carried no name, so it was
 * unfindable in the Gateway Webhooks inspector and nothing counted it.
 *
 * ⚠️ DELIBERATELY DOES NOT POST TO THE LEDGER, and that is the point of the handler
 * rather than an omission from it. A reversal is not our refund and a reserve is not a
 * payout; what either warrants in a double-entry book — which accounts, whose
 * currency, how it reconciles against the payout that nets it — is a design decision
 * with real consequences and it is not made by whoever happens to be mapping events.
 * So this makes the event VISIBLE (a named row, a linked transaction, an error-level
 * log, and the `gateway_money_reversed` ops alert that counts them) and stops there.
 *
 * Returns `ignored` honestly: nothing was reconciled. The alert is what makes an
 * `ignored` row here different from the thousands of others.
 */
/**
 * `charge.reversed`: the gateway took back a capture we booked as paid.
 *
 * An open dispute on the charge owns the money, so the reversal is that dispute's
 * withdrawal (cash → `disputed_funds`, settled by won/lost). Otherwise it goes through
 * the late-failure reversal in `reconcileChargeFailed`: cash out, AR and the invoice
 * reopen. A reversal we cannot match stays alert-only.
 *
 * Takes what the payment still holds (see `payments/late-reversal.ts`), or the amount the
 * gateway states, capped at that.
 */
async function applyChargeReversal(
  providerKey: string,
  ev: NormalizedProviderEvent,
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  if (!ev.providerChargeId) return recordMoneyMovedAgainstUs(providerKey, ev);
  const txn = await resolveTransactionByCharge(
    providerKey,
    ev.providerChargeId,
    deliveredByBusinessId,
  );
  // Already reversed: a redelivery under a new event id books nothing twice.
  if (txn?.status === "late_failed") return "ignored";
  if (!txn || txn.status !== "succeeded") return recordMoneyMovedAgainstUs(providerKey, ev);

  const [dispute] = await systemDb
    .select()
    .from(disputes)
    .where(
      and(
        eq(disputes.organizationId, txn.organizationId),
        eq(disputes.businessId, txn.businessId),
        eq(disputes.providerChargeId, ev.providerChargeId),
      ),
    )
    .orderBy(desc(disputes.createdAt))
    .limit(1);
  if (dispute && (dispute.status === "needs_response" || dispute.status === "under_review")) {
    await handleDisputeEvent(
      { ...ev, type: "dispute.funds_withdrawn", providerDisputeId: dispute.providerDisputeId },
      { businessId: txn.businessId, providerKey },
    );
    return "processed";
  }
  if (dispute?.status === "lost") {
    // The loss already took this money out of cash.
    log.warn("a reversal arrived for a charge whose dispute is already lost — nothing booked", {
      event: "reversal_after_dispute_lost",
      dispute: dispute.publicId,
      provider_charge_id: ev.providerChargeId,
    });
    return "ignored";
  }
  return reconcileChargeFailed(
    providerKey,
    { ...ev, type: "charge.failed", lateReversal: true },
    deliveredByBusinessId,
  );
}

async function recordMoneyMovedAgainstUs(
  providerKey: string,
  ev: NormalizedProviderEvent,
): Promise<HandleResult> {
  log.error("the gateway moved money against us and nothing is booked for it", {
    event: "gateway_money_moved_against_us",
    type: ev.type,
    provider: providerKey,
    provider_event_id: ev.providerEventId,
    provider_charge_id: ev.providerChargeId ?? null,
    // `reserve.hold.updated` carries the withheld amount on the settlement fields —
    // see the term's docblock in providers/types.ts for why it borrows them.
    amount_minor: ev.settlementAmountMinor != null ? String(ev.settlementAmountMinor) : null,
    currency: ev.settlementCurrency ?? null,
    status: ev.settlementStatus ?? null,
    detail:
      "recorded and alerted, NOT booked — the ledger treatment is an open design decision (#34/#35)",
  });
  return "ignored";
}

/**
 * Our refund on this payment whose public id is `ownershipRef` and which has no gateway id
 * yet (its create answer was lost). Stamps `providerRefundId` on it and returns the row.
 */
async function adoptLostRefundId(
  paymentId: string,
  providerKey: string,
  ownershipRef: string,
  providerRefundId: string | undefined,
) {
  if (!providerRefundId) return undefined;
  const [row] = await systemDb
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.paymentId, paymentId),
        eq(refunds.providerKey, providerKey),
        eq(refunds.publicId, ownershipRef),
        isNull(refunds.providerRefundId),
      ),
    )
    .limit(1);
  if (!row) return undefined;
  const [stamped] = await withTenant(row.organizationId, (tx) =>
    tx
      .update(refunds)
      .set({ providerRefundId })
      .where(and(eq(refunds.id, row.id), isNull(refunds.providerRefundId)))
      .returning(),
  );
  if (stamped) {
    await withTenant(row.organizationId, (tx) =>
      tx
        .update(transactions)
        .set({ idAtGateway: providerRefundId })
        .where(and(eq(transactions.refundId, row.id), isNull(transactions.idAtGateway))),
    );
  }
  return stamped ?? undefined;
}

async function applyRefund(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  const pay = await resolvePaymentByCharge(
    providerKey,
    ev.providerChargeId!,
    deliveredByBusinessId,
  );
  if (!pay) {
    // A payment request's charge has no payment row: spread the refund over its children.
    const { applyRequestChargeRefund } = await import("@/modules/payment-requests/gateway-hooks");
    const spread = await applyRequestChargeRefund({
      providerKey,
      providerChargeId: ev.providerChargeId!,
      providerRefundId: ev.providerRefundId ?? null,
      amountRefundedMinor: ev.amountRefundedMinor ?? null,
      ...(ev.refunds ? { refunds: ev.refunds } : {}),
      deliveredByBusinessId,
    });
    return spread ?? "ignored"; // not one of our charges (e.g. a CLI test event)
  }

  /**
   * Only money we RECEIVED can be refunded on our books. A gateway can refund a payment
   * our row still calls pending or failed — RazorPay returns a late authorization it never
   * captured — and booking that would pay out cash we never took in.
   */
  if (pay.status !== "succeeded") {
    log.error(new Error("the gateway refunded a payment we never recorded as received"), {
      event: "refund_on_unsettled_payment",
      provider: providerKey,
      payment: pay.publicId,
      payment_status: pay.status,
      provider_refund_id: ev.providerRefundId ?? null,
      amount_refunded_minor: ev.amountRefundedMinor != null ? String(ev.amountRefundedMinor) : null,
    });
    return "ignored";
  }
  if (ev.refunds) return applyRefundRecords(providerKey, pay, ev.refunds);

  // Already booked this provider refund (API-initiated or a prior webhook)?
  //
  // Scoped to THIS payment. It used to match `provider_refund_id` across the entire
  // table — no payment, no provider, no tenant — so any id another org's provider had
  // already used made a genuine out-of-band refund here return `ignored` and never
  // reach the ledger. A provider refund id names one refund of one charge, so the
  // payment is the correct and tightest scope, and it carries the org for free.
  if (ev.providerRefundId) {
    const [existing] = await systemDb
      .select()
      .from(refunds)
      .where(
        and(
          eq(refunds.paymentId, pay.id),
          eq(refunds.providerKey, providerKey),
          eq(refunds.providerRefundId, ev.providerRefundId),
        ),
      )
      .limit(1);
    // A refund of ours whose create answer was lost has no gateway id yet; the tag
    // `refund()` stamped on it (its public id) finds it, and the id is adopted here.
    const lostAnswer =
      !existing && ev.ownershipRef
        ? await adoptLostRefundId(pay.id, providerKey, ev.ownershipRef, ev.providerRefundId)
        : undefined;
    if (existing ?? lostAnswer) {
      const existingRow = (existing ?? lostAnswer)!;
      /**
       * A row we already booked. If it is still `pending`, THIS webhook is the settlement —
       * it is the only signal any provider sends that an accepted refund actually landed
       * (RazorPay `refund.processed`, PayPal `PAYMENT.CAPTURE.REFUNDED`, Stripe
       * `charge.refunded`, all normalised to `charge.refunded`).
       *
       * It used to return `ignored` here unconditionally, under a comment about not
       * double-posting. That is right for an already-settled row and wrong for a pending
       * one: the guard against double-booking silently swallowed the completion, so a
       * pending refund stayed pending for ever and the customer never got the confirmation.
       *
       * No ledger work — `refundPayment` books on acceptance, so the money is already
       * recorded. This is a status flip plus the event that carries the confirmation email.
       */
      return (await settleLandedRefund(existingRow)) ? "processed" : "ignored";
    }
  }

  // Out-of-band refund: book the (capped) delta we haven't recorded yet.
  //
  // Decided under the payment row lock: two deliveries read in parallel each saw nothing
  // recorded and both booked (measured 2026-10-27: $30 booked on a $25 payment).
  //
  // `pending` counts. It is money already committed on the rail and already booked in the
  // ledger (refunds book on acceptance), so excluding it overstated what was still
  // refundable — an out-of-band webhook arriving while one of ours was in flight could book
  // a second refund against the same money. Only `failed` frees the amount back up, and its
  // handler posts the reversal that does so.
  //
  // A tenant transaction, not the admin handle: RLS `WITH CHECK`, the append-only ledger
  // grant and idempotency write-tracking all apply (2026-08-26).
  const booked = await withTenant(pay.organizationId, async (tx) => {
    await tx
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.id, pay.id))
      .for("update");
    const prior = await tx.select().from(refunds).where(eq(refunds.paymentId, pay.id));
    if (
      ev.providerRefundId &&
      prior.some((r) => r.providerKey === providerKey && r.providerRefundId === ev.providerRefundId)
    )
      return false; // another delivery of this refund won the lock
    const recorded = prior
      .filter((r) => r.status !== "failed")
      .reduce((s, r) => s + r.amountMinor, 0n);
    const remaining = pay.amountMinor - recorded;
    const reported = ev.amountRefundedMinor ?? pay.amountMinor; // full refund if amount unknown
    const amount = reported - recorded < remaining ? reported - recorded : remaining;
    // The gateway reports more than has landed, but a refund of ours still in flight holds
    // the room: ask again later (it may be refused) rather than drop this one.
    const landed = prior
      .filter((r) => r.status === "succeeded")
      .reduce((s, r) => s + r.amountMinor, 0n);
    if (amount <= 0n && reported > landed && prior.some((r) => r.status === "pending"))
      throw new Error(
        `refund total ${reported} does not fit while a refund of ours is pending on this payment; retried later`,
      );
    if (amount <= 0n) return false; // nothing new to book
    await bookOutOfBandRefund(tx, pay, providerKey, ev.providerRefundId ?? null, amount);
    return true;
  });
  return booked ? "processed" : "ignored";
}

type ResolvedPayment = NonNullable<Awaited<ReturnType<typeof resolvePaymentByCharge>>>;

/**
 * A refund raised outside our API: a `succeeded` row, the contra-revenue/cash pair, and its
 * refund transaction, so it is on the Transactions list and in every refund total.
 */
async function bookOutOfBandRefund(
  tx: Tx,
  pay: ResolvedPayment,
  providerKey: string,
  providerRefundId: string | null,
  amount: bigint,
): Promise<void> {
  const [refund] = await tx
    .insert(refunds)
    .values({
      organizationId: pay.organizationId,
      businessId: pay.businessId,
      paymentId: pay.id,
      publicId: publicId("re"),
      status: "succeeded",
      amountMinor: amount,
      currency: pay.currency,
      reason: "out_of_band",
      providerKey,
      providerRefundId,
    })
    .returning();
  await postEntries(
    {
      organizationId: pay.organizationId,
      businessId: pay.businessId,
      customerId: pay.customerId,
      sourceType: "refund",
      sourceId: refund!.publicId,
      lines: [
        { account: "refunds", direction: "debit", amountMinor: amount, currency: pay.currency },
        { account: "cash", direction: "credit", amountMinor: amount, currency: pay.currency },
      ],
    },
    tx,
  );
  // The account the charge went through; the payment row does not carry it.
  const [charge] = await tx
    .select({ gatewayAccountId: transactions.gatewayAccountId })
    .from(transactions)
    .where(and(eq(transactions.paymentId, pay.id), eq(transactions.type, "payment")))
    .orderBy(desc(transactions.createdAt))
    .limit(1);
  const { recordTransaction } = await import("@/modules/transactions/service");
  await recordTransaction(
    {
      organizationId: pay.organizationId,
      businessId: pay.businessId,
      customerId: pay.customerId,
      type: "refund",
      status: "succeeded",
      amountMinor: amount,
      currency: pay.currency,
      gatewayAccountId: charge?.gatewayAccountId ?? null,
      gatewayKey: providerKey,
      idAtGateway: providerRefundId,
      paymentId: pay.id,
      paymentMethodId: pay.paymentMethodId,
      invoiceId: pay.invoiceId,
      refundId: refund!.id,
    },
    tx,
  );
}

/**
 * A gateway says this refund landed. A refund flagged not found (or flipped there by the stale
 * sweep while this answer was in flight) is decided under the lock on its state now; any other
 * pending refund just settles.
 */
async function settleLandedRefund(row: typeof refunds.$inferSelect): Promise<boolean> {
  const { answerUnconfirmedRefundTx } = await import("@/modules/credit-notes/service");
  const answer = () =>
    withTenant(row.organizationId, (tx) => answerUnconfirmedRefundTx(tx, row.id, "success"));
  const first = await answer();
  if (first !== "proceed") return first === "done";
  const { settleRefund } = await import("@/modules/refunds/settlement");
  if (row.status === "pending" && (await settleRefund(row))) return true;
  // Lost the settle claim: the sweep may have just flagged it. Ask again, never drop it.
  return (await answer()) === "done";
}

/**
 * Book and settle per gateway refund id, so one refund reported by several events
 * (`charge.refunded` and the Refund events) is booked once.
 */
async function applyRefundRecords(
  providerKey: string,
  pay: ResolvedPayment,
  records: ProviderRefundRecord[],
): Promise<HandleResult> {
  let applied = false;
  for (const rec of records) {
    if (await applyRefundRecord(providerKey, pay, rec)) applied = true;
  }
  return applied ? "processed" : "ignored";
}

async function applyRefundRecord(
  providerKey: string,
  pay: ResolvedPayment,
  rec: ProviderRefundRecord,
): Promise<boolean> {
  const sameRefund = and(
    eq(refunds.paymentId, pay.id),
    eq(refunds.providerKey, providerKey),
    eq(refunds.providerRefundId, rec.providerRefundId),
  );
  let [existing] = await systemDb.select().from(refunds).where(sameRefund).limit(1);
  // Ours with a lost create answer: no gateway id yet, so our tag finds the row.
  if (!existing && rec.ownershipRef)
    existing = await adoptLostRefundId(pay.id, providerKey, rec.ownershipRef, rec.providerRefundId);
  if (existing) {
    const { settleRefund, reverseRefund } = await import("@/modules/refunds/settlement");
    // Booked at acceptance: a failure undoes it, a landed refund only flips the status.
    if (rec.status === "failed")
      return reverseRefund(existing, { failureCode: null, gatewayConfirmed: true });
    if (rec.status !== "succeeded") return false;
    return settleLandedRefund(existing);
  }
  // Our own refund path issued it and books it; its row takes this id when it commits.
  // Only a refund's own ref (`re_…`) means that: a gateway may copy the sale's ref
  // (`inv_…`) onto a refund made outside us, which must still be booked here.
  if (rec.ownershipRef?.startsWith("re_")) return false;
  // Out of band: book it when it lands. `refund.failed` reverses it by this id.
  if (rec.status !== "succeeded") return false;
  return withTenant(pay.organizationId, async (tx) => {
    // Serialise with every other refund of this payment, then check again under the lock.
    await tx
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.id, pay.id))
      .for("update");
    const prior = await tx.select().from(refunds).where(eq(refunds.paymentId, pay.id));
    if (
      prior.some(
        (r) => r.providerKey === providerKey && r.providerRefundId === rec.providerRefundId,
      )
    )
      return false;
    const recorded = prior
      .filter((r) => r.status !== "failed")
      .reduce((sum, r) => sum + r.amountMinor, 0n);
    const remaining = pay.amountMinor - recorded;
    // A refund of ours still in flight holds room it may yet give back (a refusal). Ask
    // again later rather than drop this one: the error makes the gateway redeliver.
    if (rec.amountMinor > remaining && prior.some((r) => r.status === "pending"))
      throw new Error(
        `refund ${rec.providerRefundId} does not fit while a refund of ours is pending on this payment; retried later`,
      );
    const amount = rec.amountMinor < remaining ? rec.amountMinor : remaining;
    if (amount < rec.amountMinor)
      log.warn("an out-of-band refund is larger than what the payment still holds — capped", {
        event: "refund_out_of_band_capped",
        payment: pay.id,
        provider_refund_id: rec.providerRefundId,
        reported_minor: String(rec.amountMinor),
        booked_minor: String(amount > 0n ? amount : 0n),
      });
    if (amount <= 0n) return false;
    await bookOutOfBandRefund(tx, pay, providerKey, rec.providerRefundId, amount);
    return true;
  });
}

/**
 * `intent.requires_action` — the buyer has to authenticate before this money can
 * move, and the gateway is telling us so AFTER our call already returned.
 *
 * Two arrival shapes, and the second is the one that matters:
 *
 *  1. **We own an intent row.** Hosted checkout / on-session 3DS: the buyer is in
 *     our flow, so recording the challenge on the intent is the whole job — the page
 *     they are looking at reads `next_action`, and no notice is needed for someone
 *     already staring at the screen.
 *
 *  2. **We own a TRANSACTION, not an intent.** An off-session debit goes through
 *     `charge()`, which mints a PaymentIntent at the gateway and stores its id as the
 *     transaction's `id_at_gateway`; nothing is ever written to
 *     `payment_intents.intent_at_gateway`. This is the India RBI e-mandate case —
 *     Stripe parks the debit in `processing` for 26 hours while the buyer's bank
 *     sends the pre-debit notification — and here the buyer is NOT looking at
 *     anything. Nobody tells them unless we do.
 *
 * The second path emits `payment_authentication_required`, the event that already
 * drives that email. What it adds over the existing emit site in
 * `invoicing/service.ts` is authority and a deadline: that one fires on
 * `debitNeedsBuyerAuthentication`, which INFERS the requirement from amount + rail
 * (and whose own docstring flags the UPI half as "INFERRED, not measured"). This one
 * is the gateway stating it, so it cannot false-positive on a buyer whose bank was
 * never going to ask — and it carries `authenticate_by`, the moment the gateway
 * stops waiting, which no prediction can know.
 *
 * ⚠️ Since 2026-09-09 that other site reads `debitAwaitsBuyerAuthentication`, which
 * short-circuits on the gateway's statement at ANY amount — so both sites now fire for
 * the same debit and the buyer was mailed twice. The emit below suppresses the second
 * MAIL only; see it for why the event still goes out.
 */
async function applyActionRequired(
  providerKey: string,
  ev: NormalizedProviderEvent,
  /** The business that delivered this webhook — the correlation scope. */
  deliveredByBusinessId?: string | null,
): Promise<HandleResult> {
  // ── (1) our own intent ────────────────────────────────────────────────────
  const pi = ev.providerIntentId
    ? await findPaymentIntentByGatewayIntentId(ev.providerIntentId)
    : null;
  if (pi) {
    // A challenge on an intent that already finished is stale by definition.
    if (
      pi.status === "consumed" ||
      pi.status === "expired" ||
      pi.status === "voided" ||
      pi.voidedAt != null
    ) {
      return "ignored";
    }
    // `nextAction` only — deliberately NOT a status change. `payment_intents.status`
    // has no `requires_action` member (inited | in_progress | authorized | consumed |
    // expired | voided), and inventing one would touch the expiry sweep and the retry
    // state machine for what is advisory information. The intent is legitimately
    // still open; what changed is that we now know what it is waiting for.
    await withTenant(pi.organizationId, async (tx) => {
      await tx
        .update(paymentIntents)
        .set({
          nextAction: {
            type: ev.actionType ?? "unknown",
            ...(ev.actionDeadline ? { deadline: ev.actionDeadline.toISOString() } : {}),
          },
        })
        .where(eq(paymentIntents.id, pi.id));
    });
    return "processed";
  }

  // ── (2) an off-session debit, correlated through the transaction ───────────
  if (!ev.providerChargeId) return "ignored";
  const txn = await resolveTransactionByCharge(
    providerKey,
    ev.providerChargeId,
    deliveredByBusinessId,
  );
  if (!txn) return "ignored"; // not ours (a CLI test event, or another integration's)
  // Only an OPEN attempt can still be rescued by the buyer. A settled or failed
  // transaction means the window closed while this delivery was in flight, and
  // mailing "please authenticate" for money already taken (or already given up on)
  // is worse than saying nothing.
  if (!["in_progress", "timeout", "needs_attention"].includes(txn.status)) return "ignored";

  const [pay] = txn.paymentId
    ? await systemDb.select().from(payments).where(eq(payments.id, txn.paymentId)).limit(1)
    : [];
  const [pm] = txn.paymentMethodId
    ? await systemDb
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.id, txn.paymentMethodId))
        .limit(1)
    : [];
  const [inv] = txn.invoiceId
    ? await systemDb
        .select({ publicId: invoices.publicId })
        .from(invoices)
        .where(eq(invoices.id, txn.invoiceId))
        .limit(1)
    : [];

  const resourceId = pay?.publicId ?? txn.publicId;
  await withTenant(txn.organizationId, async (tx) => {
    /**
     * RECORD THE WAIT, because a later statement outranks an earlier one.
     *
     * This handler used to emit the event and nothing else, which was harmless while the
     * row could only ever say `authentication_required` or nothing. Since 2026-09-10 the
     * booking path can also write `authentication_not_required` — the gateway's own
     * "no approval needed" — and that answer OUTRANKS the rail+amount prediction. So a
     * debit Stripe first waved through and then challenged kept its stale negative, and
     * `debitAwaitsBuyerAuthentication` told the portal, the operator and the sweep that
     * nobody had to act. Measured on INV-100006 (see `authenticationWaitMayBeRecorded`).
     *
     * Written inside the SAME transaction as the emit, so the row a subscriber's handler
     * reads back can never disagree with the event that woke it.
     */
    if (authenticationWaitMayBeRecorded(txn.errorCode))
      await tx
        .update(transactions)
        .set({ errorCode: AWAITING_AUTHENTICATION_CODE })
        .where(eq(transactions.id, txn.id));
    /**
     * ONE "please authenticate" MAIL PER DEBIT, though two sites emit this event.
     *
     * `collectClaimedInvoice` emits it when it books the debit pending, and this handler
     * emits it again a second or two later when the gateway states the same thing. Both
     * render byte-identically — the template has no `authenticate_by` var — so the second
     * mail is pure duplication. It reached every debit on 2026-09-09, when the amount gate
     * came off the pending booking: below ₹15,000 the old failure booking made the
     * transaction terminal, which made the guard above return `ignored` and hid the overlap.
     *
     * Suppressed rather than not emitted: the deadline is real information, and a
     * subscriber should still get it. `enqueueEmails` owns the lever.
     */
    const [alreadyNotified] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.type, "payment_authentication_required"), eq(events.resourceId, resourceId)),
      )
      .limit(1);
    await emitEvent(tx, {
      organizationId: txn.organizationId,
      businessId: txn.businessId,
      type: "payment_authentication_required",
      data: buildEventData(
        "payment_authentication_required",
        {
          id: resourceId,
          status: "pending",
          amount_minor: Number(txn.amountMinor),
          currency: txn.currency,
          invoice: inv?.publicId ?? null,
          // Same field the predictive emit sends, so the mail template's copy split
          // ("your bank" for card vs "your UPI app") works identically on both paths.
          mandate_rail: pm?.mandateRail ?? pm?.type ?? null,
          // What the gateway told us and a prediction never could.
          authenticate_by: ev.actionDeadline ? ev.actionDeadline.toISOString() : null,
          action_type: ev.actionType ?? null,
        },
        undefined,
        // TOP-LEVEL, not inside the resource: `events/content.ts` can replace the payment
        // payload with a fresh snapshot, and a flag a sink sees only sometimes is worse
        // than one it never sees.
        alreadyNotified ? { suppress_email: true } : {},
      ),
    });
  });
  log.info("gateway reports this debit is waiting on the buyer", {
    event: "debit_authentication_required",
    transaction: txn.publicId,
    action_type: ev.actionType ?? null,
    authenticate_by: ev.actionDeadline?.toISOString() ?? null,
  });
  return "processed";
}

/**
 * `refund.failed` — a refund we already booked did not land (reversed by the bank,
 * refused at the network, a closed account).
 *
 * Correlated on the REFUND id, never the payment's: the charge succeeded and stays
 * succeeded. The money has to come back onto our books, and the ledger is
 * append-only (locked decision 4), so this posts the COMPENSATING entry — the exact
 * inverse of what `applyRefund` posted — rather than touching those lines.
 *
 * Idempotent twice over: the provider-event dedup at the top of `handleProviderEvent`
 * blocks replays, and the `status === 'succeeded'` guard means a refund already
 * marked failed cannot be reversed a second time even if it arrives by another route.
 */
async function reverseFailedRefund(
  providerKey: string,
  ev: NormalizedProviderEvent,
  deliveredByBusinessId: string | null,
): Promise<HandleResult> {
  if (!ev.providerRefundId) return "ignored";
  // Provider- and business-scoped, for the reason spelled out on `resolvePaymentByCharge`:
  // refund ids collide across tenants on a shared gateway account, and `limit(1)` would
  // reverse whichever tenant's refund it happened to pick.
  const [ref] = await systemDb
    .select()
    .from(refunds)
    .where(
      and(
        eq(refunds.providerKey, providerKey),
        eq(refunds.providerRefundId, ev.providerRefundId),
        ...(deliveredByBusinessId ? [eq(refunds.businessId, deliveredByBusinessId)] : []),
      ),
    )
    .limit(1);
  const lost =
    !ref && ev.providerChargeId && ev.ownershipRef
      ? await (async () => {
          const pay = await resolvePaymentByCharge(
            providerKey,
            ev.providerChargeId!,
            deliveredByBusinessId,
          );
          return pay
            ? adoptLostRefundId(pay.id, providerKey, ev.ownershipRef!, ev.providerRefundId!)
            : undefined;
        })()
      : undefined;
  const target = ref ?? lost;
  if (!target) return "ignored"; // never booked here — nothing to reverse

  // Shared with the stale-pending sweep, so a refusal we were TOLD about and one we had to
  // go and discover unwind identically. The conditional update inside makes a redelivery,
  // or a race with that sweep, a no-op rather than a second reversal.
  const { reverseRefund } = await import("@/modules/refunds/settlement");
  const reversed = await reverseRefund(target, {
    failureCode: ev.providerFailureCode ?? null,
    gatewayConfirmed: true,
  });
  return reversed ? "processed" : "ignored";
}

/**
 * Reopen a settled invoice after the gateway reversed its payment, through the same
 * `planFailureRearm` as the other failure writers (stop / pause / offline honoured, a
 * terminate or revoked-mandate decline not re-armed). Shared by the direct reversal and
 * a payment request's reversed charge (`reverseRequestCharge`).
 */
export async function rearmReversedInvoice(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    invoice: typeof invoices.$inferSelect;
    paymentMethodId: string | null;
    occurredAt: Date;
    /** The adapter's normalised decline, when it could classify one. */
    declineCode: string | undefined;
    retriable: boolean;
    /** The reversed payment: it is the attempt being booked, not an earlier one. */
    paymentId?: string | null;
  },
): Promise<{
  inv: typeof invoices.$inferSelect | undefined;
  set: Partial<typeof invoices.$inferInsert>;
}> {
  // Re-armed only while it is still `paid` and the reversal leaves something owing. A voided
  // or reopened invoice, or one other money still pays, is left alone. The caller has already
  // marked the reversed payment failed, so the outstanding amount excludes it.
  const [inv0] = await tx
    .select()
    .from(invoices)
    .where(eq(invoices.id, input.invoice.id))
    .limit(1)
    .for("update");
  if (!inv0 || inv0.status !== "paid") return { inv: undefined, set: {} };
  if ((await invoiceOutstanding(tx, inv0)).remainingMinor === 0n) {
    log.info("a reversed payment's invoice is still paid by other money; not re-armed", {
      event: "late_reversal_invoice_still_paid",
      invoice: inv0.publicId,
    });
    return { inv: undefined, set: {} };
  }
  const sub = inv0.subscriptionId
    ? ((
        await tx
          .select({ ac: subscriptions.autoCollection, status: subscriptions.status })
          .from(subscriptions)
          .where(eq(subscriptions.id, inv0.subscriptionId))
          .limit(1)
      )[0] ?? null)
    : null;
  const [cust] = await tx
    .select({ ac: customers.autoCollection })
    .from(customers)
    .where(eq(customers.id, inv0.customerId))
    .limit(1);
  const autoCollectOn = isAutoCollectOn(sub?.ac ?? null, cust?.ac);
  const [biz] = await tx
    .select({
      retryDays: businesses.dunningRetryDays,
      dunningConfig: businesses.dunningConfig,
      timezone: businesses.timezone,
      billingRulesConfig: businesses.billingRulesConfig,
    })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const newAttemptCount = inv0.attemptCount + 1;
  const dunningCfg = await loadEffectiveDunningConfig(tx, {
    businessId: input.businessId,
    customerId: inv0.customerId,
    subscriptionId: inv0.subscriptionId,
  });
  // Smart-dunning decline code, now that `NormalizedProviderEvent` carries one
  // (the FOLLOW-UP this comment used to describe). The adapter has already run its
  // own `normalize*Decline`, so the value here is the SAME token the synchronous
  // path would have produced for this decline — which is the point: one decline
  // must not classify two ways depending on whether it arrived in the charge
  // response or later as a reversal.
  //
  // Still `undefined` when the adapter could not classify it, and smart mode then
  // falls back to fixed retry/exhaust exactly as before. Never the raw provider
  // string: that could collide with a canonical token and misroute the disposition.
  const declineCode = input.declineCode;
  // Built once: `dunningAppliesTo` (auto-collect ON) and `offlineDunningApplies`
  // (auto-collect OFF) take the same context, and the two must not disagree about
  // which invoice they are describing.
  const dunCtx = {
    hasSubscription: inv0.subscriptionId != null,
    subscriptionStatus: sub?.status ?? null,
  };
  // Reopening a settled invoice starts dunning again, so the exclusion and the
  // minimum (on what the reversal left owing) decide whether it may.
  const startHeld = (await dunningHoldFor(tx, inv0, dunningCfg)) !== null;
  /**
   * The rail the reversed attempt ran on, so the schedule is truncated to what
   * the NETWORK will accept (`capRetryDaysForRail`).
   *
   * The other two failure writers have passed this since the NPCI caps landed and
   * this one did not, so a late failure on e-NACH or UPI Autopay re-armed the
   * merchant's full schedule past a 2- or 3-presentation cap. Same decline, same
   * instrument, two different answers depending only on whether the refusal
   * arrived in the charge response or later as a reversal — which is exactly the
   * divergence the normalised decline vocabulary exists to prevent.
   */
  const [railRow] = input.paymentMethodId
    ? await tx
        .select({
          rail: paymentMethods.mandateRail,
          type: paymentMethods.type,
          issuerZones: countries.timezones,
        })
        .from(paymentMethods)
        .leftJoin(countries, eq(countries.code, paymentMethods.issuerCountry))
        .where(eq(paymentMethods.id, input.paymentMethodId))
        .limit(1)
    : [];
  const plan = planFailureRearm({
    dunningStatus: inv0.dunningStatus,
    currentNextAttemptAt: inv0.nextAttemptAt,
    autoCollectOn,
    retriable: input.retriable,
    newAttemptCount,
    retryDays: dunningCfg.retryDays,
    now: input.occurredAt,
    mode: dunningCfg.mode,
    declineCode,
    skipRetriesForHardFailures: dunningCfg.skipRetriesForHardFailures,
    parkHardDeclines: dunningCfg.parkHardDeclines,
    // Master switch + the trial/future and one-time-invoice scope toggles.
    dunningApplies: !startHeld && dunningAppliesTo(dunningCfg, dunCtx),
    periodEndsAt: dunningPeriodEndsAt(dunningCfg, dunningAnchor(inv0)),
    dueDate: dunningAnchor(inv0),
    mandateRail: railRow?.rail ?? null,
    adaptiveTiming: dunningCfg.adaptiveTiming,
    timezone: biz?.timezone ?? null,
    issuerZones: railRow?.issuerZones ?? null,
    mandateRevoked: resolveBillingRulesConfig(biz).mandateRevoked,
    methodType: railRow?.type ?? null,
    retriesByMethod: dunningCfg.retriesByMethod,
    adaptiveCadence: dunningCfg.adaptiveCadence,
    priorMethods: await priorFailedMethods(tx, inv0.id, input.paymentId),
  });
  /**
   * An OFFLINE (auto-collect-off) invoice must not book a dunning attempt.
   *
   * No charge is ever PRESENTED on such an invoice, so `attempt_count` may not
   * count one; the collection that is being reversed here reached the
   * gateway through a manual "Collect now" / portal Pay now, and those already
   * hold the counter still (M12). Advancing it on the way back out would book an
   * attempt that its own success never booked.
   *
   * `invoicing/service.ts` holds the counter on the same `send_invoice` branch for
   * the same reason; this is the third writer catching up to that ruling.
   */
  const offlineInvoice = plan.action === "send_invoice";
  const set: Partial<typeof invoices.$inferInsert> = {
    paidAt: null,
    ...(offlineInvoice ? {} : { attemptCount: newAttemptCount }),
  };
  if (plan.action === "retry") {
    set.status = "payment_due";
    set.dunningStatus = "in_progress";
    Object.assign(set, heldRetry(plan.nextAttempt, inv0.retryHoldUntil));
  } else if (plan.action === "paused") {
    set.status = "payment_due";
    set.dunningStatus = "in_progress";
    set.nextAttemptAt = plan.until;
  } else if (plan.action === "parked") {
    set.status = "payment_due";
    set.dunningStatus = "parked";
    set.nextAttemptAt = null;
    // Set ON THE WAY IN, once: re-parking an already-parked invoice must not
    // restart its window — see the note at the same branch in
    // `invoicing/service.ts`.
    if (inv0.dunningStatus !== "parked") {
      // The window's anchor: a park has no retry to count down from (0232).
      set.dunningParkedAt = input.occurredAt;
      // …and the contact ladder inside the window (0283).
      set.dunningNextReminderAt = nextParkedReminderAt(
        dunningCfg,
        input.occurredAt,
        input.occurredAt,
        retryDaysForMethod(dunningCfg, railRow?.type, railRow?.rail),
      );
    }
  } // smart: retained, no auto-retry
  else if (plan.action === "exhausted") {
    set.status = "not_paid";
    set.dunningStatus = "exhausted";
    set.nextAttemptAt = null;
    // When dunning gave up (0282) — the dated half of the recovery rate.
    set.dunningExhaustedAt = input.occurredAt;
    set.dunningExhaustedCode = declineCode ?? null;
  } else if (plan.action === "offline") {
    // Dunning switched off for the business while auto-collection is ON. A charge
    // really was attempted and really failed, so the debt stands as `not_paid`.
    // This is NOT the auto-collect-off case — that is `send_invoice`, below.
    set.status = "not_paid";
    set.nextAttemptAt = null;
  } else if (offlineInvoice) {
    /**
     * AUTO-COLLECT OFF — the wrong write this branch exists to end (2026-09-01).
     *
     * `send_invoice` used to fall through to the `stopped` else and write
     * `not_paid` + `dunning_status: stopped` + `next_attempt_at: null`. All three
     * were wrong: `not_paid` is the collection-FAILED status and a send-invoice
     * bill has failed no collection (`due.ts`'s 2026-08-31 note, and
     * `planFailureRearm`'s `send_invoice` docblock); `stopped` claims a merchant
     * halted the chase that nobody halted; and
     * the null destroyed the offline REMINDER schedule, which is the only thing
     * that ever tells the payer the bill is outstanding again.
     *
     * ⚠️ Unlike `invoicing/service.ts`, this branch cannot write NOTHING. There a
     * charge that auto-collection ruled out failed against an invoice that was
     * already in its correct offline state, so the honest write was none. Here the
     * invoice is `paid` with a `paid_at`, and the money has just been taken back —
     * leaving it alone would leave a settled invoice for a reversed payment.
     *
     * So it is restored to the state the OFFLINE model itself would give an unpaid
     * invoice, via that model's own helpers rather than a second guess at them:
     * `payment_due` + `in_progress` + the next reminder instant while offline
     * dunning applies, and `not_paid` when the merchant has opted out of it —
     * exactly the two outcomes `runInvoiceDueTransitions` writes at `posted →`.
     * The ladder is time-indexed off the due date, so re-deriving it here gives
     * the same instants it would have had, with no counter to keep in step.
     */
    if (!startHeld && offlineDunningApplies(dunningCfg, dunCtx)) {
      set.status = "payment_due";
      set.dunningStatus = "in_progress";
      set.nextAttemptAt = nextOfflineReminderAt(
        dunningCfg,
        dunningAnchor(inv0),
        input.occurredAt,
        dunCtx,
      );
    } else {
      // Offline dunning opted out (`dun_offline_invoices: false`): the pre-parity
      // edge, kept deliberately — `due.ts` writes the same `not_paid` for an
      // offline invoice nobody will chase.
      set.status = "not_paid";
      set.nextAttemptAt = null;
    }
  } else {
    set.status = "not_paid";
    set.dunningStatus = "stopped";
    set.nextAttemptAt = null;
  } // stopped
  const [inv] = await tx
    .update(invoices)
    .set(set)
    .where(and(eq(invoices.id, inv0.id), eq(invoices.status, "paid")))
    .returning();
  if (inv && plan.action === "exhausted") {
    // A revoked mandate's subscription action, as the sync path applies it.
    const { scheduleRevokedMandateAction } = await import("@/modules/subscriptions/dunning");
    scheduleRevokedMandateAction({
      organizationId: input.organizationId,
      businessId: input.businessId,
      invoicePublicId: inv.publicId,
      subscriptionId: inv.subscriptionId,
      code: declineCode ?? null,
      rule: resolveBillingRulesConfig(biz).mandateRevoked,
      config: dunningCfg,
    });
  }
  return { inv, set };
}
