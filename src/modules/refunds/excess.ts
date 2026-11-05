import { and, eq, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { postEntries } from "@/modules/ledger/service";
import { createLogger } from "@/platform/logger";
import {
  bucketBalance,
  EXCESS_PAYMENT,
  EXCESS_REFUND_PENDING,
  lockCustomerBalances,
} from "@/modules/customers/balances-read";
import { paymentMethods, payments } from "@db/schema";
import { BANK_DEBIT_METHODS } from "@/providers/method-types";
import { UNAPPLIED_CAPTURE_KEY as UNAPPLIED_KEY } from "@/modules/payments/unapplied-capture-key";
import { refundPayment, RefundError, type Refund } from "./service";

const log = createLogger("refunds.excess");

/**
 * Excess credit is drawn into `EXCESS_REFUND_PENDING` BEFORE the gateway is called, under the
 * customer-balance lock, so no other spender (a collect, the next invoice) can use money
 * being paid out. The payout clears it to cash; a definitive failure returns it to the
 * customer's credit. A balance left there is a payout whose outcome is unknown —
 * `excess_refund_pending_clears` surfaces it.
 */
export { EXCESS_REFUND_PENDING };

/** Ledger sources that move a payment's excess, all keyed by the PAYMENT's public id. */
const HELD = "excess_payment";
const RESERVED = "excess_refund_reserve";
const RELEASED = "excess_refund_release";
/** The gateway took the payment back (late failure): what it held leaves with it. */
export const EXCESS_REVERSAL_SOURCE = "excess_payment_reversal";

/**
 * What this payment still holds on the customer's excess balance: what it put there, less
 * what its refunds have drawn back out. The customer's own bucket can be lower (a collect
 * or an invoice spent some of it), so the refundable amount is the smaller of the two.
 */
export async function excessHeldByPayment(tx: Tx, paymentPublicId: string): Promise<bigint> {
  const rows = (await tx.execute(sql`
    select coalesce(sum(case when direction = 'credit' then amount_minor else -amount_minor end), 0)::bigint as held
    from ledger_entries
    where account = ${EXCESS_PAYMENT}
      and source_id = ${paymentPublicId}
      and source_type in (${HELD}, ${RESERVED}, ${RELEASED}, ${EXCESS_REVERSAL_SOURCE})
  `)) as unknown as Array<{ held: string | number }>;
  const held = BigInt(rows[0]?.held ?? 0);
  return held > 0n ? held : 0n;
}

/**
 * What ONE overpayment can still give back to its own instrument: what it credited (net of
 * its own refunds) less every draw on the customer's excess bucket since then, each draw
 * taken to have spent this money first, and never more than the bucket. So excess from
 * another source (a bank debit, an offline payment) can never leave through this charge.
 */
export async function ownUnappliedExcess(
  tx: Tx,
  pay: {
    publicId: string;
    customerId: string | null;
    currency: string;
    metadata?: unknown;
  },
): Promise<bigint> {
  if (!pay.customerId) return 0n;
  const own = sql`(le.source_id = ${pay.publicId} and le.source_type in (${HELD}, ${RESERVED}, ${RELEASED}, ${EXCESS_REVERSAL_SOURCE}))`;
  // The overshoot path records what its invoice absorbed and that absorb's ledger entry. Each
  // overpayment's absorb drew only its own credit, so with the record those exact entries are
  // left out here and this payment's own absorb is netted out of `held` instead: children of one
  // request settlement no longer charge each other's absorb. Every other draw from this credit
  // on counts, in entry-id time (uuid v7, the real clock, so Time Travel's pinned `created_at`
  // does not matter). Without the record, every draw from this credit on counts.
  const absorbed = overpayAbsorbed(pay.metadata);
  // Other overpayments' absorbs and own refunds spent their own credit, never this one's.
  const absorbsOut =
    absorbed !== null
      ? sql`and not (le.id::text in
            (select p.metadata ->> 'overpay_absorb_entry' from payments p
             where p.customer_id = ${pay.customerId} and p.metadata ? 'overpay_absorb_entry'))
          and not (le.source_type in (${RESERVED}, ${EXCESS_REVERSAL_SOURCE}) and le.source_id in
            (select p.public_id from payments p
             where p.customer_id = ${pay.customerId} and p.metadata ? 'overpay_absorbed_minor'))`
      : sql``;
  const rows = (await tx.execute(sql`
    with h as (
      select id from ledger_entries
      where account = ${EXCESS_PAYMENT} and source_id = ${pay.publicId}
        and source_type = ${HELD} and direction = 'credit'
      order by id limit 1
    )
    select coalesce(sum(le.amount_minor), 0)::bigint as drawn
    from ledger_entries le, h
    where le.account = ${EXCESS_PAYMENT} and le.customer_id = ${pay.customerId}
      and le.currency = ${pay.currency} and le.direction = 'debit'
      and substr(le.id::text, 1, 13) >= substr(h.id::text, 1, 13)
      ${absorbsOut} and not ${own}
  `)) as unknown as Array<{ drawn: string | number }>;
  const drawn = BigInt(rows[0]?.drawn ?? 0);
  // `refundableExcess` already nets this payment's own absorb out of `held`.
  const { held, bucket } = await refundableExcess(tx, pay);
  const left = held - drawn;
  const capped = left < bucket ? left : bucket;
  // Never into bank-debit or offline money, whatever the order of events.
  const room = bucket - (await nonCardHeld(tx, pay.customerId, pay.currency));
  const out = capped < room ? capped : room;
  return out > 0n ? out : 0n;
}

/**
 * Excess this customer holds from sources that are not provably a card: every credit to the
 * bucket except a card payment's own (`excess_payment` / `excess_refund_release`), less those
 * sources' own refunds and reversals and an overpayment's recorded absorb (its own invoice took
 * it). Other draws are not subtracted: they are taken to have spent card money first. A card refund of excess may only use `bucket − nonCardHeld`.
 */
export async function nonCardHeld(tx: Tx, customerId: string, currency: string): Promise<bigint> {
  const rows = (await tx.execute(sql`
    with card as (
      select p.public_id from payments p
      left join payment_methods pm on pm.id = p.payment_method_id
      where p.customer_id = ${customerId} and coalesce(pm.type, p.method_type) = 'card'
        and p.provider_key <> 'offline'
    ), paid as (
      select p.public_id from payments p where p.customer_id = ${customerId}
    )
    select
      coalesce(sum(case when le.direction = 'credit'
        and not (le.source_type in (${HELD}, ${RELEASED}) and le.source_id in (select public_id from card))
        then le.amount_minor else 0 end), 0)
      - coalesce(sum(case when le.direction = 'debit'
        and le.source_type in (${RESERVED}, ${EXCESS_REVERSAL_SOURCE})
        and le.source_id in (select public_id from paid)
        and le.source_id not in (select public_id from card)
        then le.amount_minor else 0 end), 0)
      -- An overpayment's recorded absorb spent its own credit: count only what it left.
      - (select coalesce(sum((p.metadata ->> 'overpay_absorbed_minor')::bigint), 0)
         from payments p
         where p.customer_id = ${customerId} and p.currency = ${currency}
           and p.metadata ? 'overpay_absorbed_minor'
           and p.public_id not in (select public_id from card)) as held
    from ledger_entries le
    where le.account = ${EXCESS_PAYMENT} and le.customer_id = ${customerId}
      and le.currency = ${currency}
  `)) as unknown as Array<{ held: string | number }>;
  const held = BigInt(rows[0]?.held ?? 0);
  return held > 0n ? held : 0n;
}

/** The payment was taken on a card (not a bank debit, not offline). */
async function isCardPayment(tx: Tx, paymentPublicId: string): Promise<boolean> {
  const [row] = await tx
    .select({
      type: paymentMethods.type,
      methodType: payments.methodType,
      key: payments.providerKey,
    })
    .from(payments)
    .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
    .where(eq(payments.publicId, paymentPublicId))
    .limit(1);
  return !!row && (row.type ?? row.methodType) === "card" && row.key !== "offline";
}

/** `payments.metadata.overpay_absorbed_minor`, set by the overshoot path; null when absent. */
function overpayAbsorbed(metadata: unknown): bigint | null {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.overpay_absorbed_minor;
  return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : null;
}

/** Refundable from excess for one payment: capped by what it holds AND by the customer's bucket. */
export async function refundableExcess(
  tx: Tx,
  pay: { publicId: string; customerId: string | null; currency: string; metadata?: unknown },
): Promise<{ held: bigint; bucket: bigint; refundable: bigint }> {
  // An overpayment credited its whole amount; the part its invoice absorbed is not its to give.
  const gross = await excessHeldByPayment(tx, pay.publicId);
  const absorbed = overpayAbsorbed(pay.metadata);
  const held =
    absorbed !== null && gross > absorbed ? gross - absorbed : absorbed !== null ? 0n : gross;
  const bucket = pay.customerId
    ? await bucketBalance(tx, pay.customerId, EXCESS_PAYMENT, pay.currency)
    : 0n;
  return { held, bucket, refundable: held < bucket ? held : bucket };
}

const move = (
  tx: Tx,
  pay: {
    organizationId: string;
    businessId: string;
    customerId: string | null;
    publicId: string;
    currency: string;
  },
  amount: bigint,
  kind: typeof RESERVED | typeof RELEASED,
) =>
  postEntries(
    {
      organizationId: pay.organizationId,
      businessId: pay.businessId,
      ...(pay.customerId ? { customerId: pay.customerId } : {}),
      sourceType: kind,
      sourceId: pay.publicId,
      lines:
        kind === RESERVED
          ? [
              {
                account: EXCESS_PAYMENT,
                direction: "debit",
                amountMinor: amount,
                currency: pay.currency,
              },
              {
                account: EXCESS_REFUND_PENDING,
                direction: "credit",
                amountMinor: amount,
                currency: pay.currency,
              },
            ]
          : [
              {
                account: EXCESS_REFUND_PENDING,
                direction: "debit",
                amountMinor: amount,
                currency: pay.currency,
              },
              {
                account: EXCESS_PAYMENT,
                direction: "credit",
                amountMinor: amount,
                currency: pay.currency,
              },
            ],
    },
    tx,
  );

/**
 * Pay a customer back money a payment left on their excess balance — a charge that landed
 * on a voided invoice, an overpayment, an abandoned debit that settled.
 *
 * The amount defaults to everything refundable and may never exceed it. The gateway refund
 * books against `excess_refund_pending`, never `refunds`: this money was never revenue.
 */
export async function refundExcessPayment(input: {
  organizationId: string;
  businessId: string;
  paymentPublicId: string;
  amountMinor?: number;
  reason?: string;
  /** Cap at `ownUnappliedExcess` (the automatic and the customer's own refunds). */
  ownLeftoverOnly?: boolean;
}): Promise<Refund> {
  const reserved = await withTenant(input.organizationId, async (tx) => {
    const [pay] = await tx
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.businessId, input.businessId),
          eq(payments.publicId, input.paymentPublicId),
        ),
      )
      .limit(1);
    if (!pay)
      throw new RefundError(`We could not find the payment ${input.paymentPublicId}.`, "not_found");
    if (!pay.customerId) throw new RefundError(`Payment ${pay.publicId} has no customer to repay`);
    await lockCustomerBalances(tx, pay.customerId);
    const r = await refundableExcess(tx, pay);
    const { held, bucket } = r;
    let refundable = input.ownLeftoverOnly ? await ownUnappliedExcess(tx, pay) : r.refundable;
    // An operator refund of a recorded card overpayment: never into bank-debit or offline money.
    if (
      !input.ownLeftoverOnly &&
      overpayAbsorbed(pay.metadata) !== null &&
      pay.customerId &&
      (await isCardPayment(tx, pay.publicId))
    ) {
      const room = bucket - (await nonCardHeld(tx, pay.customerId, pay.currency));
      if (room < refundable) refundable = room > 0n ? room : 0n;
    }
    if (held === 0n) {
      throw new RefundError(`Payment ${pay.publicId} holds no excess credit for this customer`);
    }
    if (refundable === 0n) {
      throw new RefundError(
        `The ${pay.currency} excess from this payment is already applied to invoices. Nothing is left to refund.`,
      );
    }
    const amount = input.amountMinor != null ? BigInt(input.amountMinor) : refundable;
    if (amount <= 0n) throw new RefundError("Refund amount must be positive");
    if (amount > refundable) {
      throw new RefundError(
        `Refund ${amount} exceeds the ${refundable} this payment still holds as customer credit` +
          (bucket < held ? `. The rest is applied to invoices.` : ""),
      );
    }
    await move(
      tx,
      { ...pay, organizationId: input.organizationId, businessId: input.businessId },
      amount,
      RESERVED,
    );
    return { pay, amount };
  });

  const { pay, amount } = reserved;
  const release = () =>
    withTenant(input.organizationId, (tx) =>
      move(
        tx,
        { ...pay, organizationId: input.organizationId, businessId: input.businessId },
        amount,
        RELEASED,
      ),
    );

  try {
    return await refundPayment({
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentPublicId: pay.publicId,
      amountMinor: Number(amount),
      reason: input.reason,
      contraAccount: EXCESS_REFUND_PENDING,
    });
  } catch (e) {
    // A RefundError is a definitive no: nothing left the business, so the credit goes back.
    if (e instanceof RefundError) {
      await release();
      throw e;
    }
    // Anything else may have reached the gateway. Keep the reservation rather than hand the
    // customer credit that might also have been paid out.
    log.error(e, {
      event: "excess_refund_outcome_unknown",
      payment: pay.publicId,
      amountMinor: String(amount),
      currency: pay.currency,
    });
    throw e;
  }
}

