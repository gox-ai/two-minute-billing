/**
 * Lost-answer charges: `charge()` threw `ProviderIndeterminateError`, so the attempt is booked
 * `timeout` with no gateway id and its invoice is parked. Nothing else can resolve it — the
 * stale-pending pass polls by gateway id, and a webhook matches by gateway id.
 *
 * This pass asks the gateway by what we sent (`locateCharge`: our ownership ref and the
 * idempotency key, kept on the row by 0396):
 *  - found     → adopt the gateway id, then book its answer through the webhook's path;
 *  - not found → keep asking until {@link LOST_ANSWER_GIVE_UP_HOURS}, then fail the attempt as
 *                {@link LOST_ANSWER_NOT_CREATED_CODE}, and dunning retries with a new key;
 *  - no lookup → leave it for an operator, with one alert per row.
 *
 * A gateway with no lookup at all (`capabilities.locateByReplay`, Adyen) is asked by resending
 * the create under the same key, which makes a charge the gateway never received. So it is
 * asked only through {@link replayGate}: an invoice collection whose money is still owed, under
 * the invoice's collection claim. Anything else is left for an operator.
 *
 * A row where the adapter kept a stranded gateway id is asked by that id instead
 * (`fetchChargeStatus`), with the same grace: a terminal answer is booked; a non-terminal one
 * waits out the same window, then the row becomes `in_progress` for the pending sweep and the
 * webhook. Never failed on our clock: the gateway holds an object that can still move money.
 *
 * The rule it keeps: a lost answer is never a failure that permits a new key. Only the
 * gateway saying "no such charge" a full window later is.
 */
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { scanBusinessFilter } from "@/platform/clock";
import { config } from "@/platform/config";
import { createLogger } from "@/platform/logger";
import { invoices, paymentMethods, paymentRequests, payments, transactions } from "@db/schema";
import type { ChargeInitiator, ChargeResult } from "@/providers/types";
import { setTransactionStatus } from "@/modules/transactions/service";
import {
  claimCollection,
  invoiceOutstanding,
  releaseCollection,
} from "@/modules/invoicing/service";
import { loadChargeContact } from "@/modules/invoicing/collection";
import { isOpenInvoiceStatus } from "@/modules/invoicing/status";
import { liveIntentForInvoice } from "@/modules/payment-intents/service";
import { settleTransactionOutcome } from "./settlement";
import {
  clearPollSchedule,
  deferPolls,
  deferredUntilLater,
  scheduledBefore,
  type PollDeferral,
} from "./poll-schedule";
import {
  adapterForTransaction,
  applyChargeVerdict,
  type StalePendingResult,
} from "./stale-pending";

const log = createLogger("stale-pending");

/** How long a lost answer waits before the first lookup: the webhook usually comes first. */
export const LOST_ANSWER_GRACE_MINUTES = 10;

/**
 * How long "not found" stays a maybe. Past it, a `null` from `locateCharge` fails the attempt.
 * It must exceed every gateway's lag between creating a charge and listing it (seconds to
 * minutes on every adapter we have) and the time a create request can still be in flight
 * (seconds). 24 hours is far past both, and short enough that a parked invoice resumes
 * dunning the next day.
 */
export const LOST_ANSWER_GIVE_UP_HOURS = 24;

/** The failure code of a lost answer the gateway confirmed it never created. */
export const LOST_ANSWER_NOT_CREATED_CODE = "gateway_charge_not_created";

/** The window the lookup searches from: the attempt, less clock skew between us and the gateway. */
const LOOKUP_SKEW_MS = 10 * 60 * 1000;

type Txn = typeof transactions.$inferSelect;

const noGatewayId = or(isNull(transactions.idAtGateway), eq(transactions.idAtGateway, ""));
const isTimeout = and(eq(transactions.type, "payment"), eq(transactions.status, "timeout"));
/** A lost-answer row: a payment attempt in `timeout` with no gateway id. */
const isLostAnswer = and(isTimeout, noGatewayId);

