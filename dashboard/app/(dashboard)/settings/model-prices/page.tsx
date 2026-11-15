import { listBusinesses } from "@/lib/api";
import {
  getModelPriceDrift,
  getModelPriceSource,
  listModelPrices,
  listUnlistedCosts,
  type ModelPriceDrift,
  type ModelPriceFeed,
  type ModelPriceSource,
} from "@/lib/api/model-prices";
import { allows, requirePermission } from "@/lib/session";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import {
  BusinessScopePicker,
  ModelPricesTable,
} from "@/components/model-prices/model-prices-table";
import { Alert } from "@/components/ui/alert";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ErrorState } from "@/components/states";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { money } from "@/lib/format";
import {
  feedTimes,
  listFeedName,
  shortVersion,
  unlistedCostFilters,
  unlistedCostKey,
} from "@/lib/model-prices";
import { providerName } from "@/lib/model-providers";
import { fmtDateTime } from "@/lib/format-date";
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

/** The feeds, with the first one alone when the engine predates `sources`. */
function feedsOf(source: ModelPriceSource): ModelPriceFeed[] {
  return source.sources?.length
    ? source.sources
    : [
        {
          source: "genai-prices",
          url: source.url,
          licence: source.licence,
          prices: "all",
          checked_at: source.checked_at,
          last_success_at: source.last_success_at,
          check_error: source.check_error,
          upstream_version: source.upstream_version,
        },
      ];
}

function SourceDetails({ source, tz }: { source: ModelPriceSource; tz: string }) {
  const at = (iso: string) => `${fmtDateTime(iso, tz)} ${tzLabel(tz)}`;
  const feeds = feedsOf(source);
  const failed = feeds.filter((f) => f.check_error);
  const name = (f: ModelPriceFeed) => listFeedName(f.source);
  return (
    <div className="flex flex-col gap-3 text-sm">
      {failed.length ? (
        <Alert tone="error" title="We could not update the price list">
          {failed.length === feeds.length
            ? "The source did not answer."
            : `${failed.map(name).join(" and ")} did not answer.`}{" "}
          We try again at {source.next_check_at ? at(source.next_check_at) : nextCheckUtc()}. Your
          invoices use the most recent prices that we have.
        </Alert>
      ) : null}
      {feeds.map((f) => {
        const { checked, updated } = feedTimes(f);
        return (
          <p key={f.source} className="m-0">
            {f.prices === "media"
              ? "Image, video, audio and character prices from "
              : "Prices from "}
            <a
              data-document-link
              href={f.url}
              className="text-primary hover:underline"
              rel="noreferrer"
            >
              {name(f)}
            </a>
            {checked ? ` · Checked ${at(checked)}` : " · Not checked yet"}
            {updated ? ` · Updated ${at(updated)}` : null}
            {f.upstream_version ? (
              <>
                {" "}
                · Version{" "}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="font-mono text-xs">{shortVersion(f.upstream_version)}</span>
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-xs">
                    {f.upstream_version}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
          </p>
        );
      })}
      {feeds.length > 1 ? (
        <p className="m-0 text-muted-foreground">
          When both sources give a price for an image, a video, audio or characters, we use{" "}
          {name(feeds[1]!)}.
        </p>
      ) : null}
      {source.last_success_at ? null : (
        <p className="m-0 text-muted-foreground">We have not synced the prices yet.</p>
      )}
      {source.held ? (
        <p className="m-0 text-muted-foreground">
          A price update is waiting. It applies on its own when the source keeps the same prices for
          6 hours. Until then, your invoices use the current prices.
        </p>
      ) : null}
      <p className="m-0 text-muted-foreground">
        List prices are in USD. We do not convert them. For another currency, set your cost or a
        fixed rate in that currency.
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        License of the price data:{" "}
        {feeds.map((f) => `${name(f)}, ${f.licence || "MIT License"}`).join(". ")}.
      </p>
    </div>
  );
}

/**
 * The oldest last success among the feeds that have one: a model only one feed lists reads as
 * "not in the source" only after that feed has run since, so a failing feed never marks its
 * models as gone.
 */
function oldestSuccess(source: ModelPriceSource | null): string | null {
  const all = source
    ? feedsOf(source).flatMap((f) => (f.last_success_at ? [f.last_success_at] : []))
    : [];
  return all.length ? all.reduce((a, b) => (Date.parse(a) < Date.parse(b) ? a : b)) : null;
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

  // The cost card follows the list's own search and provider and unit filters.
  const filterParam = sp.filter;
  const costFilters = unlistedCostFilters(
    one("q"),
    Array.isArray(filterParam) ? filterParam : filterParam ? [filterParam] : [],
  );
  let page, source, businesses, tz, drift, unlisted;
  // When the rows were read: a cost is "ended" against this, so each reload decides again.
  const loadedAt = new Date().getTime();
  try {
    [page, source, businesses, tz, drift, unlisted] = await Promise.all([
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
      listUnlistedCosts(costFilters).catch(() => ({ rows: [], nextCursor: null })),
    ]);
  } catch (e) {
    return (
      <SettingsPage title="Model prices" crumbs={CRUMBS}>
        <ErrorState title="We could not load the price list." error={e} retry />
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
      description="The price of each AI model, by type and unit, from a public price list that we check every hour. Your cost is the price that you negotiated with a provider."
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
            In the last 7 days, these models cost at least {DRIFT_SHOWN_PERCENT}% more or less than
            the list price. We compare the cost that your calls reported with the list price of the
            same tokens.
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
                  <TableCell className="pl-5">{providerName(d.provider)}</TableCell>
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
        sourceSuccessAt={oldestSuccess(source)}
        unlistedCosts={{ ...unlisted, key: unlistedCostKey(costFilters) }}
        loadedAt={loadedAt}
      />
    </SettingsPage>
  );
}
