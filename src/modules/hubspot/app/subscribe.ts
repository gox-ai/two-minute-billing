import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businessWallClock } from "@/platform/clock";
import { currencyExponent } from "@/platform/currency";
import { createLogger } from "@/platform/logger";
import { businesses, customers, subscriptions } from "@db/schema";
import { isOverridable, type PriceSnapshot } from "@/modules/catalog/pricing";
import { getPriceByPublicId } from "@/modules/catalog/service";
import { createCustomer } from "@/modules/customers/service";
import {
  createSubscription,
  deferFirstPeriodToUnbilledCharges,
  deleteProvisionalSubscription,
  getSubscriptionItems,
  SubscriptionError,
} from "@/modules/subscriptions/service";
import {
  billSubscriptionPeriod,
  ChargeAmountMismatchError,
  commitSubscriptionPeriodInvoice,
  isAutoCollectOn,
  planSubscriptionPeriodInvoice,
} from "@/modules/invoicing/service";
import {
  chargeBeforeSubscriptionInvoice,
  refundPreInvoiceCharge,
} from "@/modules/invoicing/collection";
import { flushDeferredEvents, type DeferredEvents } from "@/modules/events/emit";
import {
  assertChargeableForAutoCollect,
  NoChargeablePaymentMethodError,
} from "@/modules/payment-methods/service";
import {
  applyCouponToSubscription,
  applyManualDiscount,
  CouponError,
} from "@/modules/coupons/service";
import { resolveUnbilledChargesConfig } from "@/modules/subscriptions/unbilled-charges-config";
import {
  changeSubscription,
  ProrationConflictError,
  ProrationError,
} from "@/modules/subscriptions/proration";
import { fireActivationCharges } from "@/modules/subscriptions/items";
import {
  directionOfItemEdit,
  prorateFor,
  resolveChangePolicy,
  resetTermForPolicy,
} from "@/modules/subscriptions/change-policy";
import { HubSpotClient, type Connection } from "../client";
import { upsertLink } from "../sync/links";
import { parseSettings, type HubSpotSettings } from "../settings";
import { HubSpotAppError } from "./resolve";

const log = createLogger("hubspot.app");

/** A deal discount as HubSpot carries it: a percentage, or an amount in major units. */
export interface DealDiscount {
  percent?: number | null;
  amount?: number | null;
  couponCode?: string | null;
}

type Sub = typeof subscriptions.$inferSelect;
type Price = NonNullable<Awaited<ReturnType<typeof getPriceByPublicId>>>;

function hasDiscount(d: DealDiscount | undefined): d is DealDiscount {
  return !!d && ((d.percent ?? 0) > 0 || (d.amount ?? 0) > 0 || !!d.couponCode?.trim());
}

function toMinor(amountMajor: number, currency: string): number {
  return Math.round(amountMajor * 10 ** currencyExponent(currency));
}

/**
 * `price_override`: the deal discount is baked into the item's unit price. An amount is off
 * the whole period, so it is spread across the quantity. Only flat/per-unit prices can carry
 * a custom unit price; anything else is refused rather than silently billed at list.
 */
function overriddenUnitMinor(
  price: Price,
  quantity: number,
  d: DealDiscount,
  listUnitMinor?: number,
): number {
  if (!isOverridable(price.model))
    throw new HubSpotAppError(
      `We cannot apply the deal discount as a price override, because price ${price.publicId} is ${price.model}-priced. Use a flat or per-unit price, or change the discount mode to coupon.`,
      422,
      "discount_not_applicable",
    );
  if (d.couponCode?.trim() && !(d.percent || d.amount))
    throw new HubSpotAppError(
      "A coupon code needs the discount mode set to coupon.",
      422,
      "discount_not_applicable",
    );
  const unit = listUnitMinor ?? Number(price.amountMinor ?? 0);
  const off =
    (d.percent ?? 0) > 0
      ? Math.round((unit * Math.min(d.percent!, 100)) / 100)
      : Math.round(toMinor(d.amount ?? 0, price.currency) / Math.max(quantity, 1));
  return Math.max(unit - off, 0);
}

