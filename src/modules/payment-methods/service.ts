import { stampNow } from "@/platform/clock";
import { credentialsChanged } from "./credentials";
import { decidePaymentSourceExpiry } from "./sweep";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { writeAuditLog } from "@/modules/audit/service";
import { publicId } from "@/platform/ids";
import { getProvider, resolveAdapter } from "@/providers/registry";
import {
  achAuthorizationIsOurs,
  gatewayAllowsPurpose,
  gatewayDefinition,
  methodLabel,
} from "@/providers/gateway-catalog";
import { liveProofPending, methodOffered, type PendingMethods } from "@/providers/conformance";
import { insertAchAuthorization, type AchAuthorizationEvidence } from "./ach-authorization";
import {
  resolveDefaultAccountForBusiness,
  listGatewayAccounts,
  getGatewayAccount,
} from "@/modules/gateway/service";
import { selectGatewayAccount, handlesCurrency } from "@/modules/gateway/router";
import { settlesAsynchronously, getWebhookEndpointInfo } from "@/modules/gateway/webhook-endpoint";
import { config } from "@/platform/config";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import {
  paymentMethods,
  payments,
  customers,
  gatewayAccounts,
  providerCustomers,
  businesses,
  subscriptions,
  subscriptionItems,
  prices,
} from "@db/schema";
import { setupChargeDescription } from "@/modules/invoicing/charge-description";
import { accountHolderName, invoiceContactName } from "@/modules/customers/names";
import type {
  PaymentProvider,
  ProviderCustomerRef,
  ProviderPaymentMethodRef,
  EnsureCustomerInput,
  ProviderContact,
  IntentPurpose,
} from "@/providers/types";
import { allowsIntentPurpose } from "@/providers/types";
import { createLogger } from "@/platform/logger";
// `getPaymentRoleIds` moved to `./serialize` (events/content.ts, via
// `customers/serialize.ts`, needs it and must never import this file — it
// imports `emitEvent`). Re-exported here for back-compat.
import { getPaymentRoleIds } from "./serialize";
// The RBI/AFA rule lives in a LEAF module (no imports) because
// `transactions/serialize.ts` needs it and must not reach anything that imports
// `events/emit` — see the header of mandate-afa.ts. Re-exported so this file stays
// the one obvious place to look for mandate rules.
import { INR_AFA_FREE_CEILING_MINOR, SMALLEST_RAIL_CEILING_CAP_MINOR } from "./mandate-afa";
export {
  INR_AFA_FREE_CEILING_MINOR,
  requiresAfaPerDebit,
  RAILS_NEEDING_PER_DEBIT_AFA,
  debitNeedsBuyerAuthentication,
  AWAITING_AUTHENTICATION_CODE,
  AUTHENTICATION_NOT_REQUIRED_CODE,
  debitAwaitsBuyerAuthentication,
  MANDATE_RAIL_MAX_CEILING_MINOR,
  MANDATE_RAIL_CEILING_CURRENCY,
  SMALLEST_RAIL_CEILING_CAP_MINOR,
  railsOverCeilingCap,
  MANDATE_LIVE_STATUSES,
  MANDATE_PENDING_STATUSES,
  DEAD_MANDATE_STATUSES,
  MANDATE_SPENT_STATUSES,
  MANDATE_MISSING_STATUS,
  MANDATE_NORMALISED_STATUSES,
  mandateChargeability,
  mandateHasExpired,
  mandateBecameLive,
  type MandateChargeability,
} from "./mandate-afa";
import { gatewayReturnUrl } from "@/providers/buyer-return";
import { providerPaymentMethodRef } from "./provider-ref";
export { getPaymentRoleIds };

const log = createLogger("payment-methods");

/** The payer's contact, for adapters that take it on the mandate (`InitiateVaultSetupInput.contact`). */
export function providerContact(customer: typeof customers.$inferSelect): ProviderContact {
  const d = providerCustomerDetails(customer);
  return {
    ...(d.email ? { email: d.email } : {}),
    ...(d.phone ? { phone: d.phone } : {}),
    ...(d.name ? { name: d.name } : {}),
    ...(d.address?.country ? { country: d.address.country } : {}),
  };
}

/** Provider-facing identity details for a customer (name+address matter for e.g. India exports). */
function providerCustomerDetails(customer: typeof customers.$inferSelect): EnsureCustomerInput {
  const holder = accountHolderName(customer);
  return {
    customerRef: customer.publicId,
    email: customer.email ?? undefined,
    // The BILLING name — the name on the document this payment settles, which is what an
    // export-rule check (India: RBI/FEMA) and a chargeback reconciliation both compare
    // against. This used to send our own invented `customers.name` column and never look at
    // the `billing_*` columns, so a company paying through its accounts-payable contact was
    // vaulted under whichever individual happened to sign up. `invoiceContactName` is the
    // same chain the invoice PDF prints, so the vault and the document can never disagree.
    name: invoiceContactName(customer) ?? undefined,
    company: customer.billingCompany ?? customer.company ?? undefined,
    // Contact/phone — RazorPay REQUIRES this on the provider customer for
    // recurring (e-mandate) setup, else the auth-order fails with "The contact
    // field is required for recurring links". Prefer the primary phone, fall
    // back to the billing-address phone.
    phone: customer.phone ?? customer.billingPhone ?? undefined,
    address: {
      line1: customer.addressLine1 ?? undefined,
      line2: customer.addressLine2 ?? undefined,
      city: customer.city ?? undefined,
      state: customer.state ?? undefined,
      postalCode: customer.postalCode ?? undefined,
      country: customer.country ?? undefined,
    },
    // The ACCOUNT HOLDER, carried alongside — not instead of — the billing name above.
    // `name` is now the billing contact, so a company paying through its accounts-payable
    // contact appears at the gateway as "Accounts Payable", which is right for the
    // document and the export check but leaves support unable to find them by the name
    // they signed up with. This keeps that name searchable at the provider without
    // letting it near the compliance field. Always present when we have one (rather than
    // only when the two differ), so the key is somewhere predictable to look.
    ...(holder ? { metadata: { tmbilling_account_holder: holder } } : {}),
  };
}

/**
 * Resolve the provider-side customer for (customer × provider × gateway
 * account), creating it ONCE and reusing it afterwards (provider_customers
 * mapping). On reuse, adapters that support `updateCustomer` get the current
 * name/email/phone/address pushed — so a newly saved billing address reaches Stripe
 * before the next SetupIntent (India-exports requirement), and a newly added phone
 * reaches RazorPay before the next mandate registration (which reads `contact` off
 * RazorPay's own customer record and refuses without it).
 *
 * That push is BEST-EFFORT: it cannot fail a vault or a charge. See the catch below.
 */
export async function ensureProviderCustomer(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  provider: PaymentProvider;
  gatewayAccountId: string | null;
}): Promise<ProviderCustomerRef> {
  const details = providerCustomerDetails(input.customer);
  const scope = and(
    eq(providerCustomers.customerId, input.customer.id),
    eq(providerCustomers.providerKey, input.provider.key),
    input.gatewayAccountId
      ? eq(providerCustomers.gatewayAccountId, input.gatewayAccountId)
      : isNull(providerCustomers.gatewayAccountId),
  );
  const [existing] = await withTenant(input.organizationId, (tx) =>
    tx.select().from(providerCustomers).where(scope).limit(1),
  );
  if (existing) {
    const ref: ProviderCustomerRef = {
      providerKey: input.provider.key,
      providerCustomerId: existing.providerCustomerId,
    };
    // ⚠️ The identity sync is BEST-EFFORT and may never fail the caller.
    //
    // This function sits on the hot path of every vault AND every charge — the
    // resolved provider customer is what both are addressed to. `updateCustomer` is a
    // second network call to the gateway purely to push name/email/phone, and
    // `providerFetch` THROWS on a transport failure (timeout, DNS, TLS, reset). So
    // without this catch, a gateway that is merely slow on an endpoint nobody is
    // waiting for would turn a renewal into a failed payment and a dunning attempt —
    // a strictly worse bug than a stale name at the provider.
    //
    // It is caught HERE, not in each adapter, so the guarantee holds for every adapter
    // including ones that raise rather than return (Stripe's `customers.update`
    // rejects on any API error). Adapters may still handle their own REFUSALS more
    // intelligently — RazorPay retries with the contact alone when a contested email
    // sinks the whole PUT — but they are not what makes this safe.
    //
    // The one caller that genuinely cannot proceed without the synced field is
    // RazorPay's `createEmandateAuthLink`, and it refuses on its own fresh read of the
    // provider customer. That is the right place for that error: it knows the field is
    // load-bearing, and this function does not.
    try {
      await input.provider.updateCustomer?.(ref, details);
    } catch (e) {
      log.warn("provider customer identity sync failed — continuing with the existing mapping", {
        provider: input.provider.key,
        provider_customer_id: existing.providerCustomerId,
        customer: input.customer.publicId,
        error: String(e),
      });
    }
    return ref;
  }
  const ref = await input.provider.ensureCustomer(details);
  await withTenant(input.organizationId, (tx) =>
    tx
      .insert(providerCustomers)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        providerKey: input.provider.key,
        gatewayAccountId: input.gatewayAccountId,
        providerCustomerId: ref.providerCustomerId,
      })
      .onConflictDoNothing(),
  );
  return ref;
}

/**
 * Headroom over the amount a mandate is sized for, in basis points: **250%**, i.e. the
 * sized amount × 3.5.
 *
 * ── ONE NAMED DECISION, not a magic number ────────────────────────────────────
 * This constant plus {@link SMALLEST_RAIL_CEILING_CAP_MINOR} is the WHOLE mandate-sizing
 * policy: everything else (`deriveMandateCeiling`, `resolveSessionMandateRequirement`,
 * `mandate_shortfall.reauthorized_ceiling_minor`, the parity fixture) reaches it through
 * {@link withMandateHeadroom}, so the multiple is changed here and nowhere else. It is
 * configuration in the sense that matters for money code — a single named, tested,
 * documented value — and deliberately NOT read from the environment: no file under
 * `src/modules/` touches `process.env`, and a ceiling that differs between two processes
 * is a ceiling nobody can reason about from a payment_methods row. Making it a
 * per-BUSINESS setting needs a `businesses` column, which is a migration and a settings
 * screen, not a constant.
 *
 * ── WHY 1.3×, AND WHAT IT DELIBERATELY GIVES UP (decided by Vinay, 2026-09-03) ─
 * The buyer sees this number. RazorPay states it in the mandate modal at registration
 * ("up to ₹X") and the portal prints it on the saved instrument, so at 3.5× a customer on
 * the ₹10,759 LITE plan was asked to authorise **₹37,657**. That reads as a merchant
 * reserving the right to take three and a half times the bill, and a customer who reads it
 * that way does not file a support ticket — they call you a scam and leave. Trust at the
 * one moment the buyer is asked to hand over a mandate was judged worth more than the
 * upgrade convenience below.
 *
 * ⚠️ WHAT IT COSTS, stated plainly because the tests below enforce it: at 1.3× a mandate
 * registered on one plan CANNOT carry a single-step upgrade on the INR ladder. The
 * customer must re-authorise before the upgrade's invoice can collect. That is now the
 * intended behaviour, not a defect — and it is survivable only because
 * `mandate_shortfall` names the shortfall on the change screen BEFORE the operator
 * commits, which is exactly what did not exist during the refusals recorded below. If that
 * warning is ever removed, this multiple must go back up.
 *
 * ── The ladder this no longer covers, kept so nobody re-derives it ────────────
 * ── HISTORY: why it WAS 3.5× ───────────────────
 * It was ×3 until 2026-08-27, then **25%** until 2026-09-01. 25% is what made every
 * upgrade of more than a quarter uncollectable, and the ladder says a quarter is nothing
 * like enough. The INR monthly ladder (`platform-*-v202607-INR-Monthly`, the prices
 * the probes and parity fixtures use) is:
 *
 *     lite ₹9,118 → pro ₹27,918 → business ₹56,118
 *     one-step ratios: 3.0645× (lite→pro) and 2.0101× (pro→business)
 *
 * So a mandate sized at 1.25× the current bill cannot carry ANY single-step upgrade on
 * this ladder, and 2× and 3× both miss one of the two. 3.5× is the smallest round
 * multiple that covers both, with the measured failure as its lower bound: the audited
 * subscription was sized 1.25 × ₹50,690.44 = **₹63,363.05** and then billed
 * **₹66,219.24** (₹56,118 + 18% GST), which is 1.3064× — three `mandate_ceiling_exceeded`
 * refusals (INV-5381, INV-5440, INV-5443) and a permanently unpayable subscription.
 *
 * ── WHAT IT COSTS, and why that is the right trade now ────────────────────────
 * The buyer sees this number: RazorPay states it in the mandate modal at registration
 * ("up to ₹X") and the portal prints it on the saved instrument. That is exactly why ×3
 * was cut — on a ₹2,595 plan it read as us reserving the right to take ₹7,785 for a
 * ₹3,062 debit. That cost is real and is being accepted, because the alternative is
 * measured: a subscription that cannot be collected at all, dunning that parks forever,
 * and a customer served for free. A ceiling the buyer finds generous is a worse outcome
 * than an invoice nobody can pay by an order of magnitude.
 *
 * Note the ×3 comparison is not apples to apples: it sat on a PRE-TAX price, so 18% GST
 * ate 1.18 of it and its effective coverage was 2.54×. `deriveMandateCeiling` now sizes
 * from the **tax-inclusive** estimated total, so 3.5× here is a true 3.5× of the bill.
 *
 * ── AFA: raising the ceiling opts NOTHING extra into buyer authentication ─────
 * Checked before choosing, because a bigger ceiling that quietly made more debits
 * interactive would be a worse defect than the one being fixed.
 * `debitNeedsBuyerAuthentication` → `requiresAfaPerDebit(currency, amountMinor)` compares
 * RBI's ₹15,000 threshold to the **debit**, never to the ceiling, and
 * `RAILS_NEEDING_PER_DEBIT_AFA` is a property of the rail. A ₹20,000 debit needs AFA on a
 * card under a ₹25,000 mandate and under a ₹70,000 one alike; a ₹12,000 debit needs it
 * under neither. `largestRecurringDebit`'s own docstring already says testing the CEILING
 * against that threshold would be a category error — this is the same statement from the
 * other side. The only thing the ceiling decides is whether we refuse the debit ourselves
 * before the rail ever gets to ask.
 *
 * ⚠️ What it still deliberately does NOT project: a limited-duration coupon expiring, or
 * customer credit that happens to be funding the next renewal. Both make a LATER debit
 * bigger than the one we sized for, and both are visible to the estimate path instead —
 * `mandate_shortfall` names the shortfall before the charge is attempted.
 */
