import { listBusinesses } from "@/lib/api";
import {
  listSegmentAttributes,
  listSegments,
  previewSegment,
  type SegmentFilter,
} from "@/lib/api/segments";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/states";
import { SegmentRail } from "@/components/reports/customers/segment-rail";
import { SegmentFilterBar } from "@/components/reports/customers/filter-bar";
import { SegmentCustomerTable } from "@/components/reports/customers/segment-table";
import {
  SegmentBodySkeleton,
  SegmentTitleSkeleton,
} from "@/components/reports/customers/skeletons";
import { NavPendingProvider, PendingContent } from "@/components/navigation/nav-pending";
import { RecordCard, Row } from "@/components/patterns/record-page";
import { Chip } from "@/components/patterns/chip";
import { KPI_LABEL } from "@/components/analytics/layout";

export const dynamic = "force-dynamic";

const PAGE = 50;

/**
 * Customers — segmentation.
 *
 * ⚠️ VOCABULARY, and it is load-bearing. A **segment** is a saved, named POPULATION of
 * customers, which reports compare a metric across. A **view** is a saved filter over a
 * LIST screen (the `All customers ▾` dropdown on `/customers`), and a **attribute** is
 * a stored customer field a segment is a predicate over. The words are not
 * interchangeable and this screen never swaps them — `docs/PROGRESS.md` § 4c.
 *
 * ── ONE predicate, and it lives in the URL ───────────────────────────────────
 * `?segment=<id>` selects a saved one; `?filter=field:op:value` (repeatable) is an
 * ad-hoc set. Both resolve to the same list of triples, which the server hands to the
 * engine's preview endpoint in the customer list's own grammar. So:
 *
 *  · The figures are COUNTED BY THE ENGINE over the whole filtered set. A screen that
 *    sums the fifty rows it loaded is quietly wrong on the fifty-first customer.
 *  · Editing a chip drops `segment` from the URL, and the rail stops claiming a saved
 *    segment is selected. Showing a segment's name over an edited predicate would be
 *    lying about which population the figures are.
 *  · The link is shareable and Back works, because nothing lives in component state.
 */
export default async function CustomerSegmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("customers:view", "ops");
  const [{ biz }, search] = await Promise.all([params, searchParams]);

  const segmentId = (Array.isArray(search.segment) ? search.segment[0] : search.segment) ?? "";
  const rawFilters = Array.isArray(search.filter)
    ? search.filter
    : search.filter
      ? [search.filter]
      : [];

  let businesses, segments, attributes;
  try {
    [businesses, segments, attributes] = await Promise.all([
      listBusinesses(),
      listSegments(biz),
      listSegmentAttributes(biz),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Customers" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const business = businesses.data.find((b) => b.id === biz) ?? null;
  const currency = business?.default_currency ?? "USD";
  const selected = segments.data.find((s) => s.id === segmentId) ?? null;

  /**
   * An ad-hoc `filter` param WINS over `segment`. The bar writes one or the other, and
   * a URL carrying both is an edited segment — the edit is what the operator is
   * looking at, so it is what the figures must be for.
   */
  const custom = rawFilters.length > 0;
  const filters: SegmentFilter[] = custom
    ? rawFilters.flatMap(parseFilterParam)
    : (selected?.filters ?? []);

  let population;
  let refusal: string | null = null;
  try {
    population = await previewSegment(biz, filters, { limit: PAGE });
  } catch (e) {
    // A refusal is the engine naming an attribute it cannot answer, and the message is
    // the product — it says which one and why. It is shown verbatim, and the rail and
    // the chips stay on screen so the offending filter can be removed.
    refusal = (e as Error).message;
  }

  const title = selected?.name ?? (custom ? "Customers" : "All customers");
  const total = population ? (population.total ?? population.data.length) : null;

  return (
    <NavPendingProvider>
      <PageHeader
        title="Customers"
        description="A segment is a saved filter over customer attributes. Reports can compare a metric across segments."
        breadcrumbs={[{ label: "Reports", href: `/businesses/${biz}/reports` }]}
      />

      <div className="flex flex-col gap-5">
        <SegmentFilterBar
          biz={biz}
          heading={
            <PendingContent skeleton={<SegmentTitleSkeleton />}>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className={KPI_LABEL}>Segment</span>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold wrap-anywhere">{title}</h2>
                  {selected?.is_starter ? <Chip>Ships with the product · read-only</Chip> : null}
                </div>
                {selected?.description ? (
                  <p className="text-sm text-muted-foreground">{selected.description}</p>
                ) : null}
              </div>
            </PendingContent>
          }
          attributes={attributes.data}
          filters={filters}
          customers={population?.total ?? null}
          mrrByCurrency={population?.mrr_by_currency ?? {}}
          currency={currency}
          canSave={filters.length > 0}
        />

        <Row span="8/4">
          <RecordCard
            title="Customers in this segment"
            meta={
              total == null
                ? undefined
                : population!.has_more
                  ? `first ${PAGE.toLocaleString("en")} of ${total.toLocaleString("en")}`
                  : `${total.toLocaleString("en")} ${total === 1 ? "customer" : "customers"}`
            }
            flush
            footer={
              population?.has_more ? (
                <span className="text-xs text-muted-foreground">
                  Showing the first {PAGE.toLocaleString("en")} of{" "}
                  {(total ?? 0).toLocaleString("en")}. The count and the MRR above are for all the
                  customers in the segment, not only this page.
                </span>
              ) : undefined
            }
          >
            <PendingContent skeleton={<SegmentBodySkeleton />}>
              {refusal ? (
                <div className="p-5">
                  <Alert tone="warning" title="We could not apply these filters">
                    {refusal}
                  </Alert>
                </div>
              ) : (
                <SegmentCustomerTable
                  biz={biz}
                  customers={population!.data}
                  fallbackCurrency={currency}
                  tz={business?.timezone ?? null}
                />
              )}
            </PendingContent>
          </RecordCard>

          {/* Below xl the rail stacks above the table, so the segment picker comes first. */}
          <div className="order-first min-w-0 self-start xl:order-0">
            <SegmentRail
              biz={biz}
              segments={segments.data}
              current={selected?.id ?? null}
              custom={custom}
            />
          </div>
        </Row>

        <p className="max-w-3xl text-xs text-muted-foreground">
          Attributes come from the customer record and its subscriptions. They include country,
          billing cycle, MRR, lifecycle dates, tax status and all custom fields. If the stored data
          cannot express a filter, we refuse it and name it. We never answer it slowly.
        </p>
      </div>
    </NavPendingProvider>
  );
}

/**
 * `field:op:value` → a triple. The value may itself contain colons (a timestamp), so
 * only the first two separators are split on; a param that cannot yield all three parts
 * is DROPPED rather than half-applied, because a filter that narrows on a guess is the
 * one failure this screen must not have.
 */
function parseFilterParam(raw: string): SegmentFilter[] {
  const first = raw.indexOf(":");
  if (first <= 0) return [];
  const second = raw.indexOf(":", first + 1);
  if (second <= first) return [];
  const field = raw.slice(0, first);
  const op = raw.slice(first + 1, second);
  const value = raw.slice(second + 1);
  return field && op ? [{ field, op, value }] : [];
}
