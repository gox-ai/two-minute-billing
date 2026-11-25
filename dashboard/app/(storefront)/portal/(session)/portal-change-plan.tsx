"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { RadioField } from "@/components/ui/radio-group";
import { CheckboxField } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { money } from "@/lib/format";
import { fmtDate } from "@/lib/format-date";
import { portalNowHint } from "@/lib/change-policy-view";
import { cn } from "@/lib/utils";
import type {
  PortalChangeOptions,
  PortalChangePreview,
  PortalChangeRequest,
  PortalChangeTiming,
} from "@/lib/portal-api";
import {
  portalCancelScheduledChangeAction,
  portalChangeApplyAction,
  portalChangeOptionsAction,
  portalChangePreviewAction,
} from "./actions";
import { usePortalSession } from "./portal-session-context";
import {
  addonOffered,
  buyerChangeError,
  buyerLine,
  cadence,
  cadenceKey,
  cadenceMonths,
  cadenceTitle,
  lineNames,
  planAfterPeriodSwitch,
  planTag,
  priceText,
  sortPlans,
  startsNewTerm,
} from "./portal-change-view";

type Plan = PortalChangeOptions["plans"][number];

const PRICE_LEAD = "We could not price this change.";
const APPLY_LEAD = "We could not change your plan.";

/**
 * "Change plan" on the portal plan card: plan, seats and add-ons, with the price of the
 * change shown before the customer confirms. Timing comes from the engine's change policy;
 * the timing question shows only when the business lets the customer choose.
 */