export const MANDATE_HEADROOM_BPS = 13_000n;

/**
 * Per-business override of the two constants above (F-45 follow-up). Mirrors
 * `DunningConfig` / `resolveDunningConfig` (`subscriptions/dunning-schedule.ts`): a nested
 * settings object with a pure resolver, every absent or malformed key falling back to a
 * documented default, so a business that configures nothing behaves byte-identically to
 * before this existed.
 */
export interface MandateHeadroomConfig {
  /**
   * See {@link MANDATE_HEADROOM_BPS}. Basis points; 13_000n = 1.3×.
   *
   * A business whose plan ladder steps up steeply can raise it here rather than globally —
   * the default trades unattended upgrades for a ceiling the buyer finds believable, and
   * that trade is not right for every catalog.
   */
  headroomBps: bigint;
  /** See {@link SMALLEST_RAIL_CEILING_CAP_MINOR}. Minor units, same denomination caveat. */
  railCeilingCapMinor: bigint;
}

/** What `resolveMandateHeadroomConfig` returns when a business sets neither key. */
export const DEFAULT_MANDATE_HEADROOM_CONFIG: MandateHeadroomConfig = {
  headroomBps: MANDATE_HEADROOM_BPS,
  railCeilingCapMinor: SMALLEST_RAIL_CEILING_CAP_MINOR,
};

/**
 * Read a jsonb field as a positive bigint, falling back to `fallback` when the field is
 * absent or cannot be trusted as one.
 *
 * jsonb has no bigint of its own, so this reads through whatever `JSON.parse` produced
 * (`number` for anything under 2^53, `string` for a merchant who quoted it to dodge that
 * limit) — the same accommodation `credits_flexibility`'s limits need. Zero and negative
 * values are rejected rather than clamped: a ceiling of ₹0 is not a smaller ceiling, it is
 * a malformed setting, and silently accepting it would size every mandate at nothing.
 */
function parsePositiveBigint(raw: unknown, fallback: bigint): bigint {
  if (typeof raw !== "number" && typeof raw !== "string") return fallback;
  if (typeof raw === "number" && !Number.isFinite(raw)) return fallback;
  try {
    const n = BigInt(typeof raw === "number" ? Math.trunc(raw) : raw.trim());
    return n > 0n ? n : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Resolve a business's effective mandate-sizing config. `mandate_config.headroom_bps`
 * and `.rail_ceiling_cap_minor` each override independently — a business raising one axis
 * need not touch the other — and either key absent or malformed keeps the platform
 * default it replaces, so importing/existing businesses are unaffected until a merchant
 * sets one.
 */
export function resolveMandateHeadroomConfig(
  biz: { mandateConfig?: unknown } | null | undefined,
): MandateHeadroomConfig {
  const raw = (biz?.mandateConfig ?? null) as {
    headroom_bps?: unknown;
    rail_ceiling_cap_minor?: unknown;
  } | null;
  return {
    headroomBps: parsePositiveBigint(raw?.headroom_bps, MANDATE_HEADROOM_BPS),
    railCeilingCapMinor: parsePositiveBigint(
      raw?.rail_ceiling_cap_minor,
      SMALLEST_RAIL_CEILING_CAP_MINOR,
    ),
  };
}

/**
 * The sized amount plus the resolved headroom, rounded UP (never short of the debit),
 * and never above what the most constrained rail can actually register.
 *
 * ── The rail cap is the ceiling on the ceiling ────────────────────────────────
 * At 3.5× a ₹40,000 debit would ask for ₹1,40,000, and NPCI caps a UPI Autopay mandate at
 * ₹1,00,000 for our merchant category. Asking anyway does not get us ₹1,40,000: RazorPay
 * clamps the order (`createMandateOrder`) so the mandate carries ₹1,00,000 regardless, and
 * `railsOverCeilingCap` — which compares the REQUESTED ceiling to each cap — would report
 * UPI as over cap and the checkout would tell the buyer their bank cannot approve it. So
 * an unclamped request buys nothing and withdraws a working rail. Clamping keeps UPI on
 * offer for every debit UPI can carry, and leaves `railsOverCeilingCap` flagging it only
 * when the DEBIT itself is over the cap, which is the question that function was reaching
 * for. See {@link SMALLEST_RAIL_CEILING_CAP_MINOR} for the denomination caveat.
 *
 * ⚠️ The clamp NEVER lands below the amount being sized. An amount at or above the cap
 * takes the full multiple instead: there the rail question is already settled (no Indian
 * rail can carry it, and the caps are INR figures anyway), and clamping would hand back a
 * ceiling smaller than the debit — a mandate guaranteed to refuse its own first charge,
 * which is the failure this whole file exists to prevent.
 *
 * Worked, at 3.5× (INR):
 *   lite  ₹10,759 incl. GST → ₹37,657   covers the pro upgrade (₹32,943)
 *   pro   ₹32,943 incl. GST → ₹1,00,000 (clamped) covers the business upgrade (₹66,219)
 *   biz   ₹66,219 incl. GST → ₹1,00,000 (clamped) — the top of the ladder, 1.51× of it
 * The whole ladder becomes collectable, and no step asks for a ceiling UPI must refuse.
 */
export function withMandateHeadroom(
  amountMinor: bigint,
  cfg: MandateHeadroomConfig = DEFAULT_MANDATE_HEADROOM_CONFIG,
): bigint {
  if (amountMinor <= 0n) return 0n;
  const generous = (amountMinor * cfg.headroomBps + 9_999n) / 10_000n;
  if (amountMinor >= cfg.railCeilingCapMinor) return generous;
  return generous > cfg.railCeilingCapMinor ? cfg.railCeilingCapMinor : generous;
}
/**
 * Ceiling used ONLY when there is no recurring amount to infer from (adding a card
 * before any subscription exists). Applied as a fallback, never as a floor over a
 * real derivation: 100,000 minor units means ₹1,000 but also $1,000, so treating it
 * as a minimum would ask a $49 subscriber to authorise a $1,000 mandate.
 */
const MANDATE_FALLBACK_CEILING = 100_000n;

/**
 * The INR fallback, which cannot be the currency-blind one.
 *
 * `MANDATE_FALLBACK_CEILING` is 100,000 minor units — a defensible $1,000, but a
 * **₹1,000** that almost no Indian subscription fits under. And the fallback is not
 * an edge case here: the ordinary signup order is *vault the instrument, then create
 * the subscription*, so at mandate-registration time there is nothing to derive from
 * and every INR mandate would register at ₹1,000.
 *
 * Measured end to end 2026-08-13: a UPI Autopay mandate registered during signup, a
 * ₹2,595 subscription created against it, and the first invoice refused before the
 * gateway call with `mandate_ceiling_exceeded` — correct behaviour from the guard,
 * but the mandate should never have been that small.
 *
 * ₹15,000 is the deliberate choice rather than "something bigger": it is exactly
 * `INR_AFA_FREE_CEILING_MINOR`, the largest per-debit amount RBI lets an e-mandate collect
 * **without** additional-factor authentication.
 *
 * ── REVERTED 2026-09-04, and the failed argument is worth keeping ─────────────────────
 * This was briefly changed to the rail cap (₹1,00,000) on the grounds that ₹15,000 blocks
 * debits the rails demonstrably carry — citing ₹66,025 collected off-session against a real
 * HDFC netbanking e-mandate. **That case never reaches this constant.** That customer has a
 * live subscription, so `deriveMandateCeiling` sizes from the renewal estimate and returns
 * `withMandateHeadroom(66_025_00)` ≈ ₹85,832. The fallback fires ONLY when nothing at all
 * can be inferred — no renewal estimate and no catalog proxy — and at that moment we know
 * nothing about the payer, so a flat ₹1,00,000 asks a stranger to authorise ₹1 lakh for a
 * plan that may be ₹2,595. That is the same mistake the currency-blind ₹1,000 made, scaled
 * up: a fallback must be proportionate to a typical subscription, not to the rail's maximum.
 *
 * The lesson is about the ARGUMENT, not the number: the evidence for raising it came from a
 * path that uses a different code branch. Check which branch your evidence exercises before
 * letting it move a constant.
 *
 * Still a FALLBACK, never a floor: a real derivation from the customer's actual
 * subscriptions always wins — including when it is smaller, which is the common case.
 */
const MANDATE_FALLBACK_CEILING_INR = INR_AFA_FREE_CEILING_MINOR;

/**
 * A ROUGH pre-tax proxy for the largest single amount that will be debited on a
 * renewal: the customer's biggest live recurring subscription in this currency, priced
 * off the catalog rows.
 *
 * Kept for the two jobs it is still honest at:
 *  1. The **buyer-facing AFA advice** (`expected_debit_minor` on the portal and
 *     checkout gateway lists), which asks "is this customer's recurring spend near
 *     ₹15,000" — a question a proxy answers well enough, and cheaply, without planning
 *     an invoice per subscription on a page load.
 *  2. The **fallback** for `deriveMandateCeiling` when no estimate can be produced.
 *
 * It must NOT be used as the ceiling's primary input, and no longer is. What it misses:
 * tax (a ₹10,000 plan is debited ₹11,800 under 18% GST), unbilled charges folded into a
 * renewal, and the item's frozen `price_snapshot` — including a custom `unit_price_minor`
 * override, which lives in the snapshot and is invisible here. It also hand-rolls
 * `amount × quantity` instead of `computeLineAmount`, so it reads **0** for tiered,
 * volume, stairstep and percentage prices (their money is in `tiers`/`percentage_bps`,
 * not `amount_minor`) and near-0 for metered ones. Every one of those understates.
 *
 * Testing the *ceiling* against `INR_AFA_FREE_CEILING_MINOR` would be a different
 * mistake: it would flag an ordinary ₹6,000 plan, whose ceiling clears the threshold
 * while every debit under it sits far below. What decides whether renewals need AFA is
 * the debit, not the headroom — which is why this stays separate from the ceiling.
 */
export async function largestRecurringDebit(
  organizationId: string,
  businessId: string,
  customerId: string,
  currency: string,
): Promise<bigint> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .select({
        amountMinor: prices.amountMinor,
        quantity: subscriptionItems.quantity,
        subId: subscriptions.id,
      })
      .from(subscriptions)
      .innerJoin(subscriptionItems, eq(subscriptionItems.subscriptionId, subscriptions.id))
      .innerJoin(prices, eq(prices.id, subscriptionItems.priceId))
      .where(
        and(
          eq(subscriptions.businessId, businessId),
          eq(subscriptions.customerId, customerId),
          // LIVE subscriptions only. Without this a cancelled ₹50,000 plan still counted,
          // so a customer returning on a ₹2,000 plan was asked to authorise a mandate
          // sized for the plan they had left — and the AFA advice warned them about a
          // debit that will never be attempted. `paused` stays IN: a pause is expected to
          // end, and sizing a mandate as though it will not is how the resume fails.
          inArray(subscriptions.status, ["active", "in_trial", "paused", "future"]),
          eq(prices.currency, currency.toUpperCase()),
          eq(prices.type, "recurring"),
        ),
      ),
  );
  // Largest single subscription, not the sum: each renewal debits one subscription.
  const perSubscription = new Map<string, bigint>();
  for (const r of rows) {
    const line = (r.amountMinor ?? 0n) * BigInt(r.quantity);
    perSubscription.set(r.subId, (perSubscription.get(r.subId) ?? 0n) + line);
  }
  return [...perSubscription.values()].reduce((a, b) => (b > a ? b : a), 0n);
}

