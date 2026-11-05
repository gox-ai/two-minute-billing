import { requirePermission } from "@/lib/session";
import { ActionForm } from "@/components/form/action-form";
import { Input } from "@/components/ui/input";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { DECLINED_REFUND_LABELS, billingRules } from "@/lib/billing-rules";
import { money } from "@/lib/format";
import { majorStep, toMajorInput } from "@/lib/money";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { loadRuleBusiness } from "../_parts/load";
import { saveCollectionRulesAction } from "./actions";

export const dynamic = "force-dynamic";

// Billing rules → Short payments and declined refunds
// (billing_rules_config.partial_payment_write_off, .declined_refund).
const DECLINED: Choice[] = [
  {
    value: "block",
    label: DECLINED_REFUND_LABELS.block,
    consequence:
      "We reverse the refund. The money stays with you, and the payment shows as not refunded. You can refund it again or give credit by hand.",
  },
  {
    value: "issue_credit",
    label: DECLINED_REFUND_LABELS.issue_credit,
    consequence:
      "The refund’s credit note becomes credit for the customer. It pays their next invoices. When you refund the payment again, we pay out this credit first.",
  },
];

export default async function ShortfallsAndRefundsSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");
  const { b, error } = await loadRuleBusiness(biz);
  if (!b) return error;
  const br = billingRules(b);
  const tol = br.partial_payment_write_off;
  // Every business currency, plus any stored one that was later removed.
  const currencies = [
    ...new Set(
      [b.default_currency, ...(b.currencies ?? []), ...Object.keys(tol)]
        .filter((c): c is string => !!c)
        .map((c) => c.toUpperCase()),
    ),
  ];
  const set = Object.entries(tol);

  return (
    <SettingsPage
      title="Short payments and declined refunds"
      crumbs={ruleCrumbs(biz, "Short payments and declined refunds")}
      description="What we do when a recorded payment is a little less than the invoice, and when the gateway declines a refund after it accepted it."
    >
      <ActionForm action={saveCollectionRulesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <SettingsSummary
              items={[
                {
                  label: "Short payments",
                  value: set.length
                    ? `Write off up to ${set.map(([c, m]) => money(m, c)).join(", ")}, and up to ${br.partial_payment_write_off_max_percent}% of the invoice`
                    : "Off",
                },
                { label: "Declined refunds", value: DECLINED_REFUND_LABELS[br.declined_refund] },
              ]}
            />
          }
          save={{ note: "Applies to the next payment you record and the next refund declined." }}
        >
          <SettingsCard title="Short payments" meta="Recorded payments">
            <SettingRow
              label="Write off a small shortfall"
              help="When you record a payment that leaves a small amount unpaid, we write off that amount with a credit note and mark the invoice paid. Leave a currency blank to keep the invoice open."
              errorFor="shortfall"
              control={
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {currencies.map((cur) => (
                    <li key={cur} className="flex flex-wrap items-center gap-2.5">
                      <span className="w-12 text-sm font-medium">{cur}</span>
                      <Input
                        name={`shortfall:${cur}`}
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step={majorStep(cur)}
                        defaultValue={tol[cur] != null ? toMajorInput(tol[cur], cur) : ""}
                        placeholder="Off"
                        className="w-36 tabular-nums"
                        aria-label={`Largest shortfall to write off in ${cur}`}
                      />
                      <span className="text-sm text-muted-foreground">or less</span>
                    </li>
                  ))}
                </ul>
              }
              consequence={
                set.length
                  ? "A shortfall at or below the amount is written off, and the invoice is paid. A larger shortfall keeps the invoice open."
                  : "Off: a part payment keeps the invoice open for the rest."
              }
            />
            <SettingRow
              label="Largest shortfall as a percent of the invoice"
              htmlFor="shortfall_max_percent"
              errorFor="shortfall_max_percent"
              help="The shortfall must also be at or below this percent of the invoice total. This stops an instalment or a small payment from settling an invoice. We never write off a credit purchase."
              control={
                <div className="flex flex-wrap items-center gap-2.5">
                  <Input
                    id="shortfall_max_percent"
                    name="shortfall_max_percent"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={10}
                    required
                    defaultValue={br.partial_payment_write_off_max_percent}
                    className="w-20 tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">% · 1 to 10</span>
                </div>
              }
              consequence={`Example: on an invoice of 1,000.00, we write off at most ${(br.partial_payment_write_off_max_percent * 10).toFixed(2)}.`}
            />
          </SettingsCard>
          <SettingsCard
            title="Declined refunds"
            meta="Refunds that fail after the gateway accepts them"
          >
            <ChoiceRow
              name="declined_refund"
              label="When the gateway declines a refund"
              defaultValue={br.declined_refund}
              options={DECLINED}
            />
            <p className="m-0 border-t px-5 py-3 text-sm text-muted-foreground">
              This applies to refunds of an invoice payment. A refund that the gateway refuses at
              once shows an error, and nothing changes. A credit note refund that fails goes back to
              the credit note. When you refund the payment again, we pay out the credit first.
            </p>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
