import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { assembleInvoiceDocument } from "@/modules/invoicing/document";
import {
  customers,
  events,
  invoices,
  payments,
  prices,
  refunds,
  subscriptionItems,
  subscriptions,
} from "@db/schema";
import type { PushContext, PushIntegration, PushRequest, PushVerdict } from "../types";
import { DEFAULT_TID_FIELD, firstPromoterInfo } from "./firstpromoter-info";

/**
 * FirstPromoter — affiliate tracking (API **v2**).
 *
 * Four one-shot tracking calls:
 *   `/track/signup`        a lead exists, and WHO referred it
 *   `/track/sale`          money collected → commission
 *   `/track/refund`        money returned → negative commission
 *   `/track/cancellation`  the lead churned
 *
 * v2 authenticates with a Bearer token AND an `ACCOUNT-ID` header, both from
 * Settings → Integrations. ⚠️ This was built against v1 first (`firstpromoter.com/api/v1`,
 * a single `X-API-KEY`) and every call came back **401**: a v2 key against a v1 endpoint is
 * rejected, and v2 would refuse us anyway for the missing account id. The v1 header was
 * correct — `X-API-KEY` is what its OpenAPI spec defines — so the header was never the bug;
 * the API VERSION was. If a v1 account ever turns up it needs its own entry, not a branch
 * here: the base URL, both headers and the credential set all differ.
 *
 * Amounts are minor units, which is what they mean by "cents" — including for zero-decimal
 * currencies, where they want whole values and our minor unit already IS the whole unit. So no
 * scaling anywhere in this file, deliberately.
 *
 * `event_id` on the sale and refund calls is OUR event's public id. That is what makes a retry
 * safe: the third attempt of a delivery carries the same id as the first, so a commission that
 * was already recorded comes back 409 rather than being paid twice.
 */

const DEFAULT_REF_ID_FIELD = "fp_ref_id";

/**
 * Read a customer custom field by the name an OPERATOR typed.
 *
 * A leading `cf_` is stripped, the same rule `validateAndCoerce`'s `baseKey` follows: the
 * stored key is bare, but `cf_` is what the API surface and the Custom fields screen both
 * SHOW, so `cf_tid` is the natural thing to copy out of it and would otherwise match nothing —
 * and "matches nothing" here is indistinguishable from "this customer was not referred".
 */