/**
 * Per-debit ceiling to register a mandate with, in minor units of `currency`.
 *
 * Mandate rails (RazorPay e-mandate/UPI/card, SEPA, ACH) demand an upper bound up
 * front, and it is enforced at debit time — so a ceiling unrelated to the plan is a
 * renewal failure waiting for the first customer who is billed more than the
 * default. Derived from the customer's largest active recurring subscription in
 * this currency, since that is what will actually be debited.
 *
 * ⚠️ INR + cards: RBI's e-mandate framework auto-debits without re-authentication
 * only up to ₹15,000. A ceiling above that is legal to register but every debit
 * over ₹15,000 triggers AFA and stops being off-session — so an expensive INR plan
 * cannot renew unattended on cards no matter what we set here. Left unclamped
 * deliberately: silently lowering the ceiling would guarantee the debit is refused,
 * which is strictly worse than a debit that asks the buyer to authenticate.
 */
/**
 * The ceiling to register when NOTHING can be derived — no priced subscription in this
 * currency, which the ordinary signup order (vault, THEN subscribe) hits every time.
 *
 * Currency-aware because the constant cannot be: see `MANDATE_FALLBACK_CEILING_INR`.
 */
export function mandateFallbackCeiling(currency: string): bigint {
  return currency.toUpperCase() === "INR" ? MANDATE_FALLBACK_CEILING_INR : MANDATE_FALLBACK_CEILING;
}

// ⚠️ `deriveMandateCeiling` used to live here, sizing the ceiling as
// `largestRecurringDebit × 3`. It now lives in `subscriptions/estimate.ts`, because
// sizing a mandate honestly means asking what the next invoice will actually PRESENT
// for collection — tax in, discounts in — and that is the estimator's job, not a
// price-column sum's (the sum missed tax entirely, and read 0 for every tiered,
// volume, stairstep, percentage and metered price). The dependency only points one
// way: the estimator imports this module's helpers, never the reverse.

/** Re-point the mapping when a vault adopted a different provider customer (stale SetupIntent). */
async function adoptProviderCustomer(input: {
  organizationId: string;
  customer: typeof customers.$inferSelect;
  providerKey: string;
  gatewayAccountId: string | null;
  providerCustomerId: string;
}): Promise<void> {
  await withTenant(input.organizationId, (tx) =>
    tx
      .update(providerCustomers)
      .set({ providerCustomerId: input.providerCustomerId, updatedAt: stampNow() })
      .where(
        and(
          eq(providerCustomers.customerId, input.customer.id),
          eq(providerCustomers.providerKey, input.providerKey),
          input.gatewayAccountId
            ? eq(providerCustomers.gatewayAccountId, input.gatewayAccountId)
            : isNull(providerCustomers.gatewayAccountId),
        ),
      ),
  );
}

/**
 * Vault a payment method for a customer via a provider adapter, then persist the
 * provider tokens + display fields. The raw card never touches us (PCI SAQ-A).
 */
export async function vaultPaymentMethod(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  token: string;
  provider?: string;
  /** Route the vault through a specific gateway account (C10). */
  gatewayAccountId?: string;
  /** Stored on the row; see `persistVaultedPaymentMethod`. */
  collectOpenInvoices?: boolean;
}): Promise<typeof paymentMethods.$inferSelect> {
  // C10: when a gateway account is given, vault through it (credentials from DB).
  // An explicit legacy `provider` key (env-configured stripe/paypal/razorpay,
  // pre-gateway-accounts) is honored if given; otherwise resolve the business's
  // configured default account. There is no mock/dev fallback — a business with
  // no provider and no gateway account cannot vault a payment method.
  let gatewayAccountId: string | null = null;
  let provider: ReturnType<typeof getProvider>;
  if (input.gatewayAccountId) {
    const [acc] = await withTenant(input.organizationId, (tx) =>
      tx
        .select()
        .from(gatewayAccounts)
        .where(
          and(
            eq(gatewayAccounts.businessId, input.businessId),
            eq(gatewayAccounts.publicId, input.gatewayAccountId!),
          ),
        )
        .limit(1),
    );
    if (!acc) throw new Error(`Gateway account not found: ${input.gatewayAccountId}`);
    provider = resolveAdapter(acc);
    gatewayAccountId = acc.id;
  } else if (input.provider) {
    // A bare provider key is the LEGACY pre-gateway-accounts path, but callers still
    // reach for it ("vault this on razorpay"). Leaving the method unbound was a live
    // footgun: with `gateway_account_id` NULL, selectGatewayAccount has no override
    // and routes the eventual charge to the business DEFAULT account — so an INR card
    // vaulted "on razorpay" was charged through Stripe, which is how a real RazorPay
    // token produced a Stripe "No such PaymentMethod".
    //
    // So bind the business's own active account for that provider when it has one,
    // and fall back to the env-configured adapter only when it genuinely has none.
    const named = await withTenant(input.organizationId, (tx) =>
      tx
        .select()
        .from(gatewayAccounts)
        .where(
          and(
            eq(gatewayAccounts.businessId, input.businessId),
            eq(gatewayAccounts.gatewayKey, input.provider!),
            eq(gatewayAccounts.status, "active"),
          ),
        ),
    );
    if (named.length === 1) {
      provider = resolveAdapter(named[0]!);
      gatewayAccountId = named[0]!.id;
    } else if (named.length > 1) {
      // Several accounts on the same gateway (e.g. one per currency). Prefer the
      // business default if it is one of them; otherwise the caller has to say which,
      // because picking arbitrarily is how a token ends up unusable at charge time.
      const dflt = await resolveDefaultAccountForBusiness(
        input.organizationId,
        input.businessId,
        input.customer.currency ?? undefined,
      );
      const chosen = dflt && named.some((a) => a.id === dflt.id) ? dflt : null;
      if (!chosen) {
        throw new PaymentMethodConfigError(
          `This business has ${named.length} active ${input.provider} gateway accounts. Pass gateway_account to select the account that vaults and charges this method.`,
        );
      }
      provider = resolveAdapter(chosen);
      gatewayAccountId = chosen.id;
    } else {
      provider = getProvider(input.provider);
    }
  } else {
    // Smart Routing: route the vault through the account that will
    // actually CHARGE it — vaulting on one gateway and charging on another leaves an
    // unusable token, and no token can be moved between gateways afterwards.
    //
    // This read `input.customer.currency` directly, and that column is usually NULL, so
    // routing was skipped for most customers and the business default came back whatever
    // currency it settles in. Same chain `api/vault-setup.ts` already uses, and for the
    // same measured reason (2026-08-14, an INR customer on a USD-default business):
    // explicit currency → the customer's live subscriptions → the business default.
    //
    // Imported dynamically because `customers/service` imports THIS module.
    const { resolveCustomerCurrency } = await import("@/modules/customers/service");
    const [vaultBiz] = await withTenant(input.organizationId, (tx) =>
      tx
        .select({ cur: businesses.defaultCurrency })
        .from(businesses)
        .where(eq(businesses.id, input.businessId))
        .limit(1),
    );
    const vaultCurrency =
      (await resolveCustomerCurrency(input.organizationId, input.customer)) ??
      vaultBiz?.cur ??
      undefined;

    let acc: Awaited<ReturnType<typeof resolveDefaultAccountForBusiness>> = null;
    if (vaultCurrency) {
      try {
        acc = await withTenant(input.organizationId, (tx) =>
          selectGatewayAccount(tx, {
            businessId: input.businessId,
            currency: vaultCurrency,
            methodType: "card",
            purpose: "setup",
          }),
        );
      } catch (e) {
        acc = null;
        log.warn(
          "currency-matched gateway account lookup failed — falling back to the business default",
          {
            businessId: input.businessId,
            currency: vaultCurrency,
            error: (e as Error)?.message,
          },
        );
      }
    }
    acc ??= await resolveDefaultAccountForBusiness(
      input.organizationId,
      input.businessId,
      vaultCurrency,
    );
    if (!acc)
      throw new PaymentMethodConfigError(
        "This business has no payment provider. Create a gateway account first.",
      );
    provider = resolveAdapter(acc);
    gatewayAccountId = acc.id;
  }

  const providerCustomer = await ensureProviderCustomer({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customer: input.customer,
    provider,
    gatewayAccountId,
  });
  // The provider rejecting a buyer-supplied token is not an internal fault — it's
  // an expired/unapproved/already-consumed token, and the buyer needs to be told
  // that, not "Internal server error" (which is what a raw throw surfaced in the
  // portal after a PayPal approval round trip).
  let vaulted;
  try {
    vaulted = await provider.vaultPaymentMethod({
      customer: providerCustomer,
      token: input.token,
      customerRef: input.customer.publicId,
    });
  } catch (e) {
    throw new PaymentMethodVaultError(provider.key, e);
  }
  return persistVaultedPaymentMethod({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customer: input.customer,
    vaulted,
    gatewayAccountId,
    providerCustomerId: providerCustomer.providerCustomerId,
    collectOpenInvoices: input.collectOpenInvoices,
  });
}

/**
 * Merge a fresh vault readback's AVS/CVC verdict onto an existing row (0245).
 * `??` per field — never blank a verdict already captured with a null from a
 * refresh whose payload carried no `checks` block at all (see the two-writer
 * race documented on `persistVaultedPaymentMethod`).
 */
export function mergedAvsFields(
  vaulted: Pick<ProviderPaymentMethodRef, "display">,
  existing: {
    avsLine1Check: string | null;
    avsPostalCheck: string | null;
    cvcCheck: string | null;
    avsCheckedAt: Date | null;
  },
) {
  return {
    avsLine1Check: vaulted.display.avsLine1Check ?? existing.avsLine1Check,
    avsPostalCheck: vaulted.display.avsPostalCheck ?? existing.avsPostalCheck,
    cvcCheck: vaulted.display.cvcCheck ?? existing.cvcCheck,
    avsCheckedAt: vaulted.display.avsCheckedAt ?? existing.avsCheckedAt,
  };
}

/**
 * Persist an ALREADY-VAULTED instrument: the `payment_methods` row, the stale-
 * provider-customer adoption, `payment_source_added` + `customer_updated`, and the
 * audit entry.
 *
 * Split out of `vaultPaymentMethod` because a `setup` payment intent
 * (`purpose: 'setup'`, 0171) arrives here with the instrument ALREADY vaulted —
 * the gateway handed the ref back from `consumeIntent`, there is no token left to
 * exchange. The intent service calls this instead of re-implementing the write, so
 * a vaulted card is created in exactly one place regardless of which flow produced
 * it.
 *
 * @param providerCustomerId the provider customer the vault call ran against;
 *   used when the ref doesn't carry its own (`ProviderPaymentMethodRef.providerCustomerId`).
 */
