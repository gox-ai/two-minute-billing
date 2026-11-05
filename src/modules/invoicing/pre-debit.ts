import { and, desc, eq, gte, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { businessWallClock } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { resolveAdapter } from "@/providers/registry";
import {
  PRE_DEBIT_NOT_DUE_CODE,
  preDebitRule,
  type ChargeResult,
  type NormalizedProviderEvent,
  type PaymentProvider,
  type ProviderPaymentMethodRef,
} from "@/providers/types";
import { gatewayAccounts, invoices, payments, paymentMethods, preDebitNotices } from "@db/schema";

const log = createLogger("invoicing.pre-debit");

type Pm = typeof paymentMethods.$inferSelect;
type GwAccount = typeof gatewayAccounts.$inferSelect;
type Notice = typeof preDebitNotices.$inferSelect;
/** The stored row, plus how the gateway's refusal reads (not stored). */
type SentNotice = Notice & { failureRetriable?: boolean; failureFinal?: boolean };

/** A notice the gateway refused (mandate revoked, bad reference). Booked like a decline. */
export const PRE_DEBIT_NOTICE_FAILED_CODE = "pre_debit_notice_failed";

/** Added to the gateway's minimum lead, so a late clock tick never debits early. */
const LEAD_MARGIN_MS = 10 * 60_000;
/** How long to wait on a notice the gateway has not answered before asking again. */
const PENDING_RECHECK_MS = 60 * 60_000;
/** A notice still unanswered after this is treated as lost and replaced. */
const PENDING_GIVE_UP_MS = 6 * 60 * 60_000;
/**
 * Notice refusals about OUR timing, not the payer's mandate: the debit waits this long and
 * asks again, with no attempt booked. `pre_debit_cycle_open`: the gateway still holds
 * another notice for the mandate (PayU UPI). `pre_debit_not_due`: sent in the wrong period.
 */
const NOTICE_WAIT_MS: Record<string, number> = {
  pre_debit_cycle_open: 6 * 60 * 60_000,
  [PRE_DEBIT_NOT_DUE_CODE]: 24 * 60 * 60_000,
};
/** Refusals of that kind in a row before the debit parks for an operator. */
const MAX_NOTICE_WAIT_REFUSALS = 8;
/**
 * A retry under a used notice must start this long before the notice ends, as the first
 * debit must (`payuDebitSchedule` keeps an hour of the debit day), so a late tick cannot
 * reach the gateway after it.
 */
const RETRY_END_MARGIN_MS = 60 * 60_000;
/** `pg_advisory_xact_lock` namespace: one notice claim at a time per payment method. */
const CLAIM_LOCK_NS = 7405;

/** What a notice announces. A notice covers debits of its own purpose only. */
export type PreDebitPurpose = "invoice" | "wallet_topup" | "credit_topup";

/** Key suffix per purpose: a notice of one purpose never replays another's. */
const KEY_SUFFIX: Record<PreDebitPurpose, string> = {
  invoice: "collect",
  wallet_topup: "topup",
  credit_topup: "credit_topup",
};

export type PreDebitGate =
  | { kind: "not_required" }
  | {
      kind: "ready";
      notice: { notificationRef: string; amountMinor: bigint; debitNumber: number };
    }
  | { kind: "wait"; until: Date; notice: string }
  | { kind: "refused"; result: ChargeResult };

/** Whether this instrument's debits need a notice sent through its gateway. */
export function needsGatewayNotice(
  adapter: Pick<PaymentProvider, "capabilities">,
  pm: Pm,
): boolean {
  const cap = adapter.capabilities.preDebitNotice;
  return Boolean(cap && (cap.methods as string[]).includes(pm.type));
}

/**
 * Send a pre-debit notice through the gateway and store the answer. Idempotent on
 * `idempotencyKey` per business: a second call returns the stored row without calling out.
 * Timing is ours: `executable_after` is the later of the gateway's statement and
 * `minLeadHours` after sending, by business time, so time travel moves it too.
 */
export async function sendGatewayNotice(input: {
  organizationId: string;
  businessId: string;
  adapter: PaymentProvider;
  account: GwAccount | null;
  pm: Pm;
  amountMinor: bigint;
  currency: string;
  debitAt: Date;
  idempotencyKey: string;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  purpose?: PreDebitPurpose;
  contact?: { email: string | null; phone: string | null } | null;
}): Promise<SentNotice> {
  const cap = input.adapter.capabilities.preDebitNotice;
  if (!cap || !input.adapter.notifyUpcomingDebit)
    throw new Error(`${input.adapter.key} declares no pre-debit notice support`);
  const now = await businessWallClock(input.businessId);

  const existing = await withTenant(input.organizationId, async (tx) => {
    const [inserted] = await tx
      .insert(preDebitNotices)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        publicId: publicId("pdn"),
        paymentMethodId: input.pm.id,
        gatewayAccountId: input.account?.id ?? null,
        subscriptionId: input.subscriptionId ?? null,
        invoiceId: input.invoiceId ?? null,
        purpose: input.purpose ?? "invoice",
        amountMinor: input.amountMinor,
        currency: input.currency,
        debitAt: input.debitAt,
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [preDebitNotices.businessId, preDebitNotices.idempotencyKey] })
      .returning();
    if (inserted) return { row: inserted, fresh: true };
    const [row] = await tx
      .select()
      .from(preDebitNotices)
      .where(
        and(
          eq(preDebitNotices.businessId, input.businessId),
          eq(preDebitNotices.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    return { row: row!, fresh: false };
  });
  if (!existing.fresh) return existing.row;

  const pmRef: ProviderPaymentMethodRef = {
    providerKey: input.adapter.key,
    providerPaymentMethodId: input.pm.providerPaymentMethodId,
    display: {
      type: input.pm.type as ProviderPaymentMethodRef["display"]["type"],
      last4: input.pm.last4 ?? undefined,
    },
  };
  const purpose = input.purpose ?? "invoice";
  const description =
    purpose === "wallet_topup"
      ? "Wallet top-up"
      : purpose === "credit_topup"
        ? "Credit top-up"
        : await invoiceLabel(input.organizationId, input.invoiceId);
  const earliest = new Date(
    now.getTime() + preDebitRule(cap, input.pm.type).minLeadHours * 3_600_000,
  );
  let answer: Awaited<ReturnType<NonNullable<PaymentProvider["notifyUpcomingDebit"]>>>;
  try {
    answer = await input.adapter.notifyUpcomingDebit({
      customer: { providerKey: input.adapter.key, providerCustomerId: input.pm.providerCustomerId },
      paymentMethod: pmRef,
      mandateReference: input.pm.mandateReference,
      amountMinor: input.amountMinor,
      currency: input.currency,
      // Never before our own lead: an adapter on the real clock would otherwise name a debit
      // day that ends before a time-travelled notice is due.
      debitAt: input.debitAt > earliest ? input.debitAt : earliest,
      idempotencyKey: input.idempotencyKey,
      ownershipRef: existing.row.publicId,
      ...(description ? { description } : {}),
      ...(input.contact?.email ? { email: input.contact.email } : {}),
      ...(input.contact?.phone ? { phone: input.contact.phone } : {}),
    });
  } catch (e) {
    // Unknown whether the gateway took it: the row stays `pending` and the gate asks again
    // after PENDING_RECHECK_MS, replacing it after PENDING_GIVE_UP_MS.
    log.error(e, {
      event: "pre_debit_notice_unreachable",
      notice: existing.row.publicId,
      gatewayKey: input.adapter.key,
    });
    return existing.row;
  }

  const executableAfter =
    answer.executableAfter && answer.executableAfter > earliest ? answer.executableAfter : earliest;
  const expiresAt =
    answer.expiresAt ??
    (cap.validForHours != null ? new Date(now.getTime() + cap.validForHours * 3_600_000) : null);
  const [row] = await withTenant(input.organizationId, (tx) =>
    tx
      .update(preDebitNotices)
      .set({
        status: answer.status,
        notificationRef: answer.notificationRef,
        executableAfter: answer.status === "failed" ? null : executableAfter,
        expiresAt: answer.status === "failed" ? null : expiresAt,
        failureCode: answer.failure?.code ?? null,
        failureMessage: answer.failure?.message ?? null,
        updatedAt: now,
      })
      .where(eq(preDebitNotices.id, existing.row.id))
      .returning(),
  );
  log.info("pre-debit notice sent through the gateway", {
    event: "pre_debit_notice_sent",
    notice: row!.publicId,
    gatewayKey: input.adapter.key,
    status: answer.status,
  });
  return answer.failure
    ? { ...row!, failureRetriable: answer.failure.retriable, failureFinal: answer.failure.final }
    : row!;
}

async function invoiceLabel(organizationId: string, invoiceId?: string | null) {
  if (!invoiceId) return undefined;
  const [inv] = await withTenant(organizationId, (tx) =>
    tx
      .select({ number: invoices.number })
      .from(invoices)
      .where(eq(invoices.id, invoiceId))
      .limit(1),
  );
  return inv?.number ? `Invoice ${inv.number}` : undefined;
}

/**
 * May this debit go now? On a `preDebitNotice` rail a debit needs a sent notice, inside its
 * window, not used up, and (when `exactAmount`) for exactly this amount. Without one, a new
 * notice is sent and the debit waits out the lead time.
 *
 * `wait` is not a failure: the caller defers collection without booking an attempt, so the
 * payer gets no failure email and dunning keeps its slots.
 */
export async function preDebitGate(input: {
  organizationId: string;
  businessId: string;
  adapter: PaymentProvider;
  account: GwAccount | null;
  pm: Pm;
  amountMinor: bigint;
  currency: string;
  contact: { email: string | null; phone: string | null } | null;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  purpose: PreDebitPurpose;
}): Promise<PreDebitGate> {
  const cap = input.adapter.capabilities.preDebitNotice;
  if (!cap || !needsGatewayNotice(input.adapter, input.pm)) return { kind: "not_required" };
  const rule = preDebitRule(cap, input.pm.type);
  const now = await businessWallClock(input.businessId);

  // The last notice was refused as final (perhaps the reminders pass's): no new notice until
  // the mandate's own state says it can take one. An instrument already invalid stays quiet
  // (reviving it — a resumed mandate — makes it valid again and lifts this).
  {
    const [last] = await withTenant(input.organizationId, (tx) =>
      tx
        .select()
        .from(preDebitNotices)
        .where(eq(preDebitNotices.paymentMethodId, input.pm.id))
        .orderBy(desc(preDebitNotices.createdAt))
        .limit(1),
    );
    if (last?.status === "failed" && last.failureCode && FINAL_NOTICE_CODES.has(last.failureCode)) {
      if (input.pm.status === "invalid")
        return {
          kind: "refused",
          result: input.pm.mandateStatus === "paused" ? pausedMandate(last) : deadMandate(last),
        };
      const verdict = await mandateVerdict(input.adapter, input.pm);
      if (verdict === "dead") return { kind: "refused", result: deadMandate(last) };
      if (verdict === "paused") return { kind: "refused", result: pausedMandate(last) };
    }
  }

  // One notice open per mandate at the gateway (PayU UPI): every purpose shares the cycle.
  const oneOpen = Boolean(cap.oneOpenPerMandate?.includes(input.pm.type as never));
  const open = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(preDebitNotices)
      .where(
        and(
          eq(preDebitNotices.paymentMethodId, input.pm.id),
          oneOpen ? undefined : eq(preDebitNotices.purpose, input.purpose),
          inArray(preDebitNotices.status, ["pending", "sent"]),
        ),
      )
      .orderBy(desc(preDebitNotices.createdAt))
      .limit(10),
  );

  // A notice covers retries, not a second debit: once a debit under it succeeded (or is still
  // settling), it is done. Matched by method, amount, time and `paidUnder` (purpose, invoice).
  // A settling debit retires the notice for every purpose's gate, for good: if it then fails,
  // its retries need a new notice. Conservative; the cost is one more lead time.
  // `payments.created_at` is `app_now()`: business time under a clock pin (travel passes,
  // pinned API requests), like `created_at` here. A payment written with no pin on a
  // time-travelled business (a background job) carries real time and is missed; the debit
  // cap and the notice's end still bound it.
  const used = open.filter((n) => n.debitsUsed > 0);
  const taken = used.length
    ? await withTenant(input.organizationId, (tx) =>
        tx
          .select({
            amountMinor: payments.amountMinor,
            createdAt: payments.createdAt,
            invoiceId: payments.invoiceId,
            purpose: sql<string | null>`${payments.metadata}->>${PAYMENT_PURPOSE_KEY}::text`,
          })
          .from(payments)
          .where(
            and(
              eq(payments.paymentMethodId, input.pm.id),
              inArray(payments.status, ["succeeded", "pending"]),
              gte(
                payments.createdAt,
                new Date(Math.min(...used.map((n) => n.createdAt.getTime()))),
              ),
            ),
          ),
      )
    : [];
  const debited = (n: Notice) =>
    n.debitsUsed > 0 &&
    taken.some(
      (p) => p.amountMinor === n.amountMinor && p.createdAt >= n.createdAt && paidUnder(p, n),
    );
  // An invoice notice belongs to the invoice it was sent for, or to the first one debited
  // under it (the claim binds it). Another invoice never debits under it.
  const bindTo = input.purpose === "invoice" ? (input.invoiceId ?? null) : null;
  const boundElsewhere = (n: Notice) =>
    bindTo !== null && n.purpose === "invoice" && n.invoiceId !== null && n.invoiceId !== bindTo;
  const ended = (n: Notice) =>
    n.expiresAt !== null &&
    n.expiresAt.getTime() - (n.debitsUsed > 0 ? RETRY_END_MARGIN_MS : 0) <= now.getTime();

  const kept = oneOpen ? new Set<string>() : await otherInvoicesNotices(input, open);
  const retire: Array<{ id: string; status: "exhausted" | "superseded" }> = [];
  const withdraw: Notice[] = [];
  let usable: Notice | null = null;
  let waitOn: Notice | null = null;
  let blockedBy: Notice | null = null;
  for (const n of open) {
    const otherDebit = oneOpen && forAnotherDebit(n, input);
    const covers =
      !otherDebit &&
      !boundElsewhere(n) &&
      n.currency === input.currency &&
      (!cap.exactAmount || n.amountMinor === input.amountMinor);
    if (n.debitsUsed >= rule.maxDebitsPerNotice || debited(n) || ended(n)) {
      retire.push({ id: n.id, status: "exhausted" });
      if (n.status === "sent" && n.debitsUsed === 0) withdraw.push(n);
      continue;
    }
    if (n.status === "pending" && now.getTime() - n.createdAt.getTime() > PENDING_GIVE_UP_MS) {
      retire.push({ id: n.id, status: "superseded" });
      continue;
    }
    if (kept.has(n.id)) continue;
    if (otherDebit) {
      blockedBy ??= n;
      continue;
    }
    if (!covers) continue;
    if (n.status === "sent" && n.executableAfter && n.executableAfter <= now) {
      usable ??= n;
    } else {
      waitOn ??= n;
    }
  }
  if (retire.length)
    await withTenant(input.organizationId, async (tx) => {
      for (const r of retire)
        await tx
          .update(preDebitNotices)
          .set({ status: r.status, updatedAt: now })
          .where(eq(preDebitNotices.id, r.id));
    });

  // The gateway's own view, before the debit is counted: the notice may still be in
  // delivery, may have failed after acceptance, or may not be due yet.
  if (usable && input.adapter.checkPreDebitNotice) {
    const n = usable;
    let seen: Awaited<ReturnType<NonNullable<PaymentProvider["checkPreDebitNotice"]>>> | null =
      null;
    try {
      seen = await input.adapter.checkPreDebitNotice({
        paymentMethod: {
          providerKey: input.adapter.key,
          providerPaymentMethodId: input.pm.providerPaymentMethodId,
          display: { type: input.pm.type as ProviderPaymentMethodRef["display"]["type"] },
        },
        notificationRef: n.notificationRef!,
        now,
      });
    } catch (e) {
      log.warn("could not read a pre-debit notice at the gateway; debiting on our record", {
        event: "pre_debit_notice_check_failed",
        notice: n.publicId,
        error: (e as Error)?.message,
      });
    }
    if (seen?.status === "failed") {
      usable = null;
      const { failureCode, failureMessage } = seen;
      await withTenant(input.organizationId, (tx) =>
        tx
          .update(preDebitNotices)
          .set({
            status: "failed",
            executableAfter: null,
            failureCode: failureCode ?? "notice_failed",
            failureMessage: failureMessage ?? null,
            updatedAt: now,
          })
          .where(and(eq(preDebitNotices.id, n.id), eq(preDebitNotices.debitsUsed, 0))),
      );
    } else if (
      seen &&
      (seen.status === "pending" || (seen.executableAfter && seen.executableAfter > now))
    ) {
      usable = null;
      const at =
        seen.status === "pending"
          ? new Date(now.getTime() + PENDING_RECHECK_MS)
          : seen.executableAfter!;
      await withTenant(input.organizationId, (tx) =>
        tx
          .update(preDebitNotices)
          .set({ executableAfter: at, updatedAt: now })
          .where(eq(preDebitNotices.id, n.id)),
      );
      waitOn = { ...n, executableAfter: at };
    }
  }

  if (usable) {
    // Counted BEFORE the debit: the gateway caps debits per notice, so an attempt that
    // reached it counts even if its answer is lost.
    const [claimed] = await withTenant(input.organizationId, async (tx) => {
      // Two debits can read the same notice as free; their claims run one at a time.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.pm.id}::text, ${CLAIM_LOCK_NS}))`,
      );
      return tx
        .update(preDebitNotices)
        .set({
          debitsUsed: sql`${preDebitNotices.debitsUsed} + 1`,
          status: sql`case when ${preDebitNotices.debitsUsed} + 1 >= ${rule.maxDebitsPerNotice} then 'exhausted' else ${preDebitNotices.status} end`,
          ...(bindTo
            ? { invoiceId: sql`coalesce(${preDebitNotices.invoiceId}, ${bindTo}::uuid)` }
            : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(preDebitNotices.id, usable!.id),
            sql`${preDebitNotices.debitsUsed} < ${rule.maxDebitsPerNotice}`,
            bindTo
              ? or(isNull(preDebitNotices.invoiceId), eq(preDebitNotices.invoiceId, bindTo))
              : undefined,
            // A retry, never a second debit: every debit claimed under it so far is booked
            // failed. One claimed and not yet booked is still in flight.
            sql`(pre_debit_notices.debits_used = 0 or pre_debit_notices.debits_used <= (
              select count(*) from payments p
              where p.payment_method_id = pre_debit_notices.payment_method_id
                and p.status = 'failed'
                and p.amount_minor = pre_debit_notices.amount_minor
                and p.created_at >= pre_debit_notices.created_at
                and case
                  when p.metadata->>${PAYMENT_PURPOSE_KEY}::text is not null then
                    p.metadata->>${PAYMENT_PURPOSE_KEY}::text = pre_debit_notices.purpose
                    and (pre_debit_notices.purpose <> 'invoice'
                      or p.invoice_id is not distinct from coalesce(pre_debit_notices.invoice_id, ${bindTo}::uuid))
                  else p.invoice_id is not distinct from coalesce(pre_debit_notices.invoice_id, ${bindTo}::uuid)
                end))`,
          ),
        )
        .returning();
    });
    if (claimed)
      return {
        kind: "ready",
        notice: {
          notificationRef: claimed.notificationRef!,
          amountMinor: claimed.amountMinor,
          debitNumber: claimed.debitsUsed,
        },
      };
    // Another debit took it first (now its notice, or its debit is in flight). Never fall
    // through to replacing notices: that would withdraw the one its debit runs under.
    return {
      kind: "wait",
      until: new Date(now.getTime() + PENDING_RECHECK_MS),
      notice: usable.publicId,
    };
  }
  if (waitOn) {
    const until =
      waitOn.status === "sent" && waitOn.executableAfter
        ? new Date(waitOn.executableAfter.getTime() + LEAD_MARGIN_MS)
        : new Date(now.getTime() + PENDING_RECHECK_MS);
    return { kind: "wait", until, notice: waitOn.publicId };
  }
  // Another debit's notice holds the mandate's one open cycle: this debit waits for it to be
  // debited, or to expire and be withdrawn.
  if (blockedBy) {
    const after = (blockedBy.executableAfter?.getTime() ?? now.getTime()) + LEAD_MARGIN_MS;
    return {
      kind: "wait",
      until: new Date(Math.max(after, now.getTime() + PENDING_RECHECK_MS)),
      notice: blockedBy.publicId,
    };
  }

  // Nothing covers this debit: notices that can no longer be used for it are replaced.
  const retired = new Set(retire.map((r) => r.id));
  for (const n of open)
    if (!retired.has(n.id) && n.status === "sent" && n.debitsUsed === 0) withdraw.push(n);
  await withTenant(input.organizationId, (tx) =>
    tx
      .update(preDebitNotices)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(preDebitNotices.paymentMethodId, input.pm.id),
          eq(preDebitNotices.purpose, input.purpose),
          inArray(preDebitNotices.status, ["pending", "sent"]),
          // Another invoice's notice stays its own (open only where the gateway allows many).
          bindTo
            ? or(isNull(preDebitNotices.invoiceId), eq(preDebitNotices.invoiceId, bindTo))
            : undefined,
          kept.size ? notInArray(preDebitNotices.id, [...kept]) : undefined,
        ),
      ),
  );
  if (oneOpen) await withdrawNotices(input, withdraw);
  const debitAt = new Date(now.getTime() + rule.minLeadHours * 3_600_000 + LEAD_MARGIN_MS);
  const key = `pdn:${input.pm.publicId}:${input.amountMinor}:${input.currency}:${KEY_SUFFIX[input.purpose]}:${now.getTime()}`;
  let sent = await sendGatewayNotice({ ...input, debitAt, idempotencyKey: key });
  // The gateway still holds an earlier notice (a withdrawal that failed before): withdraw
  // every unused one we know of, then ask once more.
  if (oneOpen && sent.status === "failed" && sent.failureCode === "pre_debit_cycle_open") {
    const stale = await withTenant(input.organizationId, (tx) =>
      tx
        .select()
        .from(preDebitNotices)
        .where(
          and(
            eq(preDebitNotices.paymentMethodId, input.pm.id),
            inArray(preDebitNotices.status, ["superseded", "exhausted"]),
            eq(preDebitNotices.debitsUsed, 0),
            isNotNull(preDebitNotices.notificationRef),
          ),
        )
        .orderBy(desc(preDebitNotices.createdAt))
        .limit(5),
    );
    if ((await withdrawNotices(input, stale)) > 0)
      sent = await sendGatewayNotice({ ...input, debitAt, idempotencyKey: `${key}:again` });
  }
  // A refusal about timing or an open cycle: wait, book nothing. Repeated, it parks.
  const waitMs = sent.status === "failed" ? NOTICE_WAIT_MS[sent.failureCode ?? ""] : undefined;
  if (waitMs) {
    const recent = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ status: preDebitNotices.status, failureCode: preDebitNotices.failureCode })
        .from(preDebitNotices)
        .where(eq(preDebitNotices.paymentMethodId, input.pm.id))
        .orderBy(desc(preDebitNotices.createdAt))
        .limit(MAX_NOTICE_WAIT_REFUSALS + 1),
    );
    let streak = 0;
    for (const r of recent) {
      if (r.status !== "failed" || !NOTICE_WAIT_MS[r.failureCode ?? ""]) break;
      streak++;
    }
    if (streak < MAX_NOTICE_WAIT_REFUSALS)
      return { kind: "wait", until: new Date(now.getTime() + waitMs), notice: sent.publicId };
    log.warn("the gateway keeps refusing the advance notice for timing; the debit parks", {
      event: "pre_debit_notice_wait_exhausted",
      notice: sent.publicId,
      code: sent.failureCode,
    });
    return { kind: "refused", result: ourRefusal(sent) };
  }
  // Our request was wrong (PayU E9260, a bad sequence number): parks for an operator.
  if (sent.status === "failed" && sent.failureCode === "gateway_request_rejected")
    return { kind: "refused", result: ourRefusal(sent) };
  // A final refusal (the mandate is revoked or inactive) keeps the gateway's class, so the
  // instrument leaves collection like any dead-mandate decline.
  // "Final" is the adapter's reading of the words; the mandate's own state decides. PayU says
  // the same thing for a paused mandate, a revoked one, and an account without SI enabled.
  if (sent.status === "failed" && sent.failureRetriable === false) {
    const verdict = await mandateVerdict(input.adapter, input.pm);
    if (verdict === "dead") return { kind: "refused", result: deadMandate(sent) };
    if (verdict === "paused") return { kind: "refused", result: pausedMandate(sent) };
    // The bank's own word (PayU `status: "QC"`): the gateway's status read lags behind it.
    if (sent.failureFinal) {
      const { applyMandateStatus } = await import("@/modules/webhooks/inbound");
      await applyMandateStatus(input.pm, { status: "cancelled" });
      return { kind: "refused", result: deadMandate(sent) };
    }
  }
  if (sent.status === "failed")
    return {
      kind: "refused",
      result: {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: PRE_DEBIT_NOTICE_FAILED_CODE,
          providerCode: sent.failureCode ?? undefined,
          // Buyer-facing: rides the payment_failed email like the mandate refusals.
          message:
            "We could not send the advance notice of this payment to your bank" +
            (sent.failureMessage ? ` (${sent.failureMessage})` : "") +
            ", so we did not charge this payment method." +
            (input.purpose === "invoice" ? " We will try again." : ""),
          retriable: true,
        },
        raw: { pre_debit_notice: sent.publicId },
      },
    };
  const until =
    sent.status === "sent" && sent.executableAfter
      ? new Date(sent.executableAfter.getTime() + LEAD_MARGIN_MS)
      : new Date(now.getTime() + PENDING_RECHECK_MS);
  return { kind: "wait", until, notice: sent.publicId };
}