export async function resolveLostAnswers(
  now: Date,
  out: StalePendingResult,
  opts?: { onlyTransactionId?: string },
): Promise<void> {
  const targeted = opts?.onlyTransactionId;
  const rows = await systemDb
    .select()
    .from(transactions)
    .where(
      and(
        isTimeout,
        targeted
          ? eq(transactions.id, targeted)
          : lt(
              transactions.createdAt,
              new Date(now.getTime() - LOST_ANSWER_GRACE_MINUTES * 60_000),
            ),
        scanBusinessFilter(transactions.businessId),
      ),
    )
    .orderBy(transactions.createdAt)
    .limit(config.TICK_SCAN_LIMIT);
  if (rows.length === 0) return;

  const skip = targeted ? new Set<string>() : await deferredUntilLater("lost_answer", now);
  const seen = await scheduledBefore(
    "lost_answer",
    rows.map((r) => r.id),
  );
  const defer: PollDeferral[] = [];
  const deferLater = (t: Txn) => {
    if (!targeted) defer.push({ organizationId: t.organizationId, transactionId: t.id });
  };

  /** Leave the row for an operator. `always`: say so on every pass, not only the first. */
  const unresolvable = (txn: Txn, reason: string, always = false) => {
    out.lostAnswerUnsupported++;
    // Once per row: a schedule row means an earlier tick already raised it.
    if (!seen.has(txn.id)) out.lostAnswerAlerted++;
    if (!seen.has(txn.id) || always)
      log.error(new Error("a charge whose answer was lost cannot be looked up at the gateway"), {
        event: "lost_answer_unresolvable",
        txn: txn.publicId,
        gateway: txn.gatewayKey,
        reason,
        detail:
          "the invoice stays parked; check the gateway for a charge with this reference and " +
          "reconcile the transaction by hand",
      });
    deferLater(txn);
  };

  for (const txn of rows) {
    if (skip.has(txn.id)) continue;
    out.lostAnswerExamined++;
    let adapter;
    try {
      adapter = await adapterForTransaction(txn);
    } catch {
      adapter = null;
    }
    if (txn.idAtGateway) {
      await resolveStranded(txn, adapter, now, out, seen.has(txn.id), deferLater);
      continue;
    }
    if (!adapter?.locateCharge || !txn.ownershipRef || !txn.idempotencyKey) {
      unresolvable(
        txn,
        !adapter ? "no_adapter" : !adapter.locateCharge ? "no_lookup" : "no_reference_recorded",
      );
      continue;
    }

    let gate: ReplayGate | null = null;
    const byReplay = adapter.capabilities.locateByReplay;
    if (byReplay) {
      try {
        gate = await replayGate(txn, byReplay.keyValidMs);
      } catch (e) {
        log.warn("lost-answer replay check failed", { txn: txn.publicId, error: String(e) });
        deferLater(txn);
        continue;
      }
      if (gate.kind === "wait") {
        deferLater(txn);
        continue;
      }
      if (gate.kind === "refused") {
        unresolvable(txn, gate.reason, true);
        continue;
      }
    }

    try {
      await locateAndBook(txn, adapter, gate?.kind === "ok" ? gate.replay : undefined);
    } finally {
      if (gate?.kind === "ok") await releaseCollection(txn.organizationId, gate.invoiceId);
    }
  }
  await deferPolls("lost_answer", defer, now);

  async function locateAndBook(txn: Txn, adapter: NonNullable<Adapter>, replay?: Replay) {
    let found: ChargeResult | null;
    try {
      found = await adapter.locateCharge!({
        ...(await locateInput(txn)),
        ...(replay ? { replay } : {}),
      });
    } catch (e) {
      // Could not ask: says nothing about the money.
      log.warn("lost-answer lookup failed", { txn: txn.publicId, error: String(e) });
      deferLater(txn);
      return;
    }

    try {
      if (found?.providerChargeId) {
        if (await adoptAndBook(txn, found, now)) out.lostAnswerFound++;
      } else if (
        !found &&
        txn.createdAt.getTime() <= now.getTime() - LOST_ANSWER_GIVE_UP_HOURS * 3_600_000
      ) {
        if (await failNotCreated(txn, now)) out.lostAnswerNotCreated++;
      } else {
        deferLater(txn);
      }
    } catch (e) {
      // e.g. the gateway id is already booked on another payment: an operator must look.
      log.error(e as Error, {
        event: "lost_answer_book_failed",
        txn: txn.publicId,
        provider_charge_id: found?.providerChargeId ?? null,
      });
      deferLater(txn);
    }
  }
}