function manualDiscountFor(d: DealDiscount, currency: string) {
  if ((d.percent ?? 0) > 0)
    return {
      kind: "percentage" as const,
      percentOffBps: Math.round(Math.min(d.percent!, 100) * 100),
    };
  if ((d.amount ?? 0) > 0)
    return { kind: "fixed_amount" as const, amountOffMinor: toMinor(d.amount!, currency) };
  return null;
}

async function loadPrice(conn: Connection, pricePublicId: string): Promise<Price> {
  const price = await getPriceByPublicId(
    conn.organizationId,
    conn.businessId,
    pricePublicId.trim(),
  );
  if (!price) throw new HubSpotAppError(`No such price: ${pricePublicId}`, 404, "price_not_found");
  if (!price.active)
    throw new HubSpotAppError(`Price ${price.publicId} is archived`, 422, "price_archived");
  if (price.type !== "recurring")
    throw new HubSpotAppError(
      `Price ${price.publicId} is not a recurring plan price`,
      422,
      "price_not_recurring",
    );
  return price;
}

function mapError(e: unknown): never {
  if (e instanceof HubSpotAppError) throw e;
  if (e instanceof SubscriptionError || e instanceof CouponError || e instanceof ProrationError)
    throw new HubSpotAppError(e.message, 422, "billing_rejected");
  if (e instanceof ProrationConflictError) throw new HubSpotAppError(e.message, 409, "conflict");
  if (e instanceof NoChargeablePaymentMethodError)
    throw new HubSpotAppError(e.message, 422, "no_chargeable_payment_method");
  throw e;
}

/**
 * Create a subscription through the same steps as the operator create route: card check,
 * charge-first when auto-collection bills now, signup discounts before the first invoice.
 * A decline leaves nothing behind.
 */