/**
 * Open notices this debit must neither use nor replace: an interim usage invoice has its own
 * notice. Its debit leaves every other notice alone, and another invoice's debit leaves the
 * interim's alone. Two invoices that replace each other's notice would never mature.
 */
async function otherInvoicesNotices(
  input: { organizationId: string; purpose: PreDebitPurpose; invoiceId?: string | null },
  open: Notice[],
): Promise<Set<string>> {
  if (input.purpose !== "invoice" || !input.invoiceId) return new Set();
  const others = open.filter((n) => n.invoiceId !== input.invoiceId);
  if (!others.length) return new Set();
  const ids = [input.invoiceId, ...others.flatMap((n) => (n.invoiceId ? [n.invoiceId] : []))];
  const interim = new Set(
    (
      await withTenant(input.organizationId, (tx) =>
        tx
          .select({ id: invoices.id })
          .from(invoices)
          .where(and(inArray(invoices.id, ids), eq(invoices.purpose, "usage_interim"))),
      )
    ).map((r) => r.id),
  );
  if (interim.has(input.invoiceId)) return new Set(others.map((n) => n.id));
  return new Set(others.filter((n) => n.invoiceId && interim.has(n.invoiceId)).map((n) => n.id));
}

/**
 * `payments.metadata` key naming the notice purpose a top-up debit ran under. A credit top-up
 * payment carries its auto top-up invoice and a wallet one none, so only this tells them apart.
 */
