"use client";

import * as React from "react";
import { Lock, Pause, Plus, RotateCw, Ban, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Alert } from "@/components/ui/alert";
import { useDefaultState } from "@/lib/use-default-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RadioField } from "@/components/ui/radio-group";
import { SelectField } from "@/components/ui/select-field";
import { NETWORK_RETRY_CAP, STRICTEST_NETWORK_RETRY_CAP } from "@/lib/dunning-caps";
import { majorStep, toMajorInput } from "@/lib/money";
import { More, SettingRow, SettingsCard } from "@/components/settings/settings-layout";
import { SelectAnswer, ToggleAnswer } from "@/components/patterns/settings-page";
import { SettingError } from "@/components/settings/setting-error";
import {
  BANK_DEBIT_MAX_RETRIES,
  DEFAULT_RETRY_DAYS,
  GENERIC_HOLD_AFTER,
  HELD_GRACE_DAYS,
  INVOICE_OPTIONS,
  SUBSCRIPTION_HELP,
  SUBSCRIPTION_OPTIONS,
  finalActionsLine,
  listDays,
  plainLine,
  unheldLine,
  type FinalInvoice,
  type FinalSubscription,
} from "./copy";

export interface DunningDefaults {
  enabled: boolean;
  mode: "smart" | "fixed";
  days: number[];
  periodDays: number | null;
  finalInvoice: FinalInvoice;
  finalSubscription: FinalSubscription;
  /** Per payment method retry days; empty = the main schedule. */
  methodDays: Record<"card" | "bank_debit" | "offline", number[]>;
  /** Smart mode's adaptive cadences, resolved. */
  cadence: {
    transientHours: number[];
    genericDays: number[];
    fundsGapDays: number | null;
    fundsMaxRetries: number;
  };
  skipHardFailures: boolean;
  parkHardDeclines: boolean;
  adaptiveTiming: boolean;
  dunTrialFuture: boolean;
  dunOneTime: boolean;
  dunOffline: boolean;
  collectOnPm: boolean;
  cancelNoPmAtRenewal: boolean;
  /** Currency → minimum amount due (minor units) before dunning chases an invoice. */
  minimumAmounts: Record<string, number>;
  /** The business's currencies, for the minimum rows. */
  currencies: string[];
}

const MAX_RETRIES = 8;

/**
 * Every Dunning field, as one client island so the mode switch (and every other
 * value) re-renders the consequences without a save. A section hidden by the mode
 * stays MOUNTED, so its hidden inputs still post and a save never wipes it.
 *
 * `policy`: a named dunning policy holds only the per-invoice keys, so the two
 * business-wide switches ("Payment methods") are not rendered. `d.collectOnPm` is then
 * the business's value, read for copy only.
 */
