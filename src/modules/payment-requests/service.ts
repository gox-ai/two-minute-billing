/**
 * Payment requests (0388): several open invoices of one customer, paid by ONE gateway charge
 * or one link. Each invoice gets an ordinary child payment (no charge id); the request holds
 * the charge id. See README.md for the bookkeeping rules.
 */
import { methodTypeFor, methodTypeOf } from "@/modules/payments/method-type";
import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { businessNow, stampNow } from "@/platform/clock";
import {
  clampLimit,
  countExpr,
  keysetCondition,
  pageOrder,
  parseCursor,
  toPage,
  type ListPage,
} from "@/platform/list-query";
import {
  businesses,
  customers,
  invoices,
  paymentMethods,
  paymentRequestInvoices,
  paymentRequests,
  payments,
  subscriptions,
  transactions,
} from "@db/schema";
import { emitEvent } from "@/modules/events/emit";
import { isCardInstrument, overCardLimit } from "@/modules/invoicing/card-limit";
import { buildEventData } from "@/modules/events/registry";
import { postEntries } from "@/modules/ledger/service";
import { OPEN_INVOICE_STATUSES, dunningFieldsOnSettle } from "@/modules/invoicing/status";
import {
  CollectionInFlightError,
  claimCollection,
  invoiceOutstanding,
  isAutoCollectOn,
  pendingPaymentForInvoice,
  releaseCollection,
} from "@/modules/invoicing/service";
import {
  chargeOrder,
  chargeWithMethod,
  resolveChargeAdapter,
  resolveChargeCandidates,
  shouldTryBackup,
  tmtestOutcome,
  lostChargeHandle,
  type ChargeAttempt,
  type LostChargeHandle,
  type Pm,
} from "@/modules/invoicing/collection";
import { applyCreditOnFile } from "@/modules/customers/collect";
import {
  compareForApplication,
  resolvePaymentApplication,
  settlesNewestFirst,
} from "@/modules/payments/application-config";
import {
  settleAbandonedCapture,
  settlePaymentFailed,
  settlePaymentSucceeded,
} from "@/modules/payments/settlement";
import { UNAPPLIED_CAPTURE_KEY } from "@/modules/payments/unapplied-capture-key";
import { recordTransaction, setTransactionStatus } from "@/modules/transactions/service";
import { createReceiptForRequestSettlement } from "@/modules/receipts/service";
import { GatewayRouterError } from "@/modules/gateway/router";
import { ProviderIndeterminateError, strandedObjectId } from "@/providers/types";

const log = createLogger("payment-requests");

export type PaymentRequest = typeof paymentRequests.$inferSelect;
export type RequestOrigin = "manual" | "dunning" | "portal";
type Invoice = typeof invoices.$inferSelect;

export class PaymentRequestError extends Error {
  constructor(
    message: string,
    readonly code: "invalid" | "not_found" | "conflict" = "invalid",
  ) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

const MAX_INVOICES = 50;
const EXPIRY_DAYS = 30;
const OPEN_SET = OPEN_INVOICE_STATUSES as readonly string[];

export interface RequestLine {
  invoice: Invoice;
  position: number;
  state: string;
  createdOutstandingMinor: bigint;
  outstandingMinor: bigint;
}

export interface RequestView {
  request: PaymentRequest;
  customerPublicId: string;
  paymentMethodPublicId: string | null;
  lines: RequestLine[];
  /** Σ outstanding of the lines still open. */
  amountMinor: bigint;
}

async function loadRequest(tx: Tx, businessId: string, pid: string, lock = false) {
  const q = tx
    .select()
    .from(paymentRequests)
    .where(and(eq(paymentRequests.businessId, businessId), eq(paymentRequests.publicId, pid)))
    .limit(1);
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

async function emitRequestEvent(
  tx: Tx,
  type:
    | "payment_request_created"
    | "payment_request_paid"
    | "payment_request_payment_failed"
    | "payment_request_canceled"
    | "payment_request_expired",
  req: PaymentRequest,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const [cus] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, req.customerId))
    .limit(1);
  const lines = await tx
    .select({ publicId: invoices.publicId })
    .from(paymentRequestInvoices)
    .innerJoin(invoices, eq(invoices.id, paymentRequestInvoices.invoiceId))
    .where(eq(paymentRequestInvoices.requestId, req.id))
    .orderBy(asc(paymentRequestInvoices.position));
  await emitEvent(tx, {
    organizationId: req.organizationId,
    businessId: req.businessId,
    type,
    data: buildEventData(
      type,
      {
        id: req.publicId,
        status: req.status,
        mode: req.mode,
        customer: cus?.publicId ?? null,
        currency: req.currency,
        invoices: lines.map((l) => l.publicId),
        ...extra,
      },
      req.resourceVersion,
    ),
  });
}

/**
 * The lines as they stand now. An invoice paid, voided or written off since creation is
 * marked `settled_elsewhere` and drops out; when every line has dropped out, an open
 * request is canceled. Runs on the caller's transaction.
 */
async function refreshLines(tx: Tx, req: PaymentRequest): Promise<RequestLine[]> {
  const rows = await tx
    .select({ line: paymentRequestInvoices, invoice: invoices })
    .from(paymentRequestInvoices)
    .innerJoin(invoices, eq(invoices.id, paymentRequestInvoices.invoiceId))
    .where(eq(paymentRequestInvoices.requestId, req.id))
    .orderBy(asc(paymentRequestInvoices.position));
  const out: RequestLine[] = [];
  const live = req.status === "open" || req.status === "processing";
  for (const { line, invoice } of rows) {
    let state = line.state;
    let outstanding = 0n;
    if (state === "open") {
      outstanding = OPEN_SET.includes(invoice.status)
        ? (await invoiceOutstanding(tx, invoice)).remainingMinor
        : 0n;
      // A processing request's children are pending: nothing has settled elsewhere yet.
      if (outstanding <= 0n && req.status === "open") {
        state = "settled_elsewhere";
        await tx
          .update(paymentRequestInvoices)
          .set({ state })
          .where(
            and(
              eq(paymentRequestInvoices.requestId, req.id),
              eq(paymentRequestInvoices.invoiceId, invoice.id),
            ),
          );
      }
    }
    out.push({
      invoice,
      position: line.position,
      state,
      createdOutstandingMinor: line.createdOutstandingMinor,
      outstandingMinor: state === "open" ? outstanding : 0n,
    });
  }
  if (live && req.status === "open" && out.every((l) => l.state !== "open")) {
    const anyPaid = out.some((l) => l.state === "paid");
    const [upd] = await tx
      .update(paymentRequests)
      .set(
        anyPaid
          ? { status: "paid", paidAt: req.paidAt ?? stampNow() }
          : { status: "canceled", cancelReason: "settled_elsewhere" },
      )
      .where(and(eq(paymentRequests.id, req.id), eq(paymentRequests.status, "open")))
      .returning();
    if (upd && !anyPaid) await emitRequestEvent(tx, "payment_request_canceled", upd);
    if (upd) Object.assign(req, upd);
  }
  return out;
}

async function viewOf(tx: Tx, req: PaymentRequest): Promise<RequestView> {
  const lines = await refreshLines(tx, req);
  const [cus] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, req.customerId))
    .limit(1);
  const [pm] = req.paymentMethodId
    ? await tx
        .select({ publicId: paymentMethods.publicId })
        .from(paymentMethods)
        .where(eq(paymentMethods.id, req.paymentMethodId))
        .limit(1)
    : [];
  return {
    request: req,
    customerPublicId: cus?.publicId ?? "",
    paymentMethodPublicId: pm?.publicId ?? null,
    lines,
    amountMinor: lines.reduce((s, l) => s + l.outstandingMinor, 0n),
  };
}

