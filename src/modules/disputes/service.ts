import { stampNow } from "@/platform/clock";
import { and, asc, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import {
  clampLimit,
  countExpr,
  keysetCondition,
  pageOrder,
  parseCursor,
  toPage,
  type ListPage,
} from "@/platform/list-query";
import { publicId } from "@/platform/ids";
import { postEntries } from "@/modules/ledger/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { disputes, ledgerEntries, payments, refunds, transactions, businesses } from "@db/schema";
import type { NormalizedProviderEvent } from "@/providers/types";
import type { EventType } from "@/modules/events/registry";
import { createLogger } from "@/platform/logger";
import { operatorRecordsDisputeOutcome } from "@/providers/gateway-catalog";

const log = createLogger("disputes");

export type DisputeRow = typeof disputes.$inferSelect;

/** Optional inbound context — carries the business resolved by the webhook route. */
export interface DisputeContext {
  businessId?: string | null;
  /**
   * The gateway the webhook was DELIVERED by. Part of the correlation key, not
   * decoration: a charge id is unique per provider, never globally.
   */
  providerKey?: string | null;
  /** Ignore a dispute that matches none of this business's payments (polled, not delivered). */
  requirePayment?: boolean;
}

/**
 * Correlation of a gateway dispute back to our records via the disputed charge id.
 *
 * Providers reference the disputed CHARGE (Stripe carries the PaymentIntent id on
 * the dispute, which is exactly what we store as `payments.provider_charge_id`).
 * We resolve, in order:
 *   1. a `payments` row (best — yields customer + invoice + payment id directly),
 *   2. a `transactions` row via `id_at_gateway` (yields customer + invoice),
 *   3. the business from the inbound webhook context (best-effort scoping).
 * If none resolves an org, the dispute cannot be tenant-scoped and is skipped.
 */
interface Correlation {
  organizationId: string;
  // Always resolved: payments/transactions carry a NOT NULL business, and the
  // ctx fallback is only taken when ctx.businessId is present.
  businessId: string;
  customerId: string | null;
  invoiceId: string | null;
  paymentId: string | null;
}

async function correlate(
  ev: NormalizedProviderEvent,
  ctx?: DisputeContext,
): Promise<Correlation | null> {
  const chargeId = ev.providerChargeId;
  if (chargeId) {
    // ── THE DELIVERING BUSINESS IS A FILTER, NOT A FALLBACK (2026-08-26) ──────────
    // This matched a BARE `provider_charge_id` — no business, no provider, `limit(1)` —
    // and the row it happened to pick BECAME the tenant: the returned `organizationId`
    // is what `handleDisputeEvent` then opens `withTenant` on, and what the
    // `disputed_funds` / `dispute_losses` clawback is posted against.
    //
    // Two ways that books a chargeback in someone else's ledger. A shared gateway
    // account — two of our organizations pointing at one Stripe account — makes charge
    // ids collide for free, and `limit(1)` silently picks one. And webhook signatures
    // are verified against the MERCHANT'S OWN stored secret, so a tenant who registers a
    // gateway account knows the secret their deliveries are checked against and can post
    // a validly-signed `dispute.*` naming any charge id at all.
    //
    // `ctx.businessId` was already here, described by this function's own doc as
    // "best-effort scoping" and used only as a fallback when nothing else resolved. It
    // comes from the VERIFIED gateway account (`gateway/inbound.ts`), so it is the one
    // trustworthy fact about the delivery — it belongs in the WHERE clause.
    //
    // Ambiguity is declined rather than guessed, mirroring `resolvePaymentByCharge` in
    // webhooks/inbound.ts. That sibling — forty lines from this one — already matched on
    // the provider key, took `limit(2)` and refused, logging "risk booking against the
    // wrong tenant". This is the copy that posts the ledger entry and had none of it.
    const payRows = await systemDb
      .select()
      .from(payments)
      .where(
        and(
          eq(payments.providerChargeId, chargeId),
          ...(ctx?.providerKey ? [eq(payments.providerKey, ctx.providerKey)] : []),
          ...(ctx?.businessId ? [eq(payments.businessId, ctx.businessId)] : []),
        ),
      )
      .limit(2);
    if (payRows.length > 1) {
      log.error(new Error("ambiguous disputed charge id — refusing to guess whose payment it is"), {
        event: "dispute_charge_ambiguous",
        provider_charge_id: chargeId,
        provider: ctx?.providerKey ?? null,
        businessId: ctx?.businessId ?? null,
        detail:
          "two payments share this charge id within the delivering business; the dispute is skipped rather than booked against the wrong tenant",
      });
      return null;
    }
    const pay = payRows[0];
    if (pay) {
      return {
        organizationId: pay.organizationId,
        businessId: pay.businessId,
        customerId: pay.customerId ?? null,
        invoiceId: pay.invoiceId ?? null,
        paymentId: pay.id,
      };
    }
    // Same treatment for the transactions fallback: scoped, and ambiguity declined.
    const txnRows = await systemDb
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.idAtGateway, chargeId),
          ...(ctx?.providerKey ? [eq(transactions.gatewayKey, ctx.providerKey)] : []),
          ...(ctx?.businessId ? [eq(transactions.businessId, ctx.businessId)] : []),
        ),
      )
      .limit(2);
    if (txnRows.length > 1) {
      log.error(new Error("ambiguous disputed charge id across transactions — refusing to guess"), {
        event: "dispute_txn_ambiguous",
        provider_charge_id: chargeId,
        provider: ctx?.providerKey ?? null,
        businessId: ctx?.businessId ?? null,
      });
      return null;
    }
    const txn = txnRows[0];
    // A payment request's charge (0388): attribute to the newest invoice it reaches.
    if (txn?.paymentRequestId) {
      const { requestDisputeTarget } = await import("@/modules/payment-requests/gateway-hooks");
      const target = await requestDisputeTarget(txn, ev.disputeAmountMinor ?? txn.amountMinor);
      return {
        organizationId: txn.organizationId,
        businessId: txn.businessId,
        customerId: txn.customerId ?? null,
        invoiceId: target?.invoiceId ?? null,
        paymentId: target?.paymentId ?? null,
      };
    }
    if (txn) {
      return {
        organizationId: txn.organizationId,
        businessId: txn.businessId,
        customerId: txn.customerId ?? null,
        invoiceId: txn.invoiceId ?? null,
        paymentId: txn.paymentId ?? null,
      };
    }
  }
  // Uncorrelated: fall back to the business the inbound route resolved (best-effort).
  if (ctx?.businessId) {
    const [biz] = await systemDb
      .select({ orgId: businesses.organizationId })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1);
    if (biz) {
      return {
        organizationId: biz.orgId,
        businessId: ctx.businessId,
        customerId: null,
        invoiceId: null,
        paymentId: null,
      };
    }
  }
  return null;
}