export interface ExcessPaymentRow {
  paymentPublicId: string;
  invoicePublicId: string | null;
  currency: string;
  paymentAmountMinor: bigint;
  heldMinor: bigint;
  /** `heldMinor` capped by the customer's excess balance in that currency right now. */
  refundableMinor: bigint;
  gateway: string | null;
  createdAt: Date;
}

/** The payments still holding part of a customer's excess credit, newest first. */
export async function listExcessPayments(
  organizationId: string,
  businessId: string,
  customerId: string,
): Promise<ExcessPaymentRow[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = (await tx.execute(sql`
      select p.public_id, i.public_id as invoice_public_id, p.currency, p.amount_minor,
             p.provider_key, p.created_at,
             sum(case when le.direction = 'credit' then le.amount_minor else -le.amount_minor end)::bigint as held
      from ledger_entries le
      join payments p on p.public_id = le.source_id and p.business_id = ${businessId}
      left join invoices i on i.id = p.invoice_id
      where le.customer_id = ${customerId}
        and le.account = ${EXCESS_PAYMENT}
        and le.source_type in (${HELD}, ${RESERVED}, ${RELEASED})
      group by p.id, i.public_id
      having sum(case when le.direction = 'credit' then le.amount_minor else -le.amount_minor end) > 0
      order by p.created_at desc
    `)) as unknown as Array<{
      public_id: string;
      invoice_public_id: string | null;
      currency: string;
      amount_minor: string | number;
      provider_key: string | null;
      created_at: string | Date;
      held: string | number;
    }>;
    const buckets = new Map<string, bigint>();
    for (const r of rows) {
      if (!buckets.has(r.currency))
        buckets.set(r.currency, await bucketBalance(tx, customerId, EXCESS_PAYMENT, r.currency));
    }
    return rows.map((r) => {
      const held = BigInt(r.held);
      const bucket = buckets.get(r.currency) ?? 0n;
      return {
        paymentPublicId: r.public_id,
        invoicePublicId: r.invoice_public_id,
        currency: r.currency,
        paymentAmountMinor: BigInt(r.amount_minor),
        heldMinor: held,
        refundableMinor: held < bucket ? held : bucket,
        gateway: r.provider_key,
        createdAt: new Date(r.created_at),
      };
    });
  });
}

