import Link from "next/link";
import { listBusinesses, getProduct, getPrice, fmtDate, fmtDateTime, type Price } from "@/lib/api";
import { allows, requirePermission } from "@/lib/session";
import { canPreviewRateChange } from "@/lib/usage-controls";
import { RatePreviewButton } from "@/components/usage-controls/rate-preview-dialog";
import { money } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { StatusChip, IdChip, Chip } from "@/components/patterns/chip";
import {
  Facts,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Zone,
} from "@/components/patterns/record-page";
import { MoreMenu, MoreSection } from "@/components/patterns/more-menu";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { MODEL_LABEL, freqLabel, priceDisplay } from "@/components/catalog/pricing-matrix";
import { ArchiveRestoreItem } from "@/components/catalog/catalog-record-actions";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ActivityLogCard } from "@/components/activity-log-card";
import { UsageTiles } from "@/components/catalog/usage-tiles";
import { getPriceStats } from "@/lib/api/catalog-stats";
import { aggregationLabel } from "@/lib/usage-aggregation";
import { divisorLabel, formatMinorRate } from "@/lib/meters";
import { ErrorState } from "@/components/states";

export const dynamic = "force-dynamic";

const KIND_META: Record<string, { plural: string; page: string }> = {
  plan: { plural: "Plans", page: "plans" },
  addon: { plural: "Add-ons", page: "addons" },
  charge: { plural: "One-time products", page: "charges" },
};

const TIERED = new Set(["tiered", "volume", "stairstep", "graduated_percentage"]);

function everyLabel(p: Price): string | null {
  if (p.type === "one_time" || !p.interval) return null;
  const n = p.interval_count ?? 1;
  return `Every ${n} ${p.interval}${n === 1 ? "" : "s"}`;
}

/**
 * Price detail, record-page layout: header, figures, Pricing (tiers or the
 * flat terms), Price cards (details | customer-facing, trial | accounting),
 * then Records.
 */