/**
 * Serialize every handler for ONE dispute — the dispute path's equivalent of
 * `lockCustomerBalances`, and for the same reason.
 *
 * `handleDisputeEvent` reads the dispute row, branches on `funds_withdrawn` / `status`,
 * POSTS THE LEDGER, and only then updates the row. The row UPDATE serializes, but it
 * happens after the cash has been booked, and the loser of that race does not lose — it
 * waits and then succeeds. So both transactions commit their postings.
 *
 * The provider-event dedup above (`handleProviderEvent`, unique on
 * `(provider_key, provider_event_id)`) does not help: the events that race are DISTINCT
 * provider events. Stripe sends `charge.dispute.funds_withdrawn` and the won-closure's
 * `charge.dispute.funds_reinstated` separately, and `charge.dispute.closed` separately
 * again from a quick loss.
 *
 * Measured on `scripts/verify-concurrent-dispute.ts` before this lock existed, for one
 * 1500 chargeback:
 *   - 5 concurrent `funds_withdrawn` credited cash 3000 (2x the chargeback),
 *   - `won` racing `funds_reinstated` debited cash back 3000 and left `disputed_funds`
 *     at -1500 — 1500 of cash conjured from nothing,
 *   - `funds_withdrawn` racing `lost` credited cash 3000 and left a phantom 1500
 *     `disputed_funds` asset (the loss took the "never withdrawn" branch on a stale read).
 *
 * Taken FIRST, before the SELECT, so the whole read-then-act runs under it. Keyed on
 * (organization, provider_dispute_id) — the same pair the unique index uses — so disputes
 * for different tenants never contend. Transaction-scoped: released at commit/rollback.
 */
export async function lockDispute(
  tx: Tx,
  organizationId: string,
  providerDisputeId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${organizationId}:${providerDisputeId}`}::text, 7402))`,
  );
}

/**
 * Handle a normalized dispute lifecycle event. Owns the MONEY side of a
 * chargeback via the append-only ledger (ADR-004): funds_withdrawn books the
 * cash clawback, reversed on won/reinstated, or realized to an expense on lost.
 *
 * New ledger accounts (free-form strings): `disputed_funds` (asset held while a
 * chargeback is contested) and `dispute_losses` (expense when we lose it).
 *
 * Idempotency: the top-level provider-event dedup (handleProviderEvent) blocks
 * exact replays; the per-dispute `fundsWithdrawn` flag + `status` guard blocks a
 * DOUBLE clawback should a provider re-send funds_withdrawn under a new event id.
 * All mutations (row upsert + ledger + event) run in one `withTenant` tx.
 */