export async function persistVaultedPaymentMethod(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  vaulted: ProviderPaymentMethodRef;
  gatewayAccountId: string | null;
  providerCustomerId?: string | null;
  /** The payer's ACH authorization, on a gateway where it is ours to capture. */
  achAuthorization?: AchAuthorizationEvidence;
  /**
   * The caller's `collect_open_invoices`, kept so a mandate confirmed later collects as
   * asked. Omitted = leave the stored value (null on a new row = the business rule).
   */
  collectOpenInvoices?: boolean;
}): Promise<typeof paymentMethods.$inferSelect> {
  const { vaulted, gatewayAccountId } = input;
  // NACHA: no ACH debit without the payer's authorization, so no such method without it.
  const needsAch =
    vaulted.display.type === "us_bank_account" && achAuthorizationIsOurs(vaulted.providerKey);
  if (needsAch && !input.achAuthorization)
    throw new AchAuthorizationRequiredError(
      "We could not save this bank account. Accept the bank debit authorization. Then try again.",
    );
  const recordAch = async (tx: Tx, pm: typeof paymentMethods.$inferSelect) => {
    if (!needsAch || !input.achAuthorization) return;
    const pma = await insertAchAuthorization(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customer.id,
      paymentMethodId: pm.id,
      paymentMethodPublicId: pm.publicId,
      gatewayKey: vaulted.providerKey,
      methodType: vaulted.display.type,
      evidence: input.achAuthorization,
    });
    // Same transaction: the outbox queues the payer's copy (`ach_authorization_copy`).
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "payment_source_updated",
      data: buildEventData(
        "payment_source_updated",
        {
          id: pm.publicId,
          customer: input.customer.publicId,
          type: pm.type,
          last4: pm.last4,
        },
        undefined,
        { ach_authorization: pma },
      ),
    });
  };
  // NOT NULL at the database, and rightly so: a vaulted token that isn't bound to a
  // provider customer cannot be charged. Fail here rather than let the insert do it.
  const providerCustomerId = vaulted.providerCustomerId ?? input.providerCustomerId;
  if (!providerCustomerId)
    throw new PaymentMethodConfigError(
      `${vaulted.providerKey} returned a payment method with no provider customer to bind it to`,
    );
  // Stale-SetupIntent edge: the pm was confirmed against a provider customer
  // minted BEFORE the mapping existed — adopt it so future ops stay aligned.
  if (
    input.providerCustomerId &&
    vaulted.providerCustomerId &&
    vaulted.providerCustomerId !== input.providerCustomerId
  ) {
    await adoptProviderCustomer({
      organizationId: input.organizationId,
      customer: input.customer,
      providerKey: vaulted.providerKey,
      gatewayAccountId,
      providerCustomerId: vaulted.providerCustomerId,
    });
  }

  const pm = await withTenant(input.organizationId, async (tx) => {
    // ── Idempotent on the PROVIDER's id for the instrument ───────────────────────
    // Two paths vault the SAME instrument by design: the buyer's browser completing
    // the add-card, and the gateway's webhook harvesting the authorized `setup` intent
    // (`harvestSetupIntent`, webhooks/inbound.ts) for the buyer who never came back.
    // The intent's atomic `authorized -> consumed` transition was believed to make that
    // safe, and it does guard callers that go THROUGH the intent — but the portal's
    // completion posts the raw provider token to `POST /portal/v1/payment_methods`,
    // which does not, so the claim never saw it.
    //
    // MEASURED 2026-08-21 (RazorPay test mode, UPI Autopay): token
    // `token_XXXXXXXXXXXX02` landed twice 15s apart — webhook first, browser second —
    // and the portal listed one mandate as two payment methods. Deduping in the single
    // WRITER rather than at each call site is what makes it hold for every gateway
    // (Stripe / RazorPay / PayPal / tmtest) and every flow (portal, hosted checkout,
    // operator API, webhook harvest), including ones not written yet;
    // `payment_methods_provider_pm_uq` (0183) closes the read->insert race underneath.
    const [existing] = await tx
      .select()
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, input.customer.id),
          eq(paymentMethods.providerKey, vaulted.providerKey),
          eq(paymentMethods.providerPaymentMethodId, vaulted.providerPaymentMethodId),
        ),
      )
      .limit(1);

    /**
     * ── THE SAME CARD, A NEW TOKEN ───────────────────────────────────────────────
     *
     * The lookup above dedupes on the GATEWAY's token id, which catches the same token
     * arriving twice. It cannot catch a RE-ADD: a customer who adds their card again
     * gets a brand-new `pm_…` at Stripe for the same physical card, so the token differs
     * and a second row is written.
     *
     * Measured on the live book 2026-09-12, the day `instrument_fingerprint` first
     * existed to see it with: one customer had ONE card vaulted FOUR times, another
     * twice. The cost is not cosmetic — `resolveChargeCandidates` used to accept a
     * backup that was a different ROW of the same card, so the fallback re-presented
     * the instrument that had just declined.
     *
     * ⚠️ Scoped to the same gateway ACCOUNT, because a Stripe fingerprint is unique per
     * card per account — two accounts give the same card different fingerprints, and
     * comparing across them would match nothing (harmless) or, if Stripe ever changed
     * that, the wrong thing (not). Null fingerprint means UNKNOWN and matches nothing:
     * RazorPay and PayPal report none, so those rails keep exactly the old behaviour.
     */
    const [sameCard] =
      !existing && vaulted.display.instrumentFingerprint
        ? await tx
            .select()
            .from(paymentMethods)
            .where(
              and(
                eq(paymentMethods.customerId, input.customer.id),
                eq(paymentMethods.providerKey, vaulted.providerKey),
                eq(paymentMethods.instrumentFingerprint, vaulted.display.instrumentFingerprint),
                gatewayAccountId
                  ? eq(paymentMethods.gatewayAccountId, gatewayAccountId)
                  : isNull(paymentMethods.gatewayAccountId),
              ),
            )
            .limit(1)
        : [];
    if (sameCard) {
      /**
       * Adopt the row rather than add a fifth. The NEW token is the live one — it is
       * what the buyer just authorised and what carries the current mandate — so the
       * row moves onto it, and the superseded id is kept in `metadata` rather than
       * dropped, because "which token did this row used to be" is exactly the question
       * a gateway-side investigation asks and nothing else would record it.
       */
      const superseded = [
        ...(((sameCard.metadata as Record<string, unknown> | null)?.superseded_tokens as
          | string[]
          | undefined) ?? []),
        sameCard.providerPaymentMethodId,
      ];
      await tx
        .update(paymentMethods)
        .set({
          providerPaymentMethodId: vaulted.providerPaymentMethodId,
          metadata: {
            ...((sameCard.metadata as object | null) ?? {}),
            superseded_tokens: superseded,
          },
          // The buyer authorised this instrument again (a new token): clears a revoked mandate.
          authorizedAt: stampNow(),
        })
        .where(eq(paymentMethods.id, sameCard.id));
      log.info("re-added card matched an existing instrument by fingerprint", {
        event: "payment_method_readded",
        paymentMethod: sameCard.publicId,
        supersededToken: sameCard.providerPaymentMethodId,
        token: vaulted.providerPaymentMethodId,
      });
    }
    const existingOrSameCard =
      existing ??
      (sameCard
        ? { ...sameCard, providerPaymentMethodId: vaulted.providerPaymentMethodId }
        : undefined);
    if (existingOrSameCard) {
      const existing = existingOrSameCard;
      // Not a plain no-op: whoever arrives second carries the FRESHER readback of the
      // same instrument — a mandate the gateway confirmed in between, a ceiling the
      // buyer's bank clamped. Take those, but only where the new ref actually says
      // something: a caller with no mandate block must not erase a confirmed mandate.
      const [refreshed] = await tx
        .update(paymentMethods)
        .set({
          type: vaulted.display.type,
          brand: vaulted.display.brand ?? existing.brand,
          last4: vaulted.display.last4 ?? existing.last4,
          expMonth: vaulted.display.expMonth ?? existing.expMonth,
          expYear: vaulted.display.expYear ?? existing.expYear,
          // When the number or expiry last changed.
          ...(credentialsChanged(existing, vaulted.display)
            ? { credentialsChangedAt: stampNow() }
            : {}),
          // Re-vault of an EXISTING row: the fresh read wins, but only where it
          // actually said something. A gateway that reports nothing must not blank a
          // fact an earlier read established — same `?? existing` rule as the fields
          // above, and the reason these are nullable-means-unknown throughout.
          issuerCountry: vaulted.display.issuerCountry ?? existing.issuerCountry,
          supportsInternational:
            vaulted.display.supportsInternational ?? existing.supportsInternational,
          instrumentSubType: vaulted.display.instrumentSubType ?? existing.instrumentSubType,
          supportsRecurring: vaulted.display.supportsRecurring ?? existing.supportsRecurring,
          instrumentFunding: vaulted.display.instrumentFunding ?? existing.instrumentFunding,
          issuerName: vaulted.display.issuerName ?? existing.issuerName,
          instrumentFingerprint:
            vaulted.display.instrumentFingerprint ?? existing.instrumentFingerprint,
          threeDSecureSupported:
            vaulted.display.threeDSecureSupported ?? existing.threeDSecureSupported,
          gatewayAccountId: gatewayAccountId ?? existing.gatewayAccountId,
          mandateMaxAmountMinor: vaulted.mandate?.maxAmountMinor ?? existing.mandateMaxAmountMinor,
          mandateCurrency: vaulted.mandate?.currency ?? existing.mandateCurrency,
          mandateRail: vaulted.mandate?.rail ?? existing.mandateRail,
          mandateStatus: vaulted.mandate?.status ?? existing.mandateStatus,
          mandateExpiresAt: vaulted.mandate?.expiresAt ?? existing.mandateExpiresAt,
          mandateReference: vaulted.mandate?.reference ?? existing.mandateReference,
          // Same "don't blank on a quieter refresh" rule as the mandate fields above:
          // a re-vault of an already-known instrument can arrive with no `checks`
          // block at all (0245), and that must not erase a verdict already captured.
          ...mergedAvsFields(vaulted, existing),
          ...(input.collectOpenInvoices !== undefined
            ? { collectOpenInvoices: input.collectOpenInvoices }
            : {}),
        })
        .where(eq(paymentMethods.id, existing.id))
        .returning();
      // No second `payment_source_added`, no second `customer_updated`, no second audit
      // entry: nothing was ADDED. One add-card in the audit log and one event is the
      // accurate account of what the buyer did.
      log.info(
        "instrument already vaulted — refreshed the existing row instead of adding a second",
        {
          paymentMethod: existing.publicId,
          provider: vaulted.providerKey,
          providerPaymentMethodId: vaulted.providerPaymentMethodId,
          customer: input.customer.publicId,
        },
      );
      await recordAch(tx, refreshed ?? (existing as typeof paymentMethods.$inferSelect));
      return refreshed ?? existing;
    }

    const [row] = await tx
      .insert(paymentMethods)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customer.id,
        publicId: publicId("pm"),
        providerKey: vaulted.providerKey,
        // A SetupIntent-confirmed pm is bound to the setup call's provider
        // customer — charge with THAT one, not the freshly-ensured customer.
        providerCustomerId,
        providerPaymentMethodId: vaulted.providerPaymentMethodId,
        type: vaulted.display.type,
        brand: vaulted.display.brand ?? null,
        last4: vaulted.display.last4 ?? null,
        expMonth: vaulted.display.expMonth ?? null,
        expYear: vaulted.display.expYear ?? null,
        // Where the card was ISSUED — what RBI's e-mandate rules actually turn on.
        // Null is UNKNOWN (RazorPay/PayPal report nothing here today), never "not
        // India": `debitNeedsBuyerAuthentication` only lets a KNOWN foreign issuer
        // suppress a claim, so an unmapped rail keeps its previous behaviour.
        issuerCountry: vaulted.display.issuerCountry ?? null,
        supportsInternational: vaulted.display.supportsInternational ?? null,
        instrumentSubType: vaulted.display.instrumentSubType ?? null,
        supportsRecurring: vaulted.display.supportsRecurring ?? null,
        instrumentFunding: vaulted.display.instrumentFunding ?? null,
        issuerName: vaulted.display.issuerName ?? null,
        instrumentFingerprint: vaulted.display.instrumentFingerprint ?? null,
        threeDSecureSupported: vaulted.display.threeDSecureSupported ?? null,
        gatewayAccountId,
        // The mandate AS REGISTERED (0179). Written from the adapter's readback of
        // the provider's own record, so a ceiling the gateway clamped — or the
        // buyer's bank lowered — is the one the charge pre-flight enforces. Absent
        // for a plain card-on-file: all-null is the correct row for "no mandate".
        mandateMaxAmountMinor: vaulted.mandate?.maxAmountMinor ?? null,
        mandateCurrency: vaulted.mandate?.currency ?? null,
        mandateRail: vaulted.mandate?.rail ?? null,
        mandateStatus: vaulted.mandate?.status ?? null,
        mandateExpiresAt: vaulted.mandate?.expiresAt ?? null,
        mandateReference: vaulted.mandate?.reference ?? null,
        // Gateway AVS/CVC verdict (0245) — all-null is correct for a rail that
        // reports nothing (RazorPay/PayPal today) or a payload with no `checks`.
        avsLine1Check: vaulted.display.avsLine1Check ?? null,
        avsPostalCheck: vaulted.display.avsPostalCheck ?? null,
        cvcCheck: vaulted.display.cvcCheck ?? null,
        avsCheckedAt: vaulted.display.avsCheckedAt ?? null,
        collectOpenInvoices: input.collectOpenInvoices ?? null,
      })
      .returning();

    /**
     * THE FIRST usable instrument becomes the customer's `primary`.
     *
     * Not a policy choice — a customer with exactly one payment method has no meaningful
     * "no default" state, and every consumer already reads `primary` as the intended one:
     * `resolveChargeCandidates` prefers it, dunning's backup logic is defined against it,
     * and the portal renders `is_default` from it. Left at the schema default of `none`, a
     * buyer who had just added their only card was shown **"Default payment method: None on
     * file"** directly above that card (seen 2026-08-27), and collection fell through to
     * "newest valid" — the same instrument, by luck rather than by intent.
     *
     * An existing primary is never demoted: adding a second card must not silently re-point
     * collection. That stays an explicit act (`assignPaymentMethodRole`, "Make default").
     *
     * Inside this transaction on purpose — two concurrent vaults would otherwise both read
     * "no primary" and both claim it. There is no partial unique index to catch that, so the
     * read and the write have to share the tx.
     */
    const hasPrimary = await tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(
        and(
          eq(paymentMethods.customerId, input.customer.id),
          eq(paymentMethods.role, "primary"),
          eq(paymentMethods.status, "valid"),
        ),
      )
      .limit(1);
    // Every later card is a backup by default; removing it is an explicit act (`none`).
    const initialRole = hasPrimary.length === 0 ? "primary" : "backup";
    // Taking over from a primary that is no longer valid: it steps down to backup, or the
    // customer is left with two primaries and collection picks between them by row order.
    // An `invalid`/`expired` backup is skipped by collection, so it is not charged again.
    const replaced =
      initialRole === "primary"
        ? await tx
            .update(paymentMethods)
            .set({ role: "backup" })
            .where(
              and(
                eq(paymentMethods.customerId, input.customer.id),
                eq(paymentMethods.role, "primary"),
              ),
            )
            .returning()
        : [];
    await tx
      .update(paymentMethods)
      .set({ role: initialRole })
      .where(eq(paymentMethods.id, row!.id));
    row!.role = initialRole;
    for (const old of replaced) {
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "payment_source_role_changed",
        data: buildEventData("payment_source_role_changed", { id: old.publicId, role: "backup" }),
      });
      await writeAuditLog(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          action: "customer.payment_method_role",
          resourceType: "customer",
          resourceId: input.customer.publicId,
          before: { payment_method: old.publicId, role: "primary" },
          after: {
            payment_method: old.publicId,
            role: "backup",
            card: cardLabel(old),
            swapped_with: row!.publicId,
          },
        },
        tx,
      );
    }

    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "payment_source_added",
      data: buildEventData("payment_source_added", {
        id: row!.publicId,
        customer: input.customer.publicId,
        type: row!.type,
        brand: row!.brand,
        last4: row!.last4,
      }),
    });
    // A payment-source change also fires `customer_changed`: tmbilling's customer row
    // does not embed its payment sources, so we signal the related change with a
    // customer_updated event (canonical `customer_changed`) rather than an artificial
    // resource_version bump.
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "customer_updated",
      data: buildEventData(
        "customer_updated",
        { id: input.customer.publicId, email: input.customer.email },
        input.customer.resourceVersion,
      ),
    });
    // `input.customer` is already in hand here, so no owner lookup is needed.
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "customer.add_payment_method",
        resourceType: "customer",
        resourceId: input.customer.publicId,
        before: { payment_method: null, card: null },
        after: {
          payment_method: row!.publicId,
          card: cardLabel(row!),
          type: row!.type,
          gateway_account: gatewayAccountId ? row!.gatewayAccountId : null,
        },
      },
      tx,
    );
    await recordAch(tx, row!);
    return row!;
  });
  // After commit, and on a re-vault too: the job key makes a second request a no-op.
  if (vaulted.setupAuthCharge) {
    const { queueSetupAuthRefund } = await import("./setup-auth-refund");
    await queueSetupAuthRefund({
      organizationId: input.organizationId,
      businessId: input.businessId,
      gatewayAccountId,
      providerKey: vaulted.providerKey,
      providerCustomerId,
      providerPaymentMethodId: vaulted.providerPaymentMethodId,
      providerChargeId: vaulted.setupAuthCharge.providerChargeId,
      amountMinor: String(vaulted.setupAuthCharge.amountMinor),
      currency: vaulted.setupAuthCharge.currency,
      paymentMethod: pm.publicId,
      ...(vaulted.setupAuthCharge.firstCharge ? { firstCharge: true } : {}),
    });
  }
  return pm;
}

