import Link from "next/link";
import { notFound } from "next/navigation";
import { listBusinesses, getTaxRegion } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import {
  AttentionCard,
  RecordCard,
  RecordCrumbs,
  RecordHeader,
  Row,
  Stack,
  Zone,
  type AttentionItem,
} from "@/components/patterns/record-page";
import { StatusChip, Chip } from "@/components/patterns/chip";
import { PageRefresh } from "@/components/patterns/page-refresh";
import { ErrorState } from "@/components/states";
import { TaxRegionSettings } from "@/components/tax/tax-region-settings";
import {
  TaxRateVector,
  StateRateOverride,
  StateRegistrations,
} from "@/components/tax/tax-rate-vector";
import { REGIME_LABEL, TREATMENT_SHORT, intraTotalBps, interTotalBps, pct } from "@/lib/tax-format";

export const dynamic = "force-dynamic";

export default async function TaxRegionPage({
  params,
}: {
  params: Promise<{ biz: string; txg: string }>;
}) {
  const { biz, txg } = await params;
  await requirePermission("taxes:view", "manager");

  let businesses, region;
  try {
    [businesses, region] = await Promise.all([listBusinesses(), getTaxRegion(biz, txg)]);
  } catch (e) {
    const msg = (e as Error).message;
    // A missing region is a 404, not an error card — the URL is wrong, not the server.
    if (/404|No such tax region/i.test(msg)) notFound();
    return <ErrorState description={<span className="font-mono text-xs">{msg}</span>} />;
  }
  const bizName = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const isGst = region.regime === "gst";
  const intra = intraTotalBps(region.components);
  const inter = interTotalBps(region.components);

  const attention: AttentionItem[] = (
    [
      !region.enabled
        ? {
            key: "archived",
            tone: "warning" as const,
            title: "This region is archived",
            detail: `We do not apply tax to new invoices for ${region.country}. Restore it from the Taxes list.`,
            actions: (
              <Link
                href={`/businesses/${biz}/catalog/tax`}
                className="text-sm text-primary hover:underline"
              >
                Open Taxes
              </Link>
            ),
          }
        : null,
      isGst && !region.home_state_code
        ? {
            key: "home_state",
            tone: "attention" as const,
            title: "No registered state set",
            detail: "Until you set it, every supply is inter-state (IGST).",
            actions: (
              <a href="#settings" className="text-sm text-primary hover:underline">
                Set it below
              </a>
            ),
          }
        : null,
    ] as Array<AttentionItem | null>
  ).filter((i): i is AttentionItem => i !== null);

  return (
    <div className="flex flex-col gap-4">
      <RecordCrumbs
        items={[
          { label: bizName, href: `/businesses/${biz}` },
          { label: "Product Catalog" },
          { label: "Taxes", href: `/businesses/${biz}/catalog/tax` },
          { label: region.country },
        ]}
        right={<PageRefresh />}
      />

      <RecordHeader
        title={region.country}
        chips={
          <>
            <StatusChip status={region.enabled ? "enabled" : "archived"} />
            <Chip>{REGIME_LABEL[region.regime]}</Chip>
          </>
        }
        facts={[
          `Prices are ${region.price_type === "inclusive" ? "inclusive" : "exclusive"} of tax`,
          region.registration_number ? (
            <span key="reg">
              {(region.registration_label ?? "tax reg").toUpperCase()}{" "}
              <span className="font-mono text-xs">{region.registration_number}</span>
            </span>
          ) : null,
        ]}
      />

      <AttentionCard items={attention} />

      <Zone title="Rates">
        <Row span="8/4">
          <TaxRateVector biz={biz} region={region} />
          <Stack>
            <RecordCard
              title="What customers here are charged"
              footer={
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Every invoice keeps the state that your business supplies from. Thus the CGST/SGST
                  split of a past invoice stays correct after you register in a different state.
                </p>
              }
            >
              {region.components.length === 0 ? (
                <p className="text-sm text-muted-foreground">No rates are configured.</p>
              ) : (
                <dl className="flex flex-col gap-2 text-sm">
                  {isGst ? (
                    <>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-muted-foreground">
                          Within {region.home_state_code ?? "—"}
                        </dt>
                        <dd className="font-semibold tabular-nums">{pct(intra)}</dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-muted-foreground">Other states</dt>
                        <dd className="font-semibold tabular-nums">{pct(inter)}</dd>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-muted-foreground">All customers</dt>
                      <dd className="font-semibold tabular-nums">{pct(inter)}</dd>
                    </div>
                  )}
                </dl>
              )}
            </RecordCard>
            <RecordCard title="Treatments a customer here can take">
              <ul className="flex flex-col gap-1 text-sm">
                {region.allowed_tax_treatments.map((t) => (
                  <li key={t}>{TREATMENT_SHORT[t]}</li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted-foreground">
                Enable more treatments below. The customer form shows only this list.
              </p>
            </RecordCard>
          </Stack>
        </Row>
        <Row span={isGst ? "6/6" : "12"}>
          <StateRegistrations biz={biz} region={region} />
          <StateRateOverride biz={biz} region={region} />
        </Row>
      </Zone>

      <Zone title="Settings">
        <div id="settings" className="scroll-mt-24">
          <TaxRegionSettings biz={biz} region={region} />
        </div>
      </Zone>
    </div>
  );
}