export function serializePaymentRequest(v: RequestView) {
  const r = v.request;
  return {
    object: "payment_request",
    id: r.publicId,
    status: r.status,
    mode: r.mode,
    origin: r.origin,
    customer: v.customerPublicId,
    currency: r.currency,
    amount_minor: Number(v.amountMinor),
    created_amount_minor: Number(r.createdAmountMinor),
    payment_method: v.paymentMethodPublicId,
    email: r.email,
    attempt_count: r.attemptCount,
    last_payment_error: r.lastPaymentError ?? null,
    cancel_reason: r.cancelReason,
    expires_at: r.expiresAt,
    paid_at: r.paidAt,
    lines: v.lines.map((l) => ({
      invoice: l.invoice.publicId,
      invoice_number: l.invoice.number,
      invoice_status: l.invoice.status,
      due_date: l.invoice.dueDate,
      position: l.position,
      state: l.state,
      created_outstanding_minor: Number(l.createdOutstandingMinor),
      amount_due_minor: Number(l.outstandingMinor),
    })),
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    resource_version: r.resourceVersion,
  };
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createPaymentRequest(input: {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  invoicePublicIds: string[];
  mode: "charge" | "link";
  paymentMethodPublicId?: string | null;
  email?: string | null;
  createdBy?: string | null;
  /** Default `manual`. `dunning` is the clock's combined retry; `portal` the customer's own. */
  origin?: RequestOrigin;
}): Promise<RequestView> {
  const ids = input.invoicePublicIds;
  if (ids.length < 1 || ids.length > MAX_INVOICES)
    throw new PaymentRequestError(
      `We could not create the payment request. Select 1 to ${MAX_INVOICES} invoices.`,
    );
  if (new Set(ids).size !== ids.length)
    throw new PaymentRequestError(
      "We could not create the payment request. The same invoice is in the list two times. Remove the duplicate.",
    );
  const now = businessNow(input.businessId);
  const view = await withTenant(input.organizationId, async (tx) => {
    const [cus] = await tx
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.businessId, input.businessId),
          eq(customers.publicId, input.customerPublicId),
        ),
      )
      .limit(1);
    if (!cus)
      throw new PaymentRequestError(
        `We could not find the customer ${input.customerPublicId}.`,
        "not_found",
      );
    const rows = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.businessId, input.businessId), inArray(invoices.publicId, ids)))
      .for("update");
    const byPid = new Map(rows.map((r) => [r.publicId, r]));
    const picked: Array<{ inv: Invoice; outstanding: bigint }> = [];
    for (const pid of ids) {
      const inv = byPid.get(pid);
      if (!inv || inv.customerId !== cus.id)
        throw new PaymentRequestError(
          `We could not find the invoice ${pid} for this customer.`,
          "not_found",
        );
      if (!OPEN_SET.includes(inv.status))
        throw new PaymentRequestError(
          `We could not add invoice ${pid}. It is ${inv.status}. Select only open invoices.`,
        );
      const outstanding = (await invoiceOutstanding(tx, inv)).remainingMinor;
      if (outstanding <= 0n)
        throw new PaymentRequestError(
          `We could not add invoice ${pid}. Nothing is left to pay on it.`,
        );
      const [pending] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.invoiceId, inv.id), eq(payments.status, "pending")))
        .limit(1);
      if (pending)
        throw new PaymentRequestError(
          `We could not add invoice ${pid}. A payment on it is in progress. Try again when it completes.`,
          "conflict",
        );
      picked.push({ inv, outstanding });
    }
    const currencies = new Set(picked.map((p) => p.inv.currency));
    if (currencies.size > 1)
      throw new PaymentRequestError(
        "We could not create the payment request. The invoices use different currencies. Select invoices of one currency.",
      );
    // The business's application order (2.66); `position` keeps it for every later step.
    const newestFirst = settlesNewestFirst(
      resolvePaymentApplication(
        (
          await tx
            .select({ billingRulesConfig: businesses.billingRulesConfig })
            .from(businesses)
            .where(eq(businesses.id, input.businessId))
            .limit(1)
        )[0],
      ),
    );
    picked.sort((a, b) => compareForApplication(a.inv, b.inv, newestFirst));
    if (input.mode === "charge") {
      // That customer was promised no automatic charge on a manual-payment invoice.
      for (const p of picked) {
        const [sub] = p.inv.subscriptionId
          ? await tx
              .select({ ac: subscriptions.autoCollection })
              .from(subscriptions)
              .where(eq(subscriptions.id, p.inv.subscriptionId))
              .limit(1)
          : [];
        if (!isAutoCollectOn(sub?.ac ?? null, cus.autoCollection))
          throw new PaymentRequestError(
            `We could not create the payment request. Invoice ${p.inv.number ?? p.inv.publicId} uses manual payment, so we must not charge it. Use mode link.`,
          );
      }
      const [anyPm] = await tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(eq(paymentMethods.customerId, cus.id))
        .limit(1);
      if (!anyPm)
        throw new PaymentRequestError(
          "We could not create the payment request. The customer has no payment method that we can charge. Use mode link.",
        );
    }
    let pmId: string | null = null;
    if (input.paymentMethodPublicId) {
      const [pm] = await tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.customerId, cus.id),
            eq(paymentMethods.publicId, input.paymentMethodPublicId),
          ),
        )
        .limit(1);
      if (!pm)
        throw new PaymentRequestError(
          `We could not find the payment method ${input.paymentMethodPublicId} for this customer.`,
          "not_found",
        );
      pmId = pm.id;
    }
    const total = picked.reduce((s, p) => s + p.outstanding, 0n);
    const [req] = await tx
      .insert(paymentRequests)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: cus.id,
        publicId: publicId("preq"),
        status: "open",
        mode: input.mode,
        origin: input.origin ?? "manual",
        currency: picked[0]!.inv.currency,
        createdAmountMinor: total,
        paymentMethodId: pmId,
        email: input.email ?? null,
        expiresAt: new Date(now.getTime() + EXPIRY_DAYS * 86_400_000),
        createdBy: input.createdBy ?? null,
      })
      .returning();
    try {
      await tx.insert(paymentRequestInvoices).values(
        picked.map((p, i) => ({
          requestId: req!.id,
          invoiceId: p.inv.id,
          organizationId: input.organizationId,
          businessId: input.businessId,
          position: i,
          createdOutstandingMinor: p.outstanding,
        })),
      );
    } catch (e) {
      if (
        (e as { code?: string })?.code === "23505" ||
        /payment_request_invoices_open_uq/.test(String(e))
      )
        throw new PaymentRequestError(
          "We could not create the payment request. An invoice is already in another open payment request. Cancel that request first.",
          "conflict",
        );
      throw e;
    }
    await emitRequestEvent(tx, "payment_request_created", req!);
    return viewOf(tx, req!);
  }).catch((e) => {
    const cause = (e as { cause?: { code?: string } })?.cause;
    if (cause?.code === "23505")
      throw new PaymentRequestError(
        "We could not create the payment request. An invoice is already in another open payment request. Cancel that request first.",
        "conflict",
      );
    throw e;
  });
  return view;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The request view on the caller's transaction. */
export async function loadPaymentRequestView(
  tx: Tx,
  businessId: string,
  pid: string,
): Promise<RequestView | null> {
  const req = await loadRequest(tx, businessId, pid);
  return req ? viewOf(tx, req) : null;
}

export async function getPaymentRequest(
  organizationId: string,
  businessId: string,
  pid: string,
  opts?: { customerId?: string },
): Promise<RequestView | null> {
  return withTenant(organizationId, async (tx) => {
    const req = await loadRequest(tx, businessId, pid);
    if (!req || (opts?.customerId && req.customerId !== opts.customerId)) return null;
    return viewOf(tx, req);
  });
}

