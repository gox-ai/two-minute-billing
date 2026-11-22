// Where a NEW payment method goes, per currency: the rows the portal shows and the account
// each one picks. Mirrors the engine's `/portal/v1/payment_methods/gateways` (method_routes)
// and `effectiveMethodTypes`; keep the two in step. Pure: safe on the server and the client.
import {
  gatewayAllowsPurpose,
  gatewayDefinition,
  gatewaySupportsCurrency,
  gatewayTakesCurrency,
  internationalAllows,
} from "../../src/providers/gateway-catalog";
import { METHOD_CURRENCY } from "../../src/providers/method-types";
import { paymentMethodTypeLabel } from "@/lib/filter-options";
import type { GatewayCatalogEntry } from "@/components/gateways/gateway-meta";

export interface RoutingAccount {
  id: string;
  gateway_key: string;
  label: string;
  status: "active" | "disabled";
  currencies: string[] | null;
  method_types: string[] | null;
  international_enabled?: boolean | null;
  created_at: string;
}

export type PaymentRouting = Record<string, { order: string[]; gateways: Record<string, string> }>;

export interface RoutingRow {
  method: string;
  label: string;
  /** Accounts that offer the method in this currency: the default first, then oldest. */
  options: Array<{ id: string; label: string }>;
  /** The account a new method of this kind goes to now. */
  selected: string;
}

export interface RoutingGroup {
  currency: string;
  rows: RoutingRow[];
}

/** As the router's `handlesCurrency`. */
function takesCurrency(a: RoutingAccount, currency: string): boolean {
  if (
    !internationalAllows(
      { gatewayKey: a.gateway_key, internationalEnabled: a.international_enabled },
      currency,
    )
  )
    return false;
  if (a.currencies == null) return gatewaySupportsCurrency(a.gateway_key, currency);
  return a.currencies.some((c) => c.toUpperCase() === currency);
}

/** As `effectiveMethodTypes(row, currency)`, with the catalogue's live-proof flag. */
function methodsFor(
  a: RoutingAccount,
  currency: string,
  catalog: readonly GatewayCatalogEntry[],
): string[] {
  if (a.gateway_key === "paypal") return ["paypal"];
  const def = gatewayDefinition(a.gateway_key);
  const can: readonly string[] = def?.advertisedMethods ?? ["card"];
  const entry = catalog.find((g) => g.key === a.gateway_key);
  const offered = (m: string) =>
    entry?.method_types.find((x) => x.value === m)?.available !== false;
  const base = (a.method_types ? a.method_types.filter((m) => can.includes(m)) : [...can]).filter(
    offered,
  );
  if (!gatewayTakesCurrency(a.gateway_key, currency)) return [];
  const bound = (m: string) => METHOD_CURRENCY[m] ?? def?.currencyBoundMethods?.[m] ?? null;
  return base.filter((m) => (bound(m) ?? currency) === currency);
}

function methodName(
  method: string,
  gatewayKey: string,
  catalog: readonly GatewayCatalogEntry[],
): string {
  return (
    catalog.find((g) => g.key === gatewayKey)?.method_types.find((m) => m.value === method)
      ?.label ?? paymentMethodTypeLabel(method)
  );
}

/**
 * The currencies to show: the business's own plus every currency an account lists. An
 * account open to any currency adds none (Stripe alone would add a hundred groups).
 */
export function routingCurrencies(
  accounts: readonly RoutingAccount[],
  businessCurrencies: readonly string[] | null | undefined,
  defaultCurrency?: string | null,
): string[] {
  const set = new Set(
    [
      ...(defaultCurrency ? [defaultCurrency] : []),
      ...(businessCurrencies ?? []),
      ...accounts.filter((a) => a.status === "active").flatMap((a) => a.currencies ?? []),
    ].map((c) => c.toUpperCase()),
  );
  return [...set].sort();
}

/** Active accounts that save a method in `currency`: the default first, then oldest. */
export function accountsForCurrency(
  accounts: readonly RoutingAccount[],
  currency: string,
  defaultId: string | null,
): RoutingAccount[] {
  return accounts
    .filter(
      (a) =>
        a.status === "active" &&
        takesCurrency(a, currency) &&
        (gatewayAllowsPurpose(a.gateway_key, "setup", currency) ||
          gatewayAllowsPurpose(a.gateway_key, "payment", currency)),
    )
    .sort(
      (a, b) =>
        Number(b.id === defaultId) - Number(a.id === defaultId) ||
        a.created_at.localeCompare(b.created_at),
    );
}

/** One group per currency, rows in the portal's order, each with its effective account. */
export function buildRoutingGroups(input: {
  accounts: readonly RoutingAccount[];
  catalog: readonly GatewayCatalogEntry[];
  currencies: readonly string[];
  defaultId: string | null;
  stored: PaymentRouting | null | undefined;
}): RoutingGroup[] {
  const groups: RoutingGroup[] = [];
  for (const currency of input.currencies) {
    const accs = accountsForCurrency(input.accounts, currency, input.defaultId);
    const rails: string[] = [];
    const offering = new Map<string, RoutingAccount[]>();
    for (const a of accs)
      for (const m of methodsFor(a, currency, input.catalog)) {
        if (!rails.includes(m)) rails.push(m);
        offering.set(m, [...(offering.get(m) ?? []), a]);
      }
    if (rails.length === 0) continue;
    const route = input.stored?.[currency];
    const order = route?.order ?? [];
    const rank = (m: string) => {
      const i = order.indexOf(m);
      return i >= 0 ? i : order.length + (m === "card" ? 0 : 1);
    };
    rails.sort((a, b) => rank(a) - rank(b));
    groups.push({
      currency,
      rows: rails.map((m) => {
        const list = offering.get(m) ?? [];
        const chosen = list.find((a) => a.id === route?.gateways[m]) ?? list[0]!;
        return {
          method: m,
          label: methodName(m, chosen.gateway_key, input.catalog),
          options: list.map((a) => ({ id: a.id, label: a.label })),
          selected: chosen.id,
        };
      }),
    });
  }
  return groups;
}

/**
 * What the business routing picks for a currency, as one label: the account's name when
 * every row goes to one account, else each method with its account.
 */
export function routingSummary(group: RoutingGroup | undefined): string | null {
  if (!group || group.rows.length === 0) return null;
  const name = (r: RoutingRow) => r.options.find((o) => o.id === r.selected)?.label ?? r.selected;
  const names = new Set(group.rows.map(name));
  if (names.size === 1) return [...names][0]!;
  return group.rows.map((r) => `${r.label}: ${name(r)}`).join(", ");
}
