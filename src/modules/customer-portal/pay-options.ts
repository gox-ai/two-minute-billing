import { effectiveMethodTypes, listGatewayAccounts } from "@/modules/gateway/service";
import { handlesCurrency } from "@/modules/gateway/router";
import {
  listPaymentMethods,
  listVaultGatewaysForBusiness,
} from "@/modules/payment-methods/service";
import { mandateRefusal, type Pm } from "@/modules/invoicing/collection";
import { debitNeedsBuyerAuthentication } from "@/modules/payment-methods/mandate-afa";
import { formatMoney } from "@/platform/currency";
import { resolveAdapter } from "@/providers/registry";
import {
  ON_FILE_CONSENT_TEXT_VERSION,
  onFileConsentText,
} from "@/modules/payment-methods/on-file-consent";

/**
 * How a saved method pays an invoice from the portal's Pay now.
 *
 * `now`: the adapter charges the stored instrument with the buyer present (`createIntent`
 * with a `paymentMethod`; the bank's check opens when it asks).
 * `debit`: the gateway can only debit it through its mandate, so it settles later (the
 * India pre-debit notice, a bank debit's clearing time).
 *
 * Only gateways whose saved-method charge was proven in their sandbox are listed.
 * CyberSource's adapter charges a saved method too, but merchants cannot connect it yet.
 */
const PAYS_NOW: ReadonlySet<string> = new Set([
  "stripe",
  "braintree",
  "adyen",
  "checkoutcom",
  "square",
  "authorizenet",
  // A vaulted PayPal method authorizes with no redirect (sandbox, 2026-11-18).
  "paypal",
  "tmtest",
]);
/** India mandate rails: a 24-hour pre-debit notice comes first. */
const INDIA_DEBIT: ReadonlySet<string> = new Set(["razorpay", "cashfree", "payu"]);
/** Bank debits that clear over days. */
const BANK_DEBIT: ReadonlySet<string> = new Set(["gocardless", "mollie"]);

export type SavedPayKind = "now" | "debit";

export interface SavedPayOption {
  payment_method: string;
  /** For the row label: what the portal's method list shows. */
  type: string;
  brand: string | null;
  last4: string | null;
  mandate_rail: string | null;
  primary: boolean;
  kind: SavedPayKind;
  /** False: shown disabled, with `reason`. */
  available: boolean;
  /** Why it cannot pay this invoice (buyer words). */
  reason: string | null;
  /** What happens when it pays (buyer words), e.g. when the money is taken. */
  hint: string | null;
}

export interface NewPayOption {
  /** gwa_… — the account we picked; the buyer never picks a gateway. */
  gateway_account: string;
  /** The rail this row pays with (`card`, `upi`, `paypal`, `us_bank_account`…). One row each. */
  method: string;
  /** `[method]`: the gateway's form is pinned to this rail. Collect with `method_type` = it. */
  method_types: string[] | null;
  /**
   * Pay and save (`portal_save_new_method`): `offer` = a box the buyer ticks, `always` = saved
   * with this text shown. Null: this row pays without saving (the setting is `never`, or the
   * gateway cannot save while it charges).
   */
  save: {
    mode: "offer" | "always";
    /** The box starts ticked: the buyer has no working saved method. */
    checked: boolean;
    text: string;
    text_version: string;
  } | null;
}

export interface PayOptions {
  saved: SavedPayOption[];
  new_methods: NewPayOption[];
}

/** The gateway family a saved method pays through, or null when Pay now cannot use it. */
export function savedPayKind(providerKey: string): SavedPayKind | null {
  if (PAYS_NOW.has(providerKey)) return "now";
  if (INDIA_DEBIT.has(providerKey) || BANK_DEBIT.has(providerKey)) return "debit";
  return null;
}

function expiredBefore(pm: Pm, now: Date): boolean {
  if (!pm.expMonth || !pm.expYear) return false;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return pm.expYear < y || (pm.expYear === y && pm.expMonth < m);
}

/**
 * Whether one saved method can pay `amountMinor` of `currency` now, and how. Shared by the
 * pay-options list and the collect route, so the list never offers what the charge refuses.
 */