export const PAYMENT_PURPOSE_KEY = "purpose";

/**
 * Could this payment be a debit under notice `n`? A payment naming its purpose must match the
 * notice's (and, for an invoice notice, its invoice). One without (written before the key):
 * by invoice, a no-invoice notice taking a no-invoice payment.
 */
function paidUnder(
  p: { invoiceId: string | null; purpose: string | null },
  n: Pick<Notice, "purpose" | "invoiceId">,
): boolean {
  if (p.purpose && p.purpose !== n.purpose) return false;
  if (p.purpose && n.purpose !== "invoice") return true;
  return (
    p.invoiceId === n.invoiceId ||
    // Used before a claim bound its notice to the invoice: any invoice's debit retires it.
    (n.purpose === "invoice" && n.invoiceId === null && p.invoiceId !== null)
  );
}

/** Is this open notice for a different debit than the one at the gate? */
function forAnotherDebit(
  n: Notice,
  input: { purpose: PreDebitPurpose; invoiceId?: string | null; subscriptionId?: string | null },
): boolean {
  if (n.purpose !== input.purpose) return true;
  if (n.invoiceId && input.invoiceId) return n.invoiceId !== input.invoiceId;
  if (n.subscriptionId && input.subscriptionId) return n.subscriptionId !== input.subscriptionId;
  return false;
}