/**
 * Give back gateway money no invoice could take — the ONE implementation, for every path
 * that ends up holding some.
 *
 * ── Why it is shared (2026-09-01) ─────────────────────────────────────────────
 * There were two policies for one situation: an abandoned-then-approved debit refunded
 * itself, while a duplicate checkout was held as customer credit and alerted. Both are
 * money we cannot apply, both are the customer's, and two policies for one situation is
 * how they drift — so they are now one, converged on REFUND. Decided 2026-09-01.
 *
 * ── Why a failed refund is swallowed ─────────────────────────────────────────
 * Rethrowing makes the gateway redeliver the webhook, and the claim inside
 * `settleAbandonedCapture` means the redelivery books nothing and retries nothing — so a
 * throw would cost the delivery and change nothing about the money. What is left behind
 * instead is a correct, visible, already-built state: the money sits as customer credit,
 * it draws down their next invoice, an operator can refund it by hand, and — since
 * 2026-08-31 — the `unapplied_gateway_money` ALERT counts it, because every path that
 * detaches a payment stamps `metadata.unapplied_gateway_capture`. That alert is what makes
 * swallowing safe rather than silent; before it, this catch was the end of the story.
 *
 * The refund runs OUTSIDE any transaction deliberately: `refundPayment` opens its own and
 * reaches a gateway, and a network round trip must not be held inside a transaction that
 * holds an invoice lock.
 */
