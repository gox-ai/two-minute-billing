import { listCustomers, listInvoices, listPrices, listSubscriptions } from "@/lib/api";
import { signupGatewayKey, signupGatewayName } from "@/lib/signup-gateway";
import { listGatewayAccounts, type GatewayAccount } from "@/lib/api/gateways";

/**
 * What actually has to be true before this business can bill anyone.
 *
 * ── WHY THIS LIST AND NOT A LONGER ONE ─────────────────────────────────────────
 * Derived from the engine's own refusals, not from a tour of the settings screens. The
 * temptation is to list everything a thorough operator would configure — tax, email sending,
 * brand, invoice numbering — and that produces a checklist that NAGS about things which do not
 * block a single rupee. Money is stopped by exactly three things:
 *
 *   - `GatewayRouterError('no_gateway_for_currency')` — no ACTIVE gateway account handles the
 *     currency the business prices in (`routeGatewayAccount`, gateway/router.ts).
 *   - `GatewayRouterError('ambiguous_gateway')` — several accounts match and no business
 *     default is set. This one is invisible from the settings screen: you connect two gateways
 *     and charging still fails until you pick one.
 *   - No price at all. A plan (recurring) bills a subscription; a charge (one-time) bills a
 *     sale. Either is enough: a business that sells only one-time is ready without a plan.
 *
 * Plus a customer, and a first bill of any kind (subscription or invoice). Tax and email are
 * quality of the invoice, not permission to raise one, so they are deliberately absent.
 *
 * ⚠️ `handlesCurrency` is MIRRORED from `src/modules/gateway/router.ts` (null = every
 * currency, otherwise case-insensitive membership). Duplicated logic drifts, so if the engine's
 * rule changes this must follow — the alternative is a readiness endpoint, which is the right
 * answer the day this list grows.
 */
export interface SetupStep {
  id: "gateway" | "gateway_default" | "price" | "customer" | "subscription";
  label: string;
  /** Why it blocks, in the operator's words. Only shown while the step is outstanding. */
  detail: string;
  href: string;
  cta: string;
  /** A second way to finish the step, shown as a quieter button. */
  alt?: { href: string; cta: string };
  done: boolean;
}

/** One cookie per business: closing the checklist on one business leaves the others alone. */
export const setupHiddenCookie = (biz: string) => `tmb_setup_hidden_${biz}`;

/** Mirrors `handlesCurrency` in `src/modules/gateway/router.ts`. */
function handlesCurrency(account: GatewayAccount, currency: string): boolean {
  if (account.currencies == null) return true;
  const want = currency.toUpperCase();
  return account.currencies.some((c) => c.toUpperCase() === want);
}

export async function resolveSetupSteps(
  biz: string,
  /** The business's own pricing currency — what the router will be asked to charge in. */
  currency: string,
  opts: {
    livemode: "live" | "test";
    /** The gateway named at sign-up; the gateway step names it and opens its form. */
    signupGateway?: string | null;
  } = { livemode: "live" },
): Promise<SetupStep[]> {
  const base = `/businesses/${biz}`;
  /**
   * Three cheap reads in parallel. Gateway accounts and prices are bounded lists (the `ui`
   * skill's own classification), and customers is a `limit: 1` probe read for its `total` — a
   * real `count(*)`, never a page length.
   *
   * Each soft-fails to "outstanding": a checklist that vanishes because a call failed would
   * report a half-configured business as ready, which is the one wrong answer here.
   */
  const [accounts, prices, customers, subscriptions, invoices] = await Promise.all([
    listGatewayAccounts(biz).catch(() => null),
    listPrices(biz).catch(() => null),
    listCustomers(biz, { limit: 1 }).catch(() => null),
    listSubscriptions(biz, undefined, { limit: 1 }).catch(() => null),
    listInvoices(biz, undefined, { limit: 1 }).catch(() => null),
  ]);
  // Named only while the step is open: once done, a test mode's built-in gateway may be the
  // account that settled it, not the one given at sign-up.
  const open = !(accounts?.data ?? []).some(
    (a) => a.status === "active" && handlesCurrency(a, currency),
  );
  const gatewayName = open ? signupGatewayName(opts.signupGateway) : null;
  const gatewayKey = open ? signupGatewayKey(opts.signupGateway) : null;
  const test = opts.livemode === "test";

  const active = (accounts?.data ?? []).filter((a) => a.status === "active");
  const matching = active.filter((a) => handlesCurrency(a, currency));
  // `ambiguous_gateway` only bites when SEVERAL match and none is the business default. One
  // matching account routes on its own, so this step must not appear then.
  const ambiguous = matching.length > 1 && !matching.some((a) => a.default);
  const priced = (prices?.data ?? []).some((p) => p.active !== false);
  const billed = (subscriptions?.total ?? 0) > 0 || (invoices?.total ?? 0) > 0;

  return [
    {
      id: "gateway",
      label: gatewayName
        ? `Connect ${gatewayName} to charge in ${currency}`
        : `Connect a gateway that charges ${currency}`,
      detail: `Nothing can be charged until an active gateway account settles in ${currency}.`,
      href: `${base}/settings/gateways/new${gatewayKey ? `?gateway=${gatewayKey}` : ""}`,
      cta: gatewayName ? `Connect ${gatewayName}` : "Add gateway",
      done: matching.length > 0,
    },
    {
      id: "gateway_default",
      label: "Select the default gateway account",
      detail: `${matching.length} accounts can charge ${currency}. We refuse every charge as ambiguous until one account is the default.`,
      href: `${base}/settings/gateways`,
      cta: "Select default",
      done: !ambiguous,
    },
    {
      id: "price",
      label: "Create a price",
      detail: "A plan bills a subscription. A charge bills a one-time sale. You need one of them.",
      href: `${base}/catalog/plans/new`,
      cta: "Create plan",
      alt: { href: `${base}/catalog/charges/new`, cta: "Create charge" },
      done: priced,
    },
    {
      id: "customer",
      label: "Create a customer",
      detail: "Create a customer to bill.",
      href: `${base}/customers/new`,
      cta: "Create customer",
      done: (customers?.total ?? 0) > 0,
    },
    {
      id: "subscription",
      label: test ? "Bill a test customer" : "Bill your first customer",
      detail: test
        ? "Create a subscription, or send a payment link for a one-time sale. Nothing here bills a real customer."
        : "Create a subscription, or send a payment link for a one-time sale. This bills a real customer. To try it first, switch to test mode.",
      href: `${base}/subscriptions/new`,
      cta: "Create subscription",
      alt: { href: `${base}/catalog/payment_links`, cta: "View payment links" },
      done: billed,
    },
  ];
}