export async function createSubscriptionFromHubSpot(input: {
  conn: Connection;
  customerId: string;
  pricePublicId: string;
  quantity: number;
  discount?: DealDiscount;
  metadata?: Record<string, unknown>;
}): Promise<{ subscription: Sub; invoiceId: string | null }> {
  const { conn } = input;
  const settings = parseSettings(conn.settings);
  const org = conn.organizationId;
  const bizId = conn.businessId;
  const price = await loadPrice(conn, input.pricePublicId);
  const quantity = Math.max(1, Math.floor(input.quantity || 1));
  const mode = settings.deals.discountMode;
  const discount = hasDiscount(input.discount) && mode !== "ignore" ? input.discount : undefined;

  const { business, customer } = await withTenant(org, async (tx) => {
    const [business] = await tx.select().from(businesses).where(eq(businesses.id, bizId)).limit(1);
    const [customer] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, input.customerId), eq(customers.businessId, bizId)))
      .limit(1);
    return { business, customer };
  });
  if (!business || !customer)
    throw new HubSpotAppError("Customer not found", 404, "customer_not_found");

  const customAmountMinor =
    discount && mode === "price_override"
      ? overriddenUnitMinor(price, quantity, discount)
      : undefined;

  const deferred: DeferredEvents = [];
  let emitted = false;
  try {
    const now = await businessWallClock(bizId);
    const hasTrial = (price.trialPeriod ?? 0) > 0;
    const invoiceNow = resolveUnbilledChargesConfig(business).onCreate === "invoice_immediately";
    const chargesNow = isAutoCollectOn(null, customer.autoCollection) && !hasTrial && invoiceNow;
    if (chargesNow)
      await assertChargeableForAutoCollect({ organizationId: org, businessId: bizId, customer });

    const { subscription } = await createSubscription({
      organizationId: org,
      businessId: bizId,
      customerId: customer.id,
      now,
      items: [{ price, quantity, customAmountMinor }],
      metadata: input.metadata,
      // The integration writes its own keys and cannot meet required or strict rules.
      metadataRules: "supplied_only",
      deferEventsTo: chargesNow ? deferred : undefined,
    });
    const discard = async () => {
      await deleteProvisionalSubscription({
        organizationId: org,
        businessId: bizId,
        subscriptionId: subscription.id,
      });
      deferred.length = 0;
    };

    if (discount && mode === "coupon") {
      try {
        if (discount.couponCode?.trim()) {
          await applyCouponToSubscription({
            organizationId: org,
            businessId: bizId,
            subscriptionId: subscription.id,
            code: discount.couponCode.trim(),
            now,
            atSignup: true,
            deferEventsTo: chargesNow ? deferred : undefined,
          });
        } else {
          const md = manualDiscountFor(discount, subscription.currency)!;
          await applyManualDiscount({
            organizationId: org,
            businessId: bizId,
            subscriptionId: subscription.id,
            ...md,
            currency: subscription.currency,
            durationType: "forever",
            note: "Deal discount from HubSpot",
            now,
          });
        }
      } catch (e) {
        if (chargesNow) await discard();
        throw e;
      }
    }

    let invoiceId: string | null = null;
    if (
      subscription.status === "active" &&
      subscription.currentPeriodStart &&
      subscription.currentPeriodEnd
    ) {
      const billInput = {
        organizationId: org,
        businessId: bizId,
        subscription,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
      };
      if (!invoiceNow) {
        await deferFirstPeriodToUnbilledCharges({
          organizationId: org,
          businessId: bizId,
          subscription,
          now,
        });
      } else if (chargesNow) {
        const plan = await planSubscriptionPeriodInvoice(billInput);
        const due = plan.mode === "finalize" ? plan.money.amountDue : 0n;
        let charge;
        if (due > 0n) {
          const outcome = await chargeBeforeSubscriptionInvoice({
            organizationId: org,
            businessId: bizId,
            customerId: customer.id,
            subscription,
            amountMinor: due,
            currency: subscription.currency,
          });
          if (outcome.kind === "action_required" || outcome.kind === "declined") {
            await discard();
            throw new HubSpotAppError(
              outcome.kind === "declined"
                ? `We could not create the subscription. The first payment failed: ${outcome.failureMessage}`
                : "We could not create the subscription. The customer must authenticate the card payment.",
              402,
              outcome.kind === "declined" ? outcome.failureCode : "requires_action",
            );
          }
          // `deferred` (a notice rail): the commit collects through the notice gate.
          if (outcome.kind === "charged") charge = outcome.charge;
        }
        try {
          const committed = await commitSubscriptionPeriodInvoice(plan, {
            preEvents: deferred,
            charge,
          });
          emitted = true;
          invoiceId = committed.invoice.publicId;
        } catch (e) {
          if (e instanceof ChargeAmountMismatchError && charge) {
            const refund = await refundPreInvoiceCharge({
              organizationId: org,
              businessId: bizId,
              charge,
              currency: subscription.currency,
              reason: "invoice_amount_mismatch",
            });
            await discard();
            if (!refund.refunded)
              log.error("refund FAILED for a pre-invoice charge — manual intervention required", {
                event: "preinvoice_refund_failed",
                providerChargeId: charge.result.providerChargeId,
                error: refund.error ?? "unknown",
              });
            throw new HubSpotAppError(
              "We could not create the subscription. The amount due changed during the first payment. Retry.",
              409,
              "charge_amount_mismatch",
            );
          }
          throw e;
        }
      } else {
        invoiceId = (await billSubscriptionPeriod(billInput)).invoice?.publicId ?? null;
      }
      await fireActivationCharges({
        organizationId: org,
        businessId: bizId,
        subscriptionId: subscription.id,
        now,
      });
    }
    if (!emitted && deferred.length > 0) {
      emitted = true;
      await flushDeferredEvents(org, deferred);
    }
    return { subscription, invoiceId };
  } catch (e) {
    if (!emitted && deferred.length > 0) {
      emitted = true;
      await flushDeferredEvents(org, deferred).catch((err) =>
        log.error(err, { event: "deferred_subscription_events_flush_failed" }),
      );
    }
    mapError(e);
  }
}

/**
 * Change the plan and/or quantity of an existing subscription via `changeSubscription`, so
 * proration and invoicing follow the business's own rules.
 */
