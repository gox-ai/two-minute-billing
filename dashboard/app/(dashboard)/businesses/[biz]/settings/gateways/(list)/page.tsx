import Link from "next/link";
import { listBusinesses } from "@/lib/api";
import {
  listGatewayAccounts,
  getGatewayCatalogOrEmpty,
  type GatewayAccount,
  type GatewayCatalogEntry,
} from "@/lib/api/gateways";
import { gatewayEntry } from "@/components/gateways/gateway-meta";
import { requirePermission } from "@/lib/session";
import { ErrorState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { SettingsPage, type AttentionItem } from "@/components/settings/settings-layout";
import { GatewaysTable } from "@/components/gateways/gateways-table";

export const dynamic = "force-dynamic";

// In a route group so the list's skeleton does not preempt /new and /[gwa].
export default async function GatewaysPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("gateways:view", "admin");

  const crumbs = [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Payment gateways" },
  ];
  let businesses, accounts, catalog;
  try {
    [businesses, accounts, catalog] = await Promise.all([
      listBusinesses(),
      listGatewayAccounts(biz),
      getGatewayCatalogOrEmpty(),
    ]);
  } catch (e) {
    return (
      <SettingsPage title="Payment gateways" crumbs={crumbs}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }
  const b = businesses.data.find((x) => x.id === biz);
  const defaultId = accounts.data.find((r) => r.default)?.id ?? null;

  // Gate removed 2026-09-02 on our user's instruction (was a step-up, audit M3.3) — see PROGRESS.
  return (
    <SettingsPage
      title="Payment gateways"
      crumbs={crumbs}
      description="Gateway accounts charge cards and keep saved payment methods for this business."
      attention={ambiguity(
        biz,
        accounts.data,
        defaultId,
        b?.livemode === "live",
        b?.currencies,
        catalog,
      )}
    >
      <GatewaysTable
        biz={biz}
        rows={accounts.data}
        catalog={catalog}
        defaultId={defaultId}
        createHref={`/businesses/${biz}/settings/gateways/new`}
      />
    </SettingsPage>
  );
}

/**
 * Currencies where `selectGatewayAccount` would refuse a payment with
 * `ambiguous_gateway`: two or more active accounts take payments in it and the default is
 * not one of them. A setup-only gateway is routed past for a payment, so it does not count.
 * Charges pinned to a saved method's own account are not affected.
 */
function ambiguity(
  biz: string,
  rows: GatewayAccount[],
  defaultId: string | null,
  live: boolean,
  bizCurrencies: string[] | null | undefined,
  catalog: readonly GatewayCatalogEntry[],
): AttentionItem[] {
  // Without a catalogue entry, count the account: a missed warning is worse than an extra one.
  const paysNow = (a: GatewayAccount) =>
    gatewayEntry(catalog, a.gateway_key)?.intent_purposes?.includes("payment") ?? true;
  const active = rows.filter((r) => r.status === "active" && r.livemode === live && paysNow(r));
  if (active.length < 2) return [];
  // As the router: an account with no list takes what its gateway takes.
  const takes = (a: GatewayAccount, c: string) =>
    a.currencies == null
      ? (gatewayEntry(catalog, a.gateway_key)?.currencies?.includes(c) ?? true)
      : a.currencies.some((x) => x.toUpperCase() === c);
  const candidates = new Set(
    [...(bizCurrencies ?? []), ...active.flatMap((a) => a.currencies ?? [])].map((c) =>
      c.toUpperCase(),
    ),
  );
  const affected: string[] = [];
  let shared: GatewayAccount[] = [];
  for (const c of [...candidates].sort()) {
    const m = active.filter((a) => takes(a, c));
    if (m.length >= 2 && !m.some((a) => a.id === defaultId)) {
      affected.push(c);
      if (shared.length === 0) shared = m;
    }
  }
  // No currency known anywhere: accounts open to every currency still collide.
  if (candidates.size === 0) {
    const open = active.filter((a) => a.currencies == null);
    if (open.length >= 2 && !open.some((a) => a.id === defaultId)) shared = open;
  }
  if (shared.length === 0) return [];
  const which = affected.length ? affected.join(", ") : "any currency";
  const two = shared.length === 2;
  return [
    {
      key: "ambiguous-gateway",
      tone: "attention",
      title: `No default gateway for payments in ${which}`,
      detail: `${shared.map((a) => a.label).join(two ? " and " : ", ")} ${two ? "both" : "all"} take payments in ${which}, and ${two ? "neither" : "none"} is the default. So we refuse a new payment in ${which}, unless it is tied to the account of a saved payment method. Open the account to use and select “Set as default”.`,
      actions: (
        <>
          {shared.slice(0, 2).map((a) => (
            <Link
              key={a.id}
              href={`/businesses/${biz}/settings/gateways/${a.id}`}
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open {a.label}
            </Link>
          ))}
        </>
      ),
    },
  ];
}
