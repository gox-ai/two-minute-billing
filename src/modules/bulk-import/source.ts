/**
 * A `MigrationSource` over the checked rows of a file import. The engine is unchanged: it
 * reads these lists the way it reads any other source.
 *
 * Records a row refers to but does not carry (a subscription's customer that is in the
 * business already) are listed as stubs with only their id. The engine finds their import
 * record and maps to them without writing; `runs.ts` adopts business records that were never
 * imported before the run, so every stub has a record.
 */
import type {
  MigrationSource,
  SourceCatalog,
  SourceCoupon,
  SourceCreditNote,
  SourceCustomer,
  SourceInvoice,
  SourcePrice,
  SourceProduct,
  SourceSubscription,
  SourceSubStatus,
  SourceTransaction,
  SourceUsageRecord,
} from "@/modules/migration/types";
import type { ParsedValues, Tier } from "./parse";

export interface StagedRow {
  rowNumber: number;
  values: ParsedValues;
}

export interface StagedInput {
  plans: StagedRow[];
  addons: StagedRow[];
  coupons: StagedRow[];
  customers: StagedRow[];
  /** Grouped: one entry per subscription, rows in file order. */
  subscriptions: Array<{ sourceId: string; rows: StagedRow[]; currency: string }>;
  /** Grouped: one entry per invoice, rows (its lines) in file order. */
  invoices?: Array<{ sourceId: string; rows: StagedRow[] }>;
  creditNotes?: StagedRow[];
  payments?: StagedRow[];
  usage?: StagedRow[];
  /** Open invoices enter the retry schedule; off: they stay owed with collection stopped. */
  collectOpenInvoices?: boolean;
  /** Invoice id → its customer id, for a credit note that names no customer. */
  invoiceCustomers?: Record<string, string>;
  /** Ids the rows refer to that are in the business already (each has an import record). */
  refs: {
    prices: string[];
    coupons: string[];
    customers: string[];
    subscriptions?: string[];
    invoices?: string[];
  };
  /** price id → kind, for subscription items. */
  priceKinds: Record<string, "plan" | "addon" | "charge">;
}

const str = (v: unknown) => (v == null ? undefined : String(v));
const num = (v: unknown) => (v == null ? undefined : Number(v));
const date = (v: unknown) => (v == null ? undefined : new Date(String(v)));
const stamps = (v: ParsedValues) => {
  const d = date(v.created_at);
  return d ? { createdAt: d, updatedAt: d } : {};
};