export async function editSubscriptionFromHubSpot(input: {
  conn: Connection;
  subscriptionId: string;
  pricePublicId?: string | null;
  quantity?: number | null;
  discount?: DealDiscount;
}): Promise<{
  subscription: Sub;
  invoiceId: string | null;
  creditNoteId: string | null;
  changed: boolean;
}> {
  const { conn } = input;
  const settings = parseSettings(conn.settings);
  const org = conn.organizationId;
  const mode = settings.deals.discountMode;
  const discount = hasDiscount(input.discount) && mode !== "ignore" ? input.discount : undefined;

  const sub = await withTenant(org, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.id, input.subscriptionId),
          eq(subscriptions.businessId, conn.businessId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!sub) throw new HubSpotAppError("Subscription not found", 404, "subscription_not_found");
  if (sub.status === "cancelled")
    throw new HubSpotAppError(
      `Subscription ${sub.publicId} is cancelled`,
      422,
      "subscription_cancelled",
    );

  try {
    const items = await getSubscriptionItems(org, sub.id);
    const withPrice = await Promise.all(
      items.map(async (i) => ({ item: i, snap: i.priceSnapshot as PriceSnapshot | null })),
    );
    // The plan line: the first recurring item.
    const planItem = withPrice.find((i) => i.snap?.type === "recurring") ?? withPrice[0];
    if (!planItem)
      throw new HubSpotAppError(`Subscription ${sub.publicId} has no items`, 422, "no_items");

    const newPrice = input.pricePublicId?.trim()
      ? await loadPrice(conn, input.pricePublicId)
      : null;
    const quantity =
      input.quantity && input.quantity > 0 ? Math.floor(input.quantity) : planItem.item.quantity;
    const priceChanged = !!newPrice && newPrice.id !== planItem.item.priceId;

    let customAmountMinor: number | undefined;
    if (discount && mode === "price_override") {
      const target =
        newPrice ??
        (await getPriceByPublicId(org, conn.businessId, planItem.snap?.publicId ?? "")) ??
        null;
      if (!target)
        throw new HubSpotAppError(
          "The subscription's plan price no longer exists",
          422,
          "price_not_found",
        );
      customAmountMinor = overriddenUnitMinor(target, quantity, discount);
    }
    const md =
      discount && mode === "coupon" && !discount.couponCode?.trim()
        ? manualDiscountFor(discount, sub.currency)
        : null;
    const couponCode =
      discount && mode === "coupon" ? discount.couponCode?.trim() || undefined : undefined;

    const moves =
      priceChanged ||
      quantity !== planItem.item.quantity ||
      (customAmountMinor != null && customAmountMinor !== (planItem.snap?.amountMinor ?? null));
    if (!moves && !md && !couponCode)
      return { subscription: sub, invoiceId: null, creditNoteId: null, changed: false };

    const changes = moves
      ? [
          {
            itemId: planItem.item.publicId,
            ...(priceChanged ? { newPriceId: newPrice!.publicId } : {}),
            ...(quantity !== planItem.item.quantity ? { newQuantity: quantity } : {}),
            ...(customAmountMinor != null ? { customAmountMinor } : {}),
          },
        ]
      : [];
    // The business's plan-change rules, as for an API change that applies now.
    const { direction, policy } = await withTenant(org, async (tx) => {
      const [biz] = await tx
        .select()
        .from(businesses)
        .where(eq(businesses.id, conn.businessId))
        .limit(1);
      const dir = await directionOfItemEdit(tx, sub, { changes });
      return {
        direction: dir,
        policy: await resolveChangePolicy({
          business: biz ?? {},
          subscription: sub,
          direction: dir,
          source: "api",
          tx,
        }),
      };
    });
    if (policy.blocked) throw new HubSpotAppError(policy.blocked.message, 409, policy.blocked.code);
    // HubSpot cannot schedule a change; the dashboard can.
    if (!policy.timings.includes("now"))
      throw new HubSpotAppError(
        `This business applies ${
          direction === "downgrade" ? "a downgrade" : "an upgrade"
        } at the end of the term. Make this change in the billing dashboard.`,
        422,
        "change_timing",
      );
    const res = await changeSubscription({
      organizationId: org,
      businessId: conn.businessId,
      subscriptionId: sub.id,
      now: await businessWallClock(conn.businessId),
      changes,
      prorate: prorateFor(policy, direction),
      resetTerm: resetTermForPolicy(policy, direction, Boolean(planItem && priceChanged)),
      couponCode,
      manualDiscount: md ? { ...md, durationType: "forever" } : undefined,
    });
    const fresh = await withTenant(org, async (tx) => {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, sub.id))
        .limit(1);
      return row ?? sub;
    });
    return {
      subscription: fresh,
      invoiceId: res.prorationInvoice?.publicId ?? null,
      creditNoteId: res.creditNote?.publicId ?? null,
      changed: true,
    };
  } catch (e) {
    mapError(e);
  }
}