function customFieldString(custom: unknown, field: string): string | null {
  if (!custom || typeof custom !== "object") return null;
  const key = field.startsWith("cf_") ? field.slice(3) : field;
  const v = (custom as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** The resource public id an event is about — `{ invoice: { id: 'inv_…' } }` → `inv_…`. */
function resourceId(data: unknown, key: string): string | null {
  const resource = (data as Record<string, unknown> | null)?.[key];
  if (!resource || typeof resource !== "object") return null;
  const id = (resource as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function resourceField(data: unknown, key: string, field: string): unknown {
  const resource = (data as Record<string, unknown> | null)?.[key];
  if (!resource || typeof resource !== "object") return undefined;
  return (resource as Record<string, unknown>)[field];
}

/**
 * `base` is the connection's own `api_base` column, not the constant below. The constant seeds a new
 * connection; the row is what we actually call, so pointing a connection at a sandbox or a capture
 * proxy is a column edit rather than a deploy.
 */
function request(
  base: string,
  path: string,
  auth: { apiKey: string; accountId: string },
  params: Record<string, unknown>,
): PushRequest {
  return {
    url: `${base.replace(/\/+$/, "")}${path}`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.apiKey}`,
      // Their spelling, from the v2 spec's `accountId` scheme. Header names are
      // case-insensitive on the wire, but matching the documentation makes a captured request
      // comparable to their examples without a second guess.
      "ACCOUNT-ID": auth.accountId,
    },
    body: JSON.stringify(params),
    // The account id is NOT masked: FirstPromoter prints it openly in its own dashboard, and
    // seeing it in a transcript is how an operator tells two connected accounts apart.
    secretHeaders: ["Authorization"],
  };
}

function authOf(ctx: PushContext): { apiKey: string; accountId: string } {
  const apiKey = ctx.credentials.apiKey;
  const accountId = ctx.credentials.accountId;
  if (
    typeof apiKey !== "string" ||
    apiKey === "" ||
    typeof accountId !== "string" ||
    accountId === ""
  ) {
    /*
     * Structurally unreachable for a connection created after v2 support: `connectIntegration`
     * refuses a transform whose declared credentials are not all present. Reachable for a row
     * connected against v1, which stored only `apiKey` — thrown rather than skipped, because
     * such a row can never succeed and a silent skip would look like an account with no
     * referrals rather than one that needs reconnecting.
     */
    throw new Error(
      "The FirstPromoter connection is missing apiKey or accountId. Connect it again",
    );
  }
  return { apiKey, accountId };
}

/** The customer, loaded by internal id, with the two fields only they can give us. */
async function loadCustomer(orgId: string, customerId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({
        publicId: customers.publicId,
        email: customers.email,
        firstName: customers.firstName,
        lastName: customers.lastName,
        customFields: customers.customFields,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    return row ?? null;
  });
}

/**
 * The sale amount FirstPromoter wants: what was actually charged, BEFORE tax and AFTER every
 * discount.
 *
 * Assembled through `assembleInvoiceDocument` rather than read off the invoice row, because
 * neither number is a column. `subtotal_minor` is already net of ITEM-level discounts but not
 * document-level ones, which live as their own line items — so `subtotal − discountTotal` is
 * the only expression that holds for both stages, and it is the document builder that knows it.
 * Getting this wrong pays commission on tax, or twice on a discount.
 */
async function invoiceCommissionable(
  orgId: string,
  businessId: string,
  invoicePublicId: string,
): Promise<{ netMinor: bigint; totalMinor: bigint } | null> {
  const doc = await assembleInvoiceDocument(orgId, businessId, invoicePublicId);
  if (!doc) return null;
  const netMinor = doc.totals.subtotalMinor - doc.totals.discountTotalMinor;
  return { netMinor: netMinor > 0n ? netMinor : 0n, totalMinor: doc.totals.totalMinor };
}

/** The subscription's first item, for the `plan` and `quantity` a commission rule reads. */
async function loadPlan(orgId: string, subscriptionId: string) {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ plan: prices.publicId, quantity: subscriptionItems.quantity })
      .from(subscriptionItems)
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .where(eq(subscriptionItems.subscriptionId, subscriptionId))
      .orderBy(subscriptionItems.publicId)
      .limit(1);
    return row ?? null;
  });
}

/**
 * The `event_id` we sent on the sale this refund reverses.
 *
 * Optional to FirstPromoter but recommended: without it a refund is matched to the lead only,
 * so on an account selling several products the negative commission can land on the wrong sale.
 * We can supply it exactly because our sale call used an event id we still have — the
 * `invoice_paid` event for the same invoice.
 */
async function saleEventIdForInvoice(
  orgId: string,
  invoicePublicId: string,
): Promise<string | null> {
  /**
   * Matched on `resource_type` + `resource_id`, NOT on the jsonb payload.
   *
   * `data->'invoice'->>'id' = $1` is the obvious expression and it is a production trap: no
   * index covers it, so Postgres reads every `invoice_paid` event ever emitted — a number that
   * grows with the book, per refund — and filters them one at a time. `emitEvent` already
   * denormalises the same value into `resource_id` (via `deriveResourceId`), and
   * `events_resource_idx` covers `(resource_type, resource_id)`, which is a handful of rows.
   */
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ publicId: events.publicId })
      .from(events)
      .where(
        and(
          eq(events.resourceType, "invoice"),
          eq(events.resourceId, invoicePublicId),
          eq(events.type, "invoice_paid"),
        ),
      )
      .orderBy(desc(events.createdAt))
      .limit(1);
    return row?.publicId ?? null;
  });
}

async function buildSignup(ctx: PushContext): Promise<PushRequest | null> {
  const publicId = resourceId(ctx.event.data, "customer");
  if (!publicId || !ctx.event.businessId) return null;

  const customer = await withTenant(ctx.event.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.businessId, ctx.event.businessId!), eq(customers.publicId, publicId)))
      .limit(1);
    return row ?? null;
  });
  if (!customer) return null;

  const tidField =
    typeof ctx.config.tidField === "string" ? ctx.config.tidField : DEFAULT_TID_FIELD;
  const refField =
    typeof ctx.config.refIdField === "string" ? ctx.config.refIdField : DEFAULT_REF_ID_FIELD;
  const tid = customFieldString(customer.customFields, tidField);
  const refId = customFieldString(customer.customFields, refField);

  /**
   * SKIPPED, not failed, and not sent anyway.
   *
   * FirstPromoter requires `tid` or `ref_id` on a signup — they are the referral itself, and a
   * call without one is a 400. The overwhelming majority of customers arrive with neither
   * because they were never referred, so this is the normal case, not an error: there is no
   * lead to create. Sending anyway would spend six attempts per organic signup learning that.
   */
  if (!tid && !refId) return null;

  return request(ctx.baseUrl, "/track/signup", authOf(ctx), {
    email: customer.email ?? undefined,
    uid: customer.publicId,
    ...(tid ? { tid } : { ref_id: refId }),
    ...(customer.firstName ? { first_name: customer.firstName } : {}),
    ...(customer.lastName ? { last_name: customer.lastName } : {}),
    created_at: ctx.event.createdAt.toISOString(),
  });
}

async function buildSale(ctx: PushContext): Promise<PushRequest | null> {
  const invoicePublicId = resourceId(ctx.event.data, "invoice");
  if (!invoicePublicId || !ctx.event.businessId) return null;
  const orgId = ctx.event.organizationId;
  const businessId = ctx.event.businessId;

  const inv = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({
        customerId: invoices.customerId,
        subscriptionId: invoices.subscriptionId,
        currency: invoices.currency,
      })
      .from(invoices)
      .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId)))
      .limit(1);
    return row ?? null;
  });
  if (!inv) return null;

  const money = await invoiceCommissionable(orgId, businessId, invoicePublicId);
  // Nothing commissionable: a 100%-discounted or fully credit-covered invoice is genuinely
  // paid, and a zero-amount sale earns nothing on any commission rule FirstPromoter can express.
  if (!money || money.netMinor === 0n) return null;

  const customer = await loadCustomer(orgId, inv.customerId);
  if (!customer) return null;

  const plan = inv.subscriptionId ? await loadPlan(orgId, inv.subscriptionId) : null;
  const subscriptionPublicId = inv.subscriptionId
    ? await withTenant(orgId, async (tx) => {
        const [row] = await tx
          .select({ publicId: subscriptions.publicId })
          .from(subscriptions)
          .where(eq(subscriptions.id, inv.subscriptionId!))
          .limit(1);
        return row?.publicId ?? null;
      })
    : null;

  return request(ctx.baseUrl, "/track/sale", authOf(ctx), {
    email: customer.email ?? undefined,
    uid: customer.publicId,
    event_id: ctx.event.publicId,
    amount: Number(money.netMinor),
    currency: inv.currency,
    ...(plan ? { plan: plan.plan, quantity: plan.quantity } : {}),
    ...(subscriptionPublicId ? { subscription_id: subscriptionPublicId } : {}),
    created_at: ctx.event.createdAt.toISOString(),
  });
}

async function buildRefund(ctx: PushContext): Promise<PushRequest | null> {
  const refundPublicId = resourceId(ctx.event.data, "refund");
  if (!refundPublicId || !ctx.event.businessId) return null;
  const orgId = ctx.event.organizationId;
  const businessId = ctx.event.businessId;

  /**
   * `refund_created` fires when the provider ACCEPTS the refund, which on cards and bank rails
   * is days before the money moves; `refund_settled` is the confirmation. We claw a commission
   * back on the money, not the instruction — so a `refund_created` still `pending` is skipped
   * and its `refund_settled` carries the call. A refund born `succeeded` never emits
   * `refund_settled` (that transition only fires out of `pending`), which is why both types are
   * subscribed and why exactly one of them sends.
   */
  const status = resourceField(ctx.event.data, "refund", "status");
  if (ctx.event.type === "refund_created" && status !== "succeeded") return null;

  const row = await withTenant(orgId, async (tx) => {
    const [r] = await tx
      .select({
        amountMinor: refunds.amountMinor,
        currency: refunds.currency,
        customerId: payments.customerId,
        invoiceId: payments.invoiceId,
      })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(and(eq(refunds.businessId, businessId), eq(refunds.publicId, refundPublicId)))
      .limit(1);
    return r ?? null;
  });
  if (!row) return null;

  const customer = await loadCustomer(orgId, row.customerId);
  if (!customer) return null;

  /**
   * SCALED to the commissionable share of the invoice.
   *
   * The refund row is gross — it includes the tax the buyer paid. The sale was reported net of
   * tax, so returning the gross figure would claw back more than was ever credited: a full
   * refund of an 18% GST invoice would remove 118% of the commission. Scaling by the same
   * net/total ratio the sale used keeps the two calls talking about one quantity. With no
   * invoice behind the payment there is nothing to scale against, so the gross stands.
   */
  let amountMinor = row.amountMinor;
  let saleEventId: string | null = null;
  if (row.invoiceId) {
    const invPublicId = await withTenant(orgId, async (tx) => {
      const [i] = await tx
        .select({ publicId: invoices.publicId })
        .from(invoices)
        .where(eq(invoices.id, row.invoiceId!))
        .limit(1);
      return i?.publicId ?? null;
    });
    if (invPublicId) {
      const money = await invoiceCommissionable(orgId, businessId, invPublicId);
      if (money && money.totalMinor > 0n) {
        amountMinor = (row.amountMinor * money.netMinor) / money.totalMinor;
      }
      saleEventId = await saleEventIdForInvoice(orgId, invPublicId);
    }
  }
  if (amountMinor <= 0n) return null;

  return request(ctx.baseUrl, "/track/refund", authOf(ctx), {
    email: customer.email ?? undefined,
    uid: customer.publicId,
    event_id: ctx.event.publicId,
    amount: Number(amountMinor),
    currency: row.currency,
    ...(saleEventId ? { sale_event_id: saleEventId } : {}),
    created_at: ctx.event.createdAt.toISOString(),
  });
}

async function buildCancellation(ctx: PushContext): Promise<PushRequest | null> {
  const subPublicId = resourceId(ctx.event.data, "subscription");
  if (!subPublicId || !ctx.event.businessId) return null;
  const orgId = ctx.event.organizationId;
  const businessId = ctx.event.businessId;

  const sub = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select({ customerId: subscriptions.customerId })
      .from(subscriptions)
      .where(and(eq(subscriptions.businessId, businessId), eq(subscriptions.publicId, subPublicId)))
      .limit(1);
    return row ?? null;
  });
  if (!sub) return null;

  const customer = await loadCustomer(orgId, sub.customerId);
  if (!customer) return null;

  return request(ctx.baseUrl, "/track/cancellation", authOf(ctx), {
    email: customer.email ?? undefined,
    uid: customer.publicId,
    event_id: ctx.event.publicId,
    created_at: ctx.event.createdAt.toISOString(),
  });
}

export const firstPromoter: PushIntegration = {
  ...firstPromoterInfo,
  async build(ctx) {
    switch (ctx.event.type) {
      case "customer_created":
        return buildSignup(ctx);
      case "invoice_paid":
        return buildSale(ctx);
      case "refund_created":
      case "refund_settled":
        return buildRefund(ctx);
      case "subscription_canceled":
        return buildCancellation(ctx);
      default:
        return null;
    }
  },
  /**
   * Their 4xx vocabulary, which is not the generic one.
   *
   * The two that matter are the ones our default rule gets WRONG. A 409 is a duplicate
   * `event_id` — the commission is already recorded, so this is the retry doing its job, and
   * counting it as a failure would fail a delivery that succeeded. A 400/404/422 is a request
   * they will refuse identically every time; retrying it five more times only delays the moment
   * the operator sees it in the failed list.
   *
   * 204 (sale/refund with no matching lead — a customer nobody referred) is a 2xx and needs no
   * special case, but it is the single most common response here and is worth knowing about
   * when reading a delivery log full of them.
   */
  judge(status: number, request?: PushRequest): PushVerdict | null {
    // A duplicate `event_id` — the commission is already recorded, so this is the retry doing
    // its job. The default rule would file a delivered event as failed after five more tries.
    if (status === 409) return "delivered";
    if (status === 429) return "retry";
    /**
     * 404 means TWO different things, which is why this reads the path.
     *
     * On a sale, refund or cancellation it is, verbatim from the v2 spec, "Referral
     * corresponding to email or uid parameter not found or promoter is banned" — i.e. **this
     * customer was never referred**. That is the normal case for most customers, and v1
     * answered 204 for the same fact, which our 2xx rule already counted as delivered. Filing
     * it as a failure turns a healthy integration into a page of red and trains an operator to
     * stop reading the log — the exact outcome this column exists to prevent.
     *
     * On a SIGNUP it means the visitor id is invalid, which is a real problem worth seeing:
     * we only send a signup when the customer carries a referral id, so a rejected one says
     * the merchant's `_fprom_tid` pipeline is feeding us ids FirstPromoter does not recognise.
     *
     * ⚠️ A wrong base URL would also 404 everywhere and now reads as "nobody was referred".
     * The tell is that NOTHING is ever delivered — a live integration always has some 200s —
     * and `last_response_status` still shows the 404 on every row.
     */
    if (status === 404) return request?.url.endsWith("/track/signup") ? "terminal" : "delivered";
    if (status >= 400 && status < 500) return "terminal";
    return null;
  },
};
