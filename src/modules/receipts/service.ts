import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  clampLimit,
  countExpr,
  filterConditions,
  keysetCondition,
  pageOrder,
  parseCursor,
  searchCondition,
  toPage,
  type FilterSpec,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { withTenant, afterCommit, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { createLogger } from "@/platform/logger";
import { config } from "@/platform/config";
import {
  businesses,
  customers,
  invoices,
  paymentMethods,
  payments,
  paymentRequests,
  receipts,
} from "@db/schema";
import { emitEvent, type EventRow } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { holderName } from "@/modules/customers/names";
import { billingAddress } from "@/modules/customers/serialize";
import {
  composeDocumentNumber,
  resolveInvoiceCustomization,
} from "@/modules/invoicing/customization";
import { requestReceiptNumbering } from "./number-queue";

const log = createLogger("receipts");

export type Receipt = typeof receipts.$inferSelect;

/** One line of what the money paid. `invoice` null = held as customer credit. */
export interface ReceiptAllocation {
  invoice: string | null;
  invoice_number: string | null;
  amount_minor: number;
}

/** What the PDF prints, frozen at creation so a later rename does not rewrite history. */
export interface ReceiptSnapshot {
  business: {
    name: string;
    address: Record<string, unknown> | null;
    tax_registration_number: string | null;
    email: string | null;
    timezone: string;
  };
  payer: {
    id: string;
    name: string | null;
    email: string | null;
    address: Record<string, unknown> | null;
    tax_id: string | null;
  };
  method: string;
  payments: string[];
  payment_request: string | null;
  allocations: ReceiptAllocation[];
}

const OFFLINE_WORDS: Record<string, string> = {
  cash: "Cash",
  cheque: "Cheque",
  check: "Cheque",
  wire: "Bank transfer",
  bank_transfer: "Bank transfer",
  other: "Other",
  offline: "Offline payment",
};

const TYPE_WORDS: Record<string, string> = {
  card: "Card",
  upi: "UPI",
  bank_account: "Bank account",
  sepa_debit: "SEPA Direct Debit",
  ach_debit: "ACH debit",
  bacs_debit: "Bacs Direct Debit",
  au_becs_debit: "BECS Direct Debit",
  nz_becs_debit: "BECS NZ Direct Debit",
  acss_debit: "Pre-authorized debit",
  autogiro: "Autogiro",
  betalingsservice: "Betalingsservice",
  payto: "PayTo",
  paypal: "PayPal",
  netbanking: "Net banking",
};

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** "Visa ···4242", "UPI", "Cash". */
async function methodWords(
  tx: Tx,
  pay: { providerKey: string; providerChargeId: string | null; paymentMethodId: string | null },
): Promise<string> {
  if (pay.providerKey === "offline")
    return OFFLINE_WORDS[pay.providerChargeId ?? "offline"] ?? "Offline payment";
  if (!pay.paymentMethodId) return "Online payment";
  const [pm] = await tx
    .select({ type: paymentMethods.type, brand: paymentMethods.brand, last4: paymentMethods.last4 })
    .from(paymentMethods)
    .where(eq(paymentMethods.id, pay.paymentMethodId))
    .limit(1);
  if (!pm) return "Online payment";
  if (pm.type === "card" && pm.last4) return `${capitalize(pm.brand ?? "Card")} ···${pm.last4}`;
  return TYPE_WORDS[pm.type] ?? capitalize(pm.type.replace(/_/g, " "));
}

async function partySnapshot(tx: Tx, businessId: string, customerId: string) {
  const [biz] = await tx.select().from(businesses).where(eq(businesses.id, businessId)).limit(1);
  const [cus] = await tx.select().from(customers).where(eq(customers.id, customerId)).limit(1);
  return {
    business: {
      name: biz?.name ?? "",
      address: (biz?.address as Record<string, unknown> | null) ?? null,
      tax_registration_number: biz?.taxRegistrationNumber ?? null,
      email: biz?.supportEmail ?? biz?.contactEmail ?? null,
      timezone: biz?.timezone ?? "UTC",
    },
    payer: {
      id: cus?.publicId ?? "",
      name: cus ? (holderName(cus) ?? cus.email ?? null) : null,
      email: cus?.email ?? null,
      address: cus ? billingAddress(cus) : null,
      tax_id: cus?.taxRegistrationNumber ?? cus?.vatNumber ?? null,
    },
  };
}

function scheduleNumbering(organizationId: string, businessId: string): void {
  if (!afterCommit(async () => requestReceiptNumbering(organizationId, businessId)))
    requestReceiptNumbering(organizationId, businessId);
}

/**
 * The receipt for one succeeded payment. Idempotent per payment. Skips imported rows and
 * payment-request children (the request gets one receipt for its settlement).
 * `receivedMinor` is the cash received when it is more than the payment (offline overpay).
 */
export async function createReceiptForPayment(
  tx: Tx,
  input: { paymentId: string; receivedMinor?: bigint; paidAt?: Date },
): Promise<Receipt | null> {
  const [pay] = await tx.select().from(payments).where(eq(payments.id, input.paymentId)).limit(1);
  if (!pay || pay.status !== "succeeded" || pay.imported || pay.paymentRequestId) return null;
  const amount =
    input.receivedMinor && input.receivedMinor > pay.amountMinor
      ? input.receivedMinor
      : pay.amountMinor;
  if (amount <= 0n) return null;
  const allocations: ReceiptAllocation[] = [];
  if (pay.invoiceId) {
    const [inv] = await tx
      .select({ publicId: invoices.publicId, number: invoices.number })
      .from(invoices)
      .where(eq(invoices.id, pay.invoiceId))
      .limit(1);
    allocations.push({
      invoice: inv?.publicId ?? null,
      invoice_number: inv?.number ?? null,
      amount_minor: Number(pay.amountMinor),
    });
    if (amount > pay.amountMinor)
      allocations.push({
        invoice: null,
        invoice_number: null,
        amount_minor: Number(amount - pay.amountMinor),
      });
  } else {
    allocations.push({ invoice: null, invoice_number: null, amount_minor: Number(amount) });
  }
  const snapshot: ReceiptSnapshot = {
    ...(await partySnapshot(tx, pay.businessId, pay.customerId)),
    method: await methodWords(tx, pay),
    payments: [pay.publicId],
    payment_request: null,
    allocations,
  };
  const [row] = await tx
    .insert(receipts)
    .values({
      organizationId: pay.organizationId,
      businessId: pay.businessId,
      customerId: pay.customerId,
      publicId: publicId("rcpt"),
      paymentId: pay.id,
      amountMinor: amount,
      currency: pay.currency,
      paidAt: input.paidAt ?? pay.createdAt,
      snapshot,
    })
    .onConflictDoNothing()
    .returning();
  if (row) scheduleNumbering(pay.organizationId, pay.businessId);
  return row ?? null;
}

/** The one receipt for a payment-request settlement (one money event on the request). */
export async function createReceiptForRequestSettlement(
  tx: Tx,
  input: {
    requestId: string;
    transactionId: string;
    paidAt: Date;
    /** The child payments this settlement created, with what each applied. */
    children: Array<{ paymentId: string; invoiceId: string | null; amountMinor: bigint }>;
    /** Money that landed as customer credit rather than on an invoice. */
    creditMinor?: bigint;
  },
): Promise<Receipt | null> {
  const [req] = await tx
    .select()
    .from(paymentRequests)
    .where(eq(paymentRequests.id, input.requestId))
    .limit(1);
  if (!req) return null;
  const total = input.children.reduce((s, c) => s + c.amountMinor, 0n) + (input.creditMinor ?? 0n);
  if (total <= 0n) return null;
  const allocations: ReceiptAllocation[] = [];
  const payIds: string[] = [];
  let firstPay: typeof payments.$inferSelect | null = null;
  for (const c of input.children) {
    const [pay] = await tx.select().from(payments).where(eq(payments.id, c.paymentId)).limit(1);
    if (pay) {
      payIds.push(pay.publicId);
      firstPay ??= pay;
    }
    const [inv] = c.invoiceId
      ? await tx
          .select({ publicId: invoices.publicId, number: invoices.number })
          .from(invoices)
          .where(eq(invoices.id, c.invoiceId))
          .limit(1)
      : [];
    allocations.push({
      invoice: inv?.publicId ?? null,
      invoice_number: inv?.number ?? null,
      amount_minor: Number(c.amountMinor),
    });
  }
  if (input.creditMinor && input.creditMinor > 0n)
    allocations.push({
      invoice: null,
      invoice_number: null,
      amount_minor: Number(input.creditMinor),
    });
  const snapshot: ReceiptSnapshot = {
    ...(await partySnapshot(tx, req.businessId, req.customerId)),
    method: firstPay
      ? await methodWords(tx, firstPay)
      : await methodWords(tx, {
          providerKey: req.providerKey ?? "",
          providerChargeId: null,
          paymentMethodId: req.paymentMethodId,
        }),
    payments: payIds,
    payment_request: req.publicId,
    allocations,
  };
  const [row] = await tx
    .insert(receipts)
    .values({
      organizationId: req.organizationId,
      businessId: req.businessId,
      customerId: req.customerId,
      publicId: publicId("rcpt"),
      paymentRequestId: req.id,
      transactionId: input.transactionId,
      amountMinor: total,
      currency: req.currency,
      paidAt: input.paidAt,
      snapshot,
    })
    .onConflictDoNothing()
    .returning();
  if (row) scheduleNumbering(req.organizationId, req.businessId);
  return row ?? null;
}

/**
 * Event sink: every `payment_succeeded` leaves a receipt. In the emitting transaction, so a
 * rolled-back payment leaves none. Children of a payment request are skipped here.
 */
export async function receiptSink(tx: Tx, ev: EventRow): Promise<void> {
  if (ev.type !== "payment_succeeded" || !ev.businessId) return;
  const data = (ev.data ?? {}) as { payment?: { id?: unknown; amount_minor?: unknown } };
  const pid = typeof data.payment?.id === "string" ? data.payment.id : null;
  if (!pid) return;
  const [pay] = await tx
    .select({ id: payments.id, providerKey: payments.providerKey, createdAt: payments.createdAt })
    .from(payments)
    .where(and(eq(payments.businessId, ev.businessId), eq(payments.publicId, pid)))
    .limit(1);
  if (!pay) return;
  const received =
    typeof data.payment?.amount_minor === "number" && data.payment.amount_minor > 0
      ? BigInt(data.payment.amount_minor)
      : undefined;
  try {
    // A savepoint: a receipt must never fail the payment that earned it.
    await tx.transaction((sp) =>
      createReceiptForPayment(sp, {
        paymentId: pay.id,
        receivedMinor: received,
        // An offline payment carries the date the operator entered; others settle now.
        paidAt: pay.providerKey === "offline" ? pay.createdAt : ev.createdAt,
      }),
    );
  } catch (e) {
    log.error(e as Error, { event: "receipt_create_failed", payment: pid });
  }
}

/** Numbers for `count` receipts with one counter update. */
async function nextReceiptNumbers(tx: Tx, businessId: string, ats: Date[]): Promise<string[]> {
  if (ats.length === 0) return [];
  const [cfg] = await tx
    .select({ customization: businesses.invoiceCustomization, timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  const numbering = resolveInvoiceCustomization({
    invoiceCustomization: cfg?.customization,
  }).receiptNumbering;
  const step = BigInt(numbering.increment);
  const [b] = await tx
    .update(businesses)
    .set({
      receiptNextNumber: sql`${businesses.receiptNextNumber} + ${step * BigInt(ats.length)}`,
    })
    .where(eq(businesses.id, businessId))
    .returning({ prefix: businesses.receiptPrefix, next: businesses.receiptNextNumber });
  const first = b!.next - step * BigInt(ats.length);
  return ats.map((at, i) =>
    composeDocumentNumber({
      prefix: b!.prefix,
      counter: first + step * BigInt(i),
      numbering,
      at,
      timezone: cfg?.timezone ?? "UTC",
    }),
  );
}

export function serializeReceipt(
  r: Receipt,
  refs?: { customer?: string | null; payment?: string | null; paymentRequest?: string | null },
) {
  const snap = r.snapshot as ReceiptSnapshot;
  return {
    object: "receipt",
    id: r.publicId,
    number: r.number,
    customer: refs?.customer ?? snap.payer?.id ?? null,
    payment: refs?.payment ?? (snap.payment_request ? null : (snap.payments?.[0] ?? null)),
    payments: snap.payments ?? [],
    payment_request: refs?.paymentRequest ?? snap.payment_request ?? null,
    amount_minor: Number(r.amountMinor),
    currency: r.currency,
    paid_at: r.paidAt,
    method: snap.method,
    allocations: snap.allocations,
    payer: snap.payer,
    numbered_at: r.numberedAt,
    created_at: r.createdAt,
  };
}

/**
 * Number a business's unnumbered receipts, oldest first, with ONE counter update per batch,
 * and emit `receipt_created` for each. Single-flight per business. Returns how many it
 * numbered; a full batch means more may be waiting.
 */
export async function numberUnnumberedReceipts(
  organizationId: string,
  businessId: string,
  limit: number = config.INVOICE_NUMBER_BATCH,
): Promise<number> {
  return withTenant(organizationId, async (tx) => {
    const [lock] = (await tx.execute(
      sql`select pg_try_advisory_xact_lock(hashtext(${"number_receipts:" + businessId})) ok`,
    )) as unknown as Array<{ ok: boolean }>;
    if (!lock?.ok) return 0;
    const rows = await tx
      .select()
      .from(receipts)
      .where(and(eq(receipts.businessId, businessId), sql`${receipts.number} is null`))
      .orderBy(asc(receipts.createdAt), asc(receipts.id))
      .limit(limit);
    if (rows.length === 0) return 0;
    const numbers = await nextReceiptNumbers(
      tx,
      businessId,
      rows.map((r) => r.paidAt),
    );
    const assigned = rows.map((r, i) => ({ id: r.id, number: numbers[i]! }));
    await tx.execute(sql`
      update receipts r set number = v.number, numbered_at = app_now()
      from jsonb_to_recordset(${JSON.stringify(assigned)}::jsonb) as v(id uuid, number text)
      where r.id = v.id`);
    for (let i = 0; i < rows.length; i++) {
      const r = { ...rows[i]!, number: numbers[i]! };
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "receipt_created",
        data: buildEventData("receipt_created", serializeReceipt(r)),
      });
    }
    return rows.length;
  });
}

// ── Read API ────────────────────────────────────────────────────────────────

export const RECEIPT_FILTER_SPECS: Record<string, FilterSpec> = {
  created_at: { column: receipts.createdAt, kind: "date" },
  paid_at: { column: receipts.paidAt, kind: "date" },
  amount_minor: { column: receipts.amountMinor, kind: "number" },
  currency: { column: receipts.currency, kind: "enum" },
  number: { column: receipts.number, kind: "text" },
};
export const RECEIPT_SORT_FIELDS = ["created_at"] as const;

export interface ReceiptRow {
  receipt: Receipt;
  customer: string | null;
  payment: string | null;
  paymentRequest: string | null;
}

const ROW_SELECTION = {
  receipt: receipts,
  customer: customers.publicId,
  payment: payments.publicId,
  paymentRequest: paymentRequests.publicId,
};

function rowQuery(tx: Tx) {
  return tx
    .select(ROW_SELECTION)
    .from(receipts)
    .leftJoin(customers, eq(customers.id, receipts.customerId))
    .leftJoin(payments, eq(payments.id, receipts.paymentId))
    .leftJoin(paymentRequests, eq(paymentRequests.id, receipts.paymentRequestId));
}

export function serializeReceiptRow(r: ReceiptRow) {
  return serializeReceipt(r.receipt, {
    customer: r.customer,
    payment: r.payment,
    paymentRequest: r.paymentRequest,
  });
}

export async function listReceiptsPage(
  organizationId: string,
  businessId: string,
  f: {
    customerPublicId?: string;
    paymentPublicId?: string;
    paymentRequestPublicId?: string;
    invoicePublicId?: string;
    filters?: ListFilter[];
    search?: string;
    startingAfter?: string;
    limit?: number;
    sortDesc?: boolean;
    tz?: string;
  } = {},
): Promise<ListPage<ReceiptRow>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? true;
  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(receipts.businessId, businessId)];
    if (f.customerPublicId)
      conds.push(
        sql`${receipts.customerId} = (select id from customers where business_id = ${businessId} and public_id = ${f.customerPublicId})`,
      );
    if (f.paymentPublicId)
      conds.push(
        sql`(${receipts.paymentId} = (select id from payments where business_id = ${businessId} and public_id = ${f.paymentPublicId})
          or ${receipts.snapshot} -> 'payments' ? ${f.paymentPublicId})`,
      );
    if (f.paymentRequestPublicId)
      conds.push(
        sql`${receipts.paymentRequestId} = (select id from payment_requests where business_id = ${businessId} and public_id = ${f.paymentRequestPublicId})`,
      );
    if (f.invoicePublicId)
      conds.push(
        sql`${receipts.snapshot} -> 'allocations' @> ${JSON.stringify([{ invoice: f.invoicePublicId }])}::jsonb`,
      );
    conds.push(...filterConditions(RECEIPT_FILTER_SPECS, f.filters, f.tz));
    const search = searchCondition([receipts.number, receipts.publicId], f.search);
    if (search) conds.push(search);
    const { keysetId, offset } = parseCursor(f.startingAfter);
    const total =
      keysetId || offset
        ? null
        : ((
            await tx
              .select({ n: countExpr })
              .from(receipts)
              .where(and(...conds))
          )[0]?.n ?? 0);
    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${receipts.createdAt}::text`,
          publicId: receipts.publicId,
        })
        .from(receipts)
        .where(and(eq(receipts.businessId, businessId), eq(receipts.publicId, keysetId)))
        .limit(1);
      const seek = keysetCondition(
        receipts.createdAt,
        receipts.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }
    const rows = await rowQuery(tx)
      .where(and(...pageConds))
      .orderBy(...pageOrder(receipts.createdAt, receipts.publicId, descending, true))
      .limit(limit + 1);
    return toPage(rows, limit, {
      keyset: true,
      offset,
      keyOf: (r) => r.receipt.publicId,
      total,
    });
  });
}

export async function getReceipt(
  organizationId: string,
  businessId: string,
  receiptPublicId: string,
  opts?: { customerId?: string },
): Promise<ReceiptRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await rowQuery(tx)
      .where(
        and(
          eq(receipts.businessId, businessId),
          eq(receipts.publicId, receiptPublicId),
          ...(opts?.customerId ? [eq(receipts.customerId, opts.customerId)] : []),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/** Public ids of the receipts behind these payments (for payment and invoice reads). */
export async function receiptRefsForPayments(
  tx: Tx,
  paymentIds: string[],
): Promise<Map<string, string>> {
  if (!paymentIds.length) return new Map();
  const rows = await tx
    .select({ paymentId: receipts.paymentId, publicId: receipts.publicId })
    .from(receipts)
    .where(inArray(receipts.paymentId, paymentIds));
  return new Map(rows.map((r) => [r.paymentId!, r.publicId]));
}