// ── Customers from HubSpot records ──────────────────────────────────────────

interface HsObject {
  id: string;
  properties?: Record<string, string | null>;
}

/** A deal's associated contact and company ids (first of each), via the v4 associations API. */
export async function dealAssociations(client: HubSpotClient, dealId: string) {
  const one = async (to: "contacts" | "companies") => {
    const res = await client.request<{ results?: Array<{ toObjectId: string | number }> }>(
      "GET",
      `/crm/v4/objects/deals/${encodeURIComponent(dealId)}/associations/${to}?limit=10`,
    );
    const first = res?.results?.[0]?.toObjectId;
    return first != null ? String(first) : null;
  };
  return { contactId: await one("contacts"), companyId: await one("companies") };
}

async function linkedCustomerId(
  conn: Connection,
  remoteType: "contact" | "company",
  remoteId: string,
) {
  const { linkedRecord } = await import("./card");
  const { customerIds } = await linkedRecord(conn, remoteType, remoteId);
  if (customerIds.length > 1)
    throw new HubSpotAppError(
      `Several customers are linked to this HubSpot ${remoteType}. Create the subscription from the customer's contact instead.`,
      409,
      "several_customers",
    );
  return customerIds[0] ?? null;
}

/**
 * The customer a HubSpot record bills to. A linked contact/company wins. Otherwise a customer
 * is created from the contact's email and name and linked to it, so the next sync updates
 * rather than duplicates. A company alone has no email to create from, so it is refused.
 */
export async function customerForRecord(
  conn: Connection,
  record: { remoteType: "contact" | "company" | "deal"; remoteId: string },
): Promise<{ customerId: string; created: boolean }> {
  let contactId: string | null = null;
  let companyId: string | null = null;
  const client = new HubSpotClient(conn);
  if (record.remoteType === "contact") contactId = record.remoteId;
  else if (record.remoteType === "company") companyId = record.remoteId;
  else ({ contactId, companyId } = await dealAssociations(client, record.remoteId));

  if (contactId) {
    const id = await linkedCustomerId(conn, "contact", contactId);
    if (id) return { customerId: id, created: false };
  }
  if (companyId) {
    const id = await linkedCustomerId(conn, "company", companyId);
    if (id) return { customerId: id, created: false };
  }
  if (!contactId)
    throw new HubSpotAppError(
      record.remoteType === "company"
        ? "No customer is linked to this company. Create the subscription from one of its contacts."
        : "This deal has no associated contact to bill. Associate a contact with the deal first.",
      422,
      "no_billable_contact",
    );

  const contact = await client.request<HsObject>(
    "GET",
    `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=email,firstname,lastname,company`,
  );
  const p = contact?.properties ?? {};
  const email = p.email?.trim().toLowerCase();
  if (!email)
    throw new HubSpotAppError(
      "The HubSpot contact has no email address to bill",
      422,
      "contact_without_email",
    );
  const customer = await createCustomer({
    organizationId: conn.organizationId,
    businessId: conn.businessId,
    email,
    firstName: p.firstname || undefined,
    lastName: p.lastname || undefined,
    company: p.company || undefined,
    metadata: { hubspot_contact_id: contactId },
    // The integration writes its own key and cannot meet required or strict rules.
    metadataRules: "supplied_only",
  });
  await upsertLink(conn, {
    localType: "customer",
    localId: customer.id,
    remoteType: "contact",
    remoteId: contactId,
    hash: null,
  });
  return { customerId: customer.id, created: true };
}

/** Remember which deal a subscription came from, so the deal sync updates that deal. */
export async function linkDeal(conn: Connection, subscriptionId: string, dealId: string) {
  await upsertLink(conn, {
    localType: "subscription",
    localId: subscriptionId,
    remoteType: "deal",
    remoteId: dealId,
    hash: null,
  });
}

export function isEditDealType(
  settings: HubSpotSettings,
  dealType: string | null | undefined,
): boolean {
  const t = (dealType ?? "").trim().toLowerCase();
  return !!t && settings.deals.editDealTypes.some((v) => v.trim().toLowerCase() === t);
}