export function savedPayOption(
  pm: Pm,
  amountMinor: bigint,
  currency: string,
  now = new Date(),
): SavedPayOption | null {
  const kind = savedPayKind(pm.providerKey);
  if (!kind) return null;
  const base = {
    payment_method: pm.publicId,
    type: pm.type,
    brand: pm.brand,
    last4: pm.last4,
    mandate_rail: pm.mandateRail ?? null,
    primary: pm.role === "primary",
    kind,
    available: false,
    hint: null,
  };
  if (pm.status === "expired" || expiredBefore(pm, now)) {
    const when =
      pm.expMonth && pm.expYear
        ? ` at the end of ${String(pm.expMonth).padStart(2, "0")}/${String(pm.expYear).slice(-2)}`
        : "";
    return { ...base, reason: `This card expired${when}. You cannot pay with it.` };
  }
  if (pm.status === "pending_verification")
    return {
      ...base,
      reason: "This payment method is waiting for verification. You cannot pay with it yet.",
    };
  if (pm.status !== "valid" && pm.status !== "expiring")
    return { ...base, reason: "We cannot charge this payment method. Use a different one." };
  if (kind === "now")
    return {
      ...base,
      available: true,
      reason: null,
      hint:
        pm.expMonth && pm.expYear
          ? `Expires ${String(pm.expMonth).padStart(2, "0")}/${String(pm.expYear).slice(-2)}`
          : null,
    };

  // A mandate debit: its ceiling, then RBI's per-debit approval above ₹15,000.
  if (mandateRefusal(pm, amountMinor, currency)) {
    const cap =
      pm.mandateMaxAmountMinor != null
        ? ` is ${formatMoney(pm.mandateMaxAmountMinor, pm.mandateCurrency ?? currency)}`
        : " is below this amount";
    return {
      ...base,
      reason: `The auto-debit limit of this payment method${cap}. You cannot pay this invoice with it.`,
    };
  }
  if (debitNeedsBuyerAuthentication(pm, currency, amountMinor))
    return {
      ...base,
      reason:
        "Your bank must approve each automatic payment of this amount. Use a new card or netbanking.",
    };
  return {
    ...base,
    available: true,
    reason: null,
    hint: INDIA_DEBIT.has(pm.providerKey)
      ? "Taken in about 1 day. Your bank sends you a notice first."
      : "Your bank takes some days to complete the payment.",
  };
}

/**
 * Pay now's step 1 for one invoice: the buyer's saved methods (primary first) and the new
 * ones to start, with the gateway already picked.
 *
 * One new-method row per rail across every account. Gateway pick for a rail: (1) it takes
 * the currency and the rail, (2) it holds the buyer's primary method, (3) the business
 * default, (4) the first by setup order.
 */