export function DunningFields({ d, policy = false }: { d: DunningDefaults; policy?: boolean }) {
  const [enabled, setEnabled] = useDefaultState(d.enabled);
  const [mode, setMode] = useDefaultState<string>(d.mode);
  const [skip, setSkip] = useDefaultState(d.skipHardFailures);
  const [hold, setHold] = useDefaultState(d.parkHardDeclines);
  const [adaptive, setAdaptive] = useDefaultState(d.adaptiveTiming);
  const [periodText, setPeriodText] = useDefaultState(
    d.periodDays == null ? "" : String(d.periodDays),
  );
  const [inv, setInv] = useDefaultState<string>(d.finalInvoice);
  const [sub, setSub] = useDefaultState<string>(d.finalSubscription);
  const [fundsMode, setFundsMode] = useDefaultState<string>(
    d.cadence.fundsGapDays == null ? "paydays" : "days",
  );
  const [trialFuture, setTrialFuture] = useDefaultState(d.dunTrialFuture);
  const [oneTime, setOneTime] = useDefaultState(d.dunOneTime);
  const [offline, setOffline] = useDefaultState(d.dunOffline);
  const [collect, setCollect] = useDefaultState(d.collectOnPm);
  const [cancelNoPm, setCancelNoPm] = useDefaultState(d.cancelNoPmAtRenewal);
  const [gapText, setGapText] = useDefaultState(String(d.cadence.fundsGapDays ?? 3));
  const [maxText, setMaxText] = useDefaultState(String(d.cadence.fundsMaxRetries));

  // Retry rows keep stable keys across removals so inputs keep their own values.
  const nextKey = React.useRef(d.days.length);
  const [rows, setRows] = useDefaultState(
    d.days.map((v, i) => ({ key: i, value: String(v) })),
    (r) => r.map((x) => x.value).join(","),
  );

  const typed = rows.map((r) => Number(r.value)).filter((n) => Number.isInteger(n) && n >= 1);
  const days = rows.length ? typed : DEFAULT_RETRY_DAYS;
  const periodNum = Number(periodText);
  const period =
    periodText.trim() !== "" && Number.isInteger(periodNum) && periodNum >= 1 ? periodNum : null;
  const smart = mode === "smart";
  const lastDay = days[days.length - 1];
  const heldWindow = period ?? HELD_GRACE_DAYS;
  const finalLine = finalActionsLine(inv as FinalInvoice, sub as FinalSubscription);

  const addRow = () => {
    if (rows.length >= MAX_RETRIES) return;
    const last = Number(rows[rows.length - 1]?.value);
    const suggestion =
      Number.isInteger(last) && last >= 1 && last < 90 ? String(Math.min(last + 2, 90)) : "";
    setRows((r) => [...r, { key: nextKey.current++, value: suggestion }]);
  };

  return (
    <>
      {/* One state, two switches (Smart's group header, Fixed's row): post it once. */}
      {hold ? <input type="hidden" name="park_hard_declines" value="on" /> : null}

      <SettingsCard title="Dunning">
        <SettingRow
          label="Retry failed payments"
          help="Automatic retries recover failed payments."
          placement="end"
          control={
            <ToggleAnswer
              name="dunning_enabled"
              label="Retry failed payments"
              checked={enabled}
              onCheckedChange={setEnabled}
            />
          }
          consequence={
            <>
              {enabled ? "When off" : "Off"}: a failed charge marks the invoice <b>not paid</b>, and
              we retry nothing. The debt stays, and you can collect it manually.
            </>
          }
        />
      </SettingsCard>

      <SettingsCard
        title="Decline handling"
        meta={
          smart ? "What happens to a declined payment" : "Every decline follows the retry schedule"
        }
      >
        <SettingRow
          label="Decline handling"
          htmlFor="dunning_mode"
          help="Smart reads the reason that the bank gave and acts on it: we retry some declines, hold some and stop some. Fixed treats every decline the same way: the retry schedule runs, with one switch for hard declines."
          placement="end"
          control={
            <SelectAnswer
              name="dunning_mode"
              ariaLabel="Decline handling"
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "smart", label: "Smart" },
                { value: "fixed", label: "Fixed" },
              ]}
            />
          }
        />

        {/* Smart: the decline table. Hidden in Fixed, but its switch state lives above. */}
        <div className={cn(!smart && "hidden")}>
          <SmartTable
            holdAfter={adaptive ? d.cadence.genericDays.length + 1 : GENERIC_HOLD_AFTER}
            days={days}
            period={period}
            hold={hold}
            onHold={setHold}
            heldWindow={heldWindow}
            collect={collect}
            policy={policy}
          />
        </div>

        {/* Fixed: Skip, and Hold scoped to what Fixed reads (only while Skip is on). */}
        <div className={cn("divide-y border-t", smart && "hidden")}>
          <SettingRow
            label="Skip retries for hard failures"
            help="We do not retry a decline that the gateway marks as hard, for example a stolen or expired card. Nothing changes until the customer acts."
            placement="end"
            control={
              <ToggleAnswer
                name="skip_retries_for_hard_failures"
                label="Skip retries for hard failures"
                checked={skip}
                onCheckedChange={setSkip}
              />
            }
            consequence={
              !skip
                ? "Off: every decline runs the full retry schedule."
                : period == null
                  ? "No dunning period is set, so a hard decline applies the final actions at once. Disable this to run the full retry schedule on every decline."
                  : `We do not retry a hard decline. The invoice stays open and payable until day ${period}. Then it gets one last try, and then the final actions.`
            }
          />
          <div className={cn(!skip && "hidden")}>
            <SettingRow
              label="Hold refusals that are not the card's fault"
              help="This covers: a mandate that is over its limit, lapsed, used up or missing. Bank authentication that is not complete. A limit or setting on our gateway account, or a request that it rejected. No payment method on file, or one that the gateway no longer has. A card network answer of “do not retry”."
              placement="end"
              control={
                <ToggleAnswer
                  label="Hold refusals that are not the card's fault"
                  checked={hold}
                  onCheckedChange={setHold}
                />
              }
              consequence={
                hold
                  ? period == null
                    ? `On: these refusals wait. We hold the invoice open for ${HELD_GRACE_DAYS} days from the refusal, so that the customer or you can fix the problem. Then it gets one last try.`
                    : `On: these refusals wait. We hold the invoice open until day ${period} after the due date, so that the customer or you can fix the problem. Then it gets one last try.`
                  : `Off: we retry these like any other decline. ${unheldLine(days, period)}`
              }
            />
          </div>
          {!skip ? (
            <p className="m-0 px-5 py-3 text-xs text-muted-foreground">
              &ldquo;Hold refusals that are not the card&rsquo;s fault&rdquo; applies only while
              &ldquo;Skip retries for hard failures&rdquo; is enabled.
            </p>
          ) : null}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Retry schedule"
        meta={rows.length ? `${rows.length} of ${MAX_RETRIES} retries` : "Default schedule"}
      >
        <div className="flex flex-col gap-4 px-5 py-4">
          <p className="m-0 text-xs leading-normal text-muted-foreground">
            Each retry counts from the invoice&rsquo;s due date. An invoice with no due date counts
            from the first failure. Remove every retry to use the default: days{" "}
            {listDays(DEFAULT_RETRY_DAYS)}.
          </p>
          <div className="flex flex-col gap-2">
            {rows.length === 0 ? (
              <p className="m-0 rounded-md bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
                No custom schedule. The default applies: days {listDays(DEFAULT_RETRY_DAYS)}.
              </p>
            ) : (
              <>
                {/* One header for the columns: a label on every row would repeat it. */}
                <div className="flex gap-2.5 text-sm font-medium" aria-hidden="true">
                  <span className="w-12 shrink-0">Retry</span>
                  <span>After the due date</span>
                </div>
                <ol className="m-0 flex list-none flex-col gap-2 p-0">
                  {rows.map((row, i) => (
                    <li key={row.key} className="flex items-center gap-2.5">
                      <span className="w-12 shrink-0 text-sm text-muted-foreground tabular-nums">
                        {i + 1}
                      </span>
                      <Input
                        name="retry_days"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={90}
                        required
                        value={row.value}
                        onChange={(e) =>
                          setRows((r) =>
                            r.map((x) => (x.key === row.key ? { ...x, value: e.target.value } : x)),
                          )
                        }
                        className="w-20 tabular-nums"
                        aria-label={`Retry ${i + 1}, days after the due date`}
                      />
                      <span className="text-sm whitespace-nowrap text-muted-foreground">days</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                        aria-label={`Remove retry ${i + 1}`}
                      >
                        <X className="size-4" aria-hidden />
                      </Button>
                    </li>
                  ))}
                </ol>
              </>
            )}
            <SettingError name="retry_days" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-2 self-start text-primary"
              onClick={addRow}
              disabled={rows.length >= MAX_RETRIES}
            >
              <Plus className="size-4" aria-hidden /> Add retry
              {rows.length >= MAX_RETRIES ? ` (max ${MAX_RETRIES})` : ""}
            </Button>
          </div>

          <Timeline days={days} period={period} />

          <MethodSchedules d={d} days={days} />

          {days.length > STRICTEST_NETWORK_RETRY_CAP ? <RailCapNote days={days} /> : null}
        </div>

        {/* Smart only. Kept mounted in Fixed so its stored value posts back. */}
        <div className={cn(!smart && "hidden")}>
          <SettingRow
            className="border-t"
            label="Adaptive retry timing"
            help="Time each retry by why the payment failed, instead of the days above."
            placement="end"
            control={
              <ToggleAnswer
                name="adaptive_timing"
                label="Adaptive retry timing"
                checked={adaptive}
                onCheckedChange={setAdaptive}
              />
            }
            consequence={
              adaptive
                ? "On: card retries follow the timings below. Mandate debits and every other decline keep the days above."
                : "Off: every retry uses the days above."
            }
          >
            {/* While the switch is off the inputs are disabled; a disabled input does not
                post, so each one mirrors its value in a hidden input and the stored value
                survives the save. */}
            <div className="flex flex-col gap-3 text-sm">
              <CadenceInput
                name="cadence_transient_hours"
                label="Gateway or network fault"
                unit="Hours after each failure, 1 to 168"
                value={d.cadence.transientHours}
                disabled={!adaptive}
              />
              <CadenceInput
                name="cadence_generic_days"
                label="Generic decline"
                unit="Days after each failure, 1 to 14"
                value={d.cadence.genericDays}
                disabled={!adaptive}
              />
              <div className={CADENCE_ROW}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className={cn("font-medium", !adaptive && "text-muted-foreground")}>
                    Insufficient funds
                  </span>
                  <span className="text-xs text-muted-foreground">When to retry the card</span>
                </div>
                <div className="flex w-full min-w-0 shrink-0 flex-col gap-2.5 sm:w-72">
                  <RadioField
                    name="cadence_funds_mode"
                    ariaLabel="Insufficient funds timing"
                    value={fundsMode}
                    onValueChange={setFundsMode}
                    options={[
                      {
                        value: "paydays",
                        label: "Next likely payday",
                        hint: "The 1st, 15th or last day of the month.",
                        disabled: !adaptive,
                      },
                      {
                        value: "days",
                        label: "A fixed number of days",
                        disabled: !adaptive,
                      },
                    ]}
                  />
                  {/* Belongs to the "fixed number of days" option: indented under its label. */}
                  <div
                    className={cn(
                      "flex items-center gap-2.5 pl-7",
                      fundsMode !== "days" && "hidden",
                    )}
                  >
                    <Input
                      name="cadence_funds_gap_days"
                      disabled={!adaptive || fundsMode !== "days"}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={14}
                      value={gapText}
                      onChange={(e) => setGapText(e.target.value)}
                      className="w-20 tabular-nums"
                      aria-label="Days after each insufficient-funds failure"
                    />
                    <span className="whitespace-nowrap text-muted-foreground">
                      days after each failure
                    </span>
                    {!adaptive && fundsMode === "days" ? (
                      <input type="hidden" name="cadence_funds_gap_days" value={gapText} />
                    ) : null}
                  </div>
                </div>
              </div>
              <div className={CADENCE_ROW}>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <label
                    htmlFor="cadence_funds_max_retries"
                    className={cn("font-medium", !adaptive && "text-muted-foreground")}
                  >
                    Most retries for insufficient funds
                  </label>
                  <span className="text-xs text-muted-foreground">1 to 6, with either timing</span>
                </div>
                <div className="flex shrink-0 items-center gap-2.5 sm:w-72">
                  <Input
                    id="cadence_funds_max_retries"
                    name="cadence_funds_max_retries"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={6}
                    required
                    disabled={!adaptive}
                    value={maxText}
                    onChange={(e) => setMaxText(e.target.value)}
                    className="w-20 tabular-nums"
                  />
                  <span className="text-muted-foreground">retries</span>
                  {!adaptive ? (
                    <input type="hidden" name="cadence_funds_max_retries" value={maxText} />
                  ) : null}
                </div>
              </div>
            </div>
            <p className="m-0 text-xs leading-normal text-muted-foreground">
              Day-based retries run at 10:00 in the card&rsquo;s country. If the country is unknown,
              they use your business time zone. They never run more than 30 days after the due date
              or after the dunning period ends. These timings are general guidance, not network
              requirements. Compare your recovery rate before and after you enable them.
            </p>
          </SettingRow>
        </div>
        {!smart ? (
          <p className="m-0 border-t px-5 py-3 text-xs text-muted-foreground">
            Adaptive retry timing is a Smart setting.
          </p>
        ) : null}
      </SettingsCard>

      <SettingsCard id="period" title="When dunning ends">
        <SettingRow
          label="Dunning period"
          htmlFor="dunning_period_days"
          errorFor="dunning_period_days"
          help="1 to 365 days. Leave it blank for no deadline. The final actions apply at the end of the period, after one last try on its final day."
          placement="end"
          control={
            <div className="flex items-center gap-2.5">
              <Input
                id="dunning_period_days"
                name="dunning_period_days"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={periodText}
                onChange={(e) => setPeriodText(e.target.value)}
                className="w-20 tabular-nums"
              />
              <span className="text-sm whitespace-nowrap text-muted-foreground">
                days after the due date
              </span>
            </div>
          }
          consequence={
            period == null ? (
              <>
                Blank: dunning ends when the last retry fails
                {lastDay == null ? "." : ` (day ${lastDay}).`}
                {smart || skip
                  ? ` Held invoices, and declines that we would hold, still close after ${HELD_GRACE_DAYS} days.`
                  : null}
                {offline ? " Offline invoices never close." : null}
              </>
            ) : (
              <>
                Day {period}: one last try
                {days.some((x) => x > period) ? `, and we drop retries after day ${period}` : ""},
                then the final actions.
                {smart ? ` Held invoices close ${period} days after they were held.` : null}
              </>
            )
          }
        />
        <SettingRow
          label="Final action for the invoice"
          htmlFor="final_invoice_action"
          help="What happens to an invoice that is still unpaid when dunning ends."
          placement="end"
          control={
            <SelectAnswer
              name="final_invoice_action"
              ariaLabel="Final action for the invoice"
              value={inv}
              onValueChange={setInv}
              options={INVOICE_OPTIONS}
            />
          }
        />
        <SettingRow
          label="Final action for the subscription"
          htmlFor="final_subscription_action"
          help="What happens to the subscription of that invoice."
          placement="end"
          control={
            <SelectAnswer
              name="final_subscription_action"
              ariaLabel="Final action for the subscription"
              value={sub}
              onValueChange={setSub}
              options={SUBSCRIPTION_OPTIONS}
            />
          }
          consequence={
            <>
              Unpaid at the end: {finalLine}. {SUBSCRIPTION_HELP[sub as FinalSubscription]}
            </>
          }
        />
      </SettingsCard>

      <SettingsCard title="Which invoices get dunning">
        <SettingRow
          label="Future and trial subscriptions"
          help="A failed activation charge on a subscription that is still scheduled or in trial."
          placement="end"
          control={
            <ToggleAnswer
              name="dun_trial_and_future_subscriptions"
              label="Dunning for future and trial subscriptions"
              checked={trialFuture}
              onCheckedChange={setTrialFuture}
            />
          }
          consequence={
            trialFuture
              ? "On: dunning runs as for any other subscription invoice."
              : "Off: we mark the invoice not paid and retry nothing."
          }
        />
        <SettingRow
          label="One-time invoices"
          help="Invoices with no subscription behind them."
          placement="end"
          control={
            <ToggleAnswer
              name="dun_one_time_invoices"
              label="Dunning for one-time invoices"
              checked={oneTime}
              onCheckedChange={setOneTime}
            />
          }
          consequence={
            oneTime
              ? "On: we retry them like subscription invoices. The final invoice action applies at the end."
              : "Off: we do not retry them. If you enable this, we start to retry them and apply the final invoice action at the end."
          }
        />
        <MinimumAmounts d={d} />
        <SettingRow
          label="Send-invoice (offline) invoices"
          help="Invoices with auto-collection off. We never charge them. We remind the customer on each retry day, and the customer can pay in their portal."
          placement="end"
          control={
            <ToggleAnswer
              name="dun_offline_invoices"
              label="Dunning for send-invoice (offline) invoices"
              checked={offline}
              onCheckedChange={setOffline}
            />
          }
          consequence={
            !offline
              ? "Off: we send no reminders. The invoice becomes not paid on its due date, and no final action applies."
              : period == null
                ? "On, with no dunning period: reminders continue, and the final actions never apply. Set a period to end dunning."
                : `On: we send a reminder on each retry day. If the invoice is still unpaid on day ${period}, ${finalLine}.`
          }
        />
      </SettingsCard>

      {policy ? null : (
        <SettingsCard title="Payment methods">
          <SettingRow
            label="Collect open invoices when a payment method is added"
            help="When a customer adds or updates a card, charge their open payment-due invoices at once, oldest first. We do not charge offline invoices."
            placement="end"
            control={
              <ToggleAnswer
                name="collect_on_payment_method_update"
                label="Collect open invoices when a payment method is added"
                checked={collect}
                onCheckedChange={setCollect}
              />
            }
            consequence={
              collect
                ? "On: we charge a held invoice as soon as the customer changes their card."
                : "Off: we do not charge a new card at once. Open invoices wait for their next try, or for the customer to pay in the portal."
            }
          />
          <SettingRow
            label="Cancel at renewal when there is no payment method"
            help="A subscription that auto-collects but whose customer has no payment method at all. We still retry an expired or declined card as usual."
            placement="end"
            control={
              <ToggleAnswer
                name="no_payment_method_at_renewal_cancel"
                label="Cancel at renewal when there is no payment method"
                checked={cancelNoPm}
                onCheckedChange={setCancelNoPm}
              />
            }
            consequence={
              cancelNoPm
                ? "On: we cancel the subscription on its renewal date, even if the final subscription action is Keep active."
                : "Off: we raise the renewal invoice, and dunning runs on it."
            }
          />
        </SettingsCard>
      )}
    </>
  );
}

