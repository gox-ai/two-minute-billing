/**
 * Gateway router (C2 / GW-2).
 *
 * Picks the gateway account to charge for a given (currency × method type ×
 * purpose), with **no silent fallback**. If nothing matches the
 * currency we raise `no_gateway_for_currency`; if several match and there is no
 * per-business default we raise `ambiguous_gateway`.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { gatewayAccounts, businesses } from "@db/schema";
import { createLogger } from "@/platform/logger";
import {
  gatewayAllowsPurpose,
  gatewaySupportsCurrency,
  internationalAllows,
} from "@/providers/gateway-catalog";
import type { IntentPurpose } from "@/providers/types";

const log = createLogger("gateway");

type GatewayAccount = typeof gatewayAccounts.$inferSelect;

export type GatewayRouterErrorCode =
  | "no_gateway_for_currency"
  | "ambiguous_gateway"
  | "gateway_not_found"
  | "gateway_disabled";

export class GatewayRouterError extends Error {
  code: GatewayRouterErrorCode;
  constructor(code: GatewayRouterErrorCode, message: string) {
    super(message);
    this.name = "GatewayRouterError";
    this.code = code;
  }
}

/**
 * `currencies == null` means "every currency the gateway takes" (its catalogue list, or any
 * when it has none); an explicit list must name it, and is honoured as written.
 * Both sides are upper-cased so a row written in lower case still routes. Exported
 * because anything that OFFERS a gateway must use the same test the charge will apply
 * — otherwise a buyer is shown a rail the router then refuses.
 */
export function handlesCurrency(acc: GatewayAccount, currency: string): boolean {
  // "International payments" off: the domestic currency only, whatever the list says.
  if (!internationalAllows(acc, currency)) return false;
  if (acc.currencies == null) return gatewaySupportsCurrency(acc.gatewayKey, currency);
  const want = currency.toUpperCase();
  return acc.currencies.some((c) => c.toUpperCase() === want);
}

function handlesMethod(acc: GatewayAccount, methodType?: string): boolean {
  if (!methodType) return true;
  return acc.methodTypes == null || acc.methodTypes.includes(methodType);
}

/**
 * Resolve the gateway account for a charge.
 *
 * @param override — a gateway account public id to force (e.g. the account that
 *   vaulted the payment method). When set, that account is used if it exists,
 *   is active, and can handle the currency/method; otherwise a router error.
 * @param tokenBound — the override IS the account that vaulted the instrument, so it is
 *   the only account that can charge it. See the note in the override branch: `currencies`
 *   is a routing preference, and a token-bound charge has nothing to route.
 */
export async function selectGatewayAccount(
  tx: Tx,
  input: {
    businessId: string;
    currency: string;
    methodType?: string;
    override?: string | null;
    /**
     * The override is the VAULTING account, not a preference — nobody chose it and
     * nothing else can charge this token.
     */
    tokenBound?: boolean;
    /**
     * What the caller is about to do: take a payment now, or save a method. Accounts whose
     * gateway cannot do it are dropped before the default breaks a tie. Not applied to an
     * override: the intent guard refuses a pinned account by name. Absent = no filter
     * (off-session renewals keep the account that holds the token).
     */
    purpose?: IntentPurpose;
  },
): Promise<GatewayAccount> {
  // TL-6 charge-time guard: only accounts whose livemode matches the business.
  // (Create/update enforce this too, but the invariant must hold at charge time
  // regardless of how a row came to exist.)
  const [bizRow] = await tx
    .select({ livemode: businesses.livemode, def: businesses.defaultGatewayAccountId })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1);
  const active = (
    await tx
      .select()
      .from(gatewayAccounts)
      .where(
        and(eq(gatewayAccounts.businessId, input.businessId), eq(gatewayAccounts.status, "active")),
      )
  ).filter((a) => !bizRow || a.livemode === (bizRow.livemode === "live"));

  // Explicit override: the payment method's own vaulting account.
  if (input.override) {
    const acc = active.find((a) => a.publicId === input.override);
    if (!acc) {
      // Distinguish "doesn't exist / not active" from "wrong currency".
      const anyRow = await tx
        .select({ status: gatewayAccounts.status })
        .from(gatewayAccounts)
        .where(
          and(
            eq(gatewayAccounts.businessId, input.businessId),
            eq(gatewayAccounts.publicId, input.override),
          ),
        )
        .limit(1);
      if (anyRow[0])
        throw new GatewayRouterError(
          "gateway_disabled",
          `Gateway account ${input.override} is not active`,
        );
      throw new GatewayRouterError(
        "gateway_not_found",
        `Gateway account ${input.override} not found`,
      );
    }
    /**
     * `currencies` decides WHICH account to route to. A token-bound charge has nothing to
     * decide: the instrument lives in this account's vault and no other account can charge
     * it, so refusing does not pick a better account — it guarantees no charge at all, on a
     * renewal, into dunning. The gateway is the authority on what it will settle, and it
     * answers with a real decline code instead of our guess.
     *
     * This is what would have broken 32 migrated subscriptions: cards vaulted on a Stripe
     * account whose `currencies` did not list INR but which had been charging in INR for
     * years. Still WARNED — it is a real configuration signal, just not a veto.
     *
     * The check STAYS for a pinned account (`resolvePinnedAccount`): that pin arrives in a
     * PUBLIC request body, where "honour it but validate it" is a security control rather
     * than a routing preference.
     */
    if (!handlesCurrency(acc, input.currency)) {
      if (!input.tokenBound)
        throw new GatewayRouterError(
          "no_gateway_for_currency",
          `Gateway account ${input.override} does not handle ${input.currency}`,
        );
      log.warn("charging a token-bound account outside its declared currencies", {
        gatewayAccount: acc.publicId,
        gateway: acc.gatewayKey,
        currency: input.currency,
        declared: acc.currencies,
        impact: "ALLOWED: only this account can charge this token; the gateway decides",
      });
    }
    if (!handlesMethod(acc, input.methodType))
      throw new GatewayRouterError(
        "no_gateway_for_currency",
        `Gateway account ${input.override} does not handle method ${input.methodType}`,
      );
    return acc;
  }

  const handles = active.filter(
    (a) => handlesCurrency(a, input.currency) && handlesMethod(a, input.methodType),
  );
  const purpose = input.purpose;
  const matches = purpose
    ? handles.filter((a) => gatewayAllowsPurpose(a.gatewayKey, purpose, input.currency))
    : handles;
  if (matches.length === 0)
    throw new GatewayRouterError(
      "no_gateway_for_currency",
      `No active gateway account handles ${input.currency}${input.methodType ? ` / ${input.methodType}` : ""}` +
        (handles.length > 0 && purpose
          ? purpose === "payment"
            ? " for a payment now"
            : " to save a payment method"
          : ""),
    );
  if (matches.length === 1) return matches[0]!;

  // Ambiguous → require a per-business default that is itself a match.
  if (bizRow?.def) {
    const chosen = matches.find((a) => a.id === bizRow.def);
    if (chosen) return chosen;
  }
  throw new GatewayRouterError(
    "ambiguous_gateway",
    `More than one gateway account matches ${input.currency}. Set a default gateway account.`,
  );
}