/** Config errors the API maps to 400 (no gateway account / bad reference). */
export class PaymentMethodConfigError extends Error {}

/** A bank account saved with no ACH authorization, on a gateway where it is ours to take. */
export class AchAuthorizationRequiredError extends PaymentMethodConfigError {}

/**
 * The gateway refused to vault the token the buyer came back with (unapproved,
 * expired, or already exchanged). Mapped to 400 — the caller can retry the setup;
 * the provider's own text is kept on `.detail` for operators/logs.
 */
export class PaymentMethodVaultError extends Error {
  readonly detail: string;
  constructor(providerKey: string, cause: unknown) {
    super(
      `We could not confirm that payment method with ${providerKey}. The approval may have expired, or it was not completed. Try to add it again.`,
    );
    this.name = "PaymentMethodVaultError";
    this.detail = cause instanceof Error ? cause.message : String(cause);
    this.cause = cause;
  }
}

export class VaultSetupUnsupportedError extends Error {
  constructor(provider: string) {
    super(`Provider '${provider}' does not support a buyer-approval vault flow`);
    this.name = "VaultSetupUnsupportedError";
  }
}

/**
 * Begin a buyer-approval vault flow (off-session mandate) for providers that need
 * it (PayPal/RazorPay). Returns an approval URL the buyer visits; after approval,
 * the setup token is completed via vaultPaymentMethod (POST .../payment_methods).
 */
/** Auto-collection needs a working card and there isn't one — creation is refused. */
export class NoChargeablePaymentMethodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoChargeablePaymentMethodError";
  }
}

/**
 * Assert the customer can actually be auto-collected from (* creating a subscription with auto-collection ON and an immediate charge is
 * refused when there is no usable card).
 *
 * ONE check, and it is the one this promises: the customer holds a payment method we
 * have not already marked `expired` or `invalid`.
 *
 * ── The second check that used to be promised here, and why it is gone ───────
 * This also claimed "the gateway verifies it, when the adapter supports verification",
 * and called `provider.verifyPaymentMethod` behind a `capabilities.verify` flag. Only
 * `tmtest` has ever implemented that method — every real adapter fell out at
 * `if (!provider.verifyPaymentMethod) return`, so the suites exercised a verification
 * step production never performed, and the docstring promised a guarantee no live
 * customer ever got. A promise nothing keeps is worse than no promise: it is why
 * "the gateway verified the card" was reasonable to believe on a live account.
 *
 * It was removed rather than pushed down into the real adapters, because on those
 * gateways there is no free answer to "is this saved instrument still good": Stripe's
 * retrieve reports what was vaulted, not whether the issuer would authorize today, so
 * a truthful probe is a zero- or minimal-amount authorization — a real gateway round-trip,
 * with a real risk footprint, in the subscription-CREATE hot path. That is a decision
 * to take deliberately, at add-card time, not something to
 * leave implied by an optional capability flag. `verifyPaymentMethod` stays in the
 * provider contract for the adapters that can honour it cheaply; if it is ever wanted
 * here, it comes back with an adapter that implements it and a test that goes red.
 *
 * Throws NoChargeablePaymentMethodError; returns silently when chargeable.
 */
export async function assertChargeableForAutoCollect(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
}): Promise<void> {
  const rows = await listPaymentMethods(input.organizationId, input.customer.id);
  const usable = rows.filter((r) => r.status !== "expired" && r.status !== "invalid");
  if (usable.length === 0) {
    throw new NoChargeablePaymentMethodError(
      "Auto-collection is on, but the customer has no usable payment method. Add a card first, or create with auto_collection=off.",
    );
  }
}

/**
 * Like initiateVaultSetup, but resolves the provider from the business's
 * default gateway account (same resolution as vaultPaymentMethod) instead of
 * an explicit env-configured provider key. Used by the customer portal, where
 * the buyer never chooses a provider. Returns the provider key alongside the
 * setup so the client knows how to complete (client_secret vs redirect).
 */
/**
 * List the business's active gateway accounts that can vault a payment method
 * (their adapter implements `initiateVaultSetup`). Powers the customer-portal
 * "which gateway?" picker — the buyer chooses one before adding a card.
 *
 * `purpose: "payment"` lists the accounts that can take a payment now instead (the
 * portal's Pay now chooser), so a setup-only gateway is not offered there.
 */
export async function listVaultGatewaysForBusiness(
  organizationId: string,
  businessId: string,
  currency?: string,
  purpose: IntentPurpose = "setup",
): Promise<Array<{ id: string; gatewayKey: string; label: string; methodTypes: string[] | null }>> {
  const accounts = await listGatewayAccounts(organizationId, businessId);
  const out: Array<{
    id: string;
    gatewayKey: string;
    label: string;
    methodTypes: string[] | null;
  }> = [];
  for (const acc of accounts) {
    // Same predicate the ROUTER applies at charge time. It used to be a hand-rolled copy
    // that treated `currencies: []` as "all" where the router reads it as "none" — an
    // offered gateway the charge would then refuse.
    if (currency && !handlesCurrency(acc, currency)) continue;
    // The gateway itself may take this currency for one purpose only (`intentCurrencies`).
    if (currency && !gatewayAllowsPurpose(acc.gatewayKey, purpose, currency)) continue;
    let provider: PaymentProvider;
    try {
      provider = resolveAdapter(acc);
    } catch (e) {
      // Don't offer a gateway we can't build an adapter for — and say which one,
      // or "no vault options" reads as "no gateways configured".
      log.warn("gateway account skipped for vault setup — adapter unresolvable", {
        gatewayAccount: acc.publicId,
        gateway: acc.gatewayKey,
        error: (e as Error)?.message,
      });
      continue;
    }
    // A gateway vaults through its setup call, or through a setup intent (Mollie has only the
    // intent: its first payment creates the mandate). Pay now needs a payment intent.
    const canIntent =
      !!provider.createIntent && allowsIntentPurpose(provider.capabilities.intentPurposes, purpose);
    const usable = purpose === "setup" ? !!provider.initiateVaultSetup || canIntent : canIntent;
    if (!usable) continue;
    out.push({
      id: acc.publicId,
      gatewayKey: acc.gatewayKey,
      label: acc.label,
      methodTypes: acc.methodTypes,
    });
  }
  // Business default first: both storefronts preselect data[0], and a `setup` with no
  // explicit account vaults on the default — so any other order previews the wrong
  // gateway. The raw order is `created_at DESC`, i.e. whichever was configured last.
  const def = await resolveDefaultAccountForBusiness(organizationId, businessId, currency);
  const i = def ? out.findIndex((g) => g.id === def.publicId) : -1;
  if (i > 0) out.unshift(out.splice(i, 1)[0]!);
  return out;
}

/**
 * Refuse to register a mandate we could never learn the outcome of.
 *
 * ── The failure this prevents ────────────────────────────────────────────────
 * On an async-settlement gateway the inbound webhook is not an extra: it is the
 * ONLY thing that turns a `pending` payment into cash. A live gateway account with
 * no webhook endpoint configured therefore takes buyers through a real mandate
 * registration, accepts real debits, moves real money at the gateway — and never
 * marks a single invoice paid. Every renewal parks `in_progress` for ever, the
 * customer is charged, and our books say they were not.
 *
 * Nothing else notices in time. Dunning correctly leaves a pending attempt alone,
 * the `stale_pending` sweep only polls once a rail's grace period has elapsed (up to
 * 7 days for netbanking), and the operator sees "everything is pending" long after
 * the money moved. Registration is the last moment the problem is cheap.
 *
 * ⚠️ **LIVE MODE ONLY.** Test accounts are routinely used without a webhook — every
 * `verify:*` suite and the whole local dev loop registers mandates against a
 * placeholder `WEBHOOK_BASE_URL` and settles by calling the inbound path directly.
 * Enforcing this in test would break the suites that prove the rail works, to guard
 * against a state that costs nothing there.
 *
 * A gateway that cannot provision (or whose credentials cannot be read) is NOT
 * treated as a failure: this guard exists to catch a missing endpoint, not to add a
 * new way for adding a card to break. It logs and allows.
 *
 * ── Which accounts it applies to ─────────────────────────────────────────────
 * `settlesAsynchronously` (gateway/webhook-endpoint.ts) decides, from the gateway AND
 * the effective method vector: RazorPay on every rail, Stripe only on its bank-debit
 * rails. `methodTypes` is what the caller asked for, else the account's own
 * `method_types` — the same list that is about to be sent to the gateway.
 */