export async function listPaymentRequestsPage(
  organizationId: string,
  businessId: string,
  f: {
    customerPublicId?: string;
    status?: string;
    customerId?: string;
    /** Leave out requests of this origin (the portal hides the clock's own). */
    excludeOrigin?: RequestOrigin;
    startingAfter?: string;
    limit?: number;
  } = {},
): Promise<ListPage<RequestView>> {
  const limit = clampLimit(f.limit);
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(paymentRequests.businessId, businessId)];
    if (f.customerId) conds.push(eq(paymentRequests.customerId, f.customerId));
    if (f.customerPublicId)
      conds.push(
        sql`${paymentRequests.customerId} = (select id from customers where business_id = ${businessId} and public_id = ${f.customerPublicId})`,
      );
    if (f.status) conds.push(inArray(paymentRequests.status, f.status.split(",")));
    if (f.excludeOrigin) conds.push(sql`${paymentRequests.origin} <> ${f.excludeOrigin}`);
    const { keysetId, offset } = parseCursor(f.startingAfter);
    const total =
      keysetId || offset
        ? null
        : ((
            await tx
              .select({ n: countExpr })
              .from(paymentRequests)
              .where(and(...conds))
          )[0]?.n ?? 0);
    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${paymentRequests.createdAt}::text`,
          publicId: paymentRequests.publicId,
        })
        .from(paymentRequests)
        .where(
          and(eq(paymentRequests.businessId, businessId), eq(paymentRequests.publicId, keysetId)),
        )
        .limit(1);
      const seek = keysetCondition(
        paymentRequests.createdAt,
        paymentRequests.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        true,
      );
      if (seek) pageConds.push(seek);
    }
    const rows = await tx
      .select()
      .from(paymentRequests)
      .where(and(...pageConds))
      .orderBy(...pageOrder(paymentRequests.createdAt, paymentRequests.publicId, true, true))
      .limit(limit + 1);
    const page = toPage(rows, limit, {
      keyset: true,
      offset,
      keyOf: (r) => r.publicId,
      total,
    });
    const data: RequestView[] = [];
    for (const r of page.data) data.push(await viewOf(tx, r));
    return { ...page, data };
  });
}

// ── Charge ──────────────────────────────────────────────────────────────────

const declined = (code: string | undefined) =>
  `We could not charge the payment request. The payment was declined (${code ?? "card_declined"}). We sent the customer a link to pay.`;

/** The shares one attempt charges: each open line's outstanding, in application order. */
interface Share {
  invoiceId: string;
  amountMinor: bigint;
  /** The invoice bills a subscription (a recurring charge under its agreement). */
  recurring?: boolean;
}

/**
 * Charge the request's live total with one `chargeWithMethod` call. `initiator.by` is
 * `merchant` for an operator or API call, `customer` for the portal. Returns the view after.
 *
 * Claims every invoice's collection lease in id order first, so dunning, Collect now and
 * another request cannot charge the same invoice meanwhile.
 */
export async function chargePaymentRequest(input: {
  organizationId: string;
  businessId: string;
  paymentRequestPublicId: string;
  paymentMethodPublicId?: string | null;
  initiator: "merchant" | "customer";
  /** Portal: only this customer's request. */
  customerId?: string;
  /** The clock's combined retry: the charge order it already resolved and checked. */
  candidates?: Pm[];
}): Promise<RequestView> {
  const { organizationId, businessId } = input;
  const now = businessNow(businessId);
  const prep = await withTenant(organizationId, async (tx) => {
    const req = await loadRequest(tx, businessId, input.paymentRequestPublicId, true);
    if (!req || (input.customerId && req.customerId !== input.customerId))
      throw new PaymentRequestError(
        `We could not find the payment request ${input.paymentRequestPublicId}.`,
        "not_found",
      );
    if (req.status !== "open")
      throw new PaymentRequestError(
        `We could not charge the payment request. It is ${req.status}.`,
        "conflict",
      );
    if (req.expiresAt.getTime() <= now.getTime())
      throw new PaymentRequestError(
        "We could not charge the payment request. It has expired. Create a new request.",
        "conflict",
      );
    const lines = (await refreshLines(tx, req)).filter((l) => l.state === "open");
    if (req.status !== "open" || lines.length === 0)
      throw new PaymentRequestError(
        "We could not charge the payment request. Every invoice in it is already settled.",
        "conflict",
      );
    const [cus] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, req.customerId))
      .limit(1);
    if (input.initiator === "merchant") {
      for (const l of lines) {
        const [sub] = l.invoice.subscriptionId
          ? await tx
              .select({ ac: subscriptions.autoCollection })
              .from(subscriptions)
              .where(eq(subscriptions.id, l.invoice.subscriptionId))
              .limit(1)
          : [];
        if (!isAutoCollectOn(sub?.ac ?? null, cus?.autoCollection))
          throw new PaymentRequestError(
            `We could not charge the payment request. Invoice ${l.invoice.number ?? l.invoice.publicId} uses manual payment, so we must not charge it. Send the request link instead.`,
          );
      }
    }
    let overridePm: string | undefined;
    if (input.paymentMethodPublicId) overridePm = input.paymentMethodPublicId;
    else if (req.paymentMethodId) {
      const [pm] = await tx
        .select({ publicId: paymentMethods.publicId })
        .from(paymentMethods)
        .where(eq(paymentMethods.id, req.paymentMethodId))
        .limit(1);
      overridePm = pm?.publicId;
    }
    return { req, lines, customer: cus!, overridePm };
  });
  const { req, customer } = prep;

  const candidates =
    input.candidates ??
    chargeOrder(
      await resolveChargeCandidates({
        organizationId,
        customerId: req.customerId,
        ...(prep.overridePm ? { paymentMethodOverrideId: prep.overridePm } : {}),
        currency: req.currency,
      }),
    );
  if (candidates.length === 0)
    throw new PaymentRequestError(
      "We could not charge the payment request. The customer has no payment method that we can charge. Send the request link instead.",
    );
  // Rails that need a gateway pre-debit notice are not charged from a request in v1.
  // `chargeShares` drops them from every position too; this answers early for the primary.
  if (await isNoticeRail(organizationId, businessId, req.currency, candidates[0]!))
    throw new PaymentRequestError(NOTICE_RAIL_REFUSAL);

  // In-flight guards: a pending payment on any invoice, then the collection lease.
  for (const l of prep.lines) {
    if (await pendingPaymentForInvoice(organizationId, l.invoice.id))
      throw new CollectionInFlightError(l.invoice.publicId);
    // A buyer mid-way through Pay now on this invoice holds a live intent.
    const { liveIntentForInvoice } = await import("@/modules/payment-intents/service");
    if (await liveIntentForInvoice(organizationId, l.invoice.id, now))
      throw new CollectionInFlightError(l.invoice.publicId);
  }
  const ordered = [...prep.lines].sort((a, b) => (a.invoice.id < b.invoice.id ? -1 : 1));
  const claimed: string[] = [];
  try {
    for (const l of ordered) {
      if (!(await claimCollection(organizationId, l.invoice.id, new Date())))
        throw new CollectionInFlightError(l.invoice.publicId);
      claimed.push(l.invoice.id);
    }
    // Credit on file first, invoice by invoice in application order.
    for (const l of prep.lines)
      await applyCreditOnFile({ organizationId, businessId, invoice: l.invoice });
    const shares = await withTenant(organizationId, async (tx) => {
      const out: Share[] = [];
      for (const l of prep.lines) {
        const [inv] = await tx
          .select()
          .from(invoices)
          .where(eq(invoices.id, l.invoice.id))
          .limit(1);
        const due =
          inv && OPEN_SET.includes(inv.status)
            ? (await invoiceOutstanding(tx, inv)).remainingMinor
            : 0n;
        if (due > 0n)
          out.push({
            invoiceId: l.invoice.id,
            amountMinor: due,
            recurring: inv!.subscriptionId != null,
          });
        else
          await tx
            .update(paymentRequestInvoices)
            .set({ state: inv?.status === "paid" ? "paid" : "settled_elsewhere" })
            .where(
              and(
                eq(paymentRequestInvoices.requestId, req.id),
                eq(paymentRequestInvoices.invoiceId, l.invoice.id),
              ),
            );
      }
      return out;
    });
    if (shares.length === 0) {
      // Credit covered everything: no money moved, so no receipt.
      await withTenant(organizationId, async (tx) => {
        const [upd] = await tx
          .update(paymentRequests)
          .set({ status: "paid", paidAt: stampNow() })
          .where(and(eq(paymentRequests.id, req.id), eq(paymentRequests.status, "open")))
          .returning();
        if (upd)
          await emitRequestEvent(tx, "payment_request_paid", upd, { paid_with_credit: true });
      });
      return (await getPaymentRequest(organizationId, businessId, req.publicId))!;
    }
    await chargeShares({
      organizationId,
      businessId,
      req,
      customer,
      candidates,
      shares,
      initiator: input.initiator,
    });
  } finally {
    for (const id of claimed) await releaseCollection(organizationId, id);
  }
  return (await getPaymentRequest(organizationId, businessId, req.publicId))!;
}

const NOTICE_RAIL_REFUSAL =
  "We could not charge the payment request. This payment method needs an advance notice to the bank. Send the request link instead.";

/** A rail whose gateway needs a pre-debit notice: never charged from a request. */
export async function isNoticeRail(
  organizationId: string,
  businessId: string,
  currency: string,
  pm: Pm,
): Promise<boolean> {
  const { adapter } = await resolveChargeAdapter({
    organizationId,
    businessId,
    currency,
    pm,
  }).catch(() => ({ adapter: null }));
  return !!adapter?.capabilities.preDebitNotice?.methods.includes(pm.type as never);
}

async function chargeShares(input: {
  organizationId: string;
  businessId: string;
  req: PaymentRequest;
  customer: typeof customers.$inferSelect;
  candidates: Pm[];
  shares: Share[];
  initiator: "merchant" | "customer";
}): Promise<void> {
  const { organizationId, businessId, req, customer, shares } = input;
  const total = shares.reduce((s, x) => s + x.amountMinor, 0n);
  // Card limit (0482) against what ONE gateway charge will take: the sum, not each invoice.
  let candidates = input.candidates;
  if (candidates.some(isCardInstrument)) {
    const [biz] = await withTenant(organizationId, (tx) =>
      tx
        .select({ cardPaymentLimits: businesses.cardPaymentLimits })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1),
    );
    if (overCardLimit(biz, req.currency, total)) {
      candidates = candidates.filter((pm) => !isCardInstrument(pm));
      if (candidates.length === 0)
        throw new PaymentRequestError(
          "We could not charge the payment request. Its total is more than the amount that this business accepts by card. Record the payment when the customer pays another way.",
        );
    }
  }
  // No notice rail at any position: a backup reached after a decline or after the card limit
  // would be debited with no notice to the bank.
  const offNotice: Pm[] = [];
  for (const pm of candidates)
    if (!(await isNoticeRail(organizationId, businessId, req.currency, pm))) offNotice.push(pm);
  if (offNotice.length === 0) throw new PaymentRequestError(NOTICE_RAIL_REFUSAL);
  candidates = offNotice;
  const contact = {
    autoCollection: customer.autoCollection,
    email: customer.email,
    phone: customer.phone,
  };
  let lastDecline: { code?: string; message?: string } | undefined;
  for (const pm of candidates) {
    let booked = false;
    const book = async () => {
      if (booked) return;
      booked = true;
      await bookChildren({ organizationId, businessId, req, pm, shares });
    };
    let a: ChargeAttempt;
    try {
      a = await chargeWithMethod({
        organizationId,
        businessId,
        currency: req.currency,
        pm,
        amountMinor: total,
        idempotencyKey: `${req.publicId}_attempt_${req.attemptCount + 1}_${pm.publicId}`,
        ownershipRef: req.publicId,
        description: `Payment request ${req.publicId}`,
        contact,
        // The clock's combined retry runs under the subscriptions' standing agreement.
        initiator: {
          by: input.initiator,
          recurring: req.origin === "dunning" && shares.some((x) => x.recurring),
        },
        beforeGatewayCall: book,
      });
    } catch (e) {
      await book();
      if (e instanceof ProviderIndeterminateError) {
        log.error(e, { event: "payment_request_charge_indeterminate", request: req.publicId });
        const lost = lostChargeHandle(e);
        await recordAttemptOutcome(input, pm, total, {
          kind: "pending",
          status: "timeout",
          chargeId: strandedObjectId(e) ?? null,
          account: lost?.account ?? null,
          gatewayKey: lost?.gatewayKey ?? pm.providerKey,
          lost,
        });
        return;
      }
      const code =
        e instanceof GatewayRouterError ? "gateway_account_unavailable" : "gateway_error";
      log.error(e as Error, { event: "payment_request_charge_threw", request: req.publicId });
      await recordAttemptOutcome(input, pm, total, {
        kind: "failed",
        chargeId: null,
        account: null,
        gatewayKey: pm.providerKey,
        failure: { code, message: e instanceof Error ? e.message : String(e), retriable: true },
      });
      throw new PaymentRequestError(
        "We could not charge the payment request. The payment gateway did not complete the request. Try again later.",
      );
    }
    if (a.deferredUntil) continue; // no notice is ever asked for; defensive
    await book();
    const chargeId = a.result.providerChargeId || null;
    if (a.result.status === "succeeded") {
      await recordAttemptOutcome(input, pm, total, {
        kind: "succeeded",
        chargeId,
        account: a.account,
        gatewayKey: a.gatewayKey,
      });
      return;
    }
    if (a.result.status !== "failed") {
      // pending or requires_action: the money may still move. Settled by webhook or sweep.
      const outcome = tmtestOutcome(a.result);
      await recordAttemptOutcome(input, pm, total, {
        kind: "pending",
        status:
          outcome === "timeout"
            ? "timeout"
            : outcome === "needs_attention"
              ? "needs_attention"
              : "in_progress",
        chargeId,
        account: a.account,
        gatewayKey: a.gatewayKey,
      });
      return;
    }
    lastDecline = a.result.failure;
    const tryNext = shouldTryBackup(a.result) && pm !== candidates[candidates.length - 1];
    await recordAttemptOutcome(input, pm, total, {
      kind: "failed",
      chargeId,
      account: a.account,
      gatewayKey: a.gatewayKey,
      failure: a.result.failure,
      final: !tryNext,
    });
    if (!tryNext) break;
  }
  throw new PaymentRequestError(declined(lastDecline?.code));
}

/** One pending child per share, the request to `processing`. Before the gateway call. */
async function bookChildren(input: {
  organizationId: string;
  businessId: string;
  req: PaymentRequest;
  pm: Pm;
  shares: Share[];
}): Promise<void> {
  await withTenant(input.organizationId, async (tx) => {
    const [upd] = await tx
      .update(paymentRequests)
      .set({
        status: "processing",
        attemptCount: sql`${paymentRequests.attemptCount} + 1`,
        paymentMethodId: input.pm.id,
        lastPaymentError: null,
      })
      .where(eq(paymentRequests.id, input.req.id))
      .returning({ attemptCount: paymentRequests.attemptCount, origin: paymentRequests.origin });
    // The clock's combined retry is ONE dunning attempt per invoice, whatever backups it
    // tries: count it on the first booking, as a single retry counts a parked attempt.
    if (upd?.origin === "dunning" && upd.attemptCount === 1)
      await tx
        .update(invoices)
        .set({ attemptCount: sql`${invoices.attemptCount} + 1`, nextAttemptAt: null })
        .where(
          inArray(
            invoices.id,
            input.shares.map((x) => x.invoiceId),
          ),
        );
    // One gateway charge: the card caps count the attempt once (`representment.ts`).
    const attempt = { payment_request_attempt: String(upd?.attemptCount ?? 0) };
    await tx.insert(payments).values(
      input.shares.map((s) => ({
        metadata: attempt,
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.req.customerId,
        invoiceId: s.invoiceId,
        paymentMethodId: input.pm.id,
        publicId: publicId("pay"),
        status: "pending",
        amountMinor: s.amountMinor,
        currency: input.req.currency,
        providerKey: input.pm.providerKey,
        providerChargeId: null,
        methodType: methodTypeOf(null, input.pm),
        paymentRequestId: input.req.id,
      })),
    );
  });
}

type AttemptOutcome =
  | {
      kind: "succeeded";
      chargeId: string | null;
      account: ChargeAttempt["account"];
      gatewayKey: string;
    }
  | {
      kind: "pending";
      status: "in_progress" | "timeout" | "needs_attention";
      chargeId: string | null;
      account: ChargeAttempt["account"];
      gatewayKey: string;
      /** A lost answer: what the gateway can find the charge by. */
      lost?: LostChargeHandle | null;
    }
  | {
      kind: "failed";
      chargeId: string | null;
      account: ChargeAttempt["account"];
      gatewayKey: string;
      failure?: { code?: string; message?: string; retriable?: boolean };
      /** False when a backup is tried next: a dunning request re-arms only on the last. */
      final?: boolean;
    };

/** Book the attempt's one transaction, stamp the charge on the request, settle. */
async function recordAttemptOutcome(
  ctx: {
    organizationId: string;
    businessId: string;
    req: PaymentRequest;
    customer: { id: string };
  },
  pm: Pm,
  total: bigint,
  o: AttemptOutcome,
): Promise<void> {
  const { organizationId, businessId, req } = ctx;
  await withTenant(organizationId, async (tx) => {
    await tx
      .update(paymentRequests)
      .set({
        providerKey: o.gatewayKey,
        gatewayAccountId: o.account?.id ?? null,
        ...(o.chargeId ? { providerChargeId: o.chargeId } : {}),
      })
      .where(eq(paymentRequests.id, req.id));
    const txn = await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: req.customerId,
        type: "payment",
        status: o.kind === "pending" ? o.status : o.kind,
        amountMinor: total,
        currency: req.currency,
        gatewayAccountId: o.account?.id ?? null,
        gatewayKey: o.gatewayKey,
        idAtGateway: o.chargeId,
        ...(o.kind === "pending" && o.lost
          ? { ownershipRef: o.lost.ownershipRef, idempotencyKey: o.lost.idempotencyKey }
          : {}),
        paymentMethodId: pm.id,
        paymentRequestId: req.id,
        ...(o.kind === "failed"
          ? {
              errorCode: o.failure?.code ?? "card_declined",
              errorText: o.failure?.message ?? null,
              retriable: o.failure?.retriable ?? null,
            }
          : {}),
      },
      tx,
    );
    if (o.kind === "succeeded")
      await settleRequestSucceeded(tx, {
        organizationId,
        businessId,
        requestId: req.id,
        transactionId: txn.id,
        chargeId: o.chargeId,
      });
    else if (o.kind === "failed")
      await settleRequestFailed(tx, {
        organizationId,
        businessId,
        requestId: req.id,
        code: o.failure?.code ?? "card_declined",
        message: o.failure?.message ?? null,
        retriable: o.failure?.retriable,
        final: o.final ?? true,
      });
  });
}

// ── Settlement (shared by the charge, webhooks, the sweep and operator reconcile) ──

/**
 * The request's charge succeeded: each pending child settles as an ordinary invoice payment
 * (an invoice that shrank meanwhile takes the overshoot path), the request is paid, one
 * receipt. Idempotent: a request that is not `processing` is left alone.
 */
export async function settleRequestSucceeded(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    requestId: string;
    transactionId: string;
    chargeId?: string | null;
    occurredAt?: Date;
  },
): Promise<boolean> {
  const [req] = await tx
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!req || req.status !== "processing") return false;
  const children = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.paymentRequestId, req.id), eq(payments.status, "pending")))
    .orderBy(asc(payments.createdAt), asc(payments.id));
  const settled: Array<{ paymentId: string; invoiceId: string | null; amountMinor: bigint }> = [];
  let creditMinor = 0n;
  for (const c of children) {
    await settlePaymentSucceeded(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentId: c.id,
      occurredAt: input.occurredAt,
    });
    const [after] = await tx.select().from(payments).where(eq(payments.id, c.id)).limit(1);
    if (after?.invoiceId)
      settled.push({ paymentId: c.id, invoiceId: after.invoiceId, amountMinor: after.amountMinor });
    else {
      // Detached by the overshoot path: the money became customer credit.
      settled.push({ paymentId: c.id, invoiceId: null, amountMinor: 0n });
      creditMinor += c.amountMinor;
    }
    if (c.invoiceId) {
      const [inv] = await tx
        .select({ status: invoices.status })
        .from(invoices)
        .where(eq(invoices.id, c.invoiceId))
        .limit(1);
      await tx
        .update(paymentRequestInvoices)
        .set({ state: inv?.status === "paid" ? "paid" : "settled_elsewhere" })
        .where(
          and(
            eq(paymentRequestInvoices.requestId, req.id),
            eq(paymentRequestInvoices.invoiceId, c.invoiceId),
            eq(paymentRequestInvoices.state, "open"),
          ),
        );
    }
  }
  const paidAt = input.occurredAt ?? stampNow();
  const stillOpen = await tx
    .select({ id: paymentRequestInvoices.invoiceId })
    .from(paymentRequestInvoices)
    .where(
      and(eq(paymentRequestInvoices.requestId, req.id), eq(paymentRequestInvoices.state, "open")),
    );
  const [upd] = await tx
    .update(paymentRequests)
    .set({
      status: stillOpen.length ? "open" : "paid",
      paidAt: stillOpen.length ? null : paidAt,
      ...(input.chargeId ? { providerChargeId: input.chargeId } : {}),
    })
    .where(eq(paymentRequests.id, req.id))
    .returning();
  await createReceiptForRequestSettlement(tx, {
    requestId: req.id,
    transactionId: input.transactionId,
    paidAt,
    children: settled.filter((s) => s.amountMinor > 0n),
    creditMinor,
  });
  if (!stillOpen.length)
    await emitRequestEvent(tx, "payment_request_paid", upd!, {
      amount_minor: Number(children.reduce((s, c) => s + c.amountMinor, 0n)),
    });
  log.info("payment request settled", {
    event: "payment_request_settled",
    request: req.publicId,
    children: children.length,
  });
  return true;
}

/**
 * The request's charge failed: its pending children fail as MANUAL attempts (no dunning
 * retry is spent), the request reopens with the error, and the customer gets the link.
 *
 * A `dunning` request (the clock's combined retry) instead fails each child as that
 * invoice's own attempt, through `settlePaymentFailed`, and closes: the next retry is each
 * invoice's again. No link is sent; each invoice's failure mail goes as usual.
 */
export async function settleRequestFailed(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    requestId: string;
    code: string;
    message?: string | null;
    retriable?: boolean;
    /** False when a backup is tried next (dunning requests only re-arm on the last). */
    final?: boolean;
  },
): Promise<boolean> {
  const [req] = await tx
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!req || req.status !== "processing") return false;
  if (req.origin === "dunning") return settleDunningRequestFailed(tx, req, input);
  await tx
    .update(payments)
    .set({ status: "failed", failureCode: input.code, failureMessage: input.message ?? null })
    .where(and(eq(payments.paymentRequestId, req.id), eq(payments.status, "pending")));
  // The customer's own Pay all is closed on its last decline: they are on the page and can
  // try again, so it must not hold the invoices or send them a link.
  const closePortal = req.origin === "portal" && input.final !== false;
  const lastPaymentError = { code: input.code, message: input.message ?? null };
  const [upd] = await tx
    .update(paymentRequests)
    .set(
      closePortal
        ? { status: "canceled", cancelReason: "payment_failed", lastPaymentError }
        : { status: "open", lastPaymentError },
    )
    .where(eq(paymentRequests.id, req.id))
    .returning();
  await emitRequestEvent(tx, "payment_request_payment_failed", upd!, {
    code: input.code,
    message: input.message ?? null,
  });
  if (closePortal) await releaseLines(tx, req.id);
  if (req.origin === "portal") return true;
  const { organizationId, businessId } = input;
  const pid = req.publicId;
  const { afterCommit } = await import("@/platform/db");
  const send = async () => {
    await sendPaymentRequestEmail({
      organizationId,
      businessId,
      paymentRequestPublicId: pid,
    }).catch((e) =>
      log.warn("payment request email not sent", { request: pid, error: (e as Error)?.message }),
    );
  };
  if (!afterCommit(send)) void send();
  return true;
}

/** A closed request lets its invoices go, so a later request (or retry) can take them. */
async function releaseLines(tx: Tx, requestId: string): Promise<void> {
  await tx
    .update(paymentRequestInvoices)
    .set({ state: "removed" })
    .where(
      and(
        eq(paymentRequestInvoices.requestId, requestId),
        eq(paymentRequestInvoices.state, "open"),
      ),
    );
}

async function settleDunningRequestFailed(
  tx: Tx,
  req: PaymentRequest,
  input: {
    organizationId: string;
    businessId: string;
    code: string;
    message?: string | null;
    retriable?: boolean;
    final?: boolean;
  },
): Promise<boolean> {
  const final = input.final !== false;
  const children = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.paymentRequestId, req.id), eq(payments.status, "pending")))
    .orderBy(asc(payments.createdAt), asc(payments.id));
  for (const c of children)
    await settlePaymentFailed(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentId: c.id,
      errorCode: input.code,
      errorText: input.message ?? null,
      retriable: input.retriable,
      rearmDunning: final,
    });
  const lastPaymentError = { code: input.code, message: input.message ?? null };
  const [upd] = await tx
    .update(paymentRequests)
    .set(
      final
        ? { status: "canceled", cancelReason: "payment_failed", lastPaymentError }
        : { status: "open", lastPaymentError },
    )
    .where(eq(paymentRequests.id, req.id))
    .returning();
  if (final) await releaseLines(tx, req.id);
  if (final)
    await emitRequestEvent(tx, "payment_request_payment_failed", upd!, {
      code: input.code,
      message: input.message ?? null,
    });
  return true;
}

/**
 * Hook for `settleTransactionOutcome`: a transaction that names a request settles the request.
 * The sweep, webhooks and operator reconcile all reach this through that one function.
 */
export async function settleRequestTransaction(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    outcome: "succeeded" | "failed";
    occurredAt?: Date;
    /** From `settleTransactionOutcome`; a dunning request re-arms each invoice by it. */
    retriable?: boolean;
    txn: {
      id?: string;
      paymentRequestId: string;
      idAtGateway?: string | null;
      errorCode?: string | null;
      errorText?: string | null;
    };
  },
): Promise<boolean> {
  if (input.outcome === "succeeded") {
    if (!input.txn.id) return false;
    return settleRequestSucceeded(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      requestId: input.txn.paymentRequestId,
      transactionId: input.txn.id,
      chargeId: input.txn.idAtGateway ?? null,
      occurredAt: input.occurredAt,
    });
  }
  return settleRequestFailed(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    requestId: input.txn.paymentRequestId,
    code: input.txn.errorCode ?? "async_failed",
    message: input.txn.errorText ?? null,
    retriable: input.retriable,
  });
}

/**
 * The gateway captured a request charge we had failed (AFA). Its children failed and its
 * invoices stayed owed, so the money pays the ones still owed, newest first, through fresh
 * children settled like a successful charge. An invoice paid meanwhile, or with another
 * payment in flight, takes nothing; the rest is one detached excess child for the caller
 * to refund. The transaction's failed → succeeded flip is the claim, so a redelivery books
 * nothing. `not_applicable` when the request no longer holds this charge or a newer
 * attempt is in flight: its children refund through the request's CURRENT charge.
 */
export async function settleLateRequestCapture(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    requestId: string;
    transactionId: string;
    chargeId: string;
    occurredAt: Date;
  },
): Promise<
  | { kind: "not_applicable"; reason: string }
  | { kind: "duplicate" }
  | { kind: "refused" }
  | {
      kind: "booked";
      appliedMinor: bigint;
      excess: { paymentPublicId: string; amountMinor: bigint; currency: string } | null;
    }
> {
  const [req] = await tx
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.id, input.requestId))
    .for("update")
    .limit(1);
  if (!req) return { kind: "not_applicable", reason: "no_request" };
  if (req.providerChargeId !== input.chargeId)
    return { kind: "not_applicable", reason: "request_holds_another_charge" };
  if (req.status === "processing") return { kind: "not_applicable", reason: "attempt_in_flight" };
  const [txn] = await tx
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.transactionId))
    .for("update")
    .limit(1);
  if (!txn || txn.status !== "failed") return { kind: "duplicate" };
  // Re-coded under this lock after a refused amount mismatch; a sweep that read it earlier stops here.
  const { AFA_REVIVABLE_CODES } = await import("@/modules/webhooks/inbound");
  if (!AFA_REVIVABLE_CODES.has(txn.errorCode ?? "")) return { kind: "refused" };
  await setTransactionStatus(tx, input.organizationId, txn.id, "succeeded", {
    errorCode: null,
    errorText: null,
    retriable: null,
    settledAt: input.occurredAt,
  });
  // Lines whose invoice was paid meanwhile drop out now, so the request's status comes out right.
  if (req.status === "open") await refreshLines(tx, req);

  const rows = await tx
    .select({ invoice: invoices })
    .from(paymentRequestInvoices)
    .innerJoin(invoices, eq(invoices.id, paymentRequestInvoices.invoiceId))
    .where(eq(paymentRequestInvoices.requestId, req.id))
    .orderBy(desc(paymentRequestInvoices.position));
  const caps = new Map<string, bigint>();
  for (const { invoice } of rows) {
    let cap = 0n;
    if (OPEN_SET.includes(invoice.status)) {
      const [inFlight] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(and(eq(payments.invoiceId, invoice.id), eq(payments.status, "pending")))
        .limit(1);
      if (!inFlight) cap = (await invoiceOutstanding(tx, invoice)).remainingMinor;
    }
    caps.set(invoice.id, cap);
  }
  const parts = spreadNewestFirst(rows, txn.amountMinor, (r) => caps.get(r.invoice.id) ?? 0n);
  const child = {
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: req.customerId,
    paymentMethodId: txn.paymentMethodId,
    currency: req.currency,
    providerKey: txn.gatewayKey ?? req.providerKey ?? "unknown",
    providerChargeId: null,
    methodType: await methodTypeFor(tx, null, txn.paymentMethodId),
    paymentRequestId: req.id,
  };
  const appliedMinor = parts.reduce((s, p) => s + p.amountMinor, 0n);
  if (parts.length) {
    await tx.insert(payments).values(
      parts.map((p) => ({
        ...child,
        invoiceId: p.child.invoice.id,
        publicId: publicId("pay"),
        status: "pending",
        amountMinor: p.amountMinor,
      })),
    );
    await tx
      .update(paymentRequests)
      .set({ status: "processing" })
      .where(eq(paymentRequests.id, req.id));
    await settleRequestSucceeded(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      requestId: req.id,
      transactionId: txn.id,
      chargeId: input.chargeId,
      occurredAt: input.occurredAt,
    });
  }
  let excess: { paymentPublicId: string; amountMinor: bigint; currency: string } | null = null;
  const excessMinor = txn.amountMinor - appliedMinor;
  if (excessMinor > 0n) {
    // Inserted `failed` so `settleAbandonedCapture` books it as excess credit (no invoice).
    const [row] = await tx
      .insert(payments)
      .values({
        ...child,
        invoiceId: null,
        publicId: publicId("pay"),
        status: "failed",
        amountMinor: excessMinor,
        failureCode: "late_capture_excess",
        metadata: { [UNAPPLIED_CAPTURE_KEY]: "late_authorization" },
      })
      .returning();
    const res = await settleAbandonedCapture(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentId: row!.id,
      occurredAt: input.occurredAt,
    });
    if (res.booked)
      excess = {
        paymentPublicId: res.paymentPublicId,
        amountMinor: res.amountMinor,
        currency: res.currency,
      };
  }
  log.warn("a payment request charge was captured after it failed — applied to its invoices", {
    event: "payment_request_late_capture",
    request: req.publicId,
    appliedMinor: String(appliedMinor),
    excessMinor: String(excessMinor),
    currency: req.currency,
  });
  return { kind: "booked", appliedMinor, excess };
}

/** The request whose single gateway charge this is, by charge id. */
export async function requestForCharge(
  tx: Tx,
  input: { businessId?: string | null; providerChargeId: string },
): Promise<PaymentRequest | null> {
  const [row] = await tx
    .select()
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.providerChargeId, input.providerChargeId),
        ...(input.businessId ? [eq(paymentRequests.businessId, input.businessId)] : []),
      ),
    )
    .limit(2);
  return row ?? null;
}

/**
 * The children that carry a request's charge, newest invoice first (reverse application
 * order), for spreading a gateway refund, dispute or late failure. Succeeded only.
 */
export async function chargeChildrenNewestFirst(
  tx: Tx,
  requestId: string,
): Promise<Array<typeof payments.$inferSelect>> {
  const rows = await tx
    .select({ pay: payments, inv: invoices, pos: paymentRequestInvoices.position })
    .from(payments)
    .leftJoin(invoices, eq(invoices.id, payments.invoiceId))
    .leftJoin(
      paymentRequestInvoices,
      and(
        eq(paymentRequestInvoices.requestId, requestId),
        eq(paymentRequestInvoices.invoiceId, payments.invoiceId),
      ),
    )
    .where(
      and(
        eq(payments.paymentRequestId, requestId),
        eq(payments.status, "succeeded"),
        sql`${payments.providerKey} <> 'offline'`,
      ),
    );
  return rows
    .sort((a, b) => (b.pos ?? -1) - (a.pos ?? -1) || (a.pay.id < b.pay.id ? 1 : -1))
    .map((r) => r.pay);
}

/** Split `amount` over the children newest first, each capped at `capOf(child)`. */
export function spreadNewestFirst<T>(
  children: T[],
  amount: bigint,
  capOf: (c: T) => bigint,
): Array<{ child: T; amountMinor: bigint }> {
  const out: Array<{ child: T; amountMinor: bigint }> = [];
  let left = amount;
  for (const c of children) {
    if (left <= 0n) break;
    const cap = capOf(c);
    const take = cap < left ? cap : left;
    if (take > 0n) out.push({ child: c, amountMinor: take });
    left -= take;
  }
  return out;
}

// ── Offline payment on a request ────────────────────────────────────────────

export async function recordPaymentRequestPayment(input: {
  organizationId: string;
  businessId: string;
  paymentRequestPublicId: string;
  amountMinor: number;
  method?: "cash" | "cheque" | "bank_transfer" | "other";
  reference?: string | null;
  occurredAt?: Date;
}): Promise<RequestView> {
  const { organizationId, businessId } = input;
  const method = input.method ?? "other";
  await withTenant(organizationId, async (tx) => {
    const req = await loadRequest(tx, businessId, input.paymentRequestPublicId, true);
    if (!req)
      throw new PaymentRequestError(
        `We could not find the payment request ${input.paymentRequestPublicId}.`,
        "not_found",
      );
    if (req.status !== "open")
      throw new PaymentRequestError(
        `We could not record the payment. The payment request is ${req.status}.`,
        "conflict",
      );
    const lines = (await refreshLines(tx, req)).filter((l) => l.state === "open");
    const live = lines.reduce((s, l) => s + l.outstandingMinor, 0n);
    const amount = BigInt(input.amountMinor);
    if (amount <= 0n)
      throw new PaymentRequestError(
        "We could not record the payment. The amount must be more than 0.",
      );
    if (amount > live)
      throw new PaymentRequestError(
        `We could not record the payment. The amount is more than the ${live} still due on the request. Record the extra amount as an excess payment on the customer.`,
      );
    const at = input.occurredAt ?? stampNow(businessId);
    let left = amount;
    const children: Array<{ paymentId: string; invoiceId: string; amountMinor: bigint }> = [];
    for (const l of lines) {
      if (left <= 0n) break;
      const [inv] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, l.invoice.id))
        .for("update")
        .limit(1);
      if (!inv || !OPEN_SET.includes(inv.status)) continue;
      const due = (await invoiceOutstanding(tx, inv)).remainingMinor;
      const share = due < left ? due : left;
      if (share <= 0n) continue;
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId,
          businessId,
          customerId: req.customerId,
          invoiceId: inv.id,
          publicId: publicId("pay"),
          status: "succeeded",
          amountMinor: share,
          currency: inv.currency,
          providerKey: "offline",
          providerChargeId: method,
          paymentRequestId: req.id,
          createdAt: at,
        })
        .returning();
      await postEntries(
        {
          organizationId,
          businessId,
          customerId: req.customerId,
          sourceType: "payment",
          sourceId: pay!.publicId,
          occurredAt: at,
          lines: [
            { account: "cash", direction: "debit", amountMinor: share, currency: inv.currency },
            {
              account: "accounts_receivable",
              direction: "credit",
              amountMinor: share,
              currency: inv.currency,
            },
          ],
        },
        tx,
      );
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_succeeded",
        data: buildEventData(
          "payment_succeeded",
          {
            id: pay!.publicId,
            status: "succeeded",
            amount_minor: Number(share),
            currency: inv.currency,
            invoice: inv.publicId,
            payment_request: req.publicId,
          },
          null,
          { offline: true },
        ),
      });
      if (share >= due) {
        await tx
          .update(invoices)
          .set({ status: "paid", paidAt: at, nextAttemptAt: null, ...dunningFieldsOnSettle(inv) })
          .where(eq(invoices.id, inv.id));
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "invoice_paid",
          data: buildEventData(
            "invoice_paid",
            { id: inv.publicId, amount_minor: Number(inv.totalMinor), currency: inv.currency },
            null,
            { offline: true },
          ),
        });
        await tx
          .update(paymentRequestInvoices)
          .set({ state: "paid" })
          .where(
            and(
              eq(paymentRequestInvoices.requestId, req.id),
              eq(paymentRequestInvoices.invoiceId, inv.id),
            ),
          );
      }
      children.push({ paymentId: pay!.id, invoiceId: inv.id, amountMinor: share });
      left -= share;
    }
    const txn = await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: req.customerId,
        type: "payment",
        status: "succeeded",
        amountMinor: amount,
        currency: req.currency,
        gatewayKey: `offline_${method}`,
        idAtGateway: input.reference ?? null,
        paymentRequestId: req.id,
        occurredAt: at,
      },
      tx,
    );
    await createReceiptForRequestSettlement(tx, {
      requestId: req.id,
      transactionId: txn.id,
      paidAt: at,
      children,
    });
    const rest = await tx
      .select({ id: paymentRequestInvoices.invoiceId })
      .from(paymentRequestInvoices)
      .where(
        and(eq(paymentRequestInvoices.requestId, req.id), eq(paymentRequestInvoices.state, "open")),
      );
    if (rest.length === 0) {
      const [upd] = await tx
        .update(paymentRequests)
        .set({ status: "paid", paidAt: at })
        .where(eq(paymentRequests.id, req.id))
        .returning();
      await emitRequestEvent(tx, "payment_request_paid", upd!, {
        amount_minor: Number(amount),
        offline: true,
      });
    }
  });
  return (await getPaymentRequest(organizationId, businessId, input.paymentRequestPublicId))!;
}

// ── Cancel / expire / send ──────────────────────────────────────────────────

export async function cancelPaymentRequest(input: {
  organizationId: string;
  businessId: string;
  paymentRequestPublicId: string;
  reason?: string | null;
}): Promise<RequestView> {
  await withTenant(input.organizationId, async (tx) => {
    const req = await loadRequest(tx, input.businessId, input.paymentRequestPublicId, true);
    if (!req)
      throw new PaymentRequestError(
        `We could not find the payment request ${input.paymentRequestPublicId}.`,
        "not_found",
      );
    if (req.status === "processing")
      throw new PaymentRequestError(
        "We could not cancel the payment request. A payment on it is in progress. Try again when it completes.",
        "conflict",
      );
    if (req.status !== "open")
      throw new PaymentRequestError(
        `We could not cancel the payment request. It is ${req.status}.`,
        "conflict",
      );
    await closeRequest(tx, req, "canceled", input.reason ?? "canceled_by_operator");
  });
  return (await getPaymentRequest(
    input.organizationId,
    input.businessId,
    input.paymentRequestPublicId,
  ))!;
}

async function closeRequest(
  tx: Tx,
  req: PaymentRequest,
  status: "canceled" | "expired",
  reason: string | null,
): Promise<void> {
  const [upd] = await tx
    .update(paymentRequests)
    .set({ status, cancelReason: reason })
    .where(and(eq(paymentRequests.id, req.id), eq(paymentRequests.status, "open")))
    .returning();
  if (!upd) return;
  await tx
    .update(paymentRequestInvoices)
    .set({ state: "removed" })
    .where(
      and(eq(paymentRequestInvoices.requestId, req.id), eq(paymentRequestInvoices.state, "open")),
    );
  await emitRequestEvent(
    tx,
    status === "canceled" ? "payment_request_canceled" : "payment_request_expired",
    upd,
  );
}

/** Clock pass: open requests past `expires_at` expire. Returns how many. */
export async function expirePaymentRequests(now: Date): Promise<{ expired: number }> {
  const { systemDb } = await import("@/platform/db");
  const { scanBusinessFilter } = await import("@/platform/clock");
  const due = await systemDb
    .select({ id: paymentRequests.id, organizationId: paymentRequests.organizationId })
    .from(paymentRequests)
    .where(
      and(
        eq(paymentRequests.status, "open"),
        sql`${paymentRequests.expiresAt} <= ${now.toISOString()}::timestamptz`,
        scanBusinessFilter(paymentRequests.businessId),
      ),
    )
    .limit(500);
  let expired = 0;
  for (const r of due) {
    await withTenant(r.organizationId, async (tx) => {
      const [req] = await tx
        .select()
        .from(paymentRequests)
        .where(eq(paymentRequests.id, r.id))
        .for("update")
        .limit(1);
      if (!req || req.status !== "open") return;
      await closeRequest(tx, req, "expired", "expired");
      expired++;
    });
  }
  return { expired };
}

/** Send (or send again) the request email with the portal link. */
export async function sendPaymentRequestEmail(input: {
  organizationId: string;
  businessId: string;
  paymentRequestPublicId: string;
  to?: string | null;
  note?: string | null;
}) {
  const view = await getPaymentRequest(
    input.organizationId,
    input.businessId,
    input.paymentRequestPublicId,
  );
  if (!view)
    throw new PaymentRequestError(
      `We could not find the payment request ${input.paymentRequestPublicId}.`,
      "not_found",
    );
  if (view.request.status !== "open")
    throw new PaymentRequestError(
      `We could not send the payment request. It is ${view.request.status}.`,
      "conflict",
    );
  const { sendAdhocEmail } = await import("@/modules/emails/adhoc-service");
  return sendAdhocEmail(input.organizationId, input.businessId, {
    type: "payment_request",
    paymentRequestId: input.paymentRequestPublicId,
    to: input.to ?? view.request.email ?? null,
    note: input.note ?? null,
  });
}

// ── The customer's own Pay all / selected invoices (portal) ─────────────────

export class PortalPayNotAllowedError extends PaymentRequestError {}

/**
 * The customer pays several open invoices in one charge from the portal (2.51 / 2.66,
 * `customer_chooses`). Without `invoicePublicIds` it takes every open invoice of
 * `currency` (Pay all; needs `several_due_invoices = customer_chooses`); with them, the
 * customer's selection (needs `invoice_order = customer_chooses`). Created and charged in one
 * call with a saved payment method; a request refused before the charge is canceled, and a
 * declined one closes itself, so nothing is left holding the invoices.
 */
export async function payInvoicesFromPortal(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  invoicePublicIds?: string[];
  currency?: string;
  paymentMethodPublicId?: string;
}): Promise<RequestView> {
  const { organizationId, businessId } = input;
  const { loadPaymentApplication } = await import("@/modules/payments/application-config");
  const cfg = await loadPaymentApplication(organizationId, businessId);
  const selecting = input.invoicePublicIds !== undefined;
  if (
    selecting
      ? cfg.invoiceOrder !== "customer_chooses"
      : cfg.severalDueInvoices !== "customer_chooses"
  )
    throw new PortalPayNotAllowedError(
      selecting
        ? "This account does not allow selecting the invoices to pay here. Pay each invoice on its own."
        : "This account does not allow paying all invoices in one payment here. Pay each invoice on its own.",
    );
  const { ids, customerPublicId } = await withTenant(organizationId, async (tx) => {
    const [cus] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(and(eq(customers.businessId, businessId), eq(customers.id, input.customerId)))
      .limit(1);
    if (!cus) throw new PaymentRequestError("We could not find your account.", "not_found");
    if (selecting) return { ids: input.invoicePublicIds!, customerPublicId: cus.publicId };
    const rows = await tx
      .select({ publicId: invoices.publicId, currency: invoices.currency })
      .from(invoices)
      .where(
        and(
          eq(invoices.businessId, businessId),
          eq(invoices.customerId, input.customerId),
          inArray(invoices.status, [...OPEN_INVOICE_STATUSES]),
          sql`not exists (select 1 from ${payments} p
                where p.invoice_id = ${invoices.id} and p.status = 'pending')`,
          sql`not exists (select 1 from ${paymentRequestInvoices} pri
                where pri.invoice_id = ${invoices.id} and pri.state = 'open')`,
        ),
      );
    const currencies = new Set(rows.map((r) => r.currency));
    const currency = input.currency?.toUpperCase();
    if (!currency && currencies.size > 1)
      throw new PaymentRequestError(
        "We could not take the payment. Your invoices use more than one currency. Select a currency and try again.",
      );
    const ids = rows.filter((r) => !currency || r.currency === currency).map((r) => r.publicId);
    if (ids.length === 0)
      throw new PaymentRequestError("We could not take the payment. You have no invoices to pay.");
    return { ids, customerPublicId: cus.publicId };
  });
  const view = await createPaymentRequest({
    organizationId,
    businessId,
    customerPublicId,
    invoicePublicIds: ids,
    mode: "link",
    origin: "portal",
    createdBy: "customer",
  });
  const pid = view.request.publicId;
  try {
    return await chargePaymentRequest({
      organizationId,
      businessId,
      paymentRequestPublicId: pid,
      paymentMethodPublicId: input.paymentMethodPublicId,
      initiator: "customer",
      customerId: input.customerId,
    });
  } catch (e) {
    const now = await getPaymentRequest(organizationId, businessId, pid);
    if (now?.request.status === "open" && now.request.attemptCount === 0)
      await cancelPaymentRequest({
        organizationId,
        businessId,
        paymentRequestPublicId: pid,
        reason: "portal_charge_refused",
      }).catch(() => {});
    throw e;
  }
}
