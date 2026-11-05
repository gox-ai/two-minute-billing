import { listBusinesses } from "@/lib/api";
import { listDisputes } from "@/lib/api/disputes";
import { gatewayDisplayName, getGatewayCatalogOrEmpty } from "@/lib/api/gateways";
import { allows, requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { DisputesTable } from "@/components/disputes/disputes-table";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";

export const dynamic = "force-dynamic";

export default async function DisputesPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  const user = await requirePermission("payments:view", "ops");

  let businesses, disputes, catalog;
  try {
    /**
     * `limit: 200` — the engine's own maximum — plus an honest notice below when even that
     * is not everything.
     *
     * This asked for no limit at all, so it got the engine's default of FIFTY and had no
     * `has_more` to notice the rest with: a business past fifty chargebacks silently saw a
     * partial screen. The endpoint now paginates properly (`has_more` / `next_cursor` /
     * `total`), which fixes it for API consumers outright.
     *
     * This screen deliberately stays CLIENT-paged rather than converting to a server cursor:
     * the engine's dispute list accepts only `status`, so server mode would kill the search
     * box and every filter field but one — the trade `retries` made, and the wrong one here,
     * where the whole point of the screen is slicing a small set by reason and gateway.
     * Bounded-list reasoning, per the `ui` skill § 6. Past 200 that trade has to be revisited.
     */
    [businesses, disputes, catalog] = await Promise.all([
      listBusinesses(),
      listDisputes(biz, { limit: 200 }),
      getGatewayCatalogOrEmpty(),
    ]);
  } catch (e) {
    return (
      <>
        <PageHeader title="Disputes" />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }
  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const gatewayNames = Object.fromEntries(
    [...new Set(disputes.data.map((d) => d.provider_key))].map((k) => [
      k,
      gatewayDisplayName(k, catalog),
    ]),
  );

  return (
    <>
      {/* Say so rather than showing a partial list as if it were the whole one — the failure
          this screen shipped with. `total` is the real filtered count from the engine. */}
      {/* The list chrome stays visible at zero rows — the table owns its empty state. */}
      <DisputesTable
        page={{
          title: "Disputes",
          breadcrumbs: [{ label: name, href: `/businesses/${biz}` }, { label: "Disputes" }],
          notice: (
            <>
              {disputes.has_more ? (
                <Alert tone="warning" title="Showing the most recent 200 disputes" className="mb-4">
                  This business has {disputes.total ?? "more"} in total. This screen does not show
                  older disputes yet. To get them, use the API parameter{" "}
                  <code className="font-mono">starting_after</code>.
                </Alert>
              ) : null}
            </>
          ),
        }}
        biz={biz}
        rows={disputes.data}
        canManage={allows(user, "payments:refund", "manager")}
        gatewayNames={gatewayNames}
      />
    </>
  );
}