async function assertSettlementReachable(
  acc: typeof gatewayAccounts.$inferSelect,
  methodTypes?: string[],
): Promise<void> {
  if (!acc.livemode || !settlesAsynchronously(acc.gatewayKey, methodTypes)) return;
  // No public base URL means there is no address for the gateway to POST to at all:
  // `buildNotificationUrl` would hand it a bare path. Checked separately because the
  // account's own credentials look perfectly configured in that state.
  if (!config.WEBHOOK_BASE_URL) {
    throw new PaymentMethodConfigError(
      `Gateway account ${acc.publicId} (${acc.gatewayKey}, live) settles these debits asynchronously, but ` +
        "this deployment has no WEBHOOK_BASE_URL. The gateway has no address to send the " +
        "settlement callback to. If you register a mandate now, we would collect money that we can never reconcile. " +
        "Set WEBHOOK_BASE_URL to the public origin of this API. Then provision the endpoint.",
    );
  }
  let configured = false;
  try {
    const info = await getWebhookEndpointInfo({
      organizationId: acc.organizationId,
      businessId: acc.businessId,
      gatewayAccountPublicId: acc.publicId,
    });
    configured = Boolean(info.configured);
  } catch (e) {
    log.warn("could not read the webhook endpoint while checking settlement reachability", {
      gateway_account: acc.publicId,
      error: String(e),
    });
    return;
  }
  if (configured) return;
  const rails = methodTypes && methodTypes.length > 0 ? methodTypes.join(", ") : "its default rail";
  throw new PaymentMethodConfigError(
    `Gateway account ${acc.publicId} (${acc.gatewayKey}, live) has no webhook endpoint configured. ` +
      `${acc.gatewayKey} settles recurring debits on ${rails} asynchronously. The charge returns pending, ` +
      "and only the inbound webhook can mark it paid. If you register a mandate now, the buyer completes " +
      "a real authorization, and then we collect money that we can never reconcile. Provision the " +
      "endpoint on the gateway account first (Settings › Gateways › Webhook endpoint).",
  );
}

/**
 * Instruments that are a CARD wearing another name. Stripe's `capabilities.methods`
 * deliberately omits them (its own comment: they "are card presentations… a pm backed
 * by one still has canonical type `card`", and listing them would let an operator
 * store an unroutable `method_types` value), but the buyer-facing `method_type` enum
 * accepts `wallet`, and RazorPay declares `wallet` for real. So a value here counts as
 * supported whenever the gateway declares `card` — the alternative is refusing an
 * add-card the adapter would have served perfectly.
 */
const CARD_PRESENTATION_METHODS = new Set(["wallet", "apple_pay", "google_pay", "link"]);

/**
 * Every precondition an add-card must satisfy before we send a buyer to a gateway.
 *
 * ── Why it is one function ───────────────────────────────────────────────────
 * There are TWO entry points — `beginVaultSetup`'s intent path (api/vault-setup.ts,
 * which is what the customer portal and hosted checkout actually take) and the legacy
 * `initiateVaultSetupForBusiness` below — and they used to hold two copies of this
 * list. The copies drifted exactly where it was most expensive: the intent path
 * carried three of the four checks and left out the settlement one, so
 * `assertSettlementReachable` — written for a state that costs real money — only ever
 * ran on the path nobody takes. A shared function is the fix; a fourth copied check
 * would only have reset the clock on the next divergence.
 *
 * Everything raised here is a `PaymentMethodConfigError`, which the buyer surfaces
 * turn into an actionable 400 — the point is that the buyer sees the same message
 * whichever path served them, instead of a gateway 500 or a silently wrong rail.
 *
 * Returns the method types to actually request: the caller's, or the account's own
 * allow-list when the caller named none.
 */
export async function assertVaultPreconditions(input: {
  account: typeof gatewayAccounts.$inferSelect;
  customer: typeof customers.$inferSelect;
  methodTypes?: string[];
  /** Already-resolved adapter, when the caller has one; resolved here otherwise. */
  provider?: PaymentProvider;
  /** `live-proof-pending.json` by default; tests pass a fake. */
  pendingMethods?: PendingMethods;
}): Promise<string[] | undefined> {
  const acc = input.account;
  const pending = input.pendingMethods ?? liveProofPending();
  const offered = (m: string) => methodOffered(acc.gatewayKey, m, pending);

  // Some gateways refuse recurring setup without a contact on the customer (RazorPay's
  // auth order 500s: "The contact field is required for recurring links").
  const def = gatewayDefinition(acc.gatewayKey);
  if (def?.recurringNeedsPhone && !(input.customer.phone ?? input.customer.billingPhone)) {
    throw new PaymentMethodConfigError(
      `${def.displayName} requires a phone number for recurring payments. Add a phone number to the customer. Then try to add a card again.`,
    );
  }

  // The email fallback is not a name: a gateway that wants a person's name refuses it.
  if (def?.recurringNeedsName && !invoiceContactName({ ...input.customer, email: null })) {
    throw new PaymentMethodConfigError(
      `${def.displayName} requires the customer's name for recurring payments. Add a name to the customer. Then try to add a payment method again.`,
    );
  }

  // The operator's own allow-list on this account (`method_types`) — checked before
  // the adapter's, because it is the narrower and more specific "no".
  if (input.methodTypes && acc.methodTypes && acc.methodTypes.length > 0) {
    const disallowed = input.methodTypes.filter((m) => !acc.methodTypes!.includes(m));
    if (disallowed.length > 0) {
      throw new PaymentMethodConfigError(
        `The selected gateway account (${acc.label}) does not allow these payment methods: ${disallowed.join(", ")}. ` +
          `Allowed methods: ${acc.methodTypes.join(", ")}.`,
      );
    }
  }
  // A method not proven live is never set up new. A saved one still charges: the charge path
  // does not read this list.
  const refused = (input.methodTypes ?? []).filter((m) => !offered(m));
  if (refused.length > 0)
    throw new PaymentMethodConfigError(
      `We could not set up ${refused.map((m) => methodLabel(acc.gatewayKey, m)).join(", ")}. ` +
        "It is not available yet. Select a different payment method.",
    );
  const advertised = def?.advertisedMethods ?? [];
  const configured = acc.methodTypes && acc.methodTypes.length > 0 ? acc.methodTypes : undefined;
  // With no list the adapter offers all it can, so name the rest when one is withheld.
  const fallback = configured ?? (advertised.some((m) => !offered(m)) ? advertised : undefined);
  const effective = input.methodTypes ?? fallback?.filter(offered);
  if (!input.methodTypes && effective?.length === 0)
    throw new PaymentMethodConfigError(
      `We could not set up a payment method on ${acc.label}. ` +
        "Its payment methods are not available yet. Select a different gateway account.",
    );

  /*
   * The ADAPTER's declared vocabulary, which nothing used to check. `method_types` is
   * a free-form jsonb column, so an operator can store `upi` on a Stripe account:
   * Stripe's capabilities exclude it, `handlesMethod` in gateway/router.ts matches a
   * charge against a pm's canonical type and could never route it, and the add-card
   * would either 400 at the gateway or silently fall back to a card. Refused here with
   * the same actionable shape as everything else on this list.
   *
   * An empty `capabilities.methods` means "unconstrained" and is not checked. An
   * adapter that cannot be built is not this function's failure to report — the call
   * that follows raises it by name.
   */
  let provider = input.provider;
  if (!provider) {
    try {
      provider = resolveAdapter(acc);
    } catch {
      provider = undefined;
    }
  }
  if (provider && effective && provider.capabilities.methods.length > 0) {
    const declared = new Set<string>(provider.capabilities.methods);
    const unsupported = effective.filter(
      (m) => !declared.has(m) && !(CARD_PRESENTATION_METHODS.has(m) && declared.has("card")),
    );
    if (unsupported.length > 0) {
      // Say WHERE the bad value came from: a buyer who asked for it can pick again, an
      // operator who stored it on the account has a settings screen to fix.
      const source = input.methodTypes
        ? "requested payment method(s)"
        : `payment method(s) configured on gateway account ${acc.publicId}`;
      throw new PaymentMethodConfigError(
        `${acc.gatewayKey} cannot configure the ${source}: ${unsupported.join(", ")}. ` +
          `${acc.gatewayKey} supports: ${provider.capabilities.methods.join(", ")}.`,
      );
    }
  }

  await assertSettlementReachable(acc, effective);
  return effective;
}

export async function initiateVaultSetupForBusiness(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  returnUrl: string;
  cancelUrl: string;
  /** Vault through THIS gateway account (gwa_… public id). Omit = business default. */
  gatewayAccountId?: string;
  /**
   * Currency the mandate will be debited in. Defaults to the customer's, then the
   * business's. Load-bearing on RazorPay, where the mandate is registered against
   * an order in a specific currency and the domestic rails refuse anything but INR
   * — without it a USD subscription would be bound to an INR mandate.
   */
  currency?: string;
  /** Per-debit ceiling in minor units of `currency` (see the adapter contract). */
  maxAmountMinor?: bigint;
  /** Which instruments the buyer may set up; non-INR requires the card rail. */
  methodTypes?: string[];
}): Promise<{
  setup: import("@/providers/types").VaultSetupRef;
  providerKey: string;
  gatewayAccountId: string;
  label: string;
}> {
  const acc = input.gatewayAccountId
    ? await getGatewayAccount(input.organizationId, input.businessId, input.gatewayAccountId)
    : await resolveDefaultAccountForBusiness(
        input.organizationId,
        input.businessId,
        input.currency,
      );
  if (!acc) {
    throw new PaymentMethodConfigError(
      input.gatewayAccountId
        ? "We could not find the selected payment gateway for this business"
        : "This business has no payment provider. Create a gateway account first.",
    );
  }
  if (acc.status !== "active")
    throw new PaymentMethodConfigError("The selected payment gateway is not active");
  const provider = resolveAdapter(acc);
  if (!provider.initiateVaultSetup) throw new VaultSetupUnsupportedError(provider.key);
  // The phone, the two method-type allow-lists and the settlement-reachability check,
  // in the one place both entry points read them from (see `assertVaultPreconditions`).
  // They run BEFORE `ensureProviderCustomer` below so a misconfiguration costs no
  // gateway round-trip — the method-type check used to sit after it.
  const effectiveMethodTypes = await assertVaultPreconditions({
    account: acc,
    customer: input.customer,
    provider,
    ...(input.methodTypes ? { methodTypes: input.methodTypes } : {}),
  });
  // Reused mapping + synced name/address — Indian Stripe accounts REQUIRE
  // customer name + address on export transactions (incl. SetupIntent confirm).
  const providerCustomer = await ensureProviderCustomer({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customer: input.customer,
    provider,
    gatewayAccountId: acc.id,
  });
  if (!provider.initiateVaultSetup) throw new VaultSetupUnsupportedError(provider.key);
  // Prefer the explicit currency, then the customer's, then the business default —
  // the same precedence invoicing uses, so the mandate is registered in whatever
  // the subscription will actually bill in.
  const [biz] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ cur: businesses.defaultCurrency })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1),
  );
  const currency = input.currency ?? input.customer.currency ?? biz?.cur ?? undefined;
  // The ceiling is the CALLER's to supply. It used to be derived here, but sizing it
  // honestly now means asking the estimator what the next invoice will present
  // (`deriveMandateCeiling`, subscriptions/estimate.ts) — and that module imports this
  // one, so deriving it here would close a cycle. `beginVaultSetup` (api/vault-setup.ts)
  // derives it ONCE and passes the same number down both the intent path and this legacy
  // one, which is what stops the two from registering different mandates for one buyer.
  //
  // Undefined is not a silent default: the adapter falls back to
  // `DEFAULT_MANDATE_MAX_AMOUNT`, which is the currency-blind ₹10,000/$10,000 this whole
  // derivation exists to avoid. Every caller that can resolve a currency must pass one.
  const maxAmountMinor = input.maxAmountMinor;

  const setup = await provider.initiateVaultSetup({
    // #31: `InitiateVaultSetupInput`'s own contract note says this input otherwise
    // "carries no identifier of ours at all" — only the gateway's customer id and two
    // URLs — so the SetupIntent was untaggable by construction. The CUSTOMER is the
    // right ref and not a fallback: no payment, intent or invoice exists for a vault
    // attempt, and "whose card is this?" is the question a reconciler holding a stray
    // SetupIntent actually has.
    ownershipRef: input.customer.publicId,
    customer: providerCustomer,
    contact: providerContact(input.customer),
    returnUrl: gatewayReturnUrl(provider, input.returnUrl),
    cancelUrl: gatewayReturnUrl(provider, input.cancelUrl),
    // Beside the authorization in the gateway's own dashboard, and on RazorPay's
    // e-mandate it travels to the buyer's BANK page. Stripe showed a SetupIntent with no
    // description at all — the row a support person opens when a renewal later fails on
    // "the card they saved".
    description: await setupChargeDescription({
      organizationId: input.organizationId,
      customerId: input.customer.id,
      maxAmountMinor: maxAmountMinor ?? null,
      currency: currency ?? null,
    }),
    ...(currency ? { currency } : {}),
    ...(maxAmountMinor != null ? { maxAmountMinor } : {}),
    ...(effectiveMethodTypes ? { methodTypes: effectiveMethodTypes } : {}),
  });
  return { setup, providerKey: provider.key, gatewayAccountId: acc.publicId, label: acc.label };
}