/**
 * Withdraw unused notices at the gateway (`withdrawPreDebitNotice`). Each call is in the
 * gateway request log; a failure is logged and the next send shows whether it mattered.
 */
async function withdrawNotices(
  input: { adapter: PaymentProvider; pm: Pm },
  notices: Notice[],
): Promise<number> {
  if (!input.adapter.withdrawPreDebitNotice) return 0;
  let done = 0;
  for (const n of notices) {
    if (!n.notificationRef) continue;
    const r = await input.adapter
      .withdrawPreDebitNotice({
        paymentMethod: {
          providerKey: input.adapter.key,
          providerPaymentMethodId: input.pm.providerPaymentMethodId,
          display: { type: input.pm.type as ProviderPaymentMethodRef["display"]["type"] },
        },
        mandateReference: input.pm.mandateReference,
        notificationRef: n.notificationRef,
        amountMinor: n.amountMinor,
        debitAt: n.executableAfter ?? n.debitAt,
      })
      .catch(() => "failed" as const);
    if (r === "withdrawn") done++;
    if (r === "failed")
      log.warn("could not withdraw an unused pre-debit notice at the gateway", {
        event: "pre_debit_notice_withdraw_failed",
        notice: n.publicId,
        gatewayKey: input.adapter.key,
      });
  }
  return done;
}