export async function handleDisputeEvent(
  ev: NormalizedProviderEvent,
  ctx?: DisputeContext,
): Promise<"processed" | "ignored"> {
  if (!ev.providerDisputeId) return "ignored";
  const corr = await correlate(ev, ctx);
  if (!corr) {
    // No org determinable at all — nothing we can safely persist. Surface it.
    log.warn("uncorrelated + unscoped dispute — dropped", {
      event: "dispute_dropped",
      dispute: ev.providerDisputeId,
      charge: ev.providerChargeId ?? null,
      correlated: false,
    });
    return "ignored";
  }
  if (!corr.paymentId && ctx?.requirePayment) {
    log.info("polled dispute matches no payment of this business — not ours, ignored", {
      event: "dispute_poll_not_ours",
      dispute: ev.providerDisputeId,
      charge: ev.providerChargeId ?? null,
      businessId: corr.businessId ?? null,
    });
    return "ignored";
  }
  if (!corr.paymentId) {
    log.warn("dispute not correlated to a payment — recorded best-effort under its business", {
      event: "dispute_uncorrelated",
      dispute: ev.providerDisputeId,
      charge: ev.providerChargeId ?? null,
      businessId: corr.businessId ?? null,
    });
  }

  const amount = ev.disputeAmountMinor ?? 0n;
  const currency = (ev.disputeCurrency ?? "USD").toUpperCase();
  // The delivering gateway is known at ingestion; sniffing the payload is the last resort.
  const providerKey =
    ctx?.providerKey ??
    (ev.raw as { provider_key?: string } | undefined)?.provider_key ??
    inferProviderKey(ev);

  /**
   * 0244 chargeback policy. Decided INSIDE the transaction and applied after it: every
   * action either calls a gateway or opens its own transaction, so none can run in here.
   *
   * RETURNED from the transaction rather than written to a closure variable — mutating an
   * outer `let` from this callback makes TypeScript narrow it to its initializer at the
   * read site, which is a real signal that the value's origin was unclear.
   *
   * `firePolicy` is the idempotence guard, and there is deliberately no marker column: it
   * is set only on a real STATE TRANSITION, so a retried webhook (this runs from
   * `webhooks/inbound.ts`) asks for nothing. See `applyChargebackPolicy`.
   */
  const policy = await withTenant(corr.organizationId, async (tx) => {
    // Serialize this dispute's whole read-then-act before anything is read. Without it
    // two distinct provider events double-book the clawback — see `lockDispute`.
    await lockDispute(tx, corr.organizationId, ev.providerDisputeId!);
    // ── Upsert the dispute row by (org, provider_dispute_id) ──────────────────
    let [row] = await tx
      .select()
      .from(disputes)
      .where(
        and(
          eq(disputes.organizationId, corr.organizationId),
          eq(disputes.providerDisputeId, ev.providerDisputeId!),
        ),
      )
      .limit(1);
    // A replayed `dispute.created` finds the row and must not re-fire the policy.
    const wasNewRow = !row;
    if (!row) {
      [row] = await tx
        .insert(disputes)
        .values({
          publicId: publicId("dsp"),
          organizationId: corr.organizationId,
          businessId: corr.businessId,
          customerId: corr.customerId,
          paymentId: corr.paymentId,
          invoiceId: corr.invoiceId,
          providerKey,
          providerDisputeId: ev.providerDisputeId!,
          providerChargeId: ev.providerChargeId ?? null,
          status: "needs_response",
          reason: ev.disputeReason ?? null,
          amountMinor: amount,
          currency,
          evidenceDueBy: ev.evidenceDueBy ?? null,
        })
        .returning();
    } else {
      // Refresh soft fields on replay/later events (reason/evidence may arrive later).
      const patch: Partial<typeof disputes.$inferInsert> = {};
      if (ev.disputeReason != null && ev.disputeReason !== row.reason)
        patch.reason = ev.disputeReason;
      if (ev.evidenceDueBy != null) patch.evidenceDueBy = ev.evidenceDueBy;
      if (corr.paymentId && !row.paymentId) {
        patch.paymentId = corr.paymentId;
        patch.invoiceId = corr.invoiceId;
        patch.customerId = corr.customerId;
      }
      if (Object.keys(patch).length) {
        [row] = await tx.update(disputes).set(patch).where(eq(disputes.id, row.id)).returning();
      }
    }
    const dispute = row!;
    const policyCtx = {
      customerId: dispute.customerId ?? null,
      invoiceId: dispute.invoiceId ?? null,
      publicId: dispute.publicId,
    };
    const firePolicy = await applyDisputeTransition(
      tx,
      dispute,
      ev.type as DisputeEventType,
      corr,
      wasNewRow,
      { disputeStatus: ev.disputeStatus, amountWonMinor: ev.disputeAmountWonMinor },
    );
    return { firePolicy, policyCtx };
  });

  // ── 0244: the business's chargeback policy, outside the transaction ─────────
  if (policy.firePolicy) {
    await runChargebackPolicy({
      organizationId: corr.organizationId,
      businessId: corr.businessId,
      ...policy.policyCtx,
      currency,
      amountMinor: amount,
      phase: policy.firePolicy,
    });
  }
  return "processed";
}

export type DisputeEventType =
  | "dispute.created"
  | "dispute.updated"
  | "dispute.funds_withdrawn"
  | "dispute.funds_reinstated"
  | "dispute.won"
  | "dispute.lost"
  | "dispute.closed";

/**
 * One lifecycle step on a dispute row: the status change, its ledger posting and its event.
 * Shared by the gateway webhook path and the hand-recorded path, so both book the same way.
 * Mutates `dispute` to the new state. Returns the chargeback-policy phase to fire, if any.
 * The caller holds `lockDispute` and the transaction.
 *
 * Amounts come from what THIS dispute already posted (`disputeBooked`), not from its row:
 * a withdrawal can be capped, a win can be partial, and a reversal can absorb held funds.
 * Cash taken out by disputes never exceeds what the payment still holds (`cashLeftForDispute`).
 */
