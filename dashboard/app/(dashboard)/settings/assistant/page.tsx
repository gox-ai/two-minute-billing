import { requirePermission } from "@/lib/session";
import { assistantFetch } from "@/lib/assistant-proxy";
import { SettingsCard, SettingsPage, SettingRow } from "@/components/settings/settings-layout";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { ActionButton } from "@/components/action-button";
import { SwitchField } from "@/components/ui/switch";
import { SelectField } from "@/components/ui/select-field";
import { Input } from "@/components/ui/input";
import { ErrorState } from "@/components/states";
import { ASSISTANT_NAME } from "@/lib/assistant";
import {
  removeAssistantKeyAction,
  saveAssistantActionsAction,
  saveAssistantEnabledAction,
  saveAssistantKeyAction,
} from "./actions";
import { ActionsFields } from "./actions-fields";
import { fmtDate } from "@/lib/format-date";

const CRUMBS = [{ label: "Settings", href: "/settings" }, { label: ASSISTANT_NAME }];
const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google" },
];

interface SettingsView {
  enabled: boolean;
  actions_enabled?: boolean;
  money_actions_enabled?: boolean;
  own_key: { provider: string; model: string | null; last4: string | null } | null;
  platform_available: boolean;
  default_models: Record<string, string>;
  usage: {
    platform_tokens: number;
    own_key_tokens: number;
    turns: number;
    cap_tokens: number | null;
    remaining_tokens: number | null;
    allowance: {
      mode: "record" | "enforce";
      usd_cents: number;
      used_usd_cents: number;
      /** What members see: the allowance and its use in credits (1 credit ≈ 1 question). */
      credits: number;
      used_credits: number;
      used_percent: number;
      used_up: boolean;
      renews_at: string;
    } | null;
  };
}

