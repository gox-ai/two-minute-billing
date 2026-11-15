import Link from "next/link";
import { getCustomer } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import {
  getCreditBalance,
  listCreditGrants,
  listCreditHolds,
  listCreditTransactions,
  listCreditUnits,
  type CreditTransactionFilters,
} from "@/lib/api/credits";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { businessTz } from "@/lib/business-tz-server";
import { accountHolderName } from "@/lib/names";
import { money } from "@/lib/format";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import { allows, requirePermission } from "@/lib/session";
import {
  CATEGORY_LABEL,
  CREDIT_HOLDS_MANAGE,
  POLICY_LABEL,
  POLICY_SOURCE_LABEL,
  SOURCE_LABEL,
  txnKindLabel,
  balanceView,
  fmtUnits,
  hasMoneyValue,
  heldUnsettledRows,
  holdAmount,
  holdLeaseLines,
  movementCells,
  unitCount,
  resolveCreditConfig,
  unitInfo,
  type CreditConfigInput,
  type CustomerCreditSettings,
  grantStatusKey,
} from "@/lib/credits";
import { PageHeader } from "@/components/page-header";
import { ErrorState, EmptyState } from "@/components/states";
import { Facts, RecordCard, Row, Zone } from "@/components/patterns/record-page";
import { StatusChip } from "@/components/patterns/chip";
import { IdText, MiddleEllipsis } from "@/components/patterns/id-text";
import { Alert } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { GiveCreditButton } from "@/components/credits/give-credit-dialog";
import {
  CustomerCreditSettingsButton,
  ReleaseHoldButton,
  VoidGrantButton,
} from "@/components/credits/credit-row-actions";
import { CreditTransactionFiltersForm } from "@/components/credits/credit-transaction-filters";
import { CustomerUnitLimits } from "@/components/credits/customer-unit-limits";

export const dynamic = "force-dynamic";

type Search = {
  grant?: string;
  kind?: string;
  category?: string;
  unit?: string;
  invoice?: string;
  created_from?: string;
  created_to?: string;
  after?: string;
};

/** An override with no end date, or one that ends in the future. */
const stillLive = (iso?: string | null) => !iso || Date.parse(iso) > Date.now();

const toUnix = (iso?: string) => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? String(Math.floor(t / 1000)) : undefined;
};

/**
 * Customer → Credits (design G3 § 7): live balance, grants, open holds and every movement.
 * Each section degrades on its own, so one failed read does not hide the others.
 */