export async function applyDisputeTransition(
  tx: Tx,
  dispute: DisputeRow,
  type: DisputeEventType,
  scope: { organizationId: string; businessId: string; customerId: string | null },
  wasNewRow: boolean,
  opts: {
    /** `dispute.updated`: the gateway's status in our vocabulary, when known. */
    disputeStatus?: string | null;
    /** `dispute.won` / `funds_reinstated`: the amount won back; absent = all of it. */
    amountWonMinor?: bigint | null;
  } = {},
): Promise<"initiated" | "lost" | null> {
  let firePolicy: "initiated" | "lost" | null = null;
  const base = {
    organizationId: scope.organizationId,
    businessId: scope.businessId,
    customerId: scope.customerId ?? undefined,
  };
  const ledgerCurrency = dispute.currency;
  // Serialize with refunds, late reversals and other disputes on the same money.
  if (type !== "dispute.created" && type !== "dispute.updated")
    await lockDisputedPayments(tx, dispute.paymentId);

  const post = async (debit: string, credit: string, amountMinor: bigint) => {
    if (amountMinor <= 0n) return;
    await postEntries(
      {
        ...base,
        sourceType: "dispute",
        sourceId: dispute.publicId,
        lines: [
          { account: debit, direction: "debit", amountMinor, currency: ledgerCurrency },
          { account: credit, direction: "credit", amountMinor, currency: ledgerCurrency },
        ],
      },
      tx,
    );
  };
  /** At most `want`, capped by what the payment can still lose. */
  const capped = async (want: bigint) => {
    const room = await cashLeftForDispute(tx, dispute);
    if (room == null || room >= want) return want;
    log.warn("a dispute would take more cash than the payment holds — capped", {
      event: "dispute_cash_capped",
      dispute: dispute.publicId,
      type,
      wanted_minor: String(want),
      capped_minor: String(room),
    });
    return room;
  };

  const emit = (t: EventType) =>
    emitEvent(tx, {
      organizationId: scope.organizationId,
      businessId: scope.businessId,
      type: t,
      data: buildEventData(t, { id: dispute.publicId, status: dispute.status }),
    });

  switch (type) {
    case "dispute.created": {
      // No ledger — the network has only OPENED the case; cash is untouched yet.
      // The POLICY may still act: the "on initiated" action stops service to a
      // disputing customer, which does not wait for the money to move.
      if (wasNewRow) firePolicy = "initiated";
      await emit("dispute_created");
      break;
    }

    case "dispute.updated": {
      // Status refresh only. If the update is the first word we hear of the case, it
      // opens it: CREATED arriving later finds the row and would not fire the policy.
      if (wasNewRow) {
        firePolicy = "initiated";
        await emit("dispute_created");
      }
      const next = opts.disputeStatus;
      const open = (OPEN_DISPUTE_STATUSES as readonly string[]).includes(dispute.status);
      if (
        open &&
        (next === "needs_response" || next === "under_review") &&
        next !== dispute.status
      ) {
        await tx.update(disputes).set({ status: next }).where(eq(disputes.id, dispute.id));
        dispute.status = next;
      }
      break;
    }

    case "dispute.funds_withdrawn": {
      // TERMINAL FIRST, and it is a money guard, not tidiness (2026-08-28).
      //
      // Webhook deliveries are not ordered. A quickly-lost dispute delivers its closure
      // before its clawback often enough that `scripts/verify-concurrent-dispute.ts`
      // reproduces it with no concurrency at all: `dispute.lost` on a dispute whose funds
      // were not separately withdrawn books the whole economic outcome (dr dispute_losses
      // / cr cash), and this branch — which guarded only on `fundsWithdrawn`, never on the
      // case being over — then credited THE SAME CASH AGAIN. Measured 3000 credited for
      // one 1500 chargeback, plus a phantom 1500 `disputed_funds` asset on a closed case.
      //
      // A late clawback notice about a case we have already settled carries no new money:
      // won → the cash is back, lost/closed → the cash is gone and expensed. Post nothing
      // and leave `fundsWithdrawn` alone (flipping it to 'true' on a LOST dispute would
      // let a subsequent `won` "reverse" a clawback that was already expensed as a loss).
      // The event is still emitted, so consumers see the notice.
      const terminal =
        dispute.status === "won" || dispute.status === "lost" || dispute.status === "closed";
      if (terminal) {
        log.error("funds_withdrawn arrived after the dispute closed — no ledger posted", {
          event: "dispute_late_funds_withdrawn",
          dispute: dispute.publicId,
          status: dispute.status,
        });
      }
      // The payment's money has not landed yet, so there is nothing to take back: ask again
      // later (the error makes the gateway redeliver) rather than mark it withdrawn.
      if (!terminal && dispute.fundsWithdrawn !== "true") {
        const pays = await disputedPayments(tx, dispute.paymentId);
        if (
          pays.some((p) => p.status === "pending") &&
          (await cashLeftForDispute(tx, dispute)) === 0n
        )
          throw new Error(
            `dispute ${dispute.publicId}: funds withdrawn before its payment settled; retried later`,
          );
      }
      if (!terminal && dispute.fundsWithdrawn !== "true") {
        // The network clawed the cash back while the case is contested: move it out of
        // cash into a held asset — no more than the payment still holds, so a second
        // dispute or a late reversal on the same money cannot take it twice.
        await post("disputed_funds", "cash", await capped(dispute.amountMinor));
        // DELIBERATE: we do NOT change the invoice status here. A paid invoice
        // stays paid — reopening it would wrongly re-trigger dunning against the
        // customer. The chargeback is tracked on the dispute row + the ledger
        // (the cash clawback), independently of the invoice's collection state.
        await tx
          .update(disputes)
          .set({ fundsWithdrawn: "true", status: "under_review" })
          .where(eq(disputes.id, dispute.id));
        dispute.fundsWithdrawn = "true";
        dispute.status = "under_review";
      }
      await emit("dispute_funds_withdrawn");
      break;
    }

    case "dispute.won":
    case "dispute.funds_reinstated": {
      const booked = await disputeBooked(tx, scope.organizationId, dispute.publicId);
      const wonMinor = opts.amountWonMinor ?? null;
      const upTo = (n: bigint) => (wonMinor == null || wonMinor > n ? n : wonMinor);
      if (dispute.fundsWithdrawn === "true") {
        // Reinstate what was won; on a partial win the rest of the held funds is a loss.
        const back = upTo(booked.held);
        await post("cash", "disputed_funds", back);
        await post("dispute_losses", "disputed_funds", booked.held - back);
        await tx
          .update(disputes)
          .set({ fundsWithdrawn: "false", status: "won", closedAt: stampNow() })
          .where(eq(disputes.id, dispute.id));
        dispute.fundsWithdrawn = "false";
        dispute.status = "won";
      } else if (dispute.status === "lost" || dispute.status === "closed") {
        // A win after the loss was booked: what the loss took comes back. Once only —
        // the row is `won` after this, and a second win finds nothing to undo.
        await post("cash", "dispute_losses", upTo(booked.loss));
        await tx
          .update(disputes)
          .set({ status: "won", closedAt: stampNow() })
          .where(eq(disputes.id, dispute.id));
        dispute.status = "won";
      } else if (dispute.status !== "won") {
        // Never withdrawn: a partial win means the rest was taken.
        if (wonMinor != null && wonMinor < dispute.amountMinor)
          await post("dispute_losses", "cash", await capped(dispute.amountMinor - wonMinor));
        await tx
          .update(disputes)
          .set({ status: "won", closedAt: stampNow() })
          .where(eq(disputes.id, dispute.id));
        dispute.status = "won";
      }
      await emit(type === "dispute.funds_reinstated" ? "dispute_funds_reinstated" : "dispute_won");
      break;
    }

    case "dispute.lost": {
      // Only realize a loss from a non-terminal state. Guarding against 'won'
      // too (not just 'lost') prevents a contradictory won→lost sequence from
      // booking an erroneous loss after the cash was already reinstated.
      if (dispute.status !== "lost" && dispute.status !== "won") {
        if (dispute.fundsWithdrawn === "true") {
          // Realize the loss: clear the held asset to an expense (cash stays gone).
          const booked = await disputeBooked(tx, scope.organizationId, dispute.publicId);
          await post("dispute_losses", "disputed_funds", booked.held);
        } else if (await paymentAlreadyReversed(tx, dispute.paymentId)) {
          // A gateway reversal already took this cash and reopened the invoice
          // (`payment_reversal`). Booking the loss against cash again would count it twice.
          log.warn("dispute lost on a payment already reversed — no second cash posting", {
            event: "dispute_lost_after_reversal",
            dispute: dispute.publicId,
          });
        } else {
          // Funds were never withdrawn separately — book the loss straight against cash.
          await post("dispute_losses", "cash", await capped(dispute.amountMinor));
        }
        await tx
          .update(disputes)
          .set({ fundsWithdrawn: "false", status: "lost", closedAt: stampNow() })
          .where(eq(disputes.id, dispute.id));
        dispute.status = "lost";
        // Inside the transition guard, so exactly once per dispute.
        firePolicy = "lost";
      }
      await emit("dispute_lost");
      break;
    }

    case "dispute.closed": {
      if (dispute.status !== "won" && dispute.status !== "lost") {
        // If funds were withdrawn and the dispute closes without an explicit
        // won/lost, the held `disputed_funds` asset must not dangle — realize it
        // as a loss (the money left our account and isn't coming back).
        if (dispute.fundsWithdrawn === "true") {
          const booked = await disputeBooked(tx, scope.organizationId, dispute.publicId);
          await post("dispute_losses", "disputed_funds", booked.held);
        }
        await tx
          .update(disputes)
          .set({ fundsWithdrawn: "false", status: "closed", closedAt: stampNow() })
          .where(eq(disputes.id, dispute.id));
        dispute.status = "closed";
      }
      await emit("dispute_closed");
      break;
    }
  }
  return firePolicy;
}