export async function initiateVaultSetup(input: {
  organizationId: string;
  customer: typeof customers.$inferSelect;
  provider: string;
  returnUrl: string;
  cancelUrl: string;
}): Promise<import("@/providers/types").VaultSetupRef> {
  const provider = getProvider(input.provider);
  if (!provider.initiateVaultSetup) throw new VaultSetupUnsupportedError(input.provider);
  const providerCustomer = await ensureProviderCustomer({
    organizationId: input.organizationId,
    businessId: input.customer.businessId,
    customer: input.customer,
    provider,
    gatewayAccountId: null, // legacy env-configured provider (no gateway_accounts row)
  });
  return provider.initiateVaultSetup({
    // #31, same ref as the gateway-account path above — the legacy env-configured
    // provider has no `gateway_accounts` row, but it creates the same SetupIntent.
    ownershipRef: input.customer.publicId,
    customer: providerCustomer,
    contact: providerContact(input.customer),
    returnUrl: gatewayReturnUrl(provider, input.returnUrl),
    cancelUrl: gatewayReturnUrl(provider, input.cancelUrl),
    // No ceiling is resolved on this path, so the label names the customer alone rather
    // than inventing terms — a shorter true description beats a fuller invented one.
    description: await setupChargeDescription({
      organizationId: input.organizationId,
      customerId: input.customer.id,
    }),
  });
}

export async function listPaymentMethods(
  organizationId: string,
  customerId: string,
): Promise<Array<typeof paymentMethods.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, customerId))
      .orderBy(desc(paymentMethods.createdAt)),
  );
}

/**
 * The instrument a BUYER-PRESENT payment should open on: the customer's default, else
 * the latest — among the ones that could actually pay.
 *
 * Exists as one function because two places must never disagree about it. The portal's
 * Pay-now route uses it to mint the intent (and, through `methodTypes`, to decide which
 * rail the checkout even offers), and `GET /portal/v1/me` uses it to TELL the buyer what
 * pressing the button will open. A label derived independently would be right until the
 * rule changed, and then it would quietly lie on the one screen where the buyer is
 * deciding whether to press.
 *
 * Same precedence `resolveChargeCandidates` applies to automatic collection — primary
 * role, else the latest — so the button and the clock agree about which instrument is
 * the customer's. It differs in one way, and only one: it filters to `valid` first.
 * Collection does not need to, because it can hard-decline and fall through to the
 * backup; a checkout has no second chance, and opening on a dead card only wastes the
 * buyer's time.
 *
 * Ordering is taken from `listPaymentMethods` (`created_at DESC`) rather than assumed by
 * the caller — passing a differently-ordered list was the bug this shape prevents.
 */
export async function resolveBuyerPayMethod(
  organizationId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<typeof paymentMethods.$inferSelect | null> {
  const methods = await listPaymentMethods(organizationId, customerId);
  const payable = methods.filter((m) => isPayableOnSession(m, now));
  return payable.find((m) => m.role === "primary") ?? payable[0] ?? null;
}

/**
 * Can the BUYER pay with this instrument right now, with themselves present?
 *
 * Deliberately not `status === 'valid'`, which is what this used to ask and what broke
 * Pay now on 2026-09-01. `status` carries two different facts on one axis: the sweep
 * demotes an instrument to `expired` both for a dead CARD and for a lapsed MANDATE
 * (`decidePaymentSourceExpiry`'s `reason`), and the mandate demotion is correct — an
 * instrument that cannot be auto-debited must drop out of automatic collection.
 *
 * But Pay now is ON-SESSION and, by its own design, never touches the mandate: it mints
 * a `payment` intent and the buyer completes the gateway's checkout themselves. Reading
 * the conflated column blocked the buyer from the one path that does not use the thing
 * that is broken — on an overdue balance the automation had already given up on, with
 * the portal telling them to pay. A card good until 01/2099 was refused because an
 * authorization attached to it lapsed the day before.
 *
 * So this asks the narrower question, and asks it through the SAME predicate the sweep
 * uses, so the two cannot drift: a printed-expired card is out, a lapsed mandate is not.
 */
export function isPayableOnSession(
  pm: Pick<
    typeof paymentMethods.$inferSelect,
    "status" | "expMonth" | "expYear" | "mandateExpiresAt"
  >,
  now: Date = new Date(),
): boolean {
  // `invalid` is the gateway telling us the instrument itself is dead — nothing
  // on-session can rescue that.
  if (pm.status === "invalid") return false;
  if (pm.status !== "expired") return true;
  return decidePaymentSourceExpiry(pm, now).reason === "mandate";
}

export type PaymentMethodRole = "primary" | "backup" | "none";

/**
 * Assign a collection role to a payment method (C6). One primary, any number of
 * backups; `none` takes a card out of automatic collection. Assigning `primary` moves
 * the previous primary to `backup`. The primary itself cannot be demoted — choose a new
 * one instead (`PrimaryDemotionError`), so a customer with cards always has one.
 * Collection resolves: subscription PM → customer primary → customer backups.
 */
export class PrimaryDemotionError extends Error {
  constructor() {
    super(
      "You cannot demote the primary payment method. Make a different payment method primary instead.",
    );
    this.name = "PrimaryDemotionError";
  }
}
/**
 * A payment method's owner as the audit log addresses it (0149).
 *
 * Payment-method actions are audited against the CUSTOMER, not against the payment
 * method: "who added a card to this account" is a fact about the account, and the
 * customer's Activity Log is the only screen where anyone looks for it. A
 * `payment_method`-scoped row would be correct and invisible — no screen lists a
 * deleted card to drill into.
 *
 * These functions take the internal `customerId` uuid, so the public id needs one
 * PK lookup. Returns nulls rather than throwing: a missing owner must never turn a
 * successful detach into an error, so the audit row is skipped instead.
 */
async function auditOwner(
  tx: Tx,
  customerId: string,
): Promise<{ publicId: string; businessId: string } | null> {
  const [c] = await tx
    .select({ publicId: customers.publicId, businessId: customers.businessId })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  return c ?? null;
}

export async function assignPaymentMethodRole(
  organizationId: string,
  customerId: string,
  pmPublicId: string,
  role: PaymentMethodRole,
): Promise<typeof paymentMethods.$inferSelect | null> {
  return withTenant(organizationId, async (tx) => {
    const [pm] = await tx
      .select()
      .from(paymentMethods)
      .where(
        and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, pmPublicId)),
      )
      .limit(1);
    if (!pm) return null;
    if (pm.role === "primary" && role !== "primary") throw new PrimaryDemotionError();
    // A single primary: the incumbent becomes a backup, not `none` — it is still the
    // customer's card and nobody asked to take it out of collection.
    const swappedOut: Array<typeof paymentMethods.$inferSelect> = [];
    if (role === "primary" && pm.role !== "primary") {
      const rows = await tx
        .update(paymentMethods)
        .set({ role: "backup" })
        .where(and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.role, "primary")))
        .returning();
      swappedOut.push(...rows.filter((r) => r.id !== pm.id));
    }
    const [updated] = await tx
      .update(paymentMethods)
      .set({ role })
      .where(eq(paymentMethods.id, pm.id))
      .returning();
    if (updated) {
      await emitEvent(tx, {
        organizationId,
        businessId: updated.businessId,
        type: "payment_source_role_changed",
        data: buildEventData(
          "payment_source_role_changed",
          { id: updated.publicId, role },
          undefined,
        ),
      });
      const owner = await auditOwner(tx, customerId);
      if (owner) {
        await writeAuditLog(
          {
            organizationId,
            businessId: owner.businessId,
            action: "customer.payment_method_role",
            resourceType: "customer",
            resourceId: owner.publicId,
            // The instrument is named in the diff so the row reads as "which card",
            // not just "a role changed": brand + last4 are what the operator sees on
            // screen, and they survive the card being detached later.
            before: { payment_method: updated.publicId, role: pm.role },
            after: { payment_method: updated.publicId, role, card: cardLabel(updated) },
          },
          tx,
        );
      }
      /**
       * The other half of a swap. It moved from one designated role to the other, which
       * is a change in its own right — a consumer reading only the assigned card's event
       * would believe the account still had whatever it had before.
       */
      for (const other of swappedOut) {
        await emitEvent(tx, {
          organizationId,
          businessId: other.businessId,
          type: "payment_source_role_changed",
          data: buildEventData(
            "payment_source_role_changed",
            { id: other.publicId, role: other.role },
            undefined,
          ),
        });
        const owner = await auditOwner(tx, customerId);
        if (owner) {
          await writeAuditLog(
            {
              organizationId,
              businessId: owner.businessId,
              action: "customer.payment_method_role",
              resourceType: "customer",
              resourceId: owner.publicId,
              before: { payment_method: other.publicId, role },
              after: {
                payment_method: other.publicId,
                role: other.role,
                card: cardLabel(other),
                swapped_with: updated.publicId,
              },
            },
            tx,
          );
        }
      }
    }
    return updated ?? null;
  });
}

/** "visa •••• 4242" — how the operator identifies an instrument on screen. */
function cardLabel(pm: {
  brand: string | null;
  last4: string | null;
  type: string | null;
}): string | null {
  const brand = pm.brand ?? pm.type ?? null;
  if (!pm.last4) return brand;
  return `${brand ?? "card"} •••• ${pm.last4}`;
}

/** Back-compat helper: "set default" now means assign the `primary` role. */
export async function setDefaultPaymentMethod(
  organizationId: string,
  customerId: string,
  pmPublicId: string,
): Promise<typeof paymentMethods.$inferSelect | null> {
  return assignPaymentMethodRole(organizationId, customerId, pmPublicId, "primary");
}

/** Flag a payment method's lifecycle status (C6 sweep + hard-decline handling). */
export async function setPaymentMethodStatus(
  tx: import("@/platform/db").Tx,
  organizationId: string,
  pmId: string,
  status: "valid" | "expiring" | "expired" | "invalid" | "pending_verification",
): Promise<void> {
  await tx.update(paymentMethods).set({ status }).where(eq(paymentMethods.id, pmId));
}

/**
 * Detach (delete) a vaulted payment method. Payment + subscription FK refs are
 * `on delete set null`, so history is preserved (the link is just cleared).
 * Returns true if a row was deleted.
 */
/**
 * Delete the instrument at the gateway so no vaulted card/mandate outlives the
 * local row (CUST-7, and plain data minimisation — a "deleted" source that is
 * still chargeable at the provider is a liability).
 *
 * Best-effort by design: a gateway outage must not block the customer's delete.
 * A failure is logged, never thrown — the local row goes either way, which can
 * leave an orphan at the provider. That is the lesser of the two evils, but it
 * is the reason the warning carries the provider ids needed to clean up by hand.
 *
 * Skipped when another payment_methods row still references the same provider
 * token: `provider_payment_method_id` has no unique index, so the same vault id
 * can legitimately appear twice (re-vaulted, or imported under two rows), and
 * deleting upstream would break the surviving row.
 */
