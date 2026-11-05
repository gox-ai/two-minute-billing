import { RecordCard } from "@/components/patterns/record-page";
import { Alert } from "@/components/ui/alert";
import { money } from "@/lib/format";
import { listUsageInvoiceThresholds } from "@/lib/api/usage-controls";
import type { Price } from "@/lib/api";
import { ConfirmActionButton } from "./controls";
import {
  PlanUsageThresholdButton,
  SubscriptionUsageThresholdButton,
} from "./usage-invoice-threshold-form";
import { removeUsageInvoiceThresholdAction } from "@/app/(dashboard)/businesses/[biz]/usage-controls-actions";

const PERIOD_END_MODELS = new Set(["volume"]);
const PERIOD_END_AGGREGATIONS = new Set(["last", "latest", "min", "avg"]);

/** Usage that can only bill at the end of the period (its amount can fall as usage grows). */
export function periodEndOnly(
  p: Pick<Price, "model"> & { usage_aggregation?: string | null; usage_recurring?: boolean | null },
) {
  return (
    PERIOD_END_MODELS.has(p.model) ||
    PERIOD_END_AGGREGATIONS.has(p.usage_aggregation ?? "") ||
    p.usage_recurring === true
  );
}

const NOTE =
  "Discounts and the minimum spend apply only on the invoice at the end of the period. Each early invoice shows the usage to date, the amount billed before and the amount of this invoice.";

/** Plan detail: "Invoice usage early", one amount per currency. */
export async function PlanUsageThresholdCard({
  biz,
  product,
  prices,
  canManage,
}: {
  biz: string;
  product: string;
  prices: Price[];
  canManage: boolean;
}) {
  const rows = await listUsageInvoiceThresholds(biz, { product }).catch(() => null);
  const metered = prices.filter((p) => p.metered && p.active !== false);
  const currencies = [...new Set(metered.map((p) => p.currency.toUpperCase()))];
  const late = metered.filter((p) => periodEndOnly(p as Parameters<typeof periodEndOnly>[0]));
  const returnTo = `/businesses/${biz}/catalog/products/${product}`;
  return (
    <RecordCard
      id="invoice-usage-early"
      title="Invoice usage early"
      actions={
        canManage && currencies.length ? (
          <PlanUsageThresholdButton
            biz={biz}
            product={product}
            currencies={currencies}
            returnTo={returnTo}
          />
        ) : null
      }
    >
      {!rows ? (
        <Alert tone="error">We could not load the setting. Reload the page.</Alert>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {rows.data.filter((r) => r.scope === "plan" && r.active).length === 0 ? (
            <p className="m-0 text-muted-foreground">
              Off. Usage is billed at the end of each period.
            </p>
          ) : (
            rows.data
              .filter((r) => r.scope === "plan" && r.active)
              .map((r) => (
                <div key={r.currency} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Invoice each time unbilled usage reaches{" "}
                    <span className="font-medium tabular-nums">
                      {money(r.amount_minor ?? 0, r.currency)}
                    </span>
                  </span>
                  {canManage ? (
                    <ConfirmActionButton
                      action={removeUsageInvoiceThresholdAction}
                      fields={{ biz, product, currency: r.currency, return_to: returnTo }}
                      label="Remove"
                      title="Stop invoicing usage early?"
                      description={`Subscriptions to this plan in ${r.currency} bill usage at the end of the period. Subscriptions with their own amount keep it.`}
                      confirmLabel="Remove"
                    />
                  ) : null}
                </div>
              ))
          )}
          <p className="m-0 text-muted-foreground">{NOTE}</p>
          {late.length ? (
            <p className="m-0 text-muted-foreground">
              Billed only at the end of the period: {late.map((p) => p.name || p.id).join(", ")}.
              Their amount can go down as usage grows (volume pricing, or the last, lowest or
              average value).
            </p>
          ) : null}
        </div>
      )}
    </RecordCard>
  );
}

/** Subscription detail: the plan's amount and this subscription's override. */
export async function SubscriptionUsageThresholdCard({
  biz,
  subscription,
  product,
  currency,
  canManage,
}: {
  biz: string;
  subscription: string;
  product: string | null;
  currency: string;
  canManage: boolean;
}) {
  const [own, plan] = await Promise.all([
    listUsageInvoiceThresholds(biz, { subscription }).catch(() => null),
    product ? listUsageInvoiceThresholds(biz, { product }).catch(() => null) : null,
  ]);
  if (!own) return null;
  const override = own.data.find((r) => r.scope === "subscription") ?? null;
  const planRow =
    plan?.data.find(
      (r) => r.scope === "plan" && r.active && r.currency.toUpperCase() === currency.toUpperCase(),
    ) ?? null;
  const returnTo = `/businesses/${biz}/subscriptions/${subscription}`;
  const effective = override
    ? override.active && override.amount_minor != null
      ? `Each time unbilled usage reaches ${money(override.amount_minor, currency)} (this subscription)`
      : "Off for this subscription"
    : planRow?.amount_minor != null
      ? `Each time unbilled usage reaches ${money(planRow.amount_minor, currency)} (from the plan)`
      : "Off. Usage is billed at the end of each period.";
  return (
    <RecordCard
      id="invoice-usage-early"
      title="Invoice usage early"
      actions={
        canManage ? (
          <SubscriptionUsageThresholdButton
            biz={biz}
            subscription={subscription}
            currency={currency}
            override={
              override ? { amount_minor: override.amount_minor, active: override.active } : null
            }
            returnTo={returnTo}
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        <span>{effective}</span>
        <p className="m-0 text-muted-foreground">{NOTE}</p>
      </div>
    </RecordCard>
  );
}