/** What one dispute has posted so far, from its own ledger lines. */
export async function disputeBooked(
  tx: Tx,
  organizationId: string,
  disputePublicId: string,
): Promise<{ held: bigint; loss: bigint; cashOut: bigint }> {
  const rows = await tx
    .select({
      account: ledgerEntries.account,
      direction: ledgerEntries.direction,
      n: sql<string>`sum(${ledgerEntries.amountMinor})`,
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.organizationId, organizationId),
        eq(ledgerEntries.sourceType, "dispute"),
        eq(ledgerEntries.sourceId, disputePublicId),
      ),
    )
    .groupBy(ledgerEntries.account, ledgerEntries.direction);
  const net = (account: string, plus: "debit" | "credit") =>
    rows
      .filter((r) => r.account === account)
      .reduce((s, r) => s + (r.direction === plus ? 1n : -1n) * BigInt(r.n ?? "0"), 0n);
  return {
    held: net("disputed_funds", "debit"),
    loss: net("dispute_losses", "debit"),
    cashOut: net("cash", "credit"),
  };
}

/** The payments a dispute's money comes from: the payment, or every child of its request. */
async function disputedPayments(tx: Tx, paymentId: string | null) {
  if (!paymentId) return [];
  const [pay] = await tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
  if (!pay) return [];
  if (!pay.paymentRequestId) return [pay];
  return tx
    .select()
    .from(payments)
    .where(eq(payments.paymentRequestId, pay.paymentRequestId))
    .orderBy(asc(payments.id));
}