/** A notice refused for a reason on our side: parks the debit for an operator. */
function ourRefusal(n: SentNotice): ChargeResult {
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: "gateway_request_rejected",
      providerCode: n.failureCode ?? undefined,
      message:
        "We could not send the advance notice of this payment to your bank, so we did not charge this payment method.",
      retriable: false,
    },
    raw: { pre_debit_notice: n.publicId },
  };
}

/** Notice refusals that say the mandate itself is gone (the adapters' normalized codes). */
const FINAL_NOTICE_CODES = new Set(["mandate_expired", "payment_method_not_found"]);

/**
 * The mandate's state at the gateway, applied to the instrument the way a mandate webhook is
 * (`applyMandateStatus`: cancelled → invalid; paused → invalid until the paused-mandate sweep
 * revives it; confirmed → valid). `unknown` when it cannot be read: never a reason to kill it.
 */
async function mandateVerdict(
  adapter: PaymentProvider,
  pm: Pm,
): Promise<"dead" | "paused" | "alive" | "unknown"> {
  if (!adapter.fetchMandate) return "unknown";
  let m: Awaited<ReturnType<NonNullable<PaymentProvider["fetchMandate"]>>> = null;
  try {
    m = await adapter.fetchMandate({
      providerCustomerId: pm.providerCustomerId,
      token: pm.providerPaymentMethodId,
    });
  } catch (e) {
    log.warn("could not read a mandate after a refused notice", {
      event: "pre_debit_mandate_unread",
      paymentMethod: pm.publicId,
      error: (e as Error)?.message,
    });
    return "unknown";
  }
  if (!m?.status) return "unknown";
  const status = m.status.toLowerCase();
  if (status === "confirmed" || status === "active") return "alive";
  if (
    status === "paused" ||
    status === "cancelled" ||
    status === "rejected" ||
    status === "expired"
  ) {
    const { applyMandateStatus } = await import("@/modules/webhooks/inbound");
    await applyMandateStatus(pm, { ...m, status: m.status });
    return status === "paused" ? "paused" : "dead";
  }
  return "unknown";
}

