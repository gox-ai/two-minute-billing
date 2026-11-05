import type { ReactNode } from "react";
import Link from "next/link";
import { getCustomer, listPaymentMethods, listSubscriptions } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import { listMeters } from "@/lib/api/meters";
import {
  getAutoTopup,
  getCreditRunway,
  listAutoTopupRuns,
  listSpendLimits,
  listUsageAlertStates,
  listUsageAlerts,
  type AlertStateSubject,
  type AlertThresholdState,
  type UsageAlert,
} from "@/lib/api/usage-controls";
import { DEFAULT_PRIORITY, resolveCreditConfig, type CreditConfigInput } from "@/lib/credits";
import { businessTz } from "@/lib/business-tz-server";
import { accountHolderName } from "@/lib/names";
import { instrumentLabel } from "@/lib/instrument-label";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { allows, requirePermission } from "@/lib/session";
import {
  ALERT_KIND_LABEL,
  ALERT_STATE_LABEL,
  ALERT_STATE_TONE,
  DISABLED_REASON_LABEL,
  INTERVAL_SHORT,
  RUN_STATUS_LABEL,
  coverHours,
  runwayLabel,
  scheduleLabel,
  thresholdLabel,
  topupLeadInputs,
} from "@/lib/usage-controls";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/states";
import { Facts, RecordCard, Row, Zone } from "@/components/patterns/record-page";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { Alert } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AutoTopupButton,
  AutoTopupToggle,
  ConfirmActionButton,
  CreateAlertButton,
  CreateSpendLimitButton,
  EditSpendLimitButton,
} from "@/components/usage-controls/controls";
import {
  deleteSpendLimitAction,
  deleteUsageAlertAction,
} from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";

export const dynamic = "force-dynamic";

/** The weekly "threshold too low" notice is current for 7 days. */
const withinAWeek = (at: string | null) =>
  at != null && Date.now() - new Date(at).getTime() < 7 * 86_400_000;

/**
 * Customer → Usage controls (design G5 § 5): runway, spend limits, alerts with each
 * threshold's state, and automatic top-up with its runs. Each card degrades on its own.
 */
