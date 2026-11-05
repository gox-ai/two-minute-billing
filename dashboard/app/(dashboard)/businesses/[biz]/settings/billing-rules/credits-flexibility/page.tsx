import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { currencyExponent, majorStep, minorPerMajor, toMajorInput } from "@/lib/money";
import type { CreditsFlexibilitySlot } from "@/lib/api";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import {
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { saveCreditsFlexibilityAction } from "../../actions";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { CreditSlotRow } from "./slot-row";

export const dynamic = "force-dynamic";

// Billing rules → Credits flexibility (`credits_flexibility`, 0219): credit KIND
// (refundable, excess) × invoice CLASS (recurring, one-time). The per-subscription cap
// is API-only, and the page says so instead of rendering a control that does not exist.
// Promotional credit is out of scope: pre-tax, non-refundable, already capped.

type Kind = "refundable" | "excess";
type Cls = "recurring" | "one_time";

const KINDS: Array<{ kind: Kind; title: string; meta: string; what: string }> = [
  {
    kind: "refundable",
    title: "Refundable credits",
    meta: "Credit notes, downgrade prorations, credit memos",
    what: "refundable credits",
  },
  {
    kind: "excess",
    title: "Excess payments",
    meta: "Overpayments and excess offline payments",
    what: "excess payments",
  },
];

const CLASSES: Array<{ cls: Cls; label: string }> = [
  { cls: "recurring", label: "On recurring invoices" },
  { cls: "one_time", label: "On one-time invoices" },
];

export default async function CreditsFlexibilitySettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
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

  const currency = b.default_currency;
  const cfg = b.credits_flexibility ?? null;
  // resolveCreditsFlexibility reads an absent or malformed slot as auto with no ceiling.
  const slot = (kind: Kind, cls: Cls): CreditsFlexibilitySlot =>
    cfg?.[kind]?.[cls] ?? { mode: "auto" };
  const limitText = (s: CreditsFlexibilitySlot) =>
    s.mode === "limit" ? toMajorInput(s.limit_minor ?? 0, currency) : "";
  const savedLine = (s: CreditsFlexibilitySlot) =>
    s.mode === "auto"
      ? "Auto-apply"
      : s.mode === "none"
        ? "Not auto-applied"
        : `Up to ${limitText(s)} ${currency ?? ""}`.trim();

  return (
    <SettingsPage
      title="Credits flexibility"
      crumbs={ruleCrumbs(biz, "Credits flexibility")}
      description="Whether we apply refundable credits and excess payments to invoices automatically, and how much of each one invoice may take."
    >
      <ActionForm action={saveCreditsFlexibilityAction}>
        <FormIds biz={biz} version={b.resource_version} />
        {/* Amounts are typed in major units; the action converts with this factor. */}
        <input type="hidden" name="minor_per_major" value={minorPerMajor(currency)} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={KINDS.flatMap(({ kind, title }) =>
                CLASSES.map(({ cls, label }) => ({
                  label: `${title}, ${label.replace("On ", "")}`,
                  value: savedLine(slot(kind, cls)),
                })),
              )}
            />
          }
          save={{ note: "Applies to invoices raised from now on." }}
        >
          {KINDS.map(({ kind, title, meta, what }) => (
            <SettingsCard key={kind} title={title} meta={meta}>
              {CLASSES.map(({ cls, label }) => {
                const s = slot(kind, cls);
                return (
                  <CreditSlotRow
                    key={cls}
                    field={`${kind}_${cls}`}
                    label={label}
                    what={what}
                    defaultMode={s.mode}
                    defaultLimit={limitText(s)}
                    currency={currency ?? ""}
                    step={majorStep(currency)}
                    placeholder={(0).toFixed(currencyExponent(currency))}
                  />
                );
              })}
            </SettingsCard>
          ))}

          <SettingsCard title="Also worth knowing" padded>
            <ul className="m-0 flex list-disc flex-col gap-2 pl-5 text-sm leading-normal text-muted-foreground">
              <li>
                We store a limit in the smallest unit of {currency ?? "the default currency"}. We
                read it as the same number of smallest units in the currency of the invoice. In a
                currency with the same number of decimals, it is the same figure. We do not convert
                the amount.
              </li>
              <li>
                This page does not control promotional credit. We apply promotional credit before
                tax. It is not refundable, and it is always capped at the discounted subtotal of the
                invoice.
              </li>
              <li>
                You can set a lower cap for one subscription through the API (
                <span className="font-mono break-all">max_refundable_credits_usage_minor</span> and{" "}
                <span className="font-mono break-all">max_excess_payment_usage_minor</span>). The
                tighter limit applies. There is no screen for it yet.
              </li>
            </ul>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
