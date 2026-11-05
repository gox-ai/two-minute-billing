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
import { money, fmtDate } from "@/lib/format";
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

type Plan = PortalChangeOptions["plans"][number];

const periodLabel = (interval: string | null, count: number) =>
  !interval ? "" : count > 1 ? `every ${count} ${interval}s` : `every ${interval}`;
const periodKey = (p: { interval: string | null; interval_count: number }) =>
  `${p.interval_count}:${p.interval}`;

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
          const res = await portalCancelScheduledChangeAction(subscription);
          if (!res.ok) return void toast.error(res.error ?? "We could not withdraw the change.");
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
    void portalChangeOptionsAction(subscription).then((res) => {
      if (!res.ok || !res.data) return setLoadError(res.error ?? "We could not load the plans.");
      const o = res.data;
      setOptions(o);
      const current = o.plans.find((p) => p.current);
      setPlan(current?.price ?? "");
      setPeriod(current ? periodKey(current) : "");
      setSeats(o.seats?.current ?? null);
      setAddons(Object.fromEntries(o.addons.map((a) => [a.price, a.quantity])));
    });
  }, [subscription]);

  const switching = !!options && plan !== options.plans.find((p) => p.current)?.price;
  /** The quantity to send: an add-on the selected plan does not take is removed on a switch. */
  function addonQuantity(a: PortalChangeOptions["addons"][number]) {
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
    if (!options) return null;
    const current = options.plans.find((p) => p.current);
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
  }, [options, plan, seats, addons, timing]);

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
      void portalChangePreviewAction(subscription, request).then((res) => {
        if (stale) return;
        setPricing(false);
        if (!res.ok || !res.data) {
          setPreview(null);
          setPreviewError(res.error ?? "We could not price this change.");
          return;
        }
        setPreviewError(null);
        setPreview(res.data);
      });
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
      subscription,
      { ...request, timing: preview.timing },
      preview.total_minor,
      { pricedAt: preview.priced_at, quote: preview.quote },
    );
    setBusy(false);
    if (!res.ok || !res.data) {
      // The price may have moved: say why, then show the current price, so neither the
      // breakdown nor the button quotes the old amount.
      toast.error(res.error ?? "We could not change your plan.");
      const fresh = await portalChangePreviewAction(subscription, request);
      if (fresh.ok && fresh.data) {
        setPreviewError(null);
        setPreview(fresh.data);
      } else {
        setPreview(null);
        setPreviewError(fresh.error ?? res.error ?? "We could not change your plan.");
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

  const periods = options ? [...new Map(options.plans.map((p) => [periodKey(p), p])).values()] : [];
  const shown = options ? options.plans.filter((p) => periodKey(p) === period || p.current) : [];
  // Add-ons the selected plan takes on its billing period, plus any the customer already has.
  const shownAddons = options
    ? options.addons.filter((a) => (periodKey(a) === period && a.rules[plan]) || a.quantity > 0)
    : [];
  const seatRule = options?.seats ? (options.seats.by_plan[plan] ?? options.seats) : null;
  const cur = options?.currency ?? "USD";
  const due = preview?.due_today;
  const cta = !preview
    ? "Confirm change"
    : preview.timing === "end_of_term"
      ? "Schedule change"
      : preview.total_minor > 0
        ? `Confirm and pay ${money(preview.total_minor, cur)}`
        : "Confirm change";

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
                    onValueChange={setPeriod}
                    options={periods.map((p) => ({
                      value: periodKey(p),
                      label: periodLabel(p.interval, p.interval_count).replace(/^every /, "Every "),
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
                    label: `${p.name} · ${p.amount_minor == null ? "Usage-based" : money(p.amount_minor, cur)}${p.model === "per_unit" ? " per seat" : ""} ${periodLabel(p.interval, p.interval_count)}`,
                    hint: p.current
                      ? "Current plan"
                      : p.direction === "downgrade"
                        ? "Lower price"
                        : undefined,
                  }))}
                />
              </div>
              {options.seats && seats != null ? (
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
                          disabled={gone || !!rule?.mandatory}
                          onCheckedChange={(v) =>
                            set(v ? a.quantity || Math.max(min, rule?.default_quantity ?? 1) : 0)
                          }
                          label={`${a.name} · ${a.amount_minor == null ? "Usage-based" : money(a.amount_minor, cur)} ${periodLabel(a.interval, a.interval_count)}`}
                          hint={
                            gone
                              ? "Not available on this plan. We remove it when you change."
                              : rule?.mandatory
                                ? "Included with this plan."
                                : a.remove_only
                                  ? "You can remove this add-on. Contact us to change its quantity."
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
                  {!request ? (
                    <p className="text-muted-foreground">Select a change to see its price.</p>
                  ) : previewError ? (
                    <Alert tone="error">{previewError}</Alert>
                  ) : !preview ? (
                    <p className="text-muted-foreground">Pricing the change…</p>
                  ) : preview.trial_end && preview.total_minor === 0 ? (
                    <p>
                      Nothing to pay today. Your trial continues until{" "}
                      {fmtDate(preview.trial_end, tz)}. The new plan applies from now, and your
                      first payment is for the new plan.
                    </p>
                  ) : preview.timing === "end_of_term" ? (
                    <p>
                      Nothing to pay today. The change starts on{" "}
                      {preview.effective_at
                        ? fmtDate(preview.effective_at, tz)
                        : "your next renewal"}
                      .
                    </p>
                  ) : due ? (
                    <>
                      {due.lines.map((l, i) => (
                        <div key={i} className="flex justify-between gap-4">
                          <span className={cn(l.amount_minor < 0 && "text-success")}>
                            {l.description}
                          </span>
                          <span className={cn(l.amount_minor < 0 && "text-success")}>
                            {money(l.amount_minor, cur)}
                          </span>
                        </div>
                      ))}
                      {due.tax_minor ? (
                        <div className="flex justify-between gap-4 text-muted-foreground">
                          <span>Tax</span>
                          <span>{money(due.tax_minor, cur)}</span>
                        </div>
                      ) : null}
                      <div className="flex justify-between gap-4 border-t pt-2 font-medium">
                        <span>
                          {due.added_to_next_invoice ? "Added to your next invoice" : "Due today"}
                        </span>
                        <span>
                          {money(
                            due.added_to_next_invoice ? due.total_minor : preview.total_minor,
                            cur,
                          )}
                        </span>
                      </div>
                    </>
                  ) : null}
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