type Adapter = Awaited<ReturnType<typeof adapterForTransaction>>;
type Replay = { initiator: ChargeInitiator; email?: string };
type ReplayGate =
  | { kind: "ok"; invoiceId: string; replay: Replay }
  | { kind: "wait" }
  | { kind: "refused"; reason: string };

/** Instrument statuses a collection may still charge. */
const CHARGEABLE_PM = new Set(["valid", "expiring"]);

/**
 * May a replay-only lookup resend this charge? A replay of a create the gateway never received
 * MAKES the charge, so only while that is still the right thing to do: an invoice collection
 * (`collectInvoice`'s ref and key) inside the key's lifetime, on an open invoice that owes
 * exactly this amount, with no other attempt or checkout on it and the instrument still usable.
 * On `ok` the caller holds the invoice's collection claim and must release it.
 */
async function replayGate(txn: Txn, keyValidMs: number): Promise<ReplayGate> {
  const refused = (reason: string): ReplayGate => ({ kind: "refused", reason });
  // Wall clock, not the business clock: the key expires at the gateway.
  if (Date.now() - txn.createdAt.getTime() > keyValidMs) return refused("replay_window_passed");
  if (!txn.invoiceId || txn.paymentRequestId || !txn.paymentId || !txn.paymentMethodId)
    return refused("not_an_invoice_collection");
  const org = txn.organizationId;
  const [inv] = await withTenant(org, (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, txn.invoiceId!)).limit(1),
  );
  if (
    !inv ||
    inv.publicId !== txn.ownershipRef ||
    !txn.idempotencyKey?.startsWith(`inv_${inv.publicId}_attempt_`)
  )
    return refused("not_an_invoice_collection");
  if (await liveIntentForInvoice(org, inv.id, new Date())) return { kind: "wait" };
  if (!(await claimCollection(org, inv.id, new Date()))) return { kind: "wait" };
  try {
    const why = await withTenant(org, async (tx) => {
      const [cur] = await tx.select().from(invoices).where(eq(invoices.id, inv.id)).limit(1);
      if (!cur || !isOpenInvoiceStatus(cur.status)) return "invoice_not_open";
      if (cur.currency.toUpperCase() !== txn.currency.toUpperCase()) return "amount_owed_changed";
      if ((await invoiceOutstanding(tx, cur)).remainingMinor !== txn.amountMinor)
        return "amount_owed_changed";
      const pending = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.invoiceId, cur.id), eq(payments.status, "pending")));
      if (pending.length !== 1 || pending[0]!.id !== txn.paymentId)
        return "other_attempt_on_invoice";
      const [pm] = await tx
        .select({ status: paymentMethods.status })
        .from(paymentMethods)
        .where(eq(paymentMethods.id, txn.paymentMethodId!))
        .limit(1);
      if (!pm || !CHARGEABLE_PM.has(pm.status)) return "payment_method_unusable";
      return null;
    });
    if (why) {
      await releaseCollection(org, inv.id);
      return refused(why);
    }
    const contact = await loadChargeContact(org, inv.customerId);
    return {
      kind: "ok",
      invoiceId: inv.id,
      // What `collectInvoice` sent.
      replay: {
        initiator: { by: "merchant", recurring: inv.subscriptionId != null },
        ...(contact?.email ? { email: contact.email } : {}),
      },
    };
  } catch (e) {
    await releaseCollection(org, inv.id);
    throw e;
  }
}

