import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import type { UnbilledEventOption } from "@/lib/api";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import { savePendingInvoicesAction, saveUnbilledChargesMatrixAction } from "../../actions";
import { ChoiceRow, SwitchRow, type Choice } from "../_parts/rows";
import { FormIds, ruleCrumbs } from "../_parts/shared";
import { AutoCloseRow } from "./auto-close-row";

export const dynamic = "force-dynamic";

type UnbilledEventKey = "on_create" | "on_change" | "on_one_time_charge";

/**
 * The three events with a DECISION POINT that reads a business default
 * (resolveUnbilledChargesConfig):
 *   · on_create — the subscription create route, for the first period;
 *   · on_change — changeSubscription and a recurring item added mid-term (items.ts);
 *   · on_one_time_charge — a one-time item added to a subscription.
 * Term extend, future→active and advance charges have no engine path; reactivation
 * and trial conversion always invoice at once. Tracked in PROGRESS, not rendered.
 * `inherits` = unset follows `default_invoice_immediately`; the FOLLOW choice keeps it
 * unset, so saving this card never takes those events away from that switch.
 */
const EVENTS: Array<{ key: UnbilledEventKey; label: string; help: string; inherits?: boolean }> = [
  {
    key: "on_create",
    label: "New subscription",
    help: "Its first period, when it starts now and not in a trial.",
  },
  {
    key: "on_change",
    label: "Plan or item change",
    help: "A plan, price or quantity change, or a recurring add-on added mid-term.",
    inherits: true,
  },
  {
    key: "on_one_time_charge",
    label: "One-time item added",
    help: "A one-time item added to a running subscription.",
    inherits: true,
  },
];

const options = (what: string): Choice[] => [
  {
    value: "invoice_immediately",
    label: "Invoice immediately",
    consequence: `We invoice ${what.toLowerCase()} immediately.`,
  },
  {
    value: "add_to_unbilled",
    label: "Add to unbilled charges",
    consequence: `${what} waits as an unbilled charge. We bill it on the next invoice.`,
  },
];

/** Form value for "leave this key unset". The action writes no key for it. */
const FOLLOW = "follow";

const CHARGE: Record<UnbilledEventKey, string> = {
  on_create: "The first period",
  on_change: "The prorated charge",
  on_one_time_charge: "The item's charge",
};

// Two independent mechanisms, two forms: per-event invoicing, and pending renewal
// invoices for metered billing.
export default async function UnbilledChargesSettings({
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

  const base = `/businesses/${biz}/settings`;
  const inheritedUnbilled: UnbilledEventOption = b.default_invoice_immediately
    ? "invoice_immediately"
    : "add_to_unbilled";
  const stored = (key: UnbilledEventKey) => {
    const raw = b.unbilled_charges_config?.[key];
    return raw === "invoice_immediately" || raw === "add_to_unbilled" ? raw : null;
  };
  const selected = (row: (typeof EVENTS)[number]): string =>
    stored(row.key) ?? (row.inherits ? FOLLOW : "invoice_immediately");
  const switchLink = (
    <Link
      href={`${base}/billing-rules/update-subscription`}
      className="text-primary hover:underline"
    >
      &ldquo;Invoice change charges immediately&rdquo;
    </Link>
  );
  // The follow choice previews what the switch resolves to today, not a vague default.
  const followChoice = (what: string): Choice => ({
    value: FOLLOW,
    label: "Follow \u201cInvoice change charges immediately\u201d",
    consequence: (
      <>
        Decided by {switchLink} on Update subscription. That switch is{" "}
        {inheritedUnbilled === "invoice_immediately"
          ? `on, so we invoice ${what.toLowerCase()} immediately.`
          : `off, so ${what.toLowerCase()} waits as an unbilled charge.`}
      </>
    ),
  });

  return (
    <SettingsPage
      title="Unbilled charges"
      crumbs={ruleCrumbs(biz, "Unbilled charges")}
      description="For each event, whether we invoice a charge at once or hold it as an unbilled charge. Also, whether metered renewal invoices wait for usage before we finalize them. A request that specifies its choice always wins."
    >
      <ActionForm action={saveUnbilledChargesMatrixAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsCard
          title="By event"
          meta="Used when a request does not specify"
          footer={
            <div className="flex flex-wrap items-center justify-between gap-3 py-1">
              <span className="text-muted-foreground">
                Cancelling has its own rule on{" "}
                <Link
                  href={`${base}/billing-rules/subscription-cancellation`}
                  className="text-primary hover:underline"
                >
                  Subscription cancellation
                </Link>
                , and resuming on{" "}
                <Link
                  href={`${base}/billing-rules/pause-resume`}
                  className="text-primary hover:underline"
                >
                  Pause and resume
                </Link>
                . Reactivation and trial conversion always invoice at once.
              </span>
              <SubmitButton>Save</SubmitButton>
            </div>
          }
        >
          {EVENTS.map((row) => (
            <ChoiceRow
              key={row.key}
              name={row.key}
              label={row.label}
              help={row.help}
              defaultValue={selected(row)}
              options={
                row.inherits
                  ? [followChoice(CHARGE[row.key]), ...options(CHARGE[row.key])]
                  : options(CHARGE[row.key])
              }
              more={
                row.inherits
                  ? "Invoice immediately or Add to unbilled charges decides this event here, whatever the Update subscription switch says."
                  : undefined
              }
            />
          ))}
        </SettingsCard>
      </ActionForm>

      <ActionForm action={savePendingInvoicesAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsCard
          title="Pending renewal invoices"
          meta="For metered billing"
          footer={
            <div className="flex justify-end py-1">
              <SubmitButton>Save</SubmitButton>
            </div>
          }
        >
          <SwitchRow
            name="create_pending_invoices"
            label="Create renewal invoices as pending"
            help="This lets you add usage line items before the invoice is finalized."
            defaultChecked={b.create_pending_invoices ?? false}
            on="Renewal invoices stay pending for usage. We finalize them later."
            off="We issue renewal invoices at once."
          />
          <AutoCloseRow defaultValue={b.auto_close_pending_after_days ?? null} />
        </SettingsCard>
      </ActionForm>
    </SettingsPage>
  );
}