/** Row-lock the disputed payments, in id order, so every writer of that money queues. */
async function lockDisputedPayments(tx: Tx, paymentId: string | null): Promise<void> {
  const pays = await disputedPayments(tx, paymentId);
  if (!pays.length) return;
  await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      inArray(
        payments.id,
        pays.map((p) => p.id),
      ),
    )
    .orderBy(asc(payments.id))
    .for("update");
}

/**
 * Cash a dispute may still take: collected (succeeded payments) less refunds not failed less
 * cash every dispute on the same money already took. Null = no cap is computable (no payment,
 * or a different currency).
 */
async function cashLeftForDispute(tx: Tx, dispute: DisputeRow): Promise<bigint | null> {
  const pays = await disputedPayments(tx, dispute.paymentId);
  if (!pays.length || pays.some((p) => p.currency !== dispute.currency)) return null;
  const ids = pays.map((p) => p.id);
  const collected = pays
    .filter((p) => p.status === "succeeded")
    .reduce((s, p) => s + p.amountMinor, 0n);
  const [ref] = await tx
    .select({ n: sql<string>`coalesce(sum(${refunds.amountMinor}), 0)` })
    .from(refunds)
    .where(and(inArray(refunds.paymentId, ids), ne(refunds.status, "failed")));
  const siblings = await tx
    .select({ publicId: disputes.publicId })
    .from(disputes)
    .where(
      and(eq(disputes.organizationId, dispute.organizationId), inArray(disputes.paymentId, ids)),
    );
  let taken = 0n;
  for (const d of siblings)
    taken += (await disputeBooked(tx, dispute.organizationId, d.publicId)).cashOut;
  const left = collected - BigInt(ref?.n ?? "0") - taken;
  return left > 0n ? left : 0n;
}

/**
 * A late-failure reversal of money whose disputes already moved its cash. What the disputes
 * on `paymentIds` hold or expensed moves to the receivable instead of leaving cash twice, at
 * most `capMinor` in all (what the payments still hold after refunds). Returns the amount
 * moved, which the caller leaves out of its own cash credit. The caller holds the row locks.
 */
export async function absorbDisputesIntoReversal(
  tx: Tx,
  pay: {
    organizationId: string;
    businessId: string;
    customerId: string | null;
    currency: string;
  },
  paymentIds: string[],
  capMinor: bigint,
): Promise<bigint> {
  if (!paymentIds.length || capMinor <= 0n) return 0n;
  const rows = await tx
    .select()
    .from(disputes)
    .where(
      and(eq(disputes.organizationId, pay.organizationId), inArray(disputes.paymentId, paymentIds)),
    )
    .orderBy(asc(disputes.createdAt));
  let moved = 0n;
  for (const d of rows) {
    if (d.currency !== pay.currency) continue;
    const booked = await disputeBooked(tx, pay.organizationId, d.publicId);
    const room = capMinor - moved;
    const held = booked.held < room ? booked.held : room;
    const loss = booked.loss < room - held ? booked.loss : room - held;
    if (held <= 0n && loss <= 0n) continue;
    const lines: Array<{
      account: string;
      direction: "debit" | "credit";
      amountMinor: bigint;
      currency: string;
    }> = [
      {
        account: "accounts_receivable",
        direction: "debit",
        amountMinor: held + loss,
        currency: pay.currency,
      },
    ];
    if (held > 0n)
      lines.push({
        account: "disputed_funds",
        direction: "credit",
        amountMinor: held,
        currency: pay.currency,
      });
    if (loss > 0n)
      lines.push({
        account: "dispute_losses",
        direction: "credit",
        amountMinor: loss,
        currency: pay.currency,
      });
    await postEntries(
      {
        organizationId: pay.organizationId,
        businessId: pay.businessId,
        ...(pay.customerId ? { customerId: pay.customerId } : {}),
        sourceType: "dispute",
        sourceId: d.publicId,
        lines,
      },
      tx,
    );
    moved += held + loss;
    log.warn("a late reversal took money a dispute had already taken — not taken twice", {
      event: "reversal_absorbed_dispute",
      dispute: d.publicId,
      held_minor: String(held),
      loss_minor: String(loss),
    });
  }
  return moved;
}