/**
 * A `timeout` row holding what the adapter kept. A handle that is not the charge (RazorPay's
 * order id) is looked up by reference and the real id adopted; otherwise the id is read as is.
 */
async function resolveStranded(
  txn: Txn,
  adapter: Adapter | null,
  now: Date,
  out: StalePendingResult,
  seen: boolean,
  deferLater: (t: Txn) => void,
): Promise<void> {
  if (
    adapter?.locateCharge &&
    !adapter.capabilities.locateByReplay &&
    txn.ownershipRef &&
    txn.idempotencyKey
  ) {
    let found: ChargeResult | null;
    try {
      found = await adapter.locateCharge(await locateInput(txn));
    } catch (e) {
      log.warn("lost-answer lookup failed", { txn: txn.publicId, error: String(e) });
      deferLater(txn);
      return;
    }
    if (found?.providerChargeId && found.providerChargeId !== txn.idAtGateway) {
      try {
        if (await adoptAndBook(txn, found, now)) out.lostAnswerFound++;
      } catch (e) {
        log.error(e as Error, {
          event: "lost_answer_book_failed",
          txn: txn.publicId,
          provider_charge_id: found.providerChargeId,
        });
        deferLater(txn);
      }
      return;
    }
    // The lookup is the authority on whether a charge exists, as for a row with no id; a
    // terminal read of the stranded id still wins over it.
    if (!found) {
      await resolveByStrandedId(txn, adapter, now, out, seen, deferLater, true);
      return;
    }
  }
  await resolveByStrandedId(txn, adapter, now, out, seen, deferLater);
}

/**
 * A `timeout` row with a stranded gateway id: ask the gateway by that id. Terminal → booked
 * through the shared verdict path. Non-terminal → wait; past {@link LOST_ANSWER_GIVE_UP_HOURS}
 * the row becomes `in_progress`, owned by the pending sweep and the webhook — or, when
 * `locateCharge` found no charge (`notLocated`), it fails as not created.
 */
async function resolveByStrandedId(
  txn: Txn,
  adapter: Adapter | null,
  now: Date,
  out: StalePendingResult,
  seen: boolean,
  deferLater: (t: Txn) => void,
  notLocated = false,
): Promise<void> {
  const pastWindow =
    txn.createdAt.getTime() <= now.getTime() - LOST_ANSWER_GIVE_UP_HOURS * 3_600_000;
  if (!adapter?.fetchChargeStatus && notLocated) {
    if (pastWindow && (await failNotCreated(txn, now))) out.lostAnswerNotCreated++;
    else if (!pastWindow) deferLater(txn);
    return;
  }
  if (!adapter?.fetchChargeStatus) {
    out.lostAnswerUnsupported++;
    if (!seen) {
      out.lostAnswerAlerted++;
      log.error(new Error("a charge whose answer was lost cannot be read at the gateway"), {
        event: "lost_answer_unresolvable",
        txn: txn.publicId,
        gateway: txn.gatewayKey,
        provider_charge_id: txn.idAtGateway,
        reason: !adapter ? "no_adapter" : "no_status_lookup",
        detail:
          "the invoice stays parked; check the gateway for this charge id and reconcile the " +
          "transaction by hand",
      });
    }
    deferLater(txn);
    return;
  }
  let verdict: ChargeResult;
  try {
    verdict = await adapter.fetchChargeStatus({ providerChargeId: txn.idAtGateway! });
  } catch (e) {
    log.warn("lost-answer status read failed", { txn: txn.publicId, error: String(e) });
    deferLater(txn);
    return;
  }
  const terminal = verdict.status === "succeeded" || verdict.status === "failed";
  if (!terminal && !pastWindow) {
    deferLater(txn);
    return;
  }
  if (!terminal && notLocated) {
    if (await failNotCreated(txn, now)) out.lostAnswerNotCreated++;
    return;
  }
  const done = await withTenant(txn.organizationId, async (tx) => {
    const cur = await lockLostAnswer(tx, txn);
    if (!cur) return false;
    await clearPollSchedule(tx, cur.id, ["lost_answer"]);
    if (await applyChargeVerdict(tx, cur, verdict, now)) return true;
    await setTransactionStatus(tx, cur.organizationId, cur.id, "in_progress");
    log.warn("a lost-answer charge is still pending at the gateway — handed to the pending sweep", {
      event: "lost_answer_still_pending",
      txn: cur.publicId,
      provider_charge_id: cur.idAtGateway,
      status: verdict.status,
      hours: LOST_ANSWER_GIVE_UP_HOURS,
    });
    return false;
  });
  if (done) out.lostAnswerFound++;
}