export default async function CustomerUsageControlsPage({
  params,
}: {
  params: Promise<{ biz: string; cus: string }>;
}) {
  const { biz, cus } = await params;
  const me = await requirePermission("usage_controls:view", "manager");
  const canManage = allows(me, "usage_controls:manage", "manager");

  let customer, business;
  try {
    [customer, business] = await Promise.all([getCustomer(biz, cus), getBusiness(biz)]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Usage controls" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const tz = await businessTz(biz);
  const currency = (
    customer.effective_currency ??
    customer.currency ??
    business?.default_currency ??
    "USD"
  ).toUpperCase();
  const config = resolveCreditConfig(
    (business as { credit_config?: CreditConfigInput } | undefined)?.credit_config,
  );

  const [limits, alerts, runway, topup, runs, subs, meters, pms] = await Promise.all([
    listSpendLimits(biz, cus).catch(() => null),
    listUsageAlerts(biz, { customer: cus }).catch(() => null),
    getCreditRunway(biz, cus, currency).catch(() => undefined),
    getAutoTopup(biz, cus, currency).catch(() => undefined),
    listAutoTopupRuns(biz, cus).catch(() => null),
    listSubscriptions(biz, cus, { limit: 100 }).catch(() => null),
    listMeters(biz).catch(() => null),
    listPaymentMethods(biz, cus).catch(() => null),
  ]);
  const alertStates = new Map<string, AlertStateSubject[] | null>();
  await Promise.all(
    (alerts?.data ?? []).map(async (a) => {
      const s = await listUsageAlertStates(biz, a.id, cus).catch(() => null);
      alertStates.set(a.id, s?.data ?? null);
    }),
  );

  const base = `/businesses/${biz}/customers/${cus}`;
  const name = accountHolderName(customer) ?? cus;
  const loadError = (what: string) => (
    <Alert tone="error">We could not load the {what}. Reload the page.</Alert>
  );
  const propertyKeys = [
    ...new Set((meters?.data ?? []).flatMap((m) => m.limit_dimensions ?? [])),
  ].sort();
  const subscriptionOptions = (subs?.data ?? [])
    .filter((s) => s.status !== "cancelled")
    .map((s) => {
      const plan = s.items?.find((i) => i.product_kind === "plan") ?? s.items?.[0];
      return { value: s.id, label: plan?.product_name ? `${plan.product_name} · ${s.id}` : s.id };
    });
  const meterOptions = (meters?.data ?? [])
    .filter((m) => m.status === "active")
    .map((m) => ({ value: m.id, label: m.name }));

  return (
    <>
      <PageHeader
        title="Usage controls"
        description={`Spend limits, alerts and automatic top-up for ${name}.`}
        breadcrumbs={[
          { label: business?.name ?? biz, href: `/businesses/${biz}` },
          { label: "Customers", href: `/businesses/${biz}/customers` },
          { label: name, href: base },
          { label: "Usage controls" },
        ]}
      />

      <Zone title="Credit">
        <Row span="6/6">
          <RecordCard id="runway" title="Credit runway" meta="An estimate">
            {runway === undefined ? (
              loadError("runway")
            ) : runway === null ? (
              <p className="m-0 text-sm text-muted-foreground">
                No credit in {currency}.{" "}
                <Link href={`${base}/credits`} className="text-primary hover:underline">
                  View credits
                </Link>
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <span className="text-2xl font-semibold tabular-nums">
                  {runwayLabel(runway.runway_days)}
                </span>
                <Facts
                  rows={[
                    { label: "Balance", value: money(runway.balance_minor, runway.currency) },
                    {
                      label: "Usage per day (last 7 days)",
                      value:
                        runway.burn_minor_per_day != null
                          ? money(runway.burn_minor_per_day, runway.currency)
                          : "—",
                    },
                    runway.runs_out_at
                      ? { label: "Runs out on about", value: fmtDate(runway.runs_out_at, tz) }
                      : null,
                    runway.auto_topup_minor > 0
                      ? {
                          label: "Automatic top-up can still add this month",
                          value: money(runway.auto_topup_minor, runway.currency),
                        }
                      : null,
                  ]}
                />
              </div>
            )}
          </RecordCard>
          <RecordCard
            id="auto-topup"
            title="Automatic top-up"
            meta={currency}
            actions={
              canManage && topup !== undefined ? (
                <>
                  {topup ? (
                    <AutoTopupToggle
                      biz={biz}
                      cus={cus}
                      currency={currency}
                      on={topup.status === "active"}
                    />
                  ) : null}
                  <AutoTopupButton
                    biz={biz}
                    cus={cus}
                    currency={currency}
                    config={topup}
                    paymentMethods={(pms?.data ?? [])
                      .filter((p) => !p.status || p.status === "active")
                      .map((p) => ({ value: p.id, label: instrumentLabel(p) }))}
                    {...topupLeadInputs(topup ?? null, runway?.burn_minor_per_day ?? null)}
                    limits={config.top_up_limits[currency] ?? null}
                    defaultTaxTreatment={config.default_tax_treatment}
                    defaultPriority={DEFAULT_PRIORITY}
                  />
                </>
              ) : null
            }
          >
            {topup === undefined ? (
              loadError("automatic top-up")
            ) : topup === null ? (
              <p className="m-0 text-sm text-muted-foreground">
                Automatic top-up is not set up for {currency}.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusChip status={topup.status === "active" ? "active" : "disabled"} />
                  {topup.disabled_reason ? (
                    <span className="text-sm text-muted-foreground">
                      {DISABLED_REASON_LABEL[topup.disabled_reason] ?? topup.disabled_reason}
                    </span>
                  ) : null}
                </div>
                {topup.status === "active" && withinAWeek(topup.threshold_low_at) ? (
                  <Alert tone="warning">
                    Usage grew. The balance of {money(topup.threshold_minor ?? 0, currency)} no
                    longer covers the time from the notice to the charge, so credit can run out
                    before the top-up arrives. Set a higher balance.
                  </Alert>
                ) : null}
                <Facts
                  rows={[
                    {
                      label: "When",
                      value:
                        topup.trigger === "threshold"
                          ? `When the balance is ${money(topup.threshold_minor ?? 0, currency)}`
                          : scheduleLabel(topup.schedule),
                    },
                    topup.trigger === "threshold" &&
                    coverHours(topup.threshold_minor ?? 0, runway?.burn_minor_per_day) != null
                      ? {
                          label: "Covers",
                          value: `About ${coverHours(topup.threshold_minor ?? 0, runway?.burn_minor_per_day)} hours of usage at the current rate`,
                        }
                      : null,
                    {
                      label: "How much",
                      value:
                        topup.method === "fixed"
                          ? `Add ${money(topup.amount_minor ?? 0, currency)}`
                          : `Fill up to ${money(topup.target_minor ?? 0, currency)}`,
                    },
                    {
                      label: "Monthly limit",
                      value: money(topup.monthly_cap_minor, currency),
                    },
                    { label: "Top-ups per day", value: String(topup.max_runs_per_day) },
                  ]}
                />
              </div>
            )}
          </RecordCard>
        </Row>
        {runs?.data.length ? (
          <Row span="12">
            <RecordCard id="auto-topup-runs" title="Recent automatic top-ups" flush>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Created</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Charge on</TableHead>
                    <TableHead className="pr-5">Invoice</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="pl-5">{fmtDateTime(r.created_at, tz)}</TableCell>
                      <TableCell>
                        <Chip
                          tone={
                            r.status === "failed"
                              ? "red"
                              : r.status === "succeeded"
                                ? "green"
                                : "gray"
                          }
                        >
                          {RUN_STATUS_LABEL[r.status] ?? r.status}
                        </Chip>
                        {r.failure_message ? (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {r.failure_message}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(r.amount_minor, r.currency)}
                      </TableCell>
                      <TableCell>
                        {r.charge_after ? fmtDateTime(r.charge_after, tz) : "—"}
                      </TableCell>
                      <TableCell className="pr-5">
                        {r.invoice ? (
                          <Link
                            href={`/businesses/${biz}/invoices/${r.invoice}`}
                            className="text-primary hover:underline"
                          >
                            {r.invoice}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </RecordCard>
          </Row>
        ) : null}
      </Zone>

      <Zone title="Spend limits">
        <Row span="12">
          <RecordCard
            id="spend-limits"
            title="Spend limits"
            meta="Rated usage before tax and credit"
            flush
            actions={
              canManage ? (
                <CreateSpendLimitButton
                  biz={biz}
                  cus={cus}
                  currency={currency}
                  subscriptions={subscriptionOptions}
                  propertyKeys={propertyKeys}
                />
              ) : null
            }
          >
            {!limits ? (
              <div className="px-5 py-4">{loadError("spend limits")}</div>
            ) : limits.data.length === 0 ? (
              <EmptyState
                title="No spend limits"
                description="Usage has no limit for this customer."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Applies to</TableHead>
                    <TableHead className="text-right">Limit</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead>At the limit</TableHead>
                    <TableHead>Set by</TableHead>
                    <TableHead className="pr-5" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {limits.data.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="pl-5">
                        {l.scope === "customer"
                          ? "All usage"
                          : l.scope === "subscription"
                            ? `Subscription ${l.subscription}`
                            : `${l.property_key} = ${l.property_value ?? "each value"}`}
                      </TableCell>
                      <TableCell className="text-right">
                        {money(l.effective_amount_minor, l.currency)} {INTERVAL_SHORT[l.interval]}
                        {l.effective_amount_minor !== l.amount_minor ? (
                          <div className="text-xs text-muted-foreground">
                            Limit tier · set to {money(l.amount_minor, l.currency)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {l.spent_minor != null ? (
                          <div className="flex items-center justify-end gap-2">
                            {l.reached ? (
                              <Chip tone={l.mode === "hard" ? "red" : "tan"}>Reached</Chip>
                            ) : null}
                            {money(l.spent_minor, l.currency)}
                          </div>
                        ) : (
                          <span title="Each value has its own spend">—</span>
                        )}
                      </TableCell>
                      <TableCell>{l.mode === "hard" ? "Stop requests" : "Notify"}</TableCell>
                      <TableCell>{l.set_by === "customer" ? "Customer" : "You"}</TableCell>
                      <TableCell className="pr-5 text-right">
                        {canManage && l.set_by === "operator" ? (
                          <div className="flex justify-end gap-2">
                            <EditSpendLimitButton biz={biz} cus={cus} limit={l} />
                            <ConfirmActionButton
                              action={deleteSpendLimitAction}
                              fields={{ biz, cus, id: l.id }}
                              label="Delete"
                              title="Delete this spend limit?"
                              description="Usage is no longer limited by it. You cannot undo this."
                              confirmLabel="Delete limit"
                              destructive
                            />
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Alerts">
        <Row span="12">
          <RecordCard
            id="alerts"
            title="Alerts"
            meta="Each threshold fires once per period"
            actions={
              canManage ? (
                <CreateAlertButton
                  biz={biz}
                  customer={cus}
                  meters={meterOptions}
                  currencies={[currency]}
                />
              ) : null
            }
          >
            {!alerts ? (
              loadError("alerts")
            ) : alerts.data.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">No alerts for this customer.</p>
            ) : (
              <div className="flex flex-col gap-4">
                {alerts.data.map((a) => (
                  <AlertBlock
                    key={a.id}
                    alert={a}
                    states={alertStates.get(a.id) ?? null}
                    tz={tz}
                    action={
                      canManage && a.scope === "customer" ? (
                        <ConfirmActionButton
                          action={deleteUsageAlertAction}
                          fields={{ biz, cus, id: a.id }}
                          label="Delete"
                          title="Delete this alert?"
                          description="Its thresholds stop firing. You cannot undo this."
                          confirmLabel="Delete alert"
                          destructive
                        />
                      ) : null
                    }
                  />
                ))}
              </div>
            )}
          </RecordCard>
        </Row>
      </Zone>
    </>
  );
}

/** One alert and the state of each of its thresholds, per subject, this period. */
function AlertBlock({
  alert,
  states,
  tz,
  action,
}: {
  alert: UsageAlert;
  states: AlertStateSubject[] | null;
  tz: string;
  action: ReactNode;
}) {
  const cur = alert.currency;
  const lastValue = (v: number | string | null, unit: AlertThresholdState["unit"]) =>
    v == null ? "—" : typeof v === "string" ? v : thresholdLabel({ value: v, unit }, cur);
  return (
    <div className="flex flex-col gap-2 rounded-md bg-muted/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{ALERT_KIND_LABEL[alert.kind]}</span>
        {alert.interval ? (
          <span className="text-sm text-muted-foreground">{INTERVAL_SHORT[alert.interval]}</span>
        ) : null}
        {alert.scope === "plan" ? <Chip>From the plan</Chip> : null}
        {alert.email ? <Chip>Email</Chip> : null}
        <div className="ml-auto">{action}</div>
      </div>
      {states === null ? (
        <p className="m-0 text-sm text-muted-foreground">
          Thresholds: {alert.thresholds.map((t) => thresholdLabel(t, cur)).join(", ")}. We could not
          load their state.
        </p>
      ) : (
        states.map((subject) => (
          <div key={subject.subscription ?? "customer"} className="flex flex-col gap-1">
            {subject.subscription ? (
              <span className="text-xs text-muted-foreground">
                Subscription {subject.subscription}
              </span>
            ) : null}
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Threshold</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Last value</TableHead>
                  <TableHead>Fired</TableHead>
                  <TableHead>Resets</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {subject.thresholds.map((s) => (
                  <TableRow key={`${s.value}-${s.unit}`}>
                    <TableCell>{thresholdLabel({ value: s.value, unit: s.unit }, cur)}</TableCell>
                    <TableCell>
                      <Chip tone={ALERT_STATE_TONE[s.state]}>{ALERT_STATE_LABEL[s.state]}</Chip>
                      {s.resolve_reason === "period_ended" ? (
                        <span className="ml-2 text-xs text-muted-foreground">Period ended</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">{lastValue(s.last_value, s.unit)}</TableCell>
                    <TableCell>{s.triggered_at ? fmtDateTime(s.triggered_at, tz) : "—"}</TableCell>
                    <TableCell>{s.resets_at ? fmtDate(s.resets_at, tz) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))
      )}
    </div>
  );
}