/**
 * The rail this payment was taken on, when it is a bank debit — else null.
 *
 * Read from the stored instrument rather than the gateway key: one gateway carries several
 * rails, and it is the RAIL that decides whether an unprompted refund is safe. The canonical
 * types are what `describeStripePaymentMethod` writes, so `bank_transfer` covers ACH,
 * Bacs, BECS and PAD, and RazorPay's netbanking e-mandate lands there too — correctly, since
 * it is a bank debit with its own dispute path.
 */
const BANK_DEBIT_TYPES = BANK_DEBIT_METHODS;

async function bankDebitRailOf(organizationId: string, paymentPublicId: string) {
  const [row] = await withTenant(organizationId, (tx) =>
    tx
      .select({ type: paymentMethods.type })
      .from(payments)
      .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .where(eq(payments.publicId, paymentPublicId))
      .limit(1),
  );
  const type = row?.type ?? null;
  return type && BANK_DEBIT_TYPES.has(type) ? type : null;
}

export async function refundUnappliedExcess(
  ctx: { organizationId: string; businessId: string },
  booked: { paymentPublicId: string; amountMinor: bigint; currency: string },
  reason: string,
  opts: { ownLeftoverOnly?: boolean } = {},
): Promise<void> {
  /**
   * ── A BANK DEBIT IS NOT REFUNDED UNPROMPTED ───────────────────────────────────
   *
   * Stripe documents a double-refund risk specific to bank-debit rails: refund
   * proactively while the payer is also disputing, and they are credited TWICE. The
   * window makes it likely rather than theoretical — SEPA gives an unconditional right to
   * a refund for 8 weeks and 13 months to dispute an unauthorised debit, so "the payer
   * has not disputed yet" is never a safe read on this rail.
   *
   * Cards are different and stay automatic: the payer's recourse is a chargeback that
   * Stripe would refuse against an already-refunded charge, so the two cannot both land.
   *
   * Holding is not a silent failure — it is the SAME state a failed payout leaves, which
   * is already built and already alerted: the money sits as customer credit stamped
   * `metadata.unapplied_gateway_capture`, `unapplied_gateway_money` counts it, it draws
   * down the payer's next invoice, and an operator can still refund it by hand once the
   * dispute window is understood. Choosing that over an automatic payout trades a
   * recoverable delay for an unrecoverable double credit.
   */
  const rail = await bankDebitRailOf(ctx.organizationId, booked.paymentPublicId);
  if (rail) {
    log.warn("money is held as customer credit rather than auto-refunded — bank-debit rail", {
      event: "unapplied_excess_held_bank_debit",
      payment: booked.paymentPublicId,
      rail,
      amountMinor: String(booked.amountMinor),
      currency: booked.currency,
      reason,
    });
    return;
  }

  try {
    // The same path an operator's refund takes: the excess is drawn under the customer lock
    // before the gateway call, and never booked as contra-revenue — it was never revenue.
    await refundExcessPayment({
      organizationId: ctx.organizationId,
      businessId: ctx.businessId,
      paymentPublicId: booked.paymentPublicId,
      // Capped: what this payment still holds of its own, which may be less than booked.
      amountMinor: opts.ownLeftoverOnly ? undefined : Number(booked.amountMinor),
      reason,
      ownLeftoverOnly: opts.ownLeftoverOnly,
    });
    /**
     * SUCCESS was silent until 2026-09-03, and silence was wrong here.
     *
     * Money left the business without a human deciding, and it only happens because a debit
     * settled against an invoice a credit note had already cleared — so a customer was
     * charged and repaid for a debt they no longer owed. `warn`, not `info`: the refund
     * worked, but the CAUSE upstream is worth someone's attention. The `unapplied_gateway_money`
     * alert cannot show this one, deliberately — it subtracts refunds, because money handed
     * back is not stranded — so `auto_refunded_unapplied_money` counts it instead.
     */
    log.warn("money was refunded automatically because no invoice could take it", {
      event: "unapplied_excess_refunded",
      payment: booked.paymentPublicId,
      amountMinor: String(booked.amountMinor),
      currency: booked.currency,
      reason,
    });
  } catch (e) {
    log.error(e, {
      event: "unapplied_excess_refund_failed",
      payment: booked.paymentPublicId,
      amountMinor: String(booked.amountMinor),
      currency: booked.currency,
      reason,
    });
  }
}

