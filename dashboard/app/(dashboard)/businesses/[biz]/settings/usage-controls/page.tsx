import { listProducts } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import { listMeters } from "@/lib/api/meters";
import {
  getUsageWidgetSettings,
  listSpendLimitTiers,
  listUsageAlerts,
} from "@/lib/api/usage-controls";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import { money } from "@/lib/format";
import { allows, requirePermission } from "@/lib/session";
import { ALERT_KIND_LABEL, INTERVAL_SHORT, thresholdLabel } from "@/lib/usage-controls";
import { ErrorState } from "@/components/states";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import { Alert } from "@/components/ui/alert";
import { CopyButton } from "@/components/patterns/copy-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ConfirmActionButton,
  CreateAlertButton,
  CreateTierButton,
} from "@/components/usage-controls/controls";
import { WidgetOriginsForm } from "@/components/usage-controls/widget-origins-form";
import {
  deleteSpendLimitTierAction,
  deleteUsageAlertAction,
} from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";

export const dynamic = "force-dynamic";

/** Settings → Usage controls (design G5 § 5): limit tiers, plan alerts, the usage widget. */
export default async function UsageControlSettingsPage({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  const me = await requirePermission("usage_controls:view", "manager");
  const canManage = allows(me, "usage_controls:manage", "manager");

  let b;
  try {
    b = await getBusiness(biz);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  if (!b)
    return <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />;
  const currencies = businessCurrencyOptions(b) ?? [(b.default_currency ?? "USD").toUpperCase()];

  const [tiers, alerts, products, meters, widget] = await Promise.all([
    listSpendLimitTiers(biz).catch(() => null),
    listUsageAlerts(biz, {}).catch(() => null),
    listProducts(biz).catch(() => null),
    listMeters(biz).catch(() => null),
    getUsageWidgetSettings(biz).catch(() => null),
  ]);
  const productName = new Map((products?.data ?? []).map((p) => [p.id, p.name]));
  const planAlerts = (alerts?.data ?? []).filter((a) => a.scope === "plan");
  const loadError = (what: string) => (
    <Alert tone="error">We could not load the {what}. Reload the page.</Alert>
  );
  const snippet = widget?.script_url
    ? [
        `<script src="${widget.script_url}" integrity="${widget.script_integrity}" crossorigin="anonymous"></script>`,
        `<div data-usage-widget></div>`,
        `<script>`,
        `  UsageWidget.mount(document.querySelector("[data-usage-widget]"), {`,
        `    // Ask your backend for a token: POST /v1/businesses/${biz}/customers/<customer>/usage_widget_tokens`,
        `    getToken: () => fetch("/your-backend/usage-widget-token").then((r) => r.text()),`,
        `  });`,
        `</script>`,
      ].join("\n")
    : null;

  return (
    <SettingsPage
      title="Usage controls"
      crumbs={[
        { label: "Settings", href: `/businesses/${biz}/settings` },
        { label: "Usage controls" },
      ]}
      description="Limit tiers that raise customer spend limits as customers pay, alerts for every subscription to a plan, and the usage widget for your own app. Set limits and alerts for one customer on the customer's Usage controls page."
    >
      <SettingsCard
        id="tiers"
        title="Limit tiers"
        meta="Up to 10 per currency"
        actions={canManage ? <CreateTierButton biz={biz} currencies={currencies} /> : null}
      >
        {!tiers ? (
          <div className="px-5 py-4">{loadError("limit tiers")}</div>
        ) : tiers.data.length === 0 ? (
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
            No limit tiers. Customer limits stay as you set them.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Lifetime paid</TableHead>
                <TableHead>Customer limits</TableHead>
                <TableHead className="pr-5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tiers.data
                .filter((t) => t.active)
                .map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="pl-5">{money(t.level_minor, t.currency)}</TableCell>
                    <TableCell>
                      {(["day", "week", "month", "period"] as const)
                        .filter((k) => t.amounts[k] != null)
                        .map((k) => `${money(t.amounts[k]!, t.currency)} ${INTERVAL_SHORT[k]}`)
                        .join(" · ")}
                    </TableCell>
                    <TableCell className="pr-5 text-right">
                      {canManage ? (
                        <ConfirmActionButton
                          action={deleteSpendLimitTierAction}
                          fields={{ biz, id: t.id }}
                          label="Delete"
                          title="Delete this limit tier?"
                          description="Customers that reached it keep it. No new customer reaches it. You cannot undo this."
                          confirmLabel="Delete tier"
                          destructive
                        />
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>

      <SettingsCard
        id="plan-alerts"
        title="Plan alerts"
        meta="Every subscription to the plan, also new ones"
        actions={
          canManage ? (
            <CreateAlertButton
              biz={biz}
              products={(products?.data ?? [])
                .filter((p) => !p.kind || p.kind === "plan")
                .map((p) => ({ value: p.id, label: p.name }))}
              meters={(meters?.data ?? [])
                .filter((m) => m.status === "active")
                .map((m) => ({ value: m.id, label: m.name }))}
              currencies={currencies}
            />
          ) : null
        }
      >
        {!alerts ? (
          <div className="px-5 py-4">{loadError("alerts")}</div>
        ) : planAlerts.length === 0 ? (
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">No plan alerts.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Plan</TableHead>
                <TableHead>Watch</TableHead>
                <TableHead>Thresholds</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="pr-5" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {planAlerts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="pl-5">
                    {(a.product && productName.get(a.product)) ?? a.product}
                  </TableCell>
                  <TableCell>
                    {ALERT_KIND_LABEL[a.kind]}
                    {a.interval ? ` ${INTERVAL_SHORT[a.interval]}` : ""}
                  </TableCell>
                  <TableCell>
                    {a.thresholds.map((t) => thresholdLabel(t, a.currency)).join(", ")}
                  </TableCell>
                  <TableCell>{a.email ? "Yes" : "No"}</TableCell>
                  <TableCell className="pr-5 text-right">
                    {canManage ? (
                      <ConfirmActionButton
                        action={deleteUsageAlertAction}
                        fields={{ biz, id: a.id }}
                        label="Delete"
                        title="Delete this plan alert?"
                        description="Its thresholds stop firing for every subscription to the plan. You cannot undo this."
                        confirmLabel="Delete alert"
                        destructive
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>

      <SettingsCard
        id="widget"
        title="Usage widget"
        meta="Usage, balance and runway in your app"
        padded
      >
        {!widget ? (
          loadError("widget settings")
        ) : (
          <div className="flex flex-col gap-4">
            <p className="m-0 text-sm text-muted-foreground">
              Your backend creates a token for the signed-in customer. The token can only read that
              customer&apos;s usage, and stops working after 15 minutes. Only the origins below can
              show the data in a browser.
            </p>
            {canManage ? (
              <WidgetOriginsForm biz={biz} origins={widget.origins} />
            ) : (
              <p className="m-0 text-sm">
                {widget.origins.length ? widget.origins.join(", ") : "No origins."}
              </p>
            )}
            {snippet ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Snippet</span>
                  <CopyButton value={snippet} />
                </div>
                <pre className="m-0 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
                  {snippet}
                </pre>
              </div>
            ) : (
              <Alert tone="info">
                The script address is not available because the API&apos;s public URL is not set.
              </Alert>
            )}
          </div>
        )}
      </SettingsCard>
    </SettingsPage>
  );
}