async function deleteAtGateway(
  organizationId: string,
  pm: typeof paymentMethods.$inferSelect,
): Promise<void> {
  try {
    const shared = await withTenant(organizationId, (tx) =>
      tx
        .select({ id: paymentMethods.id })
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.providerKey, pm.providerKey),
            eq(paymentMethods.providerPaymentMethodId, pm.providerPaymentMethodId),
          ),
        ),
    );
    if (shared.some((r) => r.id !== pm.id)) {
      log.info(
        "[payment-methods] skipping gateway delete: the token is shared with another payment method",
        {
          event: "pm_gateway_delete_skipped_shared_token",
          pm: pm.publicId,
          provider: pm.providerKey,
          providerPaymentMethodId: pm.providerPaymentMethodId,
        },
      );
      return;
    }

    const adapter = pm.gatewayAccountId
      ? resolveAdapter(
          (
            await withTenant(organizationId, (tx) =>
              tx
                .select()
                .from(gatewayAccounts)
                .where(eq(gatewayAccounts.id, pm.gatewayAccountId!))
                .limit(1),
            )
          )[0]!,
        )
      : getProvider(pm.providerKey);

    if (!adapter.deletePaymentMethod) {
      log.warn(
        "[payment-methods] adapter cannot delete vaulted instruments — the token survives at the provider",
        {
          event: "pm_gateway_delete_unsupported",
          pm: pm.publicId,
          provider: adapter.key,
          providerPaymentMethodId: pm.providerPaymentMethodId,
        },
      );
      // Same exposure as a failed delete, so the same durable record: the
      // instrument outlives its local row either way.
      await recordOrphanedAtGateway(
        organizationId,
        pm,
        `${adapter.key} adapter has no deletePaymentMethod`,
      );
      return;
    }

    await adapter.deletePaymentMethod({
      customer: { providerKey: adapter.key, providerCustomerId: pm.providerCustomerId },
      // With the mandate we hold: Cashfree reads the rail from it when the gateway cannot say.
      paymentMethod: providerPaymentMethodRef(pm, adapter.key),
    });
  } catch (err) {
    log.warn(
      "[payment-methods] gateway delete failed — the token may still be vaulted at the provider",
      {
        event: "pm_gateway_delete_failed",
        error: err instanceof Error ? err.message : String(err),
        pm: pm.publicId,
        provider: pm.providerKey,
        providerCustomerId: pm.providerCustomerId,
        providerPaymentMethodId: pm.providerPaymentMethodId,
      },
    );
    await recordOrphanedAtGateway(
      organizationId,
      pm,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Durably record an instrument that outlived its local row at the gateway.
 *
 * A `log.warn` was the only trace, and a log line is not a record: it scrolls away,
 * it is not queryable per customer, and nobody is going to grep production logs to
 * answer "did that erasure actually revoke anything?".
 *
 * ⚠️ **RazorPay makes this a compliance question, not housekeeping.** It refuses to
 * delete an ACTIVE recurring token and exposes no cancel route at all (7 candidates
 * probed — operator ask 5). So deleting a payment source, *including as part of a
 * GDPR erasure*, can leave a live and still-chargeable mandate upstream. The local
 * row goes either way — that is the deliberate best-effort contract — which means
 * the only thing standing between us and an unrevoked mandate nobody can find is
 * this entry.
 *
 * Written to the audit log rather than a new table: it is already the per-resource,
 * queryable, retained history, and an operator chasing an erasure is looking at the
 * customer's audit trail anyway. `after` carries the gateway ids so the mandate can
 * be cancelled by hand in the RazorPay dashboard, which is currently the only way.
 *
 * Never throws: this runs inside the best-effort delete path, and failing to record
 * a failure must not turn a soft failure into a hard one.
 */
async function recordOrphanedAtGateway(
  organizationId: string,
  pm: typeof paymentMethods.$inferSelect,
  reason: string,
): Promise<void> {
  try {
    await writeAuditLog({
      organizationId,
      businessId: pm.businessId,
      action: "customer.payment_method_orphaned_at_gateway",
      resourceType: "customer",
      resourceId: pm.customerId,
      before: { payment_method: pm.publicId, status: "vaulted" },
      after: {
        payment_method: pm.publicId,
        provider: pm.providerKey,
        provider_customer_id: pm.providerCustomerId,
        provider_payment_method_id: pm.providerPaymentMethodId,
        mandate_rail: pm.mandateRail,
        mandate_status: pm.mandateStatus,
        // The actionable half: what an operator must do, and where.
        still_chargeable_at_gateway: true,
        remedy:
          gatewayDefinition(pm.providerKey)?.orphanedInstrumentRemedy ??
          "Remove the instrument in the provider dashboard.",
        reason,
      },
    });
  } catch (e) {
    log.warn("could not record an orphaned gateway instrument in the audit log", {
      pm: pm.publicId,
      error: String(e),
    });
  }
}

export async function detachPaymentMethod(
  organizationId: string,
  customerId: string,
  pmPublicId: string,
): Promise<boolean> {
  // Read first: the provider ids are needed to delete upstream, and they are gone
  // once the row is deleted.
  const [existing] = await withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(paymentMethods)
      .where(
        and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, pmPublicId)),
      )
      .limit(1),
  );
  if (!existing) return false;

  await deleteAtGateway(organizationId, existing);

  return withTenant(organizationId, async (tx) => {
    const deleted = await tx
      .delete(paymentMethods)
      .where(
        and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, pmPublicId)),
      )
      .returning({
        id: paymentMethods.id,
        publicId: paymentMethods.publicId,
        businessId: paymentMethods.businessId,
      });
    if (deleted.length > 0) {
      await emitEvent(tx, {
        organizationId,
        businessId: deleted[0]!.businessId,
        type: "payment_source_deleted",
        data: buildEventData("payment_source_deleted", { id: deleted[0]!.publicId }),
      });
      const owner = await auditOwner(tx, customerId);
      if (owner) {
        // `after: null` on both keys — the instrument is gone, and the row is the
        // only remaining record that it ever existed. Hence the label: once the
        // gateway delete above succeeds, nothing else can tell you which card this
        // was. Also written when erasure calls this in a loop, on purpose: an
        // instrument removed as part of a GDPR clear is still a removal someone
        // needs to be able to reconcile, and brand + last4 are not personal data.
        await writeAuditLog(
          {
            organizationId,
            businessId: owner.businessId,
            action: "customer.remove_payment_method",
            resourceType: "customer",
            resourceId: owner.publicId,
            before: {
              payment_method: existing.publicId,
              card: cardLabel(existing),
              role: existing.role,
            },
            after: { payment_method: null, card: null, role: null },
          },
          tx,
        );
      }
    }
    return deleted.length > 0;
  });
}

/**
 * Attach an instrument that already lives in a gateway vault (a permanent token), without
 * re-vaulting it — the path for bringing cards/mandates across from another billing
 * system on the SAME gateway account.
 *
 * The gateway is asked first (`fetchVaultedPaymentMethod`): an unknown token, or one owned
 * by a different gateway customer, is refused rather than stored. The gateway customer
 * must agree with this customer's existing mapping on that account, and must not already
 * belong to another of our customers; with no mapping yet, one is recorded. The row is then
 * written by `persistVaultedPaymentMethod`, the single writer every vault flow uses.
 */
export async function attachVaultedPaymentMethod(input: {
  organizationId: string;
  businessId: string;
  customer: typeof customers.$inferSelect;
  providerPaymentMethodId: string;
  providerCustomerId?: string;
  gatewayAccountId?: string;
  /** When given, must match the type the gateway reports. */
  type?: string;
}): Promise<typeof paymentMethods.$inferSelect> {
  const accounts = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(
          eq(gatewayAccounts.businessId, input.businessId),
          input.gatewayAccountId
            ? eq(gatewayAccounts.publicId, input.gatewayAccountId)
            : eq(gatewayAccounts.status, "active"),
        ),
      ),
  );
  if (input.gatewayAccountId && accounts.length === 0)
    throw new PaymentMethodConfigError(
      `We could not find the gateway account ${input.gatewayAccountId}.`,
    );
  if (!input.gatewayAccountId && accounts.length !== 1)
    throw new PaymentMethodConfigError(
      accounts.length === 0
        ? "No active gateway account on this business"
        : `This business has ${accounts.length} active gateway accounts. Pass gateway_account to select the account that holds this instrument.`,
    );
  const account = accounts[0]!;
  const provider = resolveAdapter(account);
  if (!provider.fetchVaultedPaymentMethod)
    throw new PaymentMethodConfigError(
      `${provider.key} cannot confirm an existing instrument, so you cannot attach a permanent token to it`,
    );
  const [mapping] = await withTenant(input.organizationId, (tx) =>
    tx
      .select()
      .from(providerCustomers)
      .where(
        and(
          eq(providerCustomers.customerId, input.customer.id),
          eq(providerCustomers.providerKey, provider.key),
          eq(providerCustomers.gatewayAccountId, account.id),
        ),
      )
      .limit(1),
  );
  const providerCustomerId = input.providerCustomerId ?? mapping?.providerCustomerId;
  if (!providerCustomerId)
    throw new PaymentMethodConfigError(
      "gateway_customer_id is required. This customer has no gateway customer on that account yet.",
    );
  if (mapping && mapping.providerCustomerId !== providerCustomerId)
    throw new PaymentMethodConfigError(
      `This customer is already gateway customer ${mapping.providerCustomerId} on that account`,
    );
  const [otherOwner] = await withTenant(input.organizationId, (tx) =>
    tx
      .select({ customerId: providerCustomers.customerId })
      .from(providerCustomers)
      .where(
        and(
          eq(providerCustomers.gatewayAccountId, account.id),
          eq(providerCustomers.providerCustomerId, providerCustomerId),
        ),
      )
      .limit(1),
  );
  if (otherOwner && otherOwner.customerId !== input.customer.id)
    throw new PaymentMethodConfigError(
      `Gateway customer ${providerCustomerId} belongs to another customer`,
    );

  let ref: Awaited<ReturnType<NonNullable<PaymentProvider["fetchVaultedPaymentMethod"]>>>;
  try {
    ref = await provider.fetchVaultedPaymentMethod({
      providerCustomerId,
      providerPaymentMethodId: input.providerPaymentMethodId,
    });
  } catch (e) {
    throw new PaymentMethodVaultError(provider.key, e);
  }
  if (!ref)
    throw new PaymentMethodConfigError(
      `${provider.key} has no instrument ${input.providerPaymentMethodId} for gateway customer ${providerCustomerId}`,
    );
  // The account's off-session debits need an e-mandate reference a permanent token does
  // not carry; refused until mandates can be attached too.
  if (ref.requiresPerDebitMandate)
    throw new PaymentMethodConfigError(
      `This ${provider.key} account needs an e-mandate reference for off-session charges. A permanent token has no e-mandate reference. Add the payment method through a setup flow instead.`,
    );
  if (input.type && ref.display.type !== input.type)
    throw new PaymentMethodConfigError(
      `The gateway reports this instrument as ${ref.display.type}, not ${input.type}`,
    );

  if (!mapping) {
    await withTenant(input.organizationId, (tx) =>
      tx
        .insert(providerCustomers)
        .values({
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: input.customer.id,
          providerKey: provider.key,
          gatewayAccountId: account.id,
          providerCustomerId,
        })
        .onConflictDoNothing(),
    );
  }
  return persistVaultedPaymentMethod({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customer: input.customer,
    vaulted: { ...ref, providerCustomerId },
    gatewayAccountId: account.id,
    providerCustomerId,
  });
}

/** A payment method something still depends on — delete_local refuses it (409). */
export class PaymentMethodInUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentMethodInUseError";
  }
}

/**
 * Remove OUR record of a payment method and leave the gateway's copy alone.
 *
 * Refused while a live subscription names it as its payment method, or a payment
 * against it is still pending. The instrument stays chargeable at the gateway, so that
 * is written to the audit log (`recordOrphanedAtGateway`) the same way a failed gateway
 * delete is.
 */
export async function deletePaymentMethodLocally(
  organizationId: string,
  customerId: string,
  pmPublicId: string,
): Promise<boolean> {
  const removed = await withTenant(organizationId, async (tx) => {
    const [pm] = await tx
      .select()
      .from(paymentMethods)
      .where(
        and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, pmPublicId)),
      )
      .for("update")
      .limit(1);
    if (!pm) return null;
    const [sub] = await tx
      .select({ publicId: subscriptions.publicId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.defaultPaymentMethodId, pm.id),
          isNull(subscriptions.deletedAt),
          sql`${subscriptions.status} <> 'cancelled'`,
        ),
      )
      .limit(1);
    if (sub)
      throw new PaymentMethodInUseError(
        `Subscription ${sub.publicId} pays with ${pm.publicId}. Change its payment method first.`,
      );
    const [pending] = await tx
      .select({ publicId: payments.publicId })
      .from(payments)
      .where(
        and(
          eq(payments.paymentMethodId, pm.id),
          inArray(payments.status, ["pending", "requires_action"]),
        ),
      )
      .limit(1);
    if (pending)
      throw new PaymentMethodInUseError(
        `Payment ${pending.publicId} on ${pm.publicId} is still pending`,
      );

    await tx.delete(paymentMethods).where(eq(paymentMethods.id, pm.id));
    await emitEvent(tx, {
      organizationId,
      businessId: pm.businessId,
      type: "payment_source_deleted",
      data: buildEventData("payment_source_deleted", { id: pm.publicId }, null, {
        deleted_locally: true,
      }),
    });
    const owner = await auditOwner(tx, customerId);
    if (owner) {
      await writeAuditLog(
        {
          organizationId,
          businessId: owner.businessId,
          action: "customer.remove_payment_method",
          resourceType: "customer",
          resourceId: owner.publicId,
          before: { payment_method: pm.publicId, card: cardLabel(pm), role: pm.role },
          after: { payment_method: null, card: null, role: null, local_only: true },
        },
        tx,
      );
    }
    return pm;
  });
  if (!removed) return false;
  // After the commit: the entry must not describe a delete that rolled back.
  await recordOrphanedAtGateway(organizationId, removed, "deleted locally (delete_local)");
  return true;
}