/** One Save per card, at the card's foot, right-aligned. */
function CardSave() {
  return (
    <div className="flex justify-end border-t px-5 py-3">
      <SubmitButton>Save</SubmitButton>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");
const credits = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "credit" : "credits"}`;
const renewsOn = (iso: string) => fmtDate(iso, "UTC");

export default async function AssistantSettingsPage() {
  const me = await requirePermission("settings:view", "admin");
  const canManage = (me.permissions ?? []).includes("settings:manage");
  const res = await assistantFetch("/settings");
  if (!res?.ok) {
    return (
      <SettingsPage title={ASSISTANT_NAME} crumbs={CRUMBS}>
        <ErrorState
          title={`We could not load the ${ASSISTANT_NAME} settings`}
          description="Reload the page."
        />
      </SettingsPage>
    );
  }
  const s = (await res.json()) as SettingsView;
  const providerName = (p: string) => PROVIDERS.find((x) => x.value === p)?.label ?? p;

  return (
    <SettingsPage
      title={ASSISTANT_NAME}
      crumbs={CRUMBS}
      description={`Members ask ${ASSISTANT_NAME} questions about your billing data and about the product. ${ASSISTANT_NAME} reads data with each member's own access. It changes nothing without the member's confirmation.`}
    >
      <SettingsCard title={ASSISTANT_NAME} meta="For every member of this organization">
        <ActionForm action={saveAssistantEnabledAction}>
          <SettingRow
            label={`Enable ${ASSISTANT_NAME}`}
            help="When it is on, a question and the data needed to answer it go to the model provider below."
            placement="end"
            control={
              <SwitchField
                name="enabled"
                defaultChecked={s.enabled}
                disabled={!canManage}
                ariaLabel={`Enable ${ASSISTANT_NAME}`}
              />
            }
          />
          {canManage ? <CardSave /> : null}
        </ActionForm>
      </SettingsCard>

      <SettingsCard title="Actions" meta="Changes that members confirm">
        <ActionForm action={saveAssistantActionsAction}>
          <ActionsFields
            actionsEnabled={s.actions_enabled ?? false}
            moneyActionsEnabled={s.money_actions_enabled ?? false}
            canManage={canManage}
          />
          {canManage ? <CardSave /> : null}
        </ActionForm>
      </SettingsCard>

      <SettingsCard
        title="Model"
        meta={
          s.own_key
            ? `Your ${providerName(s.own_key.provider)} key, ending ${s.own_key.last4 ?? "…"}`
            : s.platform_available
              ? "Two Minute Billing's model"
              : "No model is set up on this installation"
        }
      >
        {s.own_key ? (
          <SettingRow
            label="Your key"
            help={`${providerName(s.own_key.provider)}, model ${s.own_key.model ?? s.default_models[s.own_key.provider] ?? "default"}. Your provider bills you for these questions, and no monthly allowance applies.`}
            control={
              canManage ? (
                <ActionButton
                  resultAction={removeAssistantKeyAction}
                  fields={{}}
                  label="Remove key"
                  size="sm"
                  confirm={{
                    title: "Remove your model key?",
                    description: s.platform_available
                      ? `${ASSISTANT_NAME} then uses Two Minute Billing's model, with the monthly allowance.`
                      : `${ASSISTANT_NAME} then stops: this installation has no other model.`,
                    confirmLabel: "Remove key",
                    destructive: true,
                  }}
                />
              ) : null
            }
          />
        ) : null}
        {canManage ? (
          <ActionForm
            action={saveAssistantKeyAction}
            resetOnSuccess
            className="flex flex-col gap-4 px-5 py-4"
          >
            <p className="m-0 text-sm text-muted-foreground">
              Use your own key to send questions to your own account with a model provider. We test
              the key before we save it. We store it encrypted and show only its last 4 characters.
            </p>
            <div className="grid max-w-[720px] gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <label htmlFor="provider" className="text-sm font-medium">
                  Provider
                </label>
                <SelectField
                  name="provider"
                  id="provider"
                  options={PROVIDERS}
                  placeholder="Select a provider"
                  required
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="model" className="text-sm font-medium">
                  Model
                </label>
                <Input
                  id="model"
                  name="model"
                  placeholder="The provider's default"
                  maxLength={100}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="api_key" className="text-sm font-medium">
                  API key
                </label>
                <Input
                  id="api_key"
                  name="api_key"
                  type="password"
                  autoComplete="off"
                  required
                  maxLength={500}
                />
              </div>
            </div>
            <div className="flex justify-end">
              <SubmitButton>{s.own_key ? "Replace key" : "Save key"}</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </SettingsCard>

      {s.usage.allowance ? (
        <SettingsCard
          title="Included use"
          meta={`Renews on ${renewsOn(s.usage.allowance.renews_at)}`}
        >
          <div className="flex flex-col gap-2 px-5 py-4 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                Your plan includes {credits(s.usage.allowance.credits)} for {ASSISTANT_NAME} each
                month. A credit is about one question.
              </span>
              <span className="text-muted-foreground tabular-nums">
                {credits(s.usage.allowance.used_credits)} used ({s.usage.allowance.used_percent}%)
              </span>
            </div>
            <span
              className="block h-1.5 rounded-full bg-muted"
              role="progressbar"
              aria-label="Included use"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.min(100, s.usage.allowance.used_percent)}
            >
              <span
                className="block h-full rounded-full bg-chart-1"
                style={{ width: `${Math.min(100, s.usage.allowance.used_percent)}%` }}
              />
            </span>
            {s.usage.allowance.used_up ? (
              <p className="m-0 text-muted-foreground">
                {s.usage.allowance.mode === "enforce"
                  ? "You used all of the included use. Questions on our model stop until it renews. To continue now, upgrade your plan or add your own key."
                  : `You used all of the included use. ${ASSISTANT_NAME} continues to answer for now.`}
              </p>
            ) : null}
          </div>
        </SettingsCard>
      ) : null}

      <SettingsCard title="This month" meta="Since the first of the month, UTC">
        <div className="flex flex-wrap gap-px bg-border text-sm">
          <div className="flex-[1_1_12rem] bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Questions</div>
            <div className="tabular-nums">{fmt(s.usage.turns)}</div>
          </div>
          <div className="flex-[1_1_12rem] bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Tokens on our model</div>
            <div className="tabular-nums">
              {fmt(s.usage.platform_tokens)}
              {s.usage.cap_tokens !== null ? ` of ${fmt(s.usage.cap_tokens)}` : ""}
            </div>
          </div>
          <div className="flex-[1_1_12rem] bg-card px-4 py-3">
            <div className="text-xs text-muted-foreground">Tokens on your key</div>
            <div className="tabular-nums">{fmt(s.usage.own_key_tokens)}</div>
          </div>
        </div>
      </SettingsCard>
    </SettingsPage>
  );
}
