import { requirePermission } from "@/lib/session";
import { getBusiness } from "@/lib/api/business-settings";
import { ErrorState } from "@/components/states";
import { ActionForm } from "@/components/form/action-form";
import { CheckboxField } from "@/components/ui/checkbox";
import {
  Consequence,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
} from "@/components/settings/settings-layout";
import { savePauseResumeAction } from "../../actions";
import { ChoiceRow, type Choice } from "../_parts/rows";
import { FormIds, TimeTravelNote, ruleCrumbs } from "../_parts/shared";

export const dynamic = "force-dynamic";

// Billing rules → Pause and resume. Every answer is the default for an OMITTED argument
// on a pause or resume; an explicit one still wins.
//
// Omitted rather than rendered, because each needs an argument only the call supplies:
//   · pause "on a specific date" / "for N billing cycles" — no date or count to store;
//     both stay in the pause dialog.
//   · pause DURATION and resume TIMING — the engine has no parameter for either.
//
// A scheduled pause lands as an immediate pause (scheduled-changes.ts), so the unbilled
// and retry defaults apply at the moment it takes effect.
//
// Defaults mirror resolvePauseConfig (src/modules/subscriptions/pause-config.ts).
const DEFAULTS = {
  pause_option: "immediately",
  unbilled_on_pause: "retain",
  dunning_on_pause: "continue",
  charges_on_resume: "invoice_immediately",
  unpaid_invoices_on_resume: "no_action",
} as const;

type SettingKey = keyof typeof DEFAULTS;

type Row = {
  key: SettingKey;
  label: string;
  /** Short name for the lock list and the summary. */
  short: string;
  help?: string;
  more?: string;
  options: Choice[];
};

const PAUSE_ROWS: Row[] = [
  {
    key: "pause_option",
    label: "When a subscription is paused",
    short: "When to pause",
    more: "You select a pause date, or a number of cycles, on the pause itself.",
    options: [
      {
        value: "immediately",
        label: "Pause immediately",
        consequence: "The pause takes effect at the moment of the request.",
      },
      {
        value: "end_of_term",
        label: "Pause at end of the current term",
        consequence:
          "The subscription stays active and continues to bill until its term ends. Then it pauses.",
      },
    ],
  },
  {
    key: "unbilled_on_pause",
    label: "Unbilled charges when the pause takes effect",
    short: "Unbilled charges on pause",
    help: "One-off or prorated amounts gathered since the last invoice.",
    more: "Applies when the pause takes effect: at once, or when a scheduled pause starts.",
    options: [
      {
        value: "retain",
        label: "Leave them unbilled",
        consequence: "They wait on the account for the next invoice.",
      },
      {
        value: "invoice",
        label: "Invoice them now",
        consequence: "We invoice them when the pause takes effect.",
      },
    ],
  },
  {
    key: "dunning_on_pause",
    label: "Payment retries on unpaid invoices",
    short: "Retries on pause",
    help: "The invoices of the paused subscription that dunning is trying to collect.",
    more: "Applies when the pause takes effect: at once, or when a scheduled pause starts.",
    options: [
      {
        value: "continue",
        label: "Continue retries while paused",
        consequence: "Dunning keeps retrying those invoices on its usual schedule.",
      },
      {
        value: "stop",
        label: "Stop retries",
        consequence:
          "Dunning stops permanently for those invoices, and we mark them not paid. When the subscription resumes, we collect them only if “Collect payment” is set below.",
      },
    ],
  },
];

const RESUME_ROWS: Row[] = [
  {
    key: "charges_on_resume",
    label: "When the paid term ended during the pause",
    short: "Charges on resume",
    help: "Resuming inside the paid term continues it and charges nothing. After the paid term, the new term is a full billing period, and the resume date becomes the billing day. A customer with a fixed billing day keeps that day: the first term then runs to that day, can be shorter or longer than a billing period, and we bill it at the full price.",
    options: [
      {
        value: "invoice_immediately",
        label: "Invoice immediately",
        consequence:
          "A new term starts on the resume date. We invoice and collect it on that date.",
      },
      {
        value: "add_to_unbilled_charges",
        label: "Add to unbilled charges",
        consequence:
          "A new term starts on the resume date. Its full amount waits as an unbilled charge for the next invoice.",
      },
    ],
  },
  {
    key: "unpaid_invoices_on_resume",
    label: "Unpaid invoices when the subscription resumes",
    short: "Unpaid invoices on resume",
    options: [
      {
        value: "no_action",
        label: "Keep as unpaid",
        consequence: "They stay open as they are.",
      },
      {
        value: "schedule_payment_collection",
        label: "Collect payment",
        consequence:
          "We charge each open invoice when the subscription resumes. An invoice whose charge fails stays open.",
      },
    ],
  },
];

export default async function PauseResumeSettings({
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

  const cfg = b.pause_config ?? null;
  const answer = (k: SettingKey): string => cfg?.[k] ?? DEFAULTS[k];
  const locked = new Set(cfg?.locked ?? []);
  const all = [...PAUSE_ROWS, ...RESUME_ROWS];

  const rows = (list: Row[]) =>
    list.map((r) => (
      <ChoiceRow
        key={r.key}
        name={r.key}
        label={r.label}
        help={r.help}
        more={r.more}
        defaultValue={answer(r.key)}
        options={r.options}
      />
    ));

  return (
    <SettingsPage
      title="Pause and resume"
      crumbs={ruleCrumbs(biz, "Pause and resume")}
      description="What a pause or resume does with unbilled charges, retries and unpaid invoices when the request does not specify."
    >
      <ActionForm action={savePauseResumeAction}>
        <FormIds biz={biz} version={b.resource_version} />
        <SettingsColumns
          summary={
            <>
              <SettingsSummary
                items={[
                  ...all.map((r) => ({
                    label: r.short,
                    value: r.options.find((o) => o.value === answer(r.key))?.label ?? answer(r.key),
                  })),
                  {
                    label: "Locked",
                    value: locked.size ? `${locked.size} locked` : "None",
                  },
                ]}
              />
              <TimeTravelNote biz={biz} />
            </>
          }
          save={{ note: "Applies to the next pause or resume that does not set its own options." }}
        >
          <SettingsCard title="Pause" meta="Defaults for a pause">
            {rows(PAUSE_ROWS)}
          </SettingsCard>
          <SettingsCard title="Resume" meta="Defaults for a resume">
            {rows(RESUME_ROWS)}
          </SettingsCard>
          {/* Enforced by the pause and resume API routes (lockedOverrides). */}
          <SettingsCard title="Prevent overriding" meta="Locked defaults">
            <div className="flex flex-col gap-3 px-5 py-4">
              <p className="m-0 text-sm text-muted-foreground">
                Lock the defaults that a pause or resume from the dashboard or the API cannot
                change.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {all.map((r) => (
                  <CheckboxField
                    key={r.key}
                    name="locked"
                    value={r.key}
                    label={r.short}
                    defaultChecked={locked.has(r.key)}
                  />
                ))}
              </div>
              <Consequence>
                A request that sets a locked option to a different value fails. The pause and resume
                dialogs show a locked option as read-only. Scheduled pauses, chargeback pauses and
                the customer portal follow their own settings.
              </Consequence>
            </div>
          </SettingsCard>
        </SettingsColumns>
      </ActionForm>
    </SettingsPage>
  );
}