/** What `locateCharge` is asked with: what we sent, the instrument, and any id the row holds. */
async function locateInput(txn: Txn) {
  const [pm] = txn.paymentMethodId
    ? await systemDb
        .select({
          providerPaymentMethodId: paymentMethods.providerPaymentMethodId,
          providerCustomerId: paymentMethods.providerCustomerId,
          type: paymentMethods.type,
        })
        .from(paymentMethods)
        .where(eq(paymentMethods.id, txn.paymentMethodId))
        .limit(1)
    : [];
  return {
    ownershipRef: txn.ownershipRef!,
    idempotencyKey: txn.idempotencyKey!,
    amountMinor: txn.amountMinor,
    currency: txn.currency,
    createdAfter: new Date(txn.createdAt.getTime() - LOOKUP_SKEW_MS),
    ...(pm?.providerPaymentMethodId ? { paymentMethod: pm } : {}),
    ...(txn.idAtGateway ? { providerChargeId: txn.idAtGateway } : {}),
  };
}

/** How many open lost answers a webhook may ask the gateway about. */
const WEBHOOK_LOOKUP_CANDIDATES = 5;

/**
 * A `charge.*` event that matched no row and no ownership ref: ask `locateCharge` about this
 * business's open lost answers on the gateway, and adopt the one it names with the event's
 * charge id. For gateways whose charges cannot carry our ref (Cashfree subscription
 * payments). Exact: the gateway names the id. `raced` = the sweep adopted it first.
 */
export async function adoptLostAnswerByLookup(
  providerKey: string,
  chargeId: string,
  businessId: string | null | undefined,
  amountMinor: bigint | undefined,
): Promise<Txn | "raced" | null> {
  if (!businessId) return null;
  const rows = await systemDb
    .select()
    .from(transactions)
    .where(
      and(
        isLostAnswer,
        eq(transactions.gatewayKey, providerKey),
        eq(transactions.businessId, businessId),
        ...(amountMinor != null ? [eq(transactions.amountMinor, amountMinor)] : []),
      ),
    )
    .orderBy(desc(transactions.createdAt))
    .limit(WEBHOOK_LOOKUP_CANDIDATES);
  for (const txn of rows) {
    if (!txn.ownershipRef || !txn.idempotencyKey) continue;
    const adapter = await adapterForTransaction(txn).catch(() => null);
    // A replay-only lookup creates; a webhook never triggers one.
    if (!adapter?.locateCharge || adapter.capabilities.locateByReplay) continue;
    const found = await adapter.locateCharge(await locateInput(txn)).catch(() => null);
    if (found?.providerChargeId !== chargeId) continue;
    const adopted = await withTenant(txn.organizationId, async (tx) => {
      const cur = await lockLostAnswer(tx, txn);
      if (!cur || !(await adoptChargeId(tx, cur, chargeId))) return false;
      await clearPollSchedule(tx, cur.id, ["lost_answer"]);
      return true;
    });
    if (!adopted) return "raced";
    log.info("a lost-answer charge was matched through a gateway lookup", {
      event: "lost_answer_charge_matched",
      txn: txn.publicId,
      provider_charge_id: chargeId,
    });
    return { ...txn, idAtGateway: chargeId };
  }
  return null;
}