export default async function PriceDetail({
  params,
}: {
  params: Promise<{ biz: string; prod: string; price: string }>;
}) {
  const me = await requirePermission("catalog:view", "manager");
  const { biz, prod, price } = await params;

  let businesses, product, p, stats;
  try {
    [businesses, product, p, stats] = await Promise.all([
      listBusinesses(),
      getProduct(biz, prod),
      getPrice(biz, price),
      // Figures are supplementary: a stats failure drops the two tiles, not the page.
      getPriceStats(biz, price).catch(() => null),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Price" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz);
  const bizName = business?.name ?? biz;
  // Dates render in the business timezone — the engine's term boundaries are midnight there.
  const tz = business?.timezone ?? null;
  const meta = KIND_META[product.kind ?? "plan"] ?? KIND_META.plan;
  const active = p.active !== false;
  const detailHref = `/businesses/${biz}/catalog/products/${prod}`;
  const editHref = `${detailHref}/prices/${price}/edit`;
  const displayName = p.external_name || p.name || p.id;
  const recurring = p.type !== "one_time" && !!p.interval;
  const lastModified = p.updated_at ?? p.created_at;
  const metaKeys = p.metadata ? Object.keys(p.metadata).length : 0;
  const hasTiers = TIERED.has(p.model) || !!p.tiers?.length;
  // Graduated percentage tiers are bands of a money amount, each with a rate.
  const rateTiers = p.model === "graduated_percentage";

  // Package / free-unit terms, shown under the tiers or in the flat-terms card.
  const terms = [
    p.package_size != null
      ? { label: "Package size", value: p.package_size.toLocaleString() }
      : null,
    p.free_units != null ? { label: "Free units", value: p.free_units.toLocaleString() } : null,
    p.free_quantity != null
      ? { label: "Free quantity", value: p.free_quantity.toLocaleString() }
      : null,
    p.percentage_bps != null
      ? { label: "Percentage", value: `${(p.percentage_bps / 100).toFixed(2)}%` }
      : null,
    p.metered && p.model !== "usage" ? { label: "Bill from", value: "Recorded usage" } : null,
    p.meter
      ? {
          label: "Bill from a meter",
          value: p.meter,
        }
      : null,
    p.meter && p.amount_source && p.amount_source !== "rate"
      ? {
          label: "Amount",
          value: amountSourceText(p),
        }
      : null,
    p.meter && p.unit_amount_decimal != null
      ? {
          label: "Default rate",
          value: `${formatMinorRate(p.unit_amount_decimal, p.currency)} ${divisorLabel(p.quantity_divisor)}`,
        }
      : null,
    ...(p.meter && p.rates?.length
      ? p.rates.map((r) => ({
          label: Object.entries(r.match)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · "),
          value:
            r.markup_percent != null && r.markup_percent !== ""
              ? `Markup ${r.markup_percent}%`
              : `${formatMinorRate(r.unit_amount_decimal, p.currency)} ${divisorLabel(p.quantity_divisor)}`,
        }))
      : []),
    p.usage_aggregation
      ? { label: "Usage aggregation", value: aggregationLabel(p.usage_aggregation) }
      : null,
    p.metered
      ? { label: "Carry the level to the next period", value: p.usage_recurring ? "Yes" : "No" }
      : null,
    p.usage_time_unit
      ? { label: "Time unit", value: p.usage_time_unit === "day" ? "Day" : "Hour" }
      : null,
    p.minimum_amount_minor != null
      ? { label: "Minimum spend", value: money(p.minimum_amount_minor, p.currency) }
      : null,
    p.bill_usage_monthly ? { label: "Usage billing", value: "Every month" } : null,
    p.commitment_amount_minor != null
      ? {
          label: "Minimum commitment",
          value: `${money(p.commitment_amount_minor, p.currency)} per billing period`,
        }
      : null,
  ].filter((t): t is { label: string; value: string } => t != null);

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: meta.plural, href: `/businesses/${biz}/catalog/${meta.page}` },
          { label: product.name, href: detailHref },
          { label: `${p.currency}, ${freqLabel(p)}` },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={
          <>
            ‘{displayName}’ {p.currency}, {freqLabel(p)}
          </>
        }
        chips={
          <>
            <StatusChip status={active ? "active" : "archived"} />
            <Chip>{recurring ? "Recurring" : "One-time"}</Chip>
          </>
        }
        facts={[
          <IdChip key="id" label="Price ID" id={p.id} />,
          <Link key="prod" href={detailHref} className="hover:text-foreground hover:underline">
            {product.name}
          </Link>,
          everyLabel(p),
        ]}
        actions={
          <>
            {canPreviewRateChange(p) && allows(me, "usage_controls:view", "manager") ? (
              <RatePreviewButton biz={biz} price={p} />
            ) : null}
            <Button asChild>
              <Link href={editHref}>Edit</Link>
            </Button>
            <MoreMenu>
              <MoreSection heading="Price">
                <ArchiveRestoreItem
                  biz={biz}
                  resource="prices"
                  id={p.id}
                  active={active}
                  noun="price"
                  archiveLabel="Archive"
                  archiveDescription="Active price lists do not show it. Live subscriptions keep their snapshotted price. You can restore it later."
                  restoreDescription="Active price lists show it again."
                  afterArchiveHref={detailHref}
                />
              </MoreSection>
            </MoreMenu>
          </>
        }
      />

      <UsageTiles stats={stats} scope="price" currency={business?.default_currency} />

      <Zone title="Pricing">
        <Row span="12">
          {hasTiers ? (
            <RecordCard
              id="pricing"
              title="Tiers"
              flush
              footer={
                terms.length ? (
                  <span className="text-muted-foreground">
                    {terms.map((t) => `${t.label} ${t.value}`).join(" · ")}
                  </span>
                ) : undefined
              }
            >
              {p.tiers?.length ? (
                <Table className="table-fixed max-lg:min-w-0">
                  <colgroup>
                    <col className="w-[40%]" />
                    <col className="w-[30%]" />
                    <col className="w-[30%]" />
                  </colgroup>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-5">{rateTiers ? "Amount" : "Units"}</TableHead>
                      <TableHead className="text-right">
                        {rateTiers ? "Rate" : "Price per unit"}
                      </TableHead>
                      <TableHead className="pr-5 text-right">Flat fee</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {p.tiers.map((t, i, all) => {
                      // `upToMinor` is a QUANTITY threshold, despite the name — except on a
                      // graduated percentage price, where it is money and bands touch.
                      const prev = i === 0 ? 0 : (all[i - 1].upToMinor ?? 0);
                      const fmt = (x: number) =>
                        rateTiers ? money(x, p.currency) : x.toLocaleString();
                      const from = fmt(rateTiers ? prev : prev + 1);
                      return (
                        <TableRow key={i}>
                          <TableCell className="pl-5 tabular-nums">
                            {t.upToMinor == null
                              ? `${from} and up`
                              : `${from} – ${fmt(t.upToMinor)}`}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {rateTiers
                              ? t.rateBps != null
                                ? `${(t.rateBps / 100).toFixed(2)}%`
                                : "—"
                              : t.unitAmountMinor != null
                                ? money(t.unitAmountMinor, p.currency)
                                : "—"}
                          </TableCell>
                          <TableCell className="pr-5 text-right tabular-nums">
                            {t.flatAmountMinor != null ? money(t.flatAmountMinor, p.currency) : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              ) : (
                <p className="px-5 py-4 text-sm text-muted-foreground">No tiers defined.</p>
              )}
            </RecordCard>
          ) : (
            <RecordCard id="pricing" title="Pricing">
              <Facts
                rows={[
                  {
                    label: "Price",
                    value: (
                      <span className="font-medium tabular-nums">
                        {priceDisplay(p)}{" "}
                        {p.amount_minor != null ? (
                          <span className="text-muted-foreground">{p.currency}</span>
                        ) : null}
                      </span>
                    ),
                  },
                  { label: "Pricing model", value: MODEL_LABEL[p.model] ?? p.model },
                  ...terms,
                ]}
              />
            </RecordCard>
          )}
        </Row>
      </Zone>

      <Zone title="Price">
        <Row span="6/6">
          <RecordCard id="details" title="Price details">
            <Facts
              rows={[
                { label: "Internal name", value: p.name || "—" },
                { label: "Pricing model", value: MODEL_LABEL[p.model] ?? p.model },
                { label: "Taxable", value: p.is_taxable === false ? "No" : "Yes" },
                {
                  label: "Tax behavior",
                  value: p.tax_behavior === "inclusive" ? "Inclusive" : "Exclusive",
                },
                {
                  label: "HSN/SAC code",
                  // Blank falls back to the product's code, then the business default.
                  value: p.tax_code ? (
                    <span className="font-mono text-xs">{p.tax_code}</span>
                  ) : (
                    <span className="text-muted-foreground">Inherited from the product</span>
                  ),
                },
                {
                  label: "Last modified",
                  value: lastModified ? fmtDateTime(lastModified, tz) : "—",
                },
                { label: "Created", value: p.created_at ? fmtDate(p.created_at, tz) : "—" },
                {
                  label: "JSON metadata",
                  value: metaKeys ? (
                    <span className="font-mono text-xs break-all">
                      {JSON.stringify(p.metadata)}
                    </span>
                  ) : (
                    "—"
                  ),
                },
              ]}
            />
          </RecordCard>
          <RecordCard id="customer-facing" title="Customer-facing info">
            <Facts
              rows={[
                { label: "External name", value: p.external_name || "—" },
                { label: "Description", value: p.description || "—" },
              ]}
            />
          </RecordCard>
        </Row>
        <Row span="6/6">
          <RecordCard id="trial" title="Trial">
            <Facts
              rows={[
                {
                  label: "Trial",
                  value: p.trial_period
                    ? `${p.trial_period} ${p.trial_period_unit ?? "day"}${p.trial_period === 1 ? "" : "s"}`
                    : "—",
                },
                p.trial_period
                  ? {
                      label: "When the trial ends",
                      // Unset converts, the same as activate_subscription.
                      value:
                        p.trial_end_action === "cancel_subscription"
                          ? "Cancel the subscription"
                          : "Activate and charge",
                    }
                  : null,
                {
                  label: "Billing cycles",
                  value: p.billing_cycles ? `${p.billing_cycles} cycles` : "Forever",
                },
              ]}
            />
          </RecordCard>
          <RecordCard id="accounting" title="Accounting">
            <Facts
              rows={[
                { label: "SKU / Alternative Name", value: p.sku || "—" },
                { label: "Account name", value: p.accounting_code || "—" },
                { label: "Class", value: p.accounting_category_code || "—" },
              ]}
            />
            {/* Descriptive only: nothing in the billing engine reads these. */}
            <p className="mt-3 text-xs text-muted-foreground">
              These values are for your own reporting and exports. The billing engine does not use
              them.
            </p>
          </RecordCard>
        </Row>
      </Zone>

      <Zone title="Records">
        <Row span="12">
          <ActivityLogCard
            biz={biz}
            resourceType="price"
            resourceId={p.id}
            tz={tz}
            layout="card"
            previewRows={5}
          />
        </Row>
      </Zone>
    </div>
  );
}

/** The "Amount" row of a meter price that does not bill from a plain rate. */
function amountSourceText(p: Price): string {
  const markup = `${p.markup_percent ?? "0"}%`;
  const base = p.markup_base === "cost" ? "your cost" : "the list price";
  switch (p.amount_source) {
    case "event_cost":
      return `Cost on each event, plus ${markup}`;
    case "model_price_list":
      return `Model price list, plus ${markup} on ${base}`;
    case "event_cost_or_list":
      return `Cost on each event, else the model price list, plus ${markup}. Events without a cost take the markup on ${base}.`;
    default:
      return "Amount on each event";
  }
}