/**
 * Apply the business's chargeback policy (0244) after the transaction. Never throws: a
 * failed webhook would be retried, the retry would find the transition already made, and the
 * policy would then be skipped, so a throw turns a partial application into a silent,
 * permanent one. Reported instead.
 */
export async function runChargebackPolicy(input: {
  organizationId: string;
  businessId: string;
  publicId: string;
  customerId: string | null;
  invoiceId: string | null;
  currency: string;
  amountMinor: bigint;
  phase: "initiated" | "lost";
}): Promise<void> {
  try {
    const { applyChargebackPolicy } = await import("./chargeback-policy");
    await applyChargebackPolicy({
      organizationId: input.organizationId,
      businessId: input.businessId,
      disputePublicId: input.publicId,
      customerId: input.customerId,
      invoiceId: input.invoiceId,
      currency: input.currency,
      amountMinor: input.amountMinor,
      phase: input.phase,
      now: new Date(),
    });
  } catch (e) {
    log.error(e, {
      event: "chargeback_policy_failed",
      dispute: input.publicId,
      businessId: input.businessId,
      phase: input.phase,
    });
  }
}

/** The disputed payment was already taken back by a late-failure reversal. */
async function paymentAlreadyReversed(tx: Tx, paymentId: string | null): Promise<boolean> {
  if (!paymentId) return false;
  const [p] = await tx
    .select({ failureCode: payments.failureCode })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1);
  return p?.failureCode === "late_failure";
}

/** Best-effort provider key from the raw payload shape (tmtest carries none inline). */
function inferProviderKey(ev: NormalizedProviderEvent): string {
  const raw = ev.raw as
    | { object?: string; event?: string; event_type?: string; resource_type?: string }
    | undefined;
  if (!raw) return "tmtest";
  if (typeof raw.event === "string") return "razorpay";
  if (typeof raw.resource_type === "string") return "gocardless";
  if (typeof raw.event_type === "string") return "paypal";
  if (raw.object === "event") return "stripe";
  return "tmtest";
}

// ── Read API ─────────────────────────────────────────────────────────────────

/**
 * The paginated dispute list — `has_more` / `next_cursor` / `total`, per the contract in
 * `docs/GUIDE.md` §3.4.
 *
 * WHY THIS EXISTS. `listDisputes` below returns a bare array capped at
 * `min(limit ?? 50, 200)`, so a business past fifty chargebacks simply could not reach the
 * rest and no caller could tell: there was no `has_more` to check. Same defect class as
 * `listGatewayRequests`, where the missing flag hid **61 of 111 rows** — the `ui` skill's rule
 * ("if the endpoint paginates, the wrapper returns `PagedList<T>`") had never been applied
 * here. It also made disputes uncountable, which is why the sidebar promoted Disputes without
 * a badge: a page size is not a count.
 *
 * Keyset on `(created_at, public_id)` — `disputes_biz_created_idx` already covers it — and the
 * tiebreak is a TEXT public id, so a stale cursor looks up to no row and degrades to the first
 * page rather than raising `22P02` the way a raw-uuid tiebreak does (see `isUuidCursor`).
 */
/** Still awaiting a decision: the gateway wants evidence, or is weighing it. */
export const OPEN_DISPUTE_STATUSES = ["needs_response", "under_review"] as const;

