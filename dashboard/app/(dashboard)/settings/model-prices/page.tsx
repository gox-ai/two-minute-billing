import { listBusinesses } from "@/lib/api";
import {
  getModelPriceDrift,
  getModelPriceSource,
  listModelPrices,
  type ModelPriceDrift,
  type ModelPriceSource,
} from "@/lib/api/model-prices";
import { allows, requirePermission } from "@/lib/session";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import {
  BusinessScopePicker,
  ModelPricesTable,
} from "@/components/model-prices/model-prices-table";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fmtDateTime, money } from "@/lib/format";
import { urlFilters } from "@/lib/list-source";
import { orgTz } from "@/lib/org-tz-server";
import { tzLabel } from "@/lib/tz";

export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Settings", href: "/settings" }, { label: "Model prices" }];
const PAGE = 100;
/** Show a model's drift from this many percent, either way (design G1c § 3.4). */
const DRIFT_SHOWN_PERCENT = 10;

/** The sync runs hourly at :10 UTC. */
function nextCheckUtc(now = new Date()): string {
  const h = (now.getUTCHours() + (now.getUTCMinutes() >= 10 ? 1 : 0)) % 24;
  return `${String(h).padStart(2, "0")}:10 UTC`;
}

/** The source's version is an ETag: drop the weak marker and quotes, keep 8 characters. */
function shortVersion(raw: string): string {
  return raw.replace(/^W\//, "").replaceAll('"', "").slice(0, 8);
}

function SourceDetails({ source, tz }: { source: ModelPriceSource; tz: string }) {
  const at = (iso: string) => `${fmtDateTime(iso, tz)} ${tzLabel(tz)}`;
  return (
    <div className="flex flex-col gap-3 text-sm">
      {source.check_error ? (
        <Alert tone="error" title="We could not update the price list">
          The source did not answer. We try again at{" "}
          {source.next_check_at ? at(source.next_check_at) : nextCheckUtc()}. Your bills use the
          last prices.
        </Alert>
      ) : null}
      <p className="m-0">
        Prices from{" "}
        <a href={source.url} className="text-primary hover:underline" rel="noreferrer">
          genai-prices
        </a>{" "}
        · Updated {source.last_success_at ? at(source.last_success_at) : "never"}
        {source.upstream_version ? (
          <>
            {" "}
            · Version{" "}
            <span className="font-mono text-xs" title={source.upstream_version}>
              {shortVersion(source.upstream_version)}
            </span>
          </>
        ) : null}
      </p>
      {source.held ? (
        <p className="m-0 text-muted-foreground">
          A price update is waiting. It applies on its own when the source keeps the same prices for
          6 hours. Until then, your bills use the last prices.
        </p>
      ) : null}
      <p className="m-0 text-muted-foreground">
        License of the price data: {source.licence || "MIT"}.
      </p>
      <p className="m-0 text-muted-foreground">
        List prices are in USD. We do not convert them to other currencies. For a business that
        bills in another currency, set your cost or a fixed rate in that currency.
      </p>
    </div>
  );
}

/**
 * Settings → Model prices (organization level, design G1b § 5.3). The dated AI model price list
 * from `GET /v1/organization/model_prices`, with your cost beside each row.
 *
 * `business`, `has_cost` and `used` are page scope, read here. Search (`q`) and the provider
 * filter (`filter=provider:is:…`) belong to the list, which fetches through `/api/lists`.
 */
export default async function ModelPricesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requirePermission("model_prices:view");
  const canManage = allows(me, "model_prices:manage", "manager");
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const scope = {
    business: one("business") || undefined,
    hasCost: one("has_cost") === "on",
    used: one("used") === "on",
  };

  let page, source, businesses, tz, drift;
  try {
    [page, source, businesses, tz, drift] = await Promise.all([
      listModelPrices({
        business: scope.business,
        has_cost: scope.hasCost,
        used: scope.used,
        limit: PAGE,
      }),
      getModelPriceSource().catch(() => null),
      listBusinesses().catch(() => null),
      orgTz(),
      getModelPriceDrift(scope.business)
        .then((d) => d.data.filter((r) => Math.abs(r.difference_percent) >= DRIFT_SHOWN_PERCENT))
        .catch(() => [] as ModelPriceDrift[]),
    ]);
  } catch (e) {
    return (
      <SettingsPage title="Model prices" crumbs={CRUMBS}>
        <ErrorState
          title="We could not load the price list"
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }

  const currencies = Array.from(
    new Set(
      (businesses?.data ?? []).flatMap((b) => [
        ...(b.default_currency ? [b.default_currency.toUpperCase()] : []),
        ...(b.currencies ?? []).map((c) => c.toUpperCase()),
      ]),
    ),
  );
  const businessName = scope.business
    ? (businesses?.data.find((b) => b.id === scope.business)?.name ?? scope.business)
    : null;

  return (
    <SettingsPage
      title="Model prices"
      description="The price of each AI model and token type, from a public price list that we update every hour. Your cost is the price that you negotiated with a provider."
      crumbs={CRUMBS}
      actions={
        businesses?.data.length ? (
          <BusinessScopePicker
            value={scope.business}
            businesses={businesses.data.map((b) => ({ id: b.id, name: b.name }))}
          />
        ) : undefined
      }
    >
      {source ? (
        <SettingsCard title="Price source" padded>
          <SourceDetails source={source} tz={tz} />
        </SettingsCard>
      ) : null}

      {drift.length ? (
        <SettingsCard
          title="Reported cost and list price"
          meta={businessName ? businessName : "All businesses"}
        >
          <p className="m-0 px-5 py-4 text-sm text-muted-foreground">
            These models cost a different amount from the list in the last 7 days. We compare the
            cost that your calls reported with the list price of the same tokens.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Provider</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Reported cost</TableHead>
                <TableHead className="text-right">List price</TableHead>
                <TableHead className="pr-5">Difference</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drift.map((d) => (
                <TableRow key={`${d.provider}/${d.model}`}>
                  <TableCell className="pl-5">{d.provider}</TableCell>
                  <TableCell className="font-mono">{d.model}</TableCell>
                  <TableCell className="text-right">
                    {money(d.reported_cost_minor, "USD")}
                  </TableCell>
                  <TableCell className="text-right">{money(d.list_cost_minor, "USD")}</TableCell>
                  <TableCell className="pr-5">
                    {Math.abs(d.difference_percent)}%{" "}
                    {d.difference_percent > 0 ? "more than the list" : "less than the list"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </SettingsCard>
      ) : null}

      <ModelPricesTable
        rows={page.data}
        hasMore={page.has_more}
        nextCursor={page.next_cursor}
        pageSize={PAGE}
        scope={scope}
        providers={source?.providers ?? []}
        initialFilters={urlFilters(sp, {})}
        canManage={canManage}
        currencies={currencies}
        sourceSuccessAt={source?.last_success_at ?? null}
      />
    </SettingsPage>
  );
}