/** A paused mandate: no debit now, and retried once the paused-mandate sweep revives it. */
function pausedMandate(n: Notice): ChargeResult {
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: "mandate_paused",
      message:
        "The authorization for automatic payments is paused, so we did not charge this payment method. " +
        "We will try again when it is active.",
      retriable: true,
    },
    raw: { pre_debit_notice: n.publicId },
  };
}

/** A final notice refusal, as a non-retriable decline in the gateway's class. */
function deadMandate(n: Notice): ChargeResult {
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: n.failureCode ?? "mandate_expired",
      message:
        "Your bank says that the authorization for automatic payments is no longer active" +
        (n.failureMessage ? ` (${n.failureMessage})` : "") +
        ", so we did not charge this payment method. Set up the payment method again.",
      retriable: false,
    },
    raw: { pre_debit_notice: n.publicId },
  };
}

/**
 * `pre_debit_notice.updated`: the gateway's late answer to a notice we sent `pending`.
 * Matched on the delivering gateway account and the gateway's ref (the business and the
 * gateway key when the account is not known, as on a replay). Idempotent: only a pending
 * notice becomes sent, and only an unused one becomes failed.
 */
export async function applyGatewayNoticeUpdate(input: {
  providerKey: string;
  businessId: string | null;
  gatewayAccountId: string | null;
  update: NonNullable<NormalizedProviderEvent["preDebitNotice"]>;
}): Promise<"processed" | "ignored"> {
  const { update } = input;
  // A ref alone is not enough to pick a tenant: without the delivering account or its
  // business, a ref shared by two tenants' gateways could update the wrong notice.
  if (!input.gatewayAccountId && !input.businessId) {
    log.warn("pre-debit notice update with no account or business — ignored", {
      event: "pre_debit_notice_update_unscoped",
      gatewayKey: input.providerKey,
      notificationRef: update.notificationRef,
    });
    return "ignored";
  }
  const rows = await systemDb
    .select({ notice: preDebitNotices, account: gatewayAccounts, rail: paymentMethods.type })
    .from(preDebitNotices)
    .leftJoin(gatewayAccounts, eq(gatewayAccounts.id, preDebitNotices.gatewayAccountId))
    .leftJoin(paymentMethods, eq(paymentMethods.id, preDebitNotices.paymentMethodId))
    .where(
      and(
        eq(preDebitNotices.notificationRef, update.notificationRef),
        input.gatewayAccountId
          ? eq(preDebitNotices.gatewayAccountId, input.gatewayAccountId)
          : eq(preDebitNotices.businessId, input.businessId!),
      ),
    )
    .orderBy(desc(preDebitNotices.createdAt))
    .limit(5);
  const match = rows.find((r) => !r.account || r.account.gatewayKey === input.providerKey);
  if (!match) {
    log.info("pre-debit notice update for a notice we do not know", {
      event: "pre_debit_notice_update_unmatched",
      gatewayKey: input.providerKey,
      notificationRef: update.notificationRef,
    });
    return "ignored";
  }
  const n = match.notice;
  const now = await businessWallClock(n.businessId);

  if (update.status === "sent") {
    // A later statement of the earliest debit moves an unused notice later, never earlier.
    if (n.status === "sent") {
      if (
        !update.executableAfter ||
        n.debitsUsed > 0 ||
        (n.executableAfter && update.executableAfter <= n.executableAfter)
      )
        return "ignored";
      const [row] = await withTenant(n.organizationId, (tx) =>
        tx
          .update(preDebitNotices)
          .set({ executableAfter: update.executableAfter, updatedAt: now })
          .where(
            and(
              eq(preDebitNotices.id, n.id),
              eq(preDebitNotices.status, "sent"),
              eq(preDebitNotices.debitsUsed, 0),
            ),
          )
          .returning({ id: preDebitNotices.id }),
      );
      return row ? "processed" : "ignored";
    }
    if (n.status !== "pending") return "ignored";
    let leadHours = 0;
    let validForHours: number | undefined;
    try {
      const cap = match.account
        ? resolveAdapter(match.account).capabilities.preDebitNotice
        : undefined;
      leadHours = cap ? preDebitRule(cap, match.rail).minLeadHours : 0;
      validForHours = cap?.validForHours;
    } catch (e) {
      // The gateway's own statement still applies; we only lose our floor on it.
      log.warn("could not resolve the gateway for a pre-debit notice update", {
        event: "pre_debit_notice_update_no_adapter",
        notice: n.publicId,
        error: (e as Error)?.message,
      });
    }
    const floor = new Date(n.createdAt.getTime() + leadHours * 3_600_000);
    const executableAfter =
      update.executableAfter && update.executableAfter > floor ? update.executableAfter : floor;
    const expiresAt =
      n.expiresAt ??
      (validForHours != null ? new Date(n.createdAt.getTime() + validForHours * 3_600_000) : null);
    const [row] = await withTenant(n.organizationId, (tx) =>
      tx
        .update(preDebitNotices)
        .set({ status: "sent", executableAfter, expiresAt, updatedAt: now })
        .where(and(eq(preDebitNotices.id, n.id), eq(preDebitNotices.status, "pending")))
        .returning({ id: preDebitNotices.id }),
    );
    return row ? "processed" : "ignored";
  }

  if (!["pending", "sent"].includes(n.status) || n.debitsUsed > 0) return "ignored";
  const [row] = await withTenant(n.organizationId, (tx) =>
    tx
      .update(preDebitNotices)
      .set({
        status: "failed",
        executableAfter: null,
        failureCode: update.failureCode ?? "notice_failed",
        failureMessage: update.failureMessage ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(preDebitNotices.id, n.id),
          inArray(preDebitNotices.status, ["pending", "sent"]),
          eq(preDebitNotices.debitsUsed, 0),
        ),
      )
      .returning({ id: preDebitNotices.id }),
  );
  return row ? "processed" : "ignored";
}