/**
 * Per-currency minimum amount due. Rows post as paired `min_currency` / `min_amount`
 * (major units); no rows = no minimum.
 */
function MinimumAmounts({ d }: { d: DunningDefaults }) {
  const initial = Object.entries(d.minimumAmounts).map(([currency, minor], i) => ({
    key: i,
    currency,
    amount: toMajorInput(minor, currency),
  }));
  const nextKey = React.useRef(initial.length);
  const [rows, setRows] = useDefaultState(initial, (r) =>
    r.map((x) => `${x.currency}:${x.amount}`).join(","),
  );
  const used = new Set(rows.map((r) => r.currency));
  const free = d.currencies.filter((c) => !used.has(c));
  const update = (key: number, patch: Partial<{ currency: string; amount: string }>) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const editor = (
    <div className="flex flex-col gap-2">
      {rows.length ? (
        <>
          {/* One header for the columns: a label on every row would repeat it. */}
          <div className="flex gap-2.5 text-sm font-medium" aria-hidden="true">
            <span className="w-30">Currency</span>
            <span className="w-30">Amount</span>
          </div>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {rows.map((row, i) => (
              <li key={row.key} className="flex items-center gap-2.5">
                <SelectField
                  id={`min_currency_${row.key}`}
                  name="min_currency"
                  ariaLabel={`Minimum ${i + 1} currency`}
                  value={row.currency}
                  onValueChange={(currency) => update(row.key, { currency })}
                  options={[row.currency, ...free].map((c) => ({ value: c, label: c }))}
                  className="w-30"
                />
                <Input
                  name="min_amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step={majorStep(row.currency)}
                  required
                  value={row.amount}
                  onChange={(e) => update(row.key, { amount: e.target.value })}
                  className="w-30 tabular-nums"
                  aria-label={`Minimum amount due in ${row.currency}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
                  aria-label={`Remove the minimum for ${row.currency}`}
                >
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="-ml-2 self-start text-primary"
        disabled={free.length === 0}
        onClick={() =>
          setRows((r) => [...r, { key: nextKey.current++, currency: free[0]!, amount: "" }])
        }
      >
        <Plus className="size-4" aria-hidden /> Add minimum
      </Button>
    </div>
  );

  return (
    <SettingRow
      label="Minimum amount due"
      help="Dunning starts only when the amount that is still due on an invoice is at or above the minimum for its currency. A part payment can take an invoice below the minimum."
      errorFor="min_amount"
      control={editor}
      consequence={
        rows.length === 0
          ? "No minimum: dunning applies to every unpaid invoice."
          : "Below the minimum: dunning does not start, and we do not retry or send reminders. The first payment attempt on a new invoice still occurs."
      }
    />
  );
}

type Verdict = "retry" | "hold" | "stop";

const VERDICT: Record<Verdict, { icon: typeof RotateCw; text: string }> = {
  retry: { icon: RotateCw, text: "Retry on the schedule" },
  hold: { icon: Pause, text: "Hold" },
  stop: { icon: Ban, text: "Stop now" },
};

function SmartTable({
  holdAfter,
  days,
  period,
  hold,
  onHold,
  heldWindow,
  collect,
  policy,
}: {
  holdAfter: number;
  days: number[];
  period: number | null;
  hold: boolean;
  onHold: (v: boolean) => void;
  heldWindow: number;
  collect: boolean;
  policy: boolean;
}) {
  const unheld = unheldLine(days, period);
  return (
    <div className="border-t">
      <div className="hidden grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-5 border-b bg-muted/50 px-5 py-2 text-xs font-medium text-muted-foreground sm:grid">
        <span>Decline reason</span>
        <span>What we do</span>
      </div>

      <GroupHeader title="Always">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock aria-hidden className="size-3" /> Not configurable
        </span>
      </GroupHeader>
      <DeclineRow
        name="Temporary problems"
        codes="Insufficient funds · issuer unavailable · processing error · try again later · any reason we do not recognize"
        verdict="retry"
        line={plainLine(days, period)}
      />
      <DeclineRow
        name="Lost, stolen or seized card"
        codes="Lost card · stolen card · issuer asked for the card to be picked up"
        verdict="hold"
        label="Hold for a new card"
        line="We never retry this card. We ask the customer for a new card."
      />
      <DeclineRow
        name="Fraud or revoked authorization"
        codes="Fraudulent charge · authorization revoked · debit not authorized by the payer"
        verdict="stop"
        line="No retries. The final actions apply immediately."
      />

      <GroupHeader title="Your choice">
        <span className="ml-auto inline-flex items-center gap-2 text-sm font-medium">
          <span aria-hidden>Hold hard declines for the customer</span>
          <ToggleAnswer
            label="Hold hard declines for the customer"
            checked={hold}
            onCheckedChange={onHold}
          />
        </span>
      </GroupHeader>
      <DeclineRow
        name="Generic decline"
        codes="Card declined · do not honor · the bank gave no reason"
        verdict="retry"
        label={hold ? "Retry, then hold" : undefined}
        line={
          hold
            ? `We retry until ${holdAfter} attempts fail, or until the retries run out. Then we hold it for the customer.`
            : unheld
        }
        alt={
          hold
            ? `If not held: ${unheld}`
            : `If held: we retry until ${holdAfter} attempts fail, then hold it for the customer.`
        }
      />
      <DeclineRow
        name="Customer can fix it"
        codes="Expired, invalid or restricted card · authentication (3DS) needed · mandate lapsed, used up, missing or over its limit · bank authentication not completed · bank account closed or invalid · no payment method · card network said do not retry"
        verdict={hold ? "hold" : "retry"}
        label={hold ? "Hold for the customer" : undefined}
        line={hold ? "We do not retry. We hold it for the customer at once." : unheld}
        alt={
          hold
            ? `If not held: ${unheld}`
            : "If held: we do not retry, and we hold it for the customer at once."
        }
      />
      <DeclineRow
        name="Our gateway account cannot take it"
        codes="Recurring payments not enabled · gateway amount limit · request rejected by the gateway · gateway account unavailable"
        verdict={hold ? "hold" : "retry"}
        label={hold ? "Hold until you fix it" : undefined}
        line={hold ? "We do not retry. We hold it until you correct the account." : unheld}
        alt={
          hold
            ? `If not held: ${unheld}`
            : "If held: we do not retry, and we hold it until you correct the account."
        }
      />

      <div className="flex items-start gap-2 px-5 py-3.5 text-sm leading-normal text-muted-foreground">
        <Pause aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          <b className="font-semibold text-foreground">Held</b> means the invoice stays open and
          payable, and we ask the customer to update their payment method.
          {collect
            ? " We charge it as soon as they do."
            : policy
              ? " They can pay it in the portal. Charging a new card at once is disabled in the business dunning settings."
              : " They can pay it in the portal. Charging a new card at once is disabled under Payment methods."}{" "}
          {heldWindow} days after we hold it, we try once more and then apply the final actions. We
          never try again on a lost or stolen card.
          {period == null ? ` Set a dunning period to change the ${HELD_GRACE_DAYS} days.` : null}
        </span>
      </div>
    </div>
  );
}

function GroupHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-5 py-3">
      <span className="text-xs font-medium text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}

function DeclineRow({
  name,
  codes,
  verdict,
  label,
  line,
  alt,
}: {
  name: string;
  codes: string;
  verdict: Verdict;
  label?: string;
  line: string;
  alt?: string;
}) {
  const V = VERDICT[verdict];
  return (
    <div className="grid grid-cols-1 items-start gap-x-5 gap-y-2 border-b px-5 py-3.5 sm:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
      <div className="min-w-0">
        <p className="m-0 text-sm font-semibold">{name}</p>
        <p className="m-0 mt-1 text-xs leading-normal text-muted-foreground">{codes}</p>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 text-sm leading-normal">
        <span className="text-xs font-medium text-muted-foreground sm:hidden">What we do</span>
        <span className="inline-flex items-center gap-1.5 self-start rounded-full border bg-muted px-2.5 py-0.5 text-xs font-medium">
          <V.icon aria-hidden className="size-3" />
          {label ?? V.text}
        </span>
        <span>{line}</span>
        {alt ? <span className="text-xs text-muted-foreground">{alt}</span> : null}
      </div>
    </div>
  );
}

function Timeline({ days, period }: { days: number[]; period: number | null }) {
  const runs = period == null ? days : days.filter((x) => x <= period);
  const steps: Array<{ d: string; x: string; tone: "muted" | "retry" | "end" }> = [
    { d: "Due", x: "Charge fails", tone: "muted" },
    ...runs.map((day, i) => ({ d: `Day ${day}`, x: `Retry ${i + 1}`, tone: "retry" as const })),
    ...(period != null && runs[runs.length - 1] !== period
      ? [{ d: `Day ${period}`, x: "Last try", tone: "retry" as const }]
      : []),
    { d: "Then", x: "Final actions", tone: "end" },
  ];
  return (
    <div className="-mx-1 overflow-x-auto px-1" aria-label="Retry timeline preview" role="group">
      <ol className="relative m-0 flex min-w-max list-none items-start p-0 sm:min-w-0">
        <span aria-hidden className="absolute top-1.5 right-[6%] left-[6%] h-0.5 bg-border" />
        {steps.map((s, i) => (
          <li
            key={i}
            className="relative flex min-w-16 flex-1 flex-col items-center gap-1 text-center"
          >
            <span
              aria-hidden
              className={cn(
                "relative z-1 size-3 rounded-full border-[3px] bg-card",
                s.tone === "retry" && "border-primary",
                s.tone === "muted" && "border-muted-foreground",
                s.tone === "end" && "border-foreground/70",
              )}
            />
            <span className="text-xs font-semibold tabular-nums">{s.d}</span>
            <span className="text-xs leading-snug text-muted-foreground">{s.x}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Label and help on the left, the field on the card's right edge. */
const CADENCE_ROW =
  "flex flex-col gap-1.5 border-t pt-3 first:border-t-0 first:pt-0 sm:flex-row sm:items-start sm:justify-between sm:gap-8";

/** One adaptive cadence as a comma-separated list (posted as text, parsed on the server). */
function CadenceInput({
  name,
  label,
  unit,
  value,
  disabled,
}: {
  name: string;
  label: string;
  unit: string;
  value: number[];
  disabled: boolean;
}) {
  const [text, setText] = useDefaultState(value.join(", "));
  return (
    <div className={CADENCE_ROW}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={name} className={cn("font-medium", disabled && "text-muted-foreground")}>
          {label}
        </label>
        <span className="text-xs text-muted-foreground">{unit}</span>
      </div>
      <Input
        id={name}
        name={name}
        required
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="w-full shrink-0 tabular-nums sm:w-72"
      />
      {disabled ? <input type="hidden" name={name} value={text} /> : null}
    </div>
  );
}

/** Per payment method schedules (2.48). Blank = the main schedule above. */
function MethodSchedules({ d, days }: { d: DunningDefaults; days: number[] }) {
  const rows = [
    {
      kind: "card",
      label: "Cards",
      hint: "Up to 8 retries.",
    },
    {
      kind: "bank_debit",
      label: "Bank debits",
      hint: `ACH, SEPA, Bacs, BECS, PAD, e-mandate and NACH. Up to ${BANK_DEBIT_MAX_RETRIES} retries. Network limits and spacing still apply, and we never retry while a debit is pending.`,
    },
    {
      kind: "offline",
      label: "Offline invoices",
      hint: "Reminder days for invoices with automatic collection off.",
    },
  ] as const;
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div>
        <p className="m-0 text-sm font-semibold">By payment method</p>
        <p className="m-0 mt-1 text-xs text-muted-foreground">
          Days after the due date, with commas between them. Leave a row blank to use the schedule
          above. Other methods (UPI, wallets, PayPal) use the schedule above.
        </p>
      </div>
      {rows.map((r) => (
        <div
          key={r.kind}
          className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-8"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <label htmlFor={`method_days_${r.kind}`} className="text-sm font-medium">
              {r.label}
            </label>
            <span className="text-xs text-muted-foreground">{r.hint}</span>
          </div>
          <div className="flex shrink-0 flex-col gap-1">
            <div className="flex items-center gap-2.5">
              <Input
                id={`method_days_${r.kind}`}
                name={`method_days_${r.kind}`}
                defaultValue={d.methodDays[r.kind].join(", ")}
                aria-describedby={`method_days_${r.kind}_blank`}
                className="w-full tabular-nums sm:w-72"
              />
              <span className="text-sm whitespace-nowrap text-muted-foreground">days</span>
            </div>
            <span id={`method_days_${r.kind}_blank`} className="text-xs text-muted-foreground">
              {days.length ? `Blank: days ${listDays(days)}` : "Blank: the schedule above"}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** NPCI caps per rail; shown only when the schedule outruns the strictest one. */
function RailCapNote({ days }: { days: number[] }) {
  const upi = days.slice(0, NETWORK_RETRY_CAP.upi);
  const emandate = days.slice(0, NETWORK_RETRY_CAP.emandate);
  const indiaCard = days.slice(0, NETWORK_RETRY_CAP.card);
  const upiCut = days.length > NETWORK_RETRY_CAP.upi;
  return (
    <Alert tone="neutral">
      <div className="min-w-0">
        <b className="font-semibold">Indian mandate debits retry fewer times.</b> The network caps
        re-presentations: UPI Autopay gets{" "}
        {upiCut ? `the first ${upi.length} (days ${listDays(upi)})` : `all ${days.length}`},
        netbanking e-mandate the first {emandate.length} (days {listDays(emandate)}), at least 3
        days after the previous return, cards issued in India the first {indiaCard.length} (days{" "}
        {listDays(indiaCard)}). Other cards and every other rail get all {days.length}.
        <More>
          We stop at that limit. We do not present a debit that the network rejects (UPI) or that
          counts against the return rate (e-mandate). We retry an e-mandate debit only when the bank
          returned it for insufficient money. When the gateway retries a UPI Autopay debit itself,
          we add no retries in that cycle. Each retry on a card issued in India starts a new advance
          notice to the bank. After the limit, we make no extra attempt on the last day of the
          dunning period. The invoice waits for that day, and then the final actions apply. On every
          rail, we present an invoice automatically at most 8 times.
        </More>
      </div>
    </Alert>
  );
}