export async function listDisputesPage(
  organizationId: string,
  businessId: string,
  opts?: {
    status?: string;
    /** Only disputes still awaiting a decision (`OPEN_DISPUTE_STATUSES`). */
    open?: boolean;
    /** `evidence_due_by`: soonest deadline first, none last. Pages by offset. */
    sort?: "created" | "evidence_due_by";
    /** Only disputes on this payment (its public id). An unknown id answers empty. */
    payment?: string;
    limit?: number;
    startingAfter?: string;
    before?: Date;
  },
): Promise<ListPage<DisputeRow>> {
  const limit = clampLimit(opts?.limit);
  return withTenant(organizationId, async (tx) => {
    // Same RLS-scoped guard the readers below use: a business outside the caller's org
    // answers as empty, never as another tenant's rows.
    const guard = await tx
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    if (guard.length === 0) return { data: [], hasMore: false, nextCursor: null, total: 0 };

    const conds = [
      eq(disputes.organizationId, organizationId),
      eq(disputes.businessId, businessId),
    ];
    if (opts?.status) conds.push(eq(disputes.status, opts.status));
    if (opts?.open) conds.push(inArray(disputes.status, [...OPEN_DISPUTE_STATUSES]));
    if (opts?.before) conds.push(lt(disputes.createdAt, opts.before));
    if (opts?.payment) {
      const [pay] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.businessId, businessId), eq(payments.publicId, opts.payment)))
        .limit(1);
      if (!pay) return { data: [], hasMore: false, nextCursor: null, total: 0 };
      conds.push(eq(disputes.paymentId, pay.id));
    }

    const byDeadline = opts?.sort === "evidence_due_by";
    const parsed = parseCursor(opts?.startingAfter);
    // A nullable deadline has no clean keyset, so that order pages by offset instead.
    const keysetId = byDeadline ? undefined : parsed.keysetId;
    const offset = parsed.offset;
    // First page only, per the contract — a later page answers `null` rather than paying for
    // a second count(*) on every scroll.
    const total =
      keysetId || offset
        ? null
        : ((
            await tx
              .select({ n: countExpr })
              .from(disputes)
              .where(and(...conds))
          )[0]?.n ?? 0);

    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({
          // `::text` deliberately: drizzle maps timestamptz to a JS Date, which holds only
          // milliseconds, and reading the anchor through a typed select truncated Postgres's
          // microseconds — dropping every row that shared the millisecond. See the PRECISION
          // note in `keysetCondition`.
          sortValue: sql<string>`${disputes.createdAt}::text`,
          publicId: disputes.publicId,
        })
        .from(disputes)
        .where(and(eq(disputes.businessId, businessId), eq(disputes.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        disputes.createdAt,
        disputes.publicId,
        cursor ? { sortValue: cursor.sortValue, tiebreak: cursor.publicId } : undefined,
        true,
      );
      if (seek) pageConds.push(seek);
    }

    if (byDeadline) {
      const rows = await tx
        .select()
        .from(disputes)
        .where(and(...conds))
        .orderBy(sql`${disputes.evidenceDueBy} asc nulls last`, asc(disputes.publicId))
        .limit(limit + 1)
        .offset(offset);
      return toPage(rows, limit, { keyset: false, offset, keyOf: (r) => r.publicId, total });
    }

    const rows = await tx
      .select()
      .from(disputes)
      .where(and(...pageConds))
      .orderBy(...pageOrder(disputes.createdAt, disputes.publicId, true, true))
      .limit(limit + 1)
      .offset(0);

    return toPage(rows, limit, { keyset: true, offset, keyOf: (r) => r.publicId, total });
  });
}

/**
 * Capped, unpaginated read. **Internal callers only** — the API route uses
 * `listDisputesPage`, because this shape cannot say whether rows remain.
 */
export async function listDisputes(
  organizationId: string,
  businessId: string,
  opts?: { status?: string; limit?: number; before?: Date },
): Promise<DisputeRow[]> {
  // Guard the business belongs to the caller's org (RLS-scoped read).
  const guard = await withTenant(organizationId, (tx) =>
    tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
  );
  if (guard.length === 0) return [];
  const conds = [eq(disputes.organizationId, organizationId), eq(disputes.businessId, businessId)];
  if (opts?.status) conds.push(eq(disputes.status, opts.status));
  if (opts?.before) conds.push(lt(disputes.createdAt, opts.before));
  return systemDb
    .select()
    .from(disputes)
    .where(and(...conds))
    .orderBy(desc(disputes.createdAt))
    .limit(Math.min(opts?.limit ?? 50, 200));
}

export async function getDispute(
  organizationId: string,
  businessId: string,
  id: string,
): Promise<DisputeRow | null> {
  const guard = await withTenant(organizationId, (tx) =>
    tx.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1),
  );
  if (guard.length === 0) return null;
  const [row] = await systemDb
    .select()
    .from(disputes)
    .where(
      and(
        eq(disputes.publicId, id),
        eq(disputes.organizationId, organizationId),
        eq(disputes.businessId, businessId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * True when a person may set this dispute's outcome now: it is still open, and either a person
 * recorded it or its gateway never sends a final state. The same rules `recordDisputeOutcome`
 * enforces, so the dashboard shows the action only where the route accepts it.
 */
export function disputeOutcomeSettableByOperator(
  r: Pick<DisputeRow, "status" | "source" | "providerKey">,
): boolean {
  if (!(OPEN_DISPUTE_STATUSES as readonly string[]).includes(r.status)) return false;
  return r.source === "operator" || operatorRecordsDisputeOutcome(r.providerKey);
}

export function serializeDispute(r: DisputeRow) {
  return {
    object: "dispute",
    id: r.publicId,
    status: r.status,
    reason: r.reason,
    amount_minor: Number(r.amountMinor),
    currency: r.currency,
    funds_withdrawn: r.fundsWithdrawn === "true",
    provider_key: r.providerKey,
    // An operator-recorded dispute has no gateway case id; its stored key is our own id.
    provider_dispute_id: r.source === "operator" ? null : r.providerDisputeId,
    /** `gateway` (from the gateway's dispute events) or `operator` (recorded by a person). */
    source: r.source,
    processor_reference: r.processorReference,
    outcome_settable_by_operator: disputeOutcomeSettableByOperator(r),
    provider_charge_id: r.providerChargeId,
    payment_id: r.paymentId,
    invoice_id: r.invoiceId,
    customer_id: r.customerId,
    evidence_due_by: r.evidenceDueBy,
    opened_at: r.openedAt,
    closed_at: r.closedAt,
    created_at: r.createdAt,
  };
}
