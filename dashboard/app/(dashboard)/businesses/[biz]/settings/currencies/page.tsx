import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { CurrencyScreen } from "@/components/settings/currency-rates";
import { savePriceTypeAction } from "../actions";
import { PriceTypeRow } from "./price-type-row";

export const dynamic = "force-dynamic";

/**
 * Settings → Currencies: base currency, additional currencies with their rates, the
 * default price type, and where gateway routing lives.
 *
 * Exchange rates here are REPORTING + RECORD: they convert dashboard roll-ups to the base
 * currency and are stamped on new invoices. They never rate or settle a charge.
 */
export default async function CurrencySettings({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

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

  const base = b.default_currency?.toUpperCase() ?? null;
  // `currency_rates` excludes the base (1 against itself); the count adds it back.
  const additional = b.currency_rates ?? [];
  const enabledCount = additional.length + (base ? 1 : 0);
  const priceType = b.default_tax_behavior === "inclusive" ? "inclusive" : "exclusive";
  const failed = additional.filter((r) => r.last_error);
  const unrated = additional.filter((r) => !r.rate);
  const autoCount = additional.filter((r) => r.source === "auto").length;

  const attention: AttentionItem[] = [];
  if (!base)
    attention.push({
      key: "no-base",
      tone: "warning",
      title: "No base currency",
      detail:
        "Rates use the base currency as the reference. We cannot convert any amount until you set it.",
    });
  if (failed.length)
    attention.push({
      key: "refresh-failed",
      tone: "warning",
      title: failed.length === 1 ? "A rate did not refresh" : "Some rates did not refresh",
      detail: (
        <ul className="m-0 list-none space-y-1 p-0">
          {failed.map((r) => (
            <li key={r.currency}>
              <span className="font-medium">{r.currency}</span>: {r.last_error}. We still use the
              previous rate
              {r.updated_at ? ` (published ${formatDay(r.updated_at)})` : ""}. The daily refresh
              will retry.
            </li>
          ))}
        </ul>
      ),
    });
  if (base && unrated.length)
    attention.push({
      key: "unrated",
      tone: "warning",
      title: `No rate for ${unrated.map((r) => r.currency).join(", ")}`,
      detail: "Reporting cannot convert a currency without a rate. Set one from its ⋯ menu.",
    });

  return (
    <SettingsPage
      title="Currencies"
      crumbs={[{ label: "Settings", href: `/businesses/${biz}/settings` }, { label: "Currencies" }]}
      description="The currencies this business sells in, their exchange rates for reporting, and the price type new prices start with."
      attention={attention}
    >
      <SettingsColumns
        summary={
          <SettingsSummary
            items={[
              { label: "Base currency", value: base ?? "Not set" },
              {
                label: "Sells in",
                value: base
                  ? [base, ...additional.map((r) => r.currency)].join(", ")
                  : additional.map((r) => r.currency).join(", ") || "—",
              },
              additional.length > 0 && {
                label: "Rates",
                value: `${autoCount} updated daily · ${additional.length - autoCount} set by hand`,
              },
              {
                label: "New prices",
                value: priceType === "inclusive" ? "Tax inclusive" : "Tax exclusive",
              },
            ]}
          />
        }
      >
        <CurrencyScreen
          biz={biz}
          baseCurrency={base}
          rates={additional}
          enabledCount={enabledCount}
        />

        <ActionForm action={savePriceTypeAction}>
          <input type="hidden" name="biz" value={biz} />
          <SettingsCard
            title="Price types"
            footer={
              <SubmitButton size="sm" variant="outline">
                Save price type
              </SubmitButton>
            }
          >
            <PriceTypeRow saved={priceType} />
          </SettingsCard>
        </ActionForm>

        <SettingsCard title="Smart routing rules" padded>
          <p className="m-0 text-sm text-muted-foreground">
            You set which gateway account collects a payment on the gateway itself, for each
            currency and payment method.{" "}
            <Link
              href={`/businesses/${biz}/settings/gateways`}
              className="text-primary hover:underline"
            >
              Configure gateways →
            </Link>
          </p>
        </SettingsCard>
      </SettingsColumns>
    </SettingsPage>
  );
}

/** `2026-09-02T00:00:00Z` → `2 Sept 2026`. */
function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