/**
 * The gateway refused a debit only as too early (`PRE_DEBIT_NOT_DUE_CODE`): the notice is
 * still good. Gives back the debit the gate counted, holds the notice until
 * `now + retryAfterMs` and returns when to ask again.
 */
export async function releaseGatewayNotice(input: {
  organizationId: string;
  businessId: string;
  paymentMethodId: string;
  notificationRef: string;
  retryAfterMs?: number;
}): Promise<Date> {
  const now = await businessWallClock(input.businessId);
  const at = new Date(now.getTime() + (input.retryAfterMs ?? PENDING_RECHECK_MS));
  await withTenant(input.organizationId, async (tx) => {
    const [n] = await tx
      .select()
      .from(preDebitNotices)
      .where(
        and(
          eq(preDebitNotices.paymentMethodId, input.paymentMethodId),
          eq(preDebitNotices.notificationRef, input.notificationRef),
          inArray(preDebitNotices.status, ["sent", "exhausted"]),
        ),
      )
      .orderBy(desc(preDebitNotices.createdAt))
      .limit(1)
      .for("update");
    if (!n) return;
    await tx
      .update(preDebitNotices)
      .set({
        status: "sent",
        debitsUsed: Math.max(n.debitsUsed - 1, 0),
        executableAfter: n.executableAfter && n.executableAfter > at ? n.executableAfter : at,
        updatedAt: now,
      })
      .where(eq(preDebitNotices.id, n.id));
  });
  log.info("the gateway refused a debit as too early; the notice is kept", {
    event: "pre_debit_notice_released",
    notificationRef: input.notificationRef,
    until: at.toISOString(),
  });
  return new Date(at.getTime() + LEAD_MARGIN_MS);
}