export async function payOptionsFor(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  defaultGatewayAccountId: string | null;
  amountMinor: bigint;
  currency: string;
  /** `storefront_config.portal_save_new_method`. */
  saveNewMethod: "offer" | "always" | "never";
  businessName: string;
  /** Try again after a gateway-side failure: route each rail elsewhere when possible. */
  avoidGatewayAccount?: string | null;
  /** The business routing for this currency (Settings → Gateways), when set. */
  routing?: { order: string[]; gateways: Record<string, string> } | null;
  /** gwa_… this customer's new methods go to (customer page), ahead of the routing. */
  customerGateway?: string | null;
}): Promise<PayOptions> {
  const [methods, accounts, listed] = await Promise.all([
    listPaymentMethods(input.organizationId, input.customerId),
    listGatewayAccounts(input.organizationId, input.businessId),
    listVaultGatewaysForBusiness(input.organizationId, input.businessId, input.currency, "payment"),
  ]);
  const accById = new Map(accounts.map((a) => [a.id, a]));
  // Setup order, oldest first, and the rails each account really offers for this currency
  // (the same answer Add card gets from `/payment_methods/gateways`).
  const created = new Map(accounts.map((a) => [a.publicId, a.createdAt.getTime()]));
  const gateways = [...listed]
    .sort((a, b) => (created.get(a.id) ?? 0) - (created.get(b.id) ?? 0))
    .map((g) => ({ ...g, methodTypes: effectiveMethodTypes(g, input.currency, "payment") }));

  const ordered = [...methods]
    .filter((m) => m.role !== "none")
    .sort((a, b) => Number(b.role === "primary") - Number(a.role === "primary"));
  const saved: SavedPayOption[] = [];
  for (const pm of ordered) {
    const acc = pm.gatewayAccountId ? accById.get(pm.gatewayAccountId) : undefined;
    // Its own account must still be live and take this currency: charges follow the vault.
    if (!acc || acc.status !== "active" || !handlesCurrency(acc, input.currency)) continue;
    const opt = savedPayOption(pm, input.amountMinor, input.currency);
    if (opt) saved.push(opt);
  }

  const primaryAcc = ordered.find((m) => m.role === "primary")?.gatewayAccountId;
  const primaryPublic = primaryAcc ? accById.get(primaryAcc)?.publicId : undefined;
  const defaultPublic = input.defaultGatewayAccountId
    ? accById.get(input.defaultGatewayAccountId)?.publicId
    : undefined;
  const accByPublic = new Map(accounts.map((a) => [a.publicId, a]));
  const hasWorking = saved.some((o) => o.available);
  const saveFor = (gwa: string, method: string): NewPayOption["save"] => {
    if (input.saveNewMethod === "never") return null;
    const acc = accByPublic.get(gwa);
    let savesOn: string[] = [];
    try {
      savesOn = acc
        ? ((resolveAdapter(acc).capabilities.paymentSavesMethod ?? []) as string[])
        : [];
    } catch {
      return null;
    }
    if (!savesOn.includes(method)) return null;
    return {
      mode: input.saveNewMethod,
      checked: input.saveNewMethod === "always" || !hasWorking,
      text: onFileConsentText(input.businessName),
      text_version: ON_FILE_CONSENT_TEXT_VERSION,
    };
  };

  /**
   * One row per way to pay, across every account (the buyer selects a method, never a
   * gateway). Each rail goes to one account: the buyer's primary account, then the business
   * default, then the oldest that offers it. `avoidGatewayAccount` (Try again after a
   * gateway-side failure) moves a rail to another account when one offers it.
   */
  const railsOf = (g: (typeof gateways)[number]): string[] =>
    g.gatewayKey === "paypal" ? ["paypal"] : (g.methodTypes ?? ["card"]);
  const rails: string[] = [];
  for (const g of gateways) for (const m of railsOf(g)) if (!rails.includes(m)) rails.push(m);
  // The business's order for this currency (India: UPI first); unlisted rails after, card first.
  const order = input.routing?.order ?? [];
  const rank = (m: string) => {
    const i = order.indexOf(m);
    return i >= 0 ? i : order.length + (m === "card" ? 0 : 1);
  };
  rails.sort((a, b) => rank(a) - rank(b));

  // What an account has turned on at its gateway, where the adapter can say (Stripe ACH and
  // SEPA need activating). Unknown: offered, as before.
  const activeCache = new Map<string, Promise<string[] | null>>();
  const activeOn = (gwa: string): Promise<string[] | null> => {
    let hit = activeCache.get(gwa);
    if (!hit) {
      const acc = accByPublic.get(gwa);
      hit = (async () => {
        try {
          return acc ? ((await resolveAdapter(acc).activeMethodTypes?.()) ?? null) : null;
        } catch {
          return null;
        }
      })();
      activeCache.set(gwa, hit);
    }
    return hit;
  };

  const newMethods: NewPayOption[] = [];
  for (const m of rails) {
    let offering = [];
    for (const g of gateways) {
      if (!railsOf(g).includes(m)) continue;
      const active = await activeOn(g.id);
      if (!active || active.includes(m)) offering.push(g);
    }
    const elsewhere = offering.filter((g) => g.id !== input.avoidGatewayAccount);
    if (elsewhere.length) offering = elsewhere;
    const g =
      offering.find((x) => x.id === input.customerGateway) ??
      offering.find((x) => x.id === input.routing?.gateways[m]) ??
      offering.find((x) => x.id === primaryPublic) ??
      offering.find((x) => x.id === defaultPublic) ??
      offering[0];
    if (!g) continue;
    newMethods.push({
      gateway_account: g.id,
      method: m,
      method_types: [m],
      save: saveFor(g.id, m),
    });
  }
  return { saved, new_methods: newMethods };
}