/** Lock the row and confirm it is still the unresolved `timeout` it was read as. */
async function lockLostAnswer(tx: Tx, txn: Txn) {
  const [cur] = await tx
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.id, txn.id),
        txn.idAtGateway
          ? and(isTimeout, eq(transactions.idAtGateway, txn.idAtGateway))
          : isLostAnswer,
      ),
    )
    .limit(1)
    .for("update");
  return cur ?? null;
}

/**
 * Write the gateway id onto the attempt and everything that carries it, then book the answer.
 * A webhook that got there first leaves the row non-matching, and this books nothing.
 */
async function adoptAndBook(txn: Txn, found: ChargeResult, now: Date): Promise<boolean> {
  const chargeId = found.providerChargeId;
  return withTenant(txn.organizationId, async (tx) => {
    const cur = await lockLostAnswer(tx, txn);
    if (!cur) return false;
    await adoptChargeId(tx, cur, chargeId);
    await clearPollSchedule(tx, cur.id, ["lost_answer"]);
    const adopted = { ...cur, idAtGateway: chargeId };
    log.info("a lost-answer charge was found at the gateway", {
      event: "lost_answer_charge_found",
      txn: cur.publicId,
      provider_charge_id: chargeId,
      status: found.status,
    });
    if (await applyChargeVerdict(tx, adopted, found, now)) return true;
    // Still in flight: hand it to the ordinary pending sweep and the webhook, which use the id.
    await setTransactionStatus(tx, cur.organizationId, cur.id, "in_progress");
    return true;
  });
}

/** The gateway has no such charge a full window later: fail it, and dunning goes on. */
async function failNotCreated(txn: Txn, now: Date): Promise<boolean> {
  const errorText = "The gateway did not create this charge. No money moved.";
  return withTenant(txn.organizationId, async (tx) => {
    const cur = await lockLostAnswer(tx, txn);
    if (!cur) return false;
    await setTransactionStatus(tx, cur.organizationId, cur.id, "failed", {
      errorCode: LOST_ANSWER_NOT_CREATED_CODE,
      errorText,
      retriable: true,
    });
    await clearPollSchedule(tx, cur.id, ["lost_answer"]);
    await settleTransactionOutcome(tx, {
      organizationId: cur.organizationId,
      businessId: cur.businessId,
      outcome: "failed",
      occurredAt: now,
      txn: { ...cur, errorCode: LOST_ANSWER_NOT_CREATED_CODE, errorText },
      retriable: true,
    });
    log.warn("a lost-answer charge was never created at the gateway — failed, dunning resumes", {
      event: "lost_answer_not_created",
      txn: cur.publicId,
      hours: LOST_ANSWER_GIVE_UP_HOURS,
    });
    return true;
  });
}

/**
 * Stamp a gateway id on a lost-answer attempt, its payment and its payment request. Replaces
 * an empty id, or the stranded handle the attempt was booked with (`txn.idAtGateway`).
 */
export async function adoptChargeId(
  tx: Tx,
  txn: Pick<Txn, "id" | "paymentId" | "paymentRequestId" | "idAtGateway">,
  chargeId: string,
): Promise<boolean> {
  const handle = txn.idAtGateway || null;
  const unset = (col: AnyPgColumn) =>
    or(isNull(col), eq(col, ""), ...(handle ? [eq(col, handle)] : []));
  const stamped = await tx
    .update(transactions)
    .set({ idAtGateway: chargeId })
    .where(and(eq(transactions.id, txn.id), unset(transactions.idAtGateway)))
    .returning({ id: transactions.id });
  if (stamped.length === 0) return false;
  if (txn.paymentId)
    await tx
      .update(payments)
      .set({ providerChargeId: chargeId })
      .where(and(eq(payments.id, txn.paymentId), unset(payments.providerChargeId)));
  if (txn.paymentRequestId)
    await tx
      .update(paymentRequests)
      .set({ providerChargeId: chargeId })
      .where(
        and(eq(paymentRequests.id, txn.paymentRequestId), unset(paymentRequests.providerChargeId)),
      );
  return true;
}
