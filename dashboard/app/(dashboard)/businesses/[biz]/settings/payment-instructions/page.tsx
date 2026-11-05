import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import {
  listPaymentInstructions,
  PAYMENT_INSTRUCTION_KIND_LABELS,
  type PaymentInstruction,
} from "@/lib/api/payment-instructions";
import { ErrorState, EmptyState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import {
  Consequence,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { PaymentInstructionFormFields } from "@/components/settings/payment-instruction-form";
import {
  createPaymentInstructionAction,
  updatePaymentInstructionAction,
  archivePaymentInstructionAction,
} from "../actions";

export const dynamic = "force-dynamic";

/**
 * Settings → Payment instructions, for offline / manual payments. Each instruction is
 * its own card and form, so saving one cannot disturb another. The matching switch is
 * a business preference and lives on Settings → Documents.
 */
export default async function PaymentInstructionSettings({
  params,
}: {
  params: Promise<{ biz: string }>;
}) {
  const { biz } = await params;
  await requirePermission("settings:manage", "admin");

  const base = `/businesses/${biz}/settings`;
  const crumbs = [{ label: "Settings", href: base }, { label: "Payment instructions" }];
  let b;
  let instructions: PaymentInstruction[];
  try {
    b = await getBusiness(biz);
    instructions = await listPaymentInstructions(biz);
  } catch (e) {
    return (
      <SettingsPage title="Payment instructions" crumbs={crumbs}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }
  if (!b)
    return (
      <SettingsPage title="Payment instructions" crumbs={crumbs}>
        <ErrorState title="Not found" description={`We could not find the business ${biz}.`} />
      </SettingsPage>
    );

  const targeting = b.invoice_customization?.payment_instructions?.personalize ?? false;
  // The order documents print in: position, then creation (the API's order).
  const ordered = [...instructions].sort((x, y) => x.position - y.position);
  const documentsLink = (
    <Link href={`${base}/documents`} className="text-primary hover:underline">
      Documents
    </Link>
  );

  const summary = (
    <SettingsSummary
      items={[
        {
          label: "Matching",
          value: targeting
            ? "On. Each instruction shows only on invoices that match its currencies and countries"
            : "Off. Every instruction shows on every invoice",
        },
        {
          label: "Printed in this order",
          value: ordered.length ? (
            <ol className="m-0 list-decimal pl-5">
              {ordered.map((pi) => (
                <li key={pi.id}>{pi.section_title}</li>
              ))}
            </ol>
          ) : (
            "None yet. Invoices show no payment instructions"
          ),
        },
      ]}
    />
  );

  return (
    <SettingsPage
      title="Payment instructions"
      crumbs={crumbs}
      description="How we tell a customer who pays offline where to send the money. We print them on invoices."
    >
      <SettingsColumns summary={summary}>
        {targeting ? null : (
          <Consequence>
            Matching is disabled, so every instruction shows on every invoice. We do not apply the
            currency and country targeting. To target instructions, enable “Match instructions to
            the invoice” under {documentsLink}.
          </Consequence>
        )}

        {instructions.length === 0 ? (
          <SettingsCard title="Your instructions" padded>
            <EmptyState
              title="No payment instructions yet"
              description="Create one below. It shows at the foot of your invoices."
            />
          </SettingsCard>
        ) : (
          instructions.map((pi) => (
            <SettingsCard
              key={pi.id}
              title={pi.section_title}
              meta={metaLine(pi, targeting)}
              actions={
                // Archive, not delete: the row stays so an invoice that printed it can be explained.
                <ActionForm action={archivePaymentInstructionAction}>
                  <input type="hidden" name="biz" value={biz} />
                  <input type="hidden" name="pi_id" value={pi.id} />
                  <SubmitButton size="sm" variant="outline">
                    Stop showing this
                  </SubmitButton>
                </ActionForm>
              }
            >
              <ActionForm action={updatePaymentInstructionAction} className="flex flex-col">
                <input type="hidden" name="biz" value={biz} />
                <input type="hidden" name="pi_id" value={pi.id} />
                {pi.resource_version != null ? (
                  <input type="hidden" name="pi_expected_version" value={pi.resource_version} />
                ) : null}
                <div className="px-5 py-4">
                  <PaymentInstructionFormFields instruction={pi} targeting={targeting} />
                </div>
                <div className="flex justify-end border-t px-5 py-3">
                  <SubmitButton>Save</SubmitButton>
                </div>
              </ActionForm>
            </SettingsCard>
          ))
        )}

        <SettingsCard title="Create a payment instruction" meta="Bank transfer or PayPal">
          <ActionForm action={createPaymentInstructionAction} className="flex flex-col">
            <input type="hidden" name="biz" value={biz} />
            <div className="px-5 py-4">
              <PaymentInstructionFormFields targeting={targeting} />
            </div>
            <div className="flex justify-end border-t px-5 py-3">
              <SubmitButton>Create instruction</SubmitButton>
            </div>
          </ActionForm>
        </SettingsCard>
      </SettingsColumns>
    </SettingsPage>
  );
}

/** Kind · id · targeting, with targeting marked when matching is off. */
function metaLine(pi: PaymentInstruction, targeting: boolean) {
  const target = [...pi.currencies, ...pi.countries].join(", ");
  const parts = [PAYMENT_INSTRUCTION_KIND_LABELS[pi.kind], pi.id];
  if (target) parts.push(targeting ? `Only ${target}` : `Targeting ${target} (not applied)`);
  return parts.join(" · ");
}