export default async function CustomerCreditsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string; cus: string }>;
  searchParams: Promise<Search>;
}) {
  const { biz, cus } = await params;
  const sp = await searchParams;
  const me = await requirePermission("credits:view", "manager");
  const canManage = allows(me, "credits:manage", "ops");
  const canGivePaid = allows(me, ["credits:manage", "invoices:manage"], "ops");
  const canRelease = allows(me, CREDIT_HOLDS_MANAGE, "ops");

  let customer, business;
  try {
    [customer, business] = await Promise.all([getCustomer(biz, cus), getBusiness(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Credits" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const tz = await businessTz(biz);
  const config = resolveCreditConfig(
    (business as { credit_config?: CreditConfigInput } | undefined)?.credit_config,
  );
  const settings =
    (customer as { credit_settings?: CustomerCreditSettings | null }).credit_settings ?? null;
  const currencies = business
    ? (businessCurrencyOptions(business) ?? [(business.default_currency ?? "USD").toUpperCase()])
    : ["USD"];
  const custCurrency = (
    customer.effective_currency ??
    customer.currency ??
    business?.default_currency ??
    "USD"
  ).toUpperCase();

  const filters: CreditTransactionFilters = {
    grant: sp.grant || undefined,
    kind: sp.kind || undefined,
    category: sp.category || undefined,
    unit: sp.unit || undefined,
    invoice: sp.invoice || undefined,
    created_gte: toUnix(sp.created_from),
    created_lt: toUnix(sp.created_to),
    starting_after: sp.after || undefined,
  };
  const [units, balances, grants, holds, txns] = await Promise.all([
    listCreditUnits(biz).catch(() => null),
    getCreditBalance(biz, cus).catch(() => null),
    listCreditGrants(biz, cus).catch(() => null),
    listCreditHolds(biz, cus).catch(() => null),
    listCreditTransactions(biz, cus, filters).catch(() => null),
  ]);
  const unitList = units?.data ?? [];
  const info = (key: string | null, currency: string) => unitInfo(unitList, key, currency);
  const base = `/businesses/${biz}/customers/${cus}`;
  const name = accountHolderName(customer) ?? cus;

  const loadError = (what: string) => (
    <Alert tone="error">We could not load the {what}. Reload the page.</Alert>
  );

  const view = balances
    ? balanceView({ ...balances, grants_minor: balances.balance.grants_minor }, (key) =>
        info(key, balances.currency),
      )
    : null;
  const moneyLead = view?.lead !== "units";
  // A page of movements in units with no rate has no money to show.
  const showValue = hasMoneyValue((txns?.data ?? []).map((t) => info(t.unit, t.currency)));

  const overrideActive = !!settings?.on_exhausted && stillLive(settings.override_expires_at);

  return (
    <>
      <PageHeader
        title="Credits"
        description={`Credit that ${name} can use for usage, and each movement of it.`}
        breadcrumbs={[
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Customers", href: `/businesses/${biz}/customers` },
          { label: name, href: base },
          { label: "Credits" },
        ]}
        actions={
          canManage ? (
            <GiveCreditButton
              biz={biz}
              cus={cus}
              units={unitList.filter((u) => u.status === "active")}
              currencies={business ? businessCurrencyOptions(business) : null}
              defaultCurrency={custCurrency}
              canGivePaid={canGivePaid}
              blockingEnabled={config.blocking_enabled}
              defaultTaxTreatment={config.default_tax_treatment}
            />
          ) : null
        }
      />

      <Zone title="Balance">
        <Row span="8/4">
          <RecordCard
            id="balance"
            title="Available credit"
            meta="Credit left after unbilled usage and open holds"
          >
            {!balances || !view ? (
              loadError("balance")
            ) : (
              <div className="flex flex-col gap-3">
                {view.lead === "units" ? (
                  // Only credit with no money value: lead with it, not with a money figure of 0.
                  view.unrated.map((u) => (
                    <div
                      key={u.unit.key}
                      className="flex flex-wrap items-baseline justify-between gap-2"
                    >
                      <span className="text-sm font-medium">Available {u.unit.plural}</span>
                      <span className="text-2xl font-semibold tabular-nums">
                        {unitCount(u.units, u.unit)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-medium">{balances.currency}</span>
                    <span className="text-2xl font-semibold tabular-nums">
                      {money(balances.available_minor, balances.currency)}
                    </span>
                  </div>
                )}
                <Facts
                  rows={[
                    moneyLead && {
                      label: "Credit left",
                      value: money(balances.balance.grants_minor, balances.currency),
                    },
                    (moneyLead || balances.balance.unbilled_usage_minor !== 0) && {
                      label: "Unbilled usage that credit pays",
                      value: money(-balances.balance.unbilled_usage_minor || 0, balances.currency),
                    },
                    (moneyLead || balances.balance.open_holds_minor !== 0) && {
                      label: "Open holds",
                      value: money(-balances.balance.open_holds_minor || 0, balances.currency),
                    },
                    balances.balance.overdraft_limit_minor
                      ? {
                          label: "Overdraft limit",
                          value: `+${money(balances.balance.overdraft_limit_minor, balances.currency)}`,
                        }
                      : null,
                    // "left", as "Credit left": this figure does not take money holds off.
                    ...(moneyLead ? view.rated : []).map(({ unit, units }) => ({
                      label: `${unit.plural.charAt(0).toUpperCase()}${unit.plural.slice(1)} left`,
                      value: fmtUnits(units, unit),
                    })),
                    // Led by units: what the figures above do not count yet.
                    ...(moneyLead ? [] : view.unrated.flatMap((r) => heldUnsettledRows(r, r.unit))),
                    {
                      label: "When credit is used up",
                      value: [
                        `${POLICY_LABEL[balances.on_exhausted.policy]}.`,
                        POLICY_SOURCE_LABEL[balances.on_exhausted.source],
                      ]
                        .filter(Boolean)
                        .join(" "),
                    },
                  ]}
                />
                {moneyLead ? (
                  <p className="m-0 text-xs text-muted-foreground">
                    In the currency of the customer&apos;s subscriptions. Usage that credit does not
                    cover goes on the invoice. The invoice shows the final amounts.
                  </p>
                ) : (
                  <p className="m-0 text-xs text-muted-foreground">
                    This credit has no money value.
                  </p>
                )}
                {moneyLead && view.unrated.length > 0 ? (
                  // Outside the money block: these units are not part of the figure above.
                  <div className="flex flex-col gap-2 border-t pt-3">
                    <span className="text-xs text-muted-foreground">
                      Credit with no money value
                    </span>
                    <Facts
                      rows={view.unrated.flatMap((r) => [
                        { label: `Available ${r.unit.plural}`, value: fmtUnits(r.units, r.unit) },
                        ...heldUnsettledRows(r, r.unit),
                      ])}
                    />
                  </div>
                ) : null}
              </div>
            )}
          </RecordCard>
          <RecordCard
            id="credit-settings"
            title="Settings for this customer"
            actions={
              canManage ? (
                <CustomerCreditSettingsButton
                  biz={biz}
                  cus={cus}
                  settings={settings}
                  currencies={currencies}
                  blockingEnabled={config.blocking_enabled}
                  businessOverdraft={config.overdraft_limit_minor}
                />
              ) : null
            }
          >
            <Facts
              rows={[
                {
                  label: "Blocking",
                  value: config.blocking_enabled ? "On for the business" : "Off for the business",
                },
                config.blocking_enabled && {
                  label: "Override",
                  value: overrideActive
                    ? `${POLICY_LABEL[settings!.on_exhausted!]}${settings!.override_expires_at ? ` until ${fmtDate(settings!.override_expires_at, tz)}` : ""}`
                    : "None",
                },
                config.blocking_enabled &&
                  currencies.length > 0 && {
                    label: "Overdraft limit",
                    value: currencies
                      .map((c) =>
                        money(
                          settings?.overdraft_limit_minor?.[c] ??
                            config.overdraft_limit_minor[c] ??
                            0,
                          c,
                        ),
                      )
                      .join(" · "),
                  },
              ]}
            />
          </RecordCard>
        </Row>
        <CustomerUnitLimits biz={biz} cus={cus} tz={tz} canManage={canManage} />
      </Zone>

      <Zone title="Credit">
        <RecordCard id="grants" title="Credit grants" flush>
          {!grants ? (
            <div className="px-5 py-4">{loadError("credit grants")}</div>
          ) : grants.data.length === 0 ? (
            <EmptyState
              title={canManage ? `Give ${name} credit` : "No credit grants"}
              description={
                canManage
                  ? "Give credit by hand, sell a credit pack, or add credits to a plan price."
                  : "Credit grants for this customer show here."
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Grant</TableHead>
                    <TableHead>Category</TableHead>
                    {/* A labelled line on a phone: as the aside it repeated the title's amount. */}
                    <TableHead className="text-right">Remaining</TableHead>
                    <TableHead className="text-right">Cost basis</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="pr-5" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {grants.data.map((g) => {
                    const u = info(g.unit, g.currency);
                    return (
                      <TableRow key={g.id}>
                        <TableCell className="pl-5">
                          {/* Status and the used-up policy sit inside other cells: nine
                              columns overflowed the card at 1440 px. */}
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{fmtUnits(g.amount, u)}</span>
                            <StatusChip status={grantStatusKey(g.status, g.remaining.units)} />
                          </div>
                          <Link
                            href={`?grant=${g.id}#transactions`}
                            className="block max-w-56 text-primary hover:underline"
                          >
                            <MiddleEllipsis value={g.id} className="text-xs" />
                          </Link>
                          <Link
                            href={`/businesses/${biz}/customers/${cus}/credits/grants/${g.id}`}
                            className="block text-xs text-primary hover:underline"
                            aria-label={`View activity of the grant of ${fmtUnits(g.amount, u)}`}
                          >
                            View activity
                          </Link>
                        </TableCell>
                        <TableCell>
                          {CATEGORY_LABEL[g.category]}
                          {g.tax_treatment ? (
                            <div className="text-xs text-muted-foreground">
                              {g.tax_treatment === "taxed_at_use"
                                ? "Taxed at use"
                                : "Taxed at purchase"}
                            </div>
                          ) : null}
                          {config.blocking_enabled && g.on_exhausted ? (
                            <div className="text-xs text-muted-foreground">
                              When used up: {POLICY_LABEL[g.on_exhausted]}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtUnits(g.remaining.units, u)}
                          {g.unit && u.rated !== false ? (
                            <div className="text-xs text-muted-foreground">
                              {money(g.remaining.face_minor, g.currency)}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(g.cost_basis_minor, g.currency)}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {g.expires_at ? fmtDate(g.expires_at, tz) : "Never"}
                        </TableCell>
                        <TableCell>
                          {SOURCE_LABEL[g.source] ?? g.source}
                          {g.invoice ? (
                            <Link
                              href={`/businesses/${biz}/invoices/${g.invoice}`}
                              className="block font-mono text-xs text-primary hover:underline"
                            >
                              {g.invoice}
                            </Link>
                          ) : null}
                        </TableCell>
                        <TableCell className="pr-5 text-right">
                          {canManage && g.status === "active" && g.remaining.units > 0 ? (
                            <VoidGrantButton
                              biz={biz}
                              cus={cus}
                              grant={g.id}
                              remaining={fmtUnits(g.remaining.units, u)}
                              paid={g.category !== "promotional"}
                            />
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </RecordCard>

        <RecordCard
          id="holds"
          title="Open holds"
          meta="Amounts that the app reserved before a call. They count against the balance until it captures or releases them."
          flush
        >
          {!holds ? (
            <div className="px-5 py-4">{loadError("holds")}</div>
          ) : holds.data.length === 0 ? (
            <p className="m-0 px-5 py-4 text-sm text-muted-foreground">No open holds.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table phone="stack">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Hold</TableHead>
                    <TableHead phone="aside" className="text-right">
                      Amount
                    </TableHead>
                    <TableHead>Meter</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="pr-5" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {holds.data.map((h) => (
                    <TableRow key={h.id}>
                      <TableCell className="pl-5">
                        <IdText id={h.id} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {/* A lease that captured a step: what is left, then its steps. */}
                        {holdLeaseLines(h, unitList).length ? (
                          <>
                            {holdAmount(h, unitList)} left
                            {holdLeaseLines(h, unitList).map((l) => (
                              <div key={l} className="text-xs text-muted-foreground">
                                {l}
                              </div>
                            ))}
                          </>
                        ) : (
                          holdAmount(h, unitList, { ofTotal: true })
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="font-mono text-xs">{h.meter ?? "—"}</span>
                      </TableCell>
                      <TableCell className="wrap-anywhere whitespace-normal">
                        <span className="font-mono text-xs">
                          {h.scope && Object.keys(h.scope).length
                            ? Object.entries(h.scope)
                                .map(([k, v]) => `${k}=${v}`)
                                .join(", ")
                            : "—"}
                        </span>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {fmtDateTime(h.expires_at, tz)}
                      </TableCell>
                      <TableCell className="pr-5 text-right">
                        {canRelease ? (
                          <ReleaseHoldButton
                            biz={biz}
                            hold={h.id}
                            amount={holdAmount(h, unitList)}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </RecordCard>

        <RecordCard id="transactions" title="Transactions" flush>
          <div className="border-b px-5 py-4">
            <CreditTransactionFiltersForm
              units={[
                { value: "money", label: "Money" },
                ...unitList.map((u) => ({ value: u.id, label: u.plural_name })),
              ]}
              values={sp}
            />
          </div>
          {!txns ? (
            <div className="px-5 py-4">{loadError("transactions")}</div>
          ) : txns.data.length === 0 ? (
            <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
              No transactions match the filters.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table phone="stack">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">Date</TableHead>
                      <TableHead>Movement</TableHead>
                      <TableHead>Grant</TableHead>
                      <TableHead phone="aside" className="text-right">
                        Units
                      </TableHead>
                      {showValue ? <TableHead className="text-right">Value</TableHead> : null}
                      <TableHead className="pr-5">Invoice</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {txns.data.map((t) => {
                      const u = info(t.unit, t.currency);
                      const cells = movementCells(t.units, t.face_minor, u);
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="pl-5 tabular-nums">
                            {fmtDateTime(t.created_at, tz)}
                          </TableCell>
                          <TableCell>
                            {txnKindLabel(t)}
                            <div className="text-xs text-muted-foreground">
                              {CATEGORY_LABEL[t.category]}
                            </div>
                          </TableCell>
                          <TableCell>
                            <span className="font-mono text-xs">{t.grant}</span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{cells.units}</TableCell>
                          {showValue ? (
                            <TableCell className="text-right tabular-nums">{cells.value}</TableCell>
                          ) : null}
                          <TableCell className="pr-5">
                            {t.invoice ? (
                              <Link
                                href={`/businesses/${biz}/invoices/${t.invoice}`}
                                className="font-mono text-xs text-primary hover:underline"
                              >
                                {t.invoice}
                              </Link>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {txns.has_more && txns.next_cursor ? (
                <div className="border-t px-5 py-3 text-center">
                  <Link
                    href={`?${new URLSearchParams({
                      ...Object.fromEntries(
                        Object.entries(sp).filter(([k, v]) => k !== "after" && v),
                      ),
                      after: txns.next_cursor,
                    })}#transactions`}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    Show older transactions
                  </Link>
                </div>
              ) : null}
            </>
          )}
        </RecordCard>
      </Zone>
    </>
  );
}