export function PortalChangePlan({
  subscription,
  allowed,
  scheduled,
  tz,
}: {
  subscription: string;
  allowed: boolean;
  scheduled: { id: string; effective_at: string; can_cancel: boolean } | null;
  tz?: string | null;
}) {
  const session = usePortalSession();
  const router = useRouter();
  const params = useSearchParams();
  const [open, setOpen] = React.useState(false);
  const [withdrawing, setWithdrawing] = React.useState(false);
  // A "change plan" link (Phase 4b) for this subscription opens the dialog.
  React.useEffect(() => {
    if (allowed && params.get("change") === subscription) setOpen(true);
  }, [allowed, params, subscription]);
  if (!allowed && !scheduled) return null;
  return (
    <div className="flex flex-col gap-2 border-t px-5 py-3">
      {scheduled ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>
            Your plan change starts on{" "}
            <span className="text-foreground tabular-nums">
              {fmtDate(scheduled.effective_at, tz)}
            </span>
            .
          </span>
          {scheduled.can_cancel ? (
            <button
              type="button"
              onClick={() => setWithdrawing(true)}
              className="text-xs font-medium text-primary hover:underline"
            >
              Withdraw change
            </button>
          ) : null}
        </div>
      ) : null}
      {allowed ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            Change plan
          </Button>
        </div>
      ) : null}
      {open ? (
        <ChangePlanDialog
          subscription={subscription}
          tz={tz}
          onClose={() => setOpen(false)}
          onDone={() => {
            setOpen(false);
            router.refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        brand
        open={withdrawing}
        onOpenChange={setWithdrawing}
        title="Withdraw the plan change?"
        description="Your plan stays as it is now."
        confirmLabel="Withdraw change"
        cancelLabel="Keep the change"
        onConfirm={async () => {
          const res = await portalCancelScheduledChangeAction(session, subscription);
          if (!res.ok)
            return void toast.error(
              buyerChangeError(res.error, "We could not withdraw the change."),
            );
          toast.success("Plan change withdrawn.");
          router.refresh();
        }}
      />
    </div>
  );
}

function ChangePlanDialog({
  subscription,
  tz,
  onClose,
  onDone,
}: {
  subscription: string;
  tz?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const session = usePortalSession();
  const [options, setOptions] = React.useState<PortalChangeOptions | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<string>("");
  const [period, setPeriod] = React.useState<string>("");
  const [seats, setSeats] = React.useState<number | null>(null);
  const [addons, setAddons] = React.useState<Record<string, number>>({});
  const [timing, setTiming] = React.useState<PortalChangeTiming | "">("");
  const [preview, setPreview] = React.useState<PortalChangePreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [pricing, setPricing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    void portalChangeOptionsAction(session, subscription).then(
      (res) => {
        if (!res.ok || !res.data)
          return setLoadError(buyerChangeError(res.error, "We could not load the plans."));
        const o = res.data;
        setOptions(o);
        const current = o.plans.find((p) => p.current);
        setPlan(current?.price ?? "");
        setPeriod(
          current ? cadenceKey(current) : o.plans.length ? cadenceKey(sortPlans(o.plans)[0]!) : "",
        );
        setSeats(o.seats?.current ?? null);
        setAddons(Object.fromEntries(o.addons.map((a) => [a.price, a.quantity])));
      },
      () => setLoadError("We could not load the plans. Try again in a few minutes."),
    );
  }, [subscription]);

  const current = options?.plans.find((p) => p.current);
  const selected = options?.plans.find((p) => p.price === plan);
  /** A subscription with a plan must keep one selected: none means the buyer has to pick. */
  const needsPlan = !!current && !selected;
  const switching = !!options && !!selected && plan !== current?.price;
  /** The quantity to send: an add-on the selected plan does not take is removed on a switch. */
  function addonQuantity(a: PortalChangeOptions["addons"][number]) {
    // Ticked on another billing period and hidden since: it is not part of this change.
    if (!addonOffered(a, selected)) return a.quantity;
    const rule = a.rules[plan];
    if (switching && !rule) return 0;
    const q = addons[a.price] ?? 0;
    if (a.remove_only) return q === 0 ? 0 : a.quantity;
    if (!switching || !rule || q === 0) return q;
    // The selected plan sets this add-on's quantity: the edit made on the old plan does not carry.
    if (!rule.can_change_quantity) return rule.default_quantity;
    const min = rule.min ?? 1;
    const capped = rule.max != null ? Math.min(q, rule.max) : q;
    const stepped = min + Math.floor((Math.max(capped, min) - min) / rule.step) * rule.step;
    return Math.max(stepped, min);
  }

  /** Only what differs from today: the engine refuses an empty change. */
  const request = React.useMemo((): PortalChangeRequest | null => {
    if (!options || needsPlan) return null;
    const r: PortalChangeRequest = {};
    if (plan && plan !== current?.price) r.plan = plan;
    if (options.seats && seats != null && seats !== options.seats.current) r.seats = seats;
    // A mandatory add-on the plan brings is added by the engine; it is not sent.
    const changed = options.addons
      .filter((a) => !(a.rules[plan]?.mandatory && a.quantity === 0))
      .filter((a) => addonQuantity(a) !== a.quantity)
      .map((a) => ({ price: a.price, quantity: addonQuantity(a) }));
    if (changed.length) r.addons = changed;
    if (timing) r.timing = timing;
    return r.plan || r.seats != null || r.addons ? r : null;
  }, [options, plan, seats, addons, timing, needsPlan]);

  // Price the change as it is edited.
  React.useEffect(() => {
    if (!request) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let stale = false;
    setPricing(true);
    const t = setTimeout(() => {
      void portalChangePreviewAction(session, subscription, request).then(
        (res) => {
          if (stale) return;
          setPricing(false);
          if (!res.ok || !res.data) {
            setPreview(null);
            setPreviewError(buyerChangeError(res.error, PRICE_LEAD));
            return;
          }
          setPreviewError(null);
          setPreview(res.data);
        },
        () => {
          if (stale) return;
          setPricing(false);
          setPreview(null);
          setPreviewError(`${PRICE_LEAD} Try again in a few minutes.`);
        },
      );
    }, 350);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [request, subscription]);

  async function confirm() {
    if (!request || !preview || busy) return;
    setBusy(true);
    const res = await portalChangeApplyAction(
      session,
      subscription,
      { ...request, timing: preview.timing },
      preview.total_minor,
      { pricedAt: preview.priced_at, quote: preview.quote },
    );
    setBusy(false);
    if (!res.ok || !res.data) {
      // The price may have moved: say why, then show the current price, so neither the
      // breakdown nor the button quotes the old amount.
      toast.error(buyerChangeError(res.error, APPLY_LEAD));
      const fresh = await portalChangePreviewAction(session, subscription, request);
      if (fresh.ok && fresh.data) {
        setPreviewError(null);
        setPreview(fresh.data);
      } else {
        setPreview(null);
        setPreviewError(buyerChangeError(fresh.error ?? res.error, APPLY_LEAD));
      }
      return;
    }
    const r = res.data;
    if (r.scheduled_change) toast.success("Plan change scheduled.");
    else if (r.invoice && r.invoice.status !== "paid" && r.invoice.amount_due_minor > 0)
      toast.warning(
        "Plan changed. We could not take the payment yet. Pay the invoice in Invoices.",
      );
    else toast.success("Plan changed.");
    onDone();
  }

  const sorted = options ? sortPlans(options.plans) : [];
  // Shortest period first: monthly, then yearly.
  const periods = [...new Map(sorted.map((p) => [cadenceKey(p), p])).values()].sort(
    (a, b) => cadenceMonths(a) - cadenceMonths(b),
  );
  const shown = sorted.filter((p) => cadenceKey(p) === period);
  const sameName = (p: Plan) => shown.filter((q) => q.name === p.name).length > 1;
  const shownAddons = options ? options.addons.filter((a) => addonOffered(a, selected)) : [];
  const seatRule = options?.seats ? (options.seats.by_plan[plan] ?? options.seats) : null;
  const cur = options?.currency ?? "USD";
  const fmt = (minor: number) => money(minor, cur);
  const cta = !preview
    ? "Confirm change"
    : preview.timing === "end_of_term"
      ? "Schedule change"
      : !preview.due_today?.added_to_next_invoice && preview.total_minor > 0
        ? `Confirm and pay ${money(preview.total_minor, cur)}`
        : "Confirm change";

  function changePeriod(next: string) {
    setPeriod(next);
    if (options) setPlan(planAfterPeriodSwitch(options.plans, plan, next));
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      {/* `data-brand`: Radix portals the dialog outside the storefront's brand wrapper. */}
      <DialogContent size="lg" data-brand className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader className="pr-12">
          <DialogTitle>Change plan</DialogTitle>
          <DialogDescription>
            Select a plan, seats and add-ons. You see the price before you confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 space-y-5 overflow-y-auto px-6">
          {loadError ? <Alert tone="error">{loadError}</Alert> : null}
          {!options && !loadError ? (
            <p className="text-sm text-muted-foreground">Loading the plans…</p>
          ) : null}
          {options && !options.allowed ? (
            <Alert tone="info">{options.unavailable_reason}</Alert>
          ) : null}
          {options && options.allowed ? (
            <>
              {periods.length > 1 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Billing period</div>
                  <RadioField
                    ariaLabel="Billing period"
                    value={period}
                    onValueChange={changePeriod}
                    options={periods.map((p) => ({
                      value: cadenceKey(p),
                      label: cadenceTitle(p),
                      hint:
                        current && cadenceKey(current) === cadenceKey(p)
                          ? "Your current billing period"
                          : undefined,
                    }))}
                  />
                </div>
              ) : null}
              <div className="space-y-2">
                <div className="text-sm font-medium">Plan</div>
                <RadioField
                  ariaLabel="Plan"
                  value={plan}
                  onValueChange={setPlan}
                  options={shown.map((p: Plan) => ({
                    value: p.price,
                    label: `${p.name}${sameName(p) && p.price_name ? ` (${p.price_name})` : ""} · ${priceText(p, fmt)}`,
                    hint: planTag(p, options.timing),
                    disabled:
                      !p.current &&
                      p.direction != null &&
                      p.direction !== "same" &&
                      !!options.timing[p.direction]?.blocked,
                  }))}
                />
                {needsPlan ? (
                  <p className="text-xs text-muted-foreground">
                    Select a plan on this billing period.
                  </p>
                ) : null}
              </div>
              {options.seats && seats != null && !needsPlan ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Seats</div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Remove a seat"
                      disabled={
                        seats <= seatRule!.min ||
                        (!options.seats.decrease_allowed && seats <= options.seats.current)
                      }
                      onClick={() => setSeats(seats - 1)}
                    >
                      −
                    </Button>
                    <span className="w-10 text-center tabular-nums" aria-live="polite">
                      {seats}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Add a seat"
                      disabled={seatRule!.max != null && seats >= seatRule!.max}
                      onClick={() => setSeats(seats + 1)}
                    >
                      +
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {seatRule!.max != null
                      ? `From ${seatRule!.min} to ${seatRule!.max} seats.`
                      : `At least ${seatRule!.min} seat${seatRule!.min === 1 ? "" : "s"}.`}
                    {options.seats.decrease_allowed
                      ? ""
                      : " You can add seats here, but not remove them."}
                  </p>
                </div>
              ) : null}
              {shownAddons.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">Add-ons</div>
                  {shownAddons.map((a) => {
                    const rule = a.rules[plan];
                    const gone = switching && !rule;
                    const q = gone ? 0 : addonQuantity(a);
                    const min = rule?.min ?? 1;
                    const step = rule?.step ?? 1;
                    const set = (n: number) => setAddons((prev) => ({ ...prev, [a.price]: n }));
                    return (
                      <div
                        key={a.price}
                        className="flex flex-wrap items-center justify-between gap-3"
                      >
                        <CheckboxField
                          className="min-w-0 flex-[1_1_16rem]"
                          checked={rule?.mandatory ? true : q > 0}
                          disabled={gone || !!rule?.mandatory || needsPlan}
                          onCheckedChange={(v) =>
                            set(v ? a.quantity || Math.max(min, rule?.default_quantity ?? 1) : 0)
                          }
                          label={`${a.name} · ${priceText(a, fmt)}`}
                          hint={
                            gone
                              ? "Not available on this plan. We remove it when you change."
                              : rule?.mandatory
                                ? "Included with this plan."
                                : a.remove_only
                                  ? "You can remove this add-on. Contact us to change its quantity."
                                  : a.price_name && (a.metered || a.model === "usage")
                                    ? a.price_name
                                    : undefined
                          }
                        />
                        {q > 0 && !a.remove_only && rule?.can_change_quantity !== false ? (
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Remove one ${a.name}`}
                              disabled={q - step < min}
                              onClick={() => set(q - step)}
                            >
                              −
                            </Button>
                            <span className="w-10 text-center tabular-nums" aria-live="polite">
                              {q}
                            </span>
                            <Button
                              variant="outline"
                              size="sm"
                              aria-label={`Add one ${a.name}`}
                              disabled={rule?.max != null && q + step > rule.max}
                              onClick={() => set(q + step)}
                            >
                              +
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : null}
              {preview && preview.timing_options.length > 1 ? (
                <div className="space-y-2">
                  <div className="text-sm font-medium">When should the change start?</div>
                  <RadioField
                    ariaLabel="When the change starts"
                    value={timing || preview.timing}
                    onValueChange={(v) => setTiming(v as PortalChangeTiming)}
                    options={[
                      {
                        value: "now",
                        label: "Now",
                        hint: portalNowHint(preview),
                      },
                      {
                        value: "end_of_term",
                        label: options.current_period_end
                          ? `At the next renewal, ${fmtDate(options.current_period_end, tz)}`
                          : "At the next renewal",
                        hint: "Nothing to pay today.",
                      },
                    ]}
                  />
                </div>
              ) : null}

              <div className="rounded-xl border bg-card">
                <div className="border-b px-4 py-3 text-sm font-medium">Price of this change</div>
                <div
                  className={cn(
                    "space-y-2 px-4 py-3 text-sm tabular-nums",
                    pricing && "opacity-60",
                  )}
                >
                  {needsPlan ? (
                    <p className="text-muted-foreground">Select a plan to see the price.</p>
                  ) : !request ? (
                    <p className="text-muted-foreground">Select a change to see its price.</p>
                  ) : previewError ? (
                    <Alert tone="error">{previewError}</Alert>
                  ) : !preview ? (
                    <p className="text-muted-foreground">Pricing the change…</p>
                  ) : (
                    <ChangePrice
                      preview={preview}
                      options={options}
                      newPlan={request.plan ? selected : undefined}
                      showTiming={preview.timing_options.length <= 1}
                      tz={tz}
                    />
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={!preview || !!previewError || pricing || busy}>
            {busy ? "Confirming…" : cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  sub,
  amount,
  tone,
  strong,
}: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  amount: React.ReactNode;
  tone?: "credit" | "muted";
  strong?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-4",
        tone === "credit" && "text-success",
        tone === "muted" && "text-muted-foreground",
        strong && "border-t pt-2 font-medium",
      )}
    >
      <span className="min-w-0">
        <span className="block">{label}</span>
        {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
      </span>
      <span className="shrink-0">{amount}</span>
    </div>
  );
}

/**
 * The price of a change in the buyer's words: when it starts, each line with its period,
 * what is due today, and what is added later with its date. A date or an amount the engine
 * did not send is left out, never guessed.
 */
function ChangePrice({
  preview,
  options,
  newPlan,
  showTiming,
  tz,
}: {
  preview: PortalChangePreview;
  options: PortalChangeOptions;
  newPlan: Plan | undefined;
  showTiming: boolean;
  tz?: string | null;
}) {
  const cur = preview.currency;
  const fmt = (minor: number) => money(minor, cur);
  const d = (iso: string) => fmtDate(iso, tz);
  const due = preview.due_today;
  const names = lineNames([...options.plans, ...options.addons]);
  const periodEnd = options.current_period_end;
  const nextRenewal = preview.next_renewal?.at ? preview.next_renewal : null;
  const cycle = newPlan
    ? cadence(newPlan.interval, newPlan.interval_count)
    : (() => {
        const c = options.plans.find((p) => p.current);
        return c ? cadence(c.interval, c.interval_count) : "";
      })();
  const then = nextRenewal ? (
    <Row
      tone="muted"
      label={`Then ${cycle || "at each renewal"}, from ${d(nextRenewal.at!)}`}
      amount={fmt(nextRenewal.total_minor)}
    />
  ) : null;

  if (preview.timing === "end_of_term")
    return (
      <>
        <p>
          Nothing to pay today. The change starts on{" "}
          {preview.effective_at ? d(preview.effective_at) : "your next renewal"}, at your next
          renewal.
        </p>
        {nextRenewal ? (
          then
        ) : newPlan ? (
          <p className="text-muted-foreground">
            From then, your plan is {newPlan.name}: {priceText(newPlan, fmt)}.
          </p>
        ) : null}
      </>
    );

  if (!due) return <p>Nothing to pay today. The change starts now.</p>;

  const lines = due.lines.map((l) => ({
    ...buyerLine(l.description, names),
    amount: l.amount_minor,
  }));
  // The total nets out discounts AND the tax a credit line gives back, so lines plus tax can
  // exceed it. Name the gap as far as the engine says what it is.
  const gap =
    due.lines.reduce((s, l) => s + l.amount_minor, 0) + (due.tax_minor ?? 0) - due.total_minor;
  const hasCredit = due.lines.some((l) => l.amount_minor < 0);
  const discount =
    due.discount_minor != null ? due.discount_minor : hasCredit ? 0 : Math.max(gap, 0);
  const otherCredit = gap - discount;
  const newTerm = startsNewTerm(due.lines) || preview.reset_term === true;
  const span = (s: (typeof lines)[number]["span"]) =>
    s === "rest_of_period" && periodEnd
      ? `Today to ${d(periodEnd)}`
      : s === "unused"
        ? (due.credited_period_end ?? periodEnd)
          ? `Today to ${d((due.credited_period_end ?? periodEnd)!)}`
          : "The rest of this period"
        : s === "new_term"
          ? preview.new_period_end
            ? `Today to ${d(preview.new_period_end)}`
            : "A new term from today"
          : undefined;
  const items = (
    <>
      {lines.map((l, i) => (
        <Row
          key={i}
          label={l.label}
          sub={span(l.span)}
          amount={fmt(l.amount)}
          tone={l.amount < 0 ? "credit" : undefined}
        />
      ))}
      {discount > 0 ? <Row tone="credit" label="Discount" amount={fmt(-discount)} /> : null}
      {due.tax_minor ? <Row tone="muted" label="Tax" amount={fmt(due.tax_minor)} /> : null}
      {otherCredit !== 0 ? (
        <Row
          tone={otherCredit > 0 ? "credit" : "muted"}
          label={
            otherCredit < 0
              ? "Other charges"
              : due.discount_minor != null
                ? "Tax on the credit"
                : "Tax on the credit and any discount"
          }
          amount={fmt(-otherCredit)}
        />
      ) : null}
    </>
  );

  // In trial: the change applies now and the first invoice, at the trial end, bills it.
  if (preview.trial_end)
    return (
      <>
        <p>
          The new plan starts now. Your trial continues until {d(preview.trial_end)}. Nothing to pay
          today.
        </p>
        {items}
        <Row
          strong
          label={`First invoice, ${d(preview.trial_end)}`}
          amount={fmt(due.total_minor)}
        />
        <Row label="Due today" amount={fmt(0)} />
      </>
    );

  const lead = showTiming ? <p>The change starts now.</p> : null;

  if (due.total_minor <= 0) {
    const refunded = due.refunded_minor ?? 0;
    return (
      <>
        {lead}
        {items}
        <Row strong label="Due today" amount={fmt(0)} />
        {due.total_minor < 0 ? (
          <p className="text-muted-foreground">
            {refunded > 0
              ? `We refund ${fmt(refunded)} to your payment method.`
              : "We add the credit to your account. We use it for your next payments."}
          </p>
        ) : null}
        {then}
      </>
    );
  }

  if (due.added_to_next_invoice) {
    const at = due.next_invoice_at ?? (!newTerm && periodEnd ? periodEnd : null);
    return (
      <>
        {lead}
        {items}
        <Row strong label="Total of this change" amount={fmt(due.total_minor)} />
        <Row label="Due today" amount={fmt(0)} />
        <p className="text-muted-foreground">
          {at
            ? `This change adds ${fmt(due.total_minor)} to your payment on ${d(at)}.`
            : `This change adds ${fmt(due.total_minor)} to your next payment.`}
        </p>
        {then}
      </>
    );
  }

  const balance = due.total_minor - preview.total_minor;
  return (
    <>
      {lead}
      {items}
      {balance > 0 ? (
        <>
          <Row strong label="Total" amount={fmt(due.total_minor)} />
          <Row tone="credit" label="Credit balance used" amount={fmt(-balance)} />
        </>
      ) : null}
      <Row strong label="Due today" amount={fmt(preview.total_minor)} />
      {then}
    </>
  );
}