/** The overpayment marker `settlePaymentSucceeded` stamps on a payment it detached. */
const OVERPAY = "async_overpay";

export interface CustomerOverpayment {
  paymentPublicId: string;
  currency: string;
  refundableMinor: bigint;
  createdAt: Date;
}

/**
 * The customer's overpayments that still hold credit and may be paid back on their request
 * (2.69 `customer_chooses`): settled for more than the invoice owed, not on a bank-debit
 * rail (the unprompted-refund rule in `refundUnappliedExcess` holds for these too).
 */
export async function listCustomerOverpayments(
  organizationId: string,
  businessId: string,
  customerId: string,
): Promise<CustomerOverpayment[]> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ pay: payments, pmType: paymentMethods.type })
      .from(payments)
      .leftJoin(paymentMethods, eq(paymentMethods.id, payments.paymentMethodId))
      .where(
        and(
          eq(payments.businessId, businessId),
          eq(payments.customerId, customerId),
          eq(payments.status, "succeeded"),
          sql`${payments.metadata} ->> ${UNAPPLIED_KEY} = ${OVERPAY}`,
        ),
      );
    const out: CustomerOverpayment[] = [];
    for (const r of rows) {
      // Only a known instrument that is not a bank debit (`refundUnappliedExcess`'s rule).
      const type = r.pmType ?? r.pay.methodType;
      if (!type || BANK_DEBIT_METHODS.has(type)) continue;
      const refundable = await ownUnappliedExcess(tx, r.pay);
      if (refundable > 0n)
        out.push({
          paymentPublicId: r.pay.publicId,
          currency: r.pay.currency,
          refundableMinor: refundable,
          createdAt: r.pay.createdAt,
        });
    }
    return out;
  });
}

/** Pay one listed overpayment back, whole, at the customer's request. */
export async function refundCustomerOverpayment(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  paymentPublicId: string;
}): Promise<Refund> {
  const listed = await listCustomerOverpayments(
    input.organizationId,
    input.businessId,
    input.customerId,
  );
  const one = listed.find((o) => o.paymentPublicId === input.paymentPublicId);
  if (!one)
    throw new RefundError(
      "We could not refund this payment. It holds no credit that we can return.",
      "not_found",
    );
  return refundExcessPayment({
    organizationId: input.organizationId,
    businessId: input.businessId,
    paymentPublicId: one.paymentPublicId,
    amountMinor: Number(one.refundableMinor),
    reason: "The customer asked for the overpayment back",
    ownLeftoverOnly: true,
  });
}