/** "Jordan Lee" → first "Jordan", last "Lee"; one word is a first name. */
export function splitName(name: string): { firstName?: string; lastName?: string } {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

export class StagedSource implements MigrationSource {
  constructor(
    readonly name: string,
    private readonly input: StagedInput,
  ) {}

  async listCatalog(): Promise<SourceCatalog> {
    const products = new Map<string, SourceProduct>();
    const prices: SourcePrice[] = [];
    for (const [entity, rows] of [
      ["plans", this.input.plans],
      ["addons", this.input.addons],
    ] as const) {
      for (const { values: v } of rows) {
        const priceId = String(v.price_id);
        const productId = str(v[entity === "plans" ? "plan_id" : "addon_id"]) ?? priceId;
        const recurring = v.interval != null;
        const kind = entity === "plans" ? "plan" : recurring ? "addon" : "charge";
        const existing = products.get(productId);
        if (!existing)
          products.set(productId, {
            sourceId: productId,
            kind,
            name: String(v.name),
            description: str(v.description),
            ...stamps(v),
          });
        else if (existing.kind === "charge" && kind === "addon") existing.kind = "addon";
        const model = (v.pricing_model as SourcePrice["model"] | null) ?? "flat";
        const tiers = (v.tiers as Tier[] | null)?.map((t) => ({
          upTo: t.upTo,
          ...(model === "stairstep"
            ? { flatAmountMinor: t.amountMinor }
            : { unitAmountMinor: t.amountMinor }),
        }));
        prices.push({
          sourceId: priceId,
          productSourceId: productId,
          model,
          amountMinor: model === "flat" || model === "per_unit" ? num(v.amount) : undefined,
          currency: String(v.currency),
          interval: (v.interval as SourcePrice["interval"] | null) ?? undefined,
          intervalCount: num(v.interval_count) ?? 1,
          tiers,
          trialPeriod: num(v.trial_days) || undefined,
          trialPeriodUnit: v.trial_days ? "day" : undefined,
          name: String(v.name),
          description: str(v.description),
          active: v.status !== "archived",
          ...stamps(v),
        });
      }
    }
    // Every product's active flag follows its prices: archived only when all prices are.
    for (const p of products.values()) {
      const own = prices.filter((x) => x.productSourceId === p.sourceId);
      if (own.length && own.every((x) => x.active === false)) p.active = false;
    }
    for (const id of this.input.refs.prices)
      prices.push({ sourceId: id, productSourceId: id, model: "flat", currency: "USD" });
    return {
      groups: [],
      products: [...products.values()],
      prices,
      attachedAddons: [],
      differentialPrices: [],
    };
  }

  async listCoupons(): Promise<{ coupons: SourceCoupon[]; couponSets: [] }> {
    const coupons: SourceCoupon[] = this.input.coupons.map(({ values: v }) => ({
      sourceId: String(v.coupon_id),
      code: String(v.coupon_id),
      name: str(v.name),
      kind: v.discount_type === "fixed_amount" ? "fixed_amount" : "percentage",
      percentOffBps: v.discount_type === "percentage" ? num(v.percent_off) : undefined,
      amountOffMinor: v.discount_type === "fixed_amount" ? num(v.amount_off) : undefined,
      currency: v.discount_type === "fixed_amount" ? str(v.currency) : undefined,
      durationType: (v.duration as SourceCoupon["durationType"] | null) ?? "once",
      durationInPeriods: v.duration === "repeating" ? num(v.duration_periods) : undefined,
      maxRedemptions: num(v.max_redemptions),
      redeemBy: date(v.redeem_by),
      active: v.status !== "archived",
      ...stamps(v),
    }));
    for (const id of this.input.refs.coupons)
      coupons.push({ sourceId: id, code: id, kind: "percentage", durationType: "once" });
    return { coupons, couponSets: [] };
  }

  async listCustomers(): Promise<SourceCustomer[]> {
    const out: SourceCustomer[] = this.input.customers.map(({ values: v }) => {
      const names =
        v.first_name != null || v.last_name != null
          ? { firstName: str(v.first_name), lastName: str(v.last_name) }
          : v.name != null
            ? splitName(String(v.name))
            : {};
      const hasAddress = [
        "address_line1",
        "address_line2",
        "city",
        "state",
        "postal_code",
        "country",
      ].some((k) => v[k] != null);
      return {
        sourceId: String(v.customer_id),
        email: str(v.email),
        ...names,
        company: str(v.company),
        phone: str(v.phone),
        autoCollection: (v.auto_collection as "on" | "off" | null) ?? undefined,
        netTermDays: num(v.net_term_days),
        vatNumber: str(v.tax_id),
        billingAddress: hasAddress
          ? {
              line1: str(v.address_line1),
              line2: str(v.address_line2),
              city: str(v.city),
              state: str(v.state),
              postalCode: str(v.postal_code),
              country: str(v.country),
            }
          : undefined,
        paymentMethods:
          v.gateway_payment_method_id != null
            ? [
                {
                  provider: String(v.payment_gateway),
                  providerCustomerId: String(v.gateway_customer_id),
                  providerPaymentMethodId: String(v.gateway_payment_method_id),
                  brand: str(v.card_brand)?.toLowerCase(),
                  last4: str(v.card_last4)?.slice(-4),
                  expMonth: num(v.card_exp_month),
                  expYear: num(v.card_exp_year),
                  isPrimary: true,
                },
              ]
            : undefined,
        ...stamps(v),
      };
    });
    for (const id of this.input.refs.customers) out.push({ sourceId: id });
    return out;
  }

  async listSubscriptions(): Promise<SourceSubscription[]> {
    // Stubs: the engine finds their import record and maps to them without reading the rest.
    const stubs: SourceSubscription[] = (this.input.refs.subscriptions ?? []).map((id) => ({
      sourceId: id,
      customerSourceId: "",
      items: [],
      status: "active",
      currency: "USD",
      currentTermEnd: new Date(0),
    }));
    return [...this.subscriptionsOf(), ...stubs];
  }

  private subscriptionsOf(): SourceSubscription[] {
    return this.input.subscriptions.map(({ sourceId, rows, currency }) => {
      const v = rows[0]!.values;
      const coupons = [
        ...new Set(rows.flatMap((r) => (r.values.coupon_ids as string[] | null) ?? [])),
      ];
      const created = date(v.created_at);
      return {
        sourceId,
        customerSourceId: String(v.customer_id),
        items: rows.map(({ values: r }) => ({
          priceSourceId: String(r.price_id),
          kind: this.input.priceKinds[String(r.price_id)],
          quantity: num(r.quantity) ?? 1,
          unitPriceMinor: num(r.unit_price),
        })),
        appliedCoupons: coupons.length ? coupons.map((c) => ({ couponSourceId: c })) : undefined,
        status: ((v.status as SourceSubStatus | null) ?? "active") as SourceSubStatus,
        currency,
        currentTermEnd: new Date(String(v.current_term_end)),
        currentTermStart: date(v.current_term_start),
        trialEnd: date(v.trial_end),
        startDate: date(v.start_date),
        canceledAt: date(v.cancelled_at),
        autoCollection: (v.auto_collection as "on" | "off" | null) ?? undefined,
        poNumber: str(v.po_number),
        startedAt: created,
        ...(created ? { createdAt: created, updatedAt: created } : {}),
      };
    });
  }

  async listInvoices(): Promise<SourceInvoice[]> {
    const out: SourceInvoice[] = (this.input.invoices ?? []).map(({ sourceId, rows }) => {
      const v = rows[0]!.values;
      const status = v.status as "paid" | "payment_due" | "voided";
      const total = Number(v.total);
      const due =
        v.amount_due != null ? Number(v.amount_due) : status === "payment_due" ? total : 0;
      const tax = num(v.tax) ?? 0;
      const discount = num(v.discount) ?? 0;
      const issued = new Date(String(v.date));
      const lines = rows.map(({ values: r }) => {
        const qty = num(r.line_quantity) ?? 1;
        const amount = Number(r.line_amount);
        return {
          description: String(r.line_description),
          priceSourceId: str(r.line_price_id),
          quantity: qty,
          unitAmountMinor: qty ? Math.round(amount / qty) : amount,
          amountMinor: amount,
          periodStart: date(v.period_start),
          periodEnd: date(v.period_end),
        };
      });
      return {
        sourceId,
        customerSourceId: String(v.customer_id),
        subscriptionSourceId: str(v.subscription_id),
        number: str(v.number) ?? sourceId,
        status,
        currency: String(v.currency),
        subtotalMinor: lines.reduce((n, l) => n + l.amountMinor, 0),
        totalMinor: total,
        amountDueMinor: due,
        date: issued,
        dueDate: date(v.due_date),
        paidAt: status === "paid" ? (date(v.paid_at) ?? issued) : undefined,
        periodStart: date(v.period_start),
        periodEnd: date(v.period_end),
        lines,
        taxes: tax ? [{ name: "Tax", amountMinor: tax }] : undefined,
        discounts: discount ? [{ description: "Discount", amountMinor: discount }] : undefined,
        // Owed but not collected unless the import says so: the source may still be collecting.
        dunning:
          status === "payment_due" && !this.input.collectOpenInvoices
            ? { attemptCount: 0, status: "stopped" }
            : undefined,
      };
    });
    for (const id of this.input.refs.invoices ?? [])
      out.push({
        sourceId: id,
        customerSourceId: "",
        status: "paid",
        currency: "USD",
        subtotalMinor: 0,
        totalMinor: 0,
        amountDueMinor: 0,
        date: new Date(0),
        lines: [],
      });
    return out;
  }

  async listCreditNotes(): Promise<SourceCreditNote[]> {
    return (this.input.creditNotes ?? []).map(({ values: v }) => {
      const invoiceId = String(v.invoice_id);
      const allocated = num(v.amount_allocated) ?? 0;
      const issued = new Date(String(v.date));
      return {
        sourceId: String(v.credit_note_id),
        customerSourceId: str(v.customer_id) ?? this.input.invoiceCustomers?.[invoiceId] ?? "",
        invoiceSourceId: invoiceId,
        type: (v.type as "refundable" | "adjustment" | null) ?? "refundable",
        status: v.voided_at != null ? "voided" : "issued",
        voidedAt: date(v.voided_at),
        totalMinor: Number(v.total),
        amountAvailableMinor: num(v.amount_available) ?? 0,
        amountAllocatedMinor: allocated,
        amountRefundedMinor: num(v.amount_refunded) ?? 0,
        currency: String(v.currency),
        reason: str(v.reason),
        date: issued,
        allocations: allocated
          ? [{ invoiceSourceId: invoiceId, amountMinor: allocated, date: issued }]
          : [],
      };
    });
  }

  async listTransactions(): Promise<SourceTransaction[]> {
    return (this.input.payments ?? []).map(({ values: v }) => {
      const status = (v.status as "succeeded" | "failed" | null) ?? "succeeded";
      const amount = Number(v.amount);
      return {
        sourceId: String(v.transaction_id),
        customerSourceId: String(v.customer_id),
        type: (v.type as "payment" | "refund" | null) ?? "payment",
        status,
        gatewayStatus: status,
        errorText: str(v.failure_reason),
        amountMinor: amount,
        currency: String(v.currency),
        gateway: str(v.payment_gateway),
        gatewayTransactionId: str(v.gateway_transaction_id),
        date: new Date(String(v.date)),
        linkedInvoices:
          v.invoice_id != null
            ? [{ invoiceSourceId: String(v.invoice_id), appliedAmountMinor: amount }]
            : undefined,
        refundedTransactionSourceId: str(v.refunded_transaction_id),
      };
    });
  }

  async listUsageRecords(): Promise<SourceUsageRecord[]> {
    return (this.input.usage ?? []).map(({ values: v }) => ({
      sourceId: String(v.usage_id),
      subscriptionSourceId: String(v.subscription_id),
      priceSourceId: String(v.price_id),
      quantity: Number(v.quantity),
      timestamp: new Date(String(v.timestamp)),
    }));
  }
}
