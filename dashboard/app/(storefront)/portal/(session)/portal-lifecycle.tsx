"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { ConfirmDialog } from "@/components/confirm-dialog";
import { SelectField } from "@/components/ui/select-field";
import { toast } from "sonner";
import { money } from "@/lib/format";
import type {
  PortalCancelFlow,
  PortalLifecycleAction,
  PortalRetentionOffer,
  PortalSubscription,
} from "@/lib/portal-api";
import {
  portalCancelFlowAction,
  portalSubscriptionLifecycleAction,
  portalTakeRetentionOfferAction,
} from "./actions";

type Actions = NonNullable<PortalSubscription["actions"]>;

/**
 * Cancel, pause, resume and keep (undo a scheduled cancel) on the buyer's own subscription.
 * Each link renders only when the engine says the business offers it AND the subscription's
 * state allows it. Refreshes after each action: status and dates are the server's.
 */
export function PortalLifecycle({
  subscription,
  actions,
  periodEndLabel,
  resumeStartsNewPeriod,
}: {
  subscription: string;
  actions: Actions;
  /** The current period's end in the business timezone, or null. */
  periodEndLabel: string | null;
  /** The paid period ended during the pause, so a resume bills a new one. */
  resumeStartsNewPeriod: boolean;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState<Exclude<
    PortalLifecycleAction,
    "cancel"
  > | null>(null);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const params = useSearchParams();
  // A "cancel" link (Phase 4b) for this subscription opens the cancel flow.
  React.useEffect(() => {
    if (actions.cancel && params.get("cancel") === subscription) setCancelOpen(true);
  }, [actions.cancel, params, subscription]);

  const cancel = actions.cancel;
  if (!cancel && !actions.pause && !actions.resume && !actions.reactivate) return null;

  async function run(action: PortalLifecycleAction, reasonCode?: string) {
    setError(null);
    const res = await portalSubscriptionLifecycleAction(subscription, action, reasonCode);
    if (!res.ok) {
      setError(res.error ?? null);
      return false;
    }
    router.refresh();
    return true;
  }

  const until = periodEndLabel ? ` until ${periodEndLabel}` : " until the end of this period";
  const confirmCopy: Record<
    Exclude<PortalLifecycleAction, "cancel">,
    { title: string; description: string; label: string }
  > = {
    pause: {
      title: "Pause your subscription?",
      description: "We stop charging your plan while it is paused. You can resume it here.",
      label: "Pause subscription",
    },
    resume: {
      title: "Resume your subscription?",
      description: resumeStartsNewPeriod
        ? "Charges for your plan start again. We charge you today for the new period."
        : "Charges for your plan start again at your next renewal.",
      label: "Resume subscription",
    },
    reactivate: {
      title: "Keep your subscription?",
      description: periodEndLabel
        ? `Your subscription continues. It renews on ${periodEndLabel} and we charge you on that date.`
        : "Your subscription continues and renews as usual.",
      label: "Keep subscription",
    },
  };

  const link = "text-xs font-medium text-primary transition-colors hover:underline";

  return (
    <div className="border-t px-5 py-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {actions.reactivate ? (
          <button type="button" className={link} onClick={() => setConfirming("reactivate")}>
            Keep my subscription
          </button>
        ) : null}
        {actions.resume ? (
          <button type="button" className={link} onClick={() => setConfirming("resume")}>
            Resume subscription
          </button>
        ) : null}
        {actions.pause ? (
          <button type="button" className={link} onClick={() => setConfirming("pause")}>
            Pause subscription
          </button>
        ) : null}
        {cancel ? (
          <button
            type="button"
            className={link}
            onClick={() => {
              setError(null);
              setCancelOpen(true);
            }}
          >
            Cancel subscription
          </button>
        ) : null}
      </div>
      {error && !cancelOpen ? (
        <Alert tone="error" className="mt-2 text-xs">
          {error}
        </Alert>
      ) : null}

      {confirming ? (
        <ConfirmDialog
          brand
          open
          onOpenChange={(o) => {
            if (!o) setConfirming(null);
          }}
          title={confirmCopy[confirming].title}
          description={confirmCopy[confirming].description}
          confirmLabel={confirmCopy[confirming].label}
          cancelLabel="Go back"
          onConfirm={async () => {
            await run(confirming);
            setConfirming(null);
          }}
        />
      ) : null}

      {cancel && cancelOpen ? (
        <CancelFlowDialog
          subscription={subscription}
          until={until}
          timing={cancel.timing}
          onClose={() => setCancelOpen(false)}
          onDone={() => {
            setCancelOpen(false);
            router.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

type Step = "reason" | "offers" | "confirm";

/**
 * The cancel flow: a reason (when the business asks), offers (when it makes any), then the
 * cancel. "Cancel subscription" is reachable from every step, so an offer never traps anyone.
 * With no offers and an optional reason it is one dialog, as before Phase 3.
 */
function CancelFlowDialog({
  subscription,
  until,
  timing,
  onClose,
  onDone,
}: {
  subscription: string;
  until: string;
  timing: "immediately" | "end_of_term";
  onClose: () => void;
  onDone: () => void;
}) {
  const [flow, setFlow] = React.useState<PortalCancelFlow | null>(null);
  const [step, setStep] = React.useState<Step | null>(null);
  const [reason, setReason] = React.useState("");
  const [months, setMonths] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Only offers the customer actually saw count as "shown" for the saves report.
  const [sawOffers, setSawOffers] = React.useState(false);

  React.useEffect(() => {
    void portalCancelFlowAction(subscription).then((res) => {
      if (!res.ok || !res.data) {
        setError(res.error ?? "We could not load the cancel options.");
        setStep("confirm");
        return;
      }
      const f = res.data;
      setFlow(f);
      const pause = f.offers.find((o) => o.offer === "pause");
      if (pause && pause.offer === "pause" && pause.months) setMonths(String(pause.months));
      const askReason = f.reason !== "off" && f.reasons.length > 0;
      // No offers and an optional reason: one dialog with the reason inline.
      if (f.offers.length === 0 && f.reason !== "required") setStep("confirm");
      else if (askReason) setStep("reason");
      else showOffers();
    });
  }, [subscription]);

  const hasOffers = (flow?.offers.length ?? 0) > 0;
  const required = flow?.reason === "required";
  const inlineReason =
    step === "confirm" &&
    !!flow &&
    !hasOffers &&
    !required &&
    flow.reason !== "off" &&
    flow.reasons.length > 0;
  const endsNow = (flow?.timing ?? timing) === "immediately";
  const description =
    flow?.status === "paused"
      ? "Your paused subscription ends now. It does not resume. You cannot undo this."
      : endsNow
        ? "Your subscription ends now. You cannot undo this."
        : `Your subscription stays active${until}. We do not charge your plan again.${
            flow && !flow.can_undo ? "" : " You can undo this until then."
          }`;

  function showOffers() {
    setSawOffers(true);
    setStep("offers");
  }

  async function takeOffer(offer: PortalRetentionOffer) {
    if (busy) return;
    setBusy(true);
    setError(null);
    // Opened inside the click, so a popup blocker allows it.
    if (offer.offer === "contact") window.open(offer.url, "_blank", "noopener");
    const res = await portalTakeRetentionOfferAction(
      subscription,
      offer.offer,
      offer.offer === "pause" && offer.customer_chooses && months ? Number(months) : undefined,
      reason || undefined,
    );
    setBusy(false);
    if (!res.ok) return void setError(res.error ?? "We could not apply the offer.");
    if (offer.offer === "pause") toast.success("Subscription paused.");
    else if (offer.offer === "downgrade")
      toast.success(res.starts === "now" ? "Plan changed." : "Plan change scheduled.");
    else if (offer.offer === "discount") toast.success("Discount applied.");
    onDone();
  }

  async function confirmCancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await portalSubscriptionLifecycleAction(
      subscription,
      "cancel",
      reason || undefined,
      sawOffers,
    );
    setBusy(false);
    if (!res.ok) return void setError(res.error ?? "We could not cancel the subscription.");
    toast.success("Subscription cancelled.");
    onDone();
  }

  const title =
    step === "reason"
      ? "Why do you want to cancel?"
      : step === "offers"
        ? "Before you go"
        : "Cancel your subscription?";

  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      {/* `data-brand`: Radix portals the dialog outside the storefront's brand wrapper. */}
      <DialogContent size="sm" data-brand className="flex max-h-[85vh] flex-col overflow-hidden">
        <DialogHeader className="pr-12">
          <DialogTitle>{title}</DialogTitle>
          {step === "confirm" ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 space-y-3 overflow-y-auto px-6">
          {step === null ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
          {step === "reason" && flow ? (
            <>
              <div className="text-sm font-medium">
                {required ? "Select a reason" : "Select a reason (optional)"}
              </div>
              <RadioField
                ariaLabel="Reason for cancelling"
                value={reason}
                onValueChange={setReason}
                options={flow.reasons.map((r) => ({ value: r.code, label: r.label }))}
              />
            </>
          ) : null}
          {inlineReason && flow ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Reason (optional)</span>
              <SelectField
                ariaLabel="Reason for cancelling"
                value={reason}
                onValueChange={setReason}
                placeholder="Select a reason"
                options={flow.reasons.map((r) => ({ value: r.code, label: r.label }))}
              />
            </div>
          ) : null}
          {step === "offers" && flow ? (
            <div className="flex flex-col divide-y rounded-xl border bg-card">
              {flow.offers.map((o) => (
                <div
                  key={o.offer}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {o.offer === "pause"
                        ? o.months == null
                          ? "Pause instead"
                          : o.customer_chooses
                            ? `Pause for up to ${o.months} month${o.months === 1 ? "" : "s"}`
                            : `Pause for ${o.months} month${o.months === 1 ? "" : "s"}`
                        : o.offer === "downgrade"
                          ? `Switch to ${o.plan}, ${money(o.amount_minor, flow.currency)} ${
                              o.interval_count > 1
                                ? `every ${o.interval_count} ${o.interval}s`
                                : `every ${o.interval}`
                            }`
                          : o.offer === "discount"
                            ? o.summary
                            : "Talk to us"}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {o.offer === "pause"
                        ? o.months == null
                          ? "No payments while paused. You resume it when you are ready."
                          : "No payments while paused. Your subscription then continues."
                        : o.offer === "downgrade"
                          ? `${o.starts === "now" ? "Starts now." : "Starts at your next renewal."}${
                              o.includes.length ? ` Includes ${o.includes.join(", ")}.` : ""
                            }`
                          : o.offer === "discount"
                            ? "We apply it to your subscription now."
                            : "Tell us what is wrong. We can help."}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {o.offer === "pause" && o.customer_chooses && o.months ? (
                      <SelectField
                        value={months}
                        onValueChange={setMonths}
                        ariaLabel="Pause length"
                        options={Array.from({ length: o.months }, (_, i) => ({
                          value: String(i + 1),
                          label: `${i + 1} month${i === 0 ? "" : "s"}`,
                        }))}
                      />
                    ) : null}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void takeOffer(o)}
                    >
                      {o.offer === "pause"
                        ? "Pause"
                        : o.offer === "downgrade"
                          ? "Switch"
                          : o.offer === "discount"
                            ? "Apply"
                            : "Contact us"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
          {error ? (
            <Alert tone="error" className="text-xs">
              {error}
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          {step === "reason" ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Keep subscription
              </Button>
              {hasOffers ? (
                <>
                  {/* Ink, not the merchant's colour: the offers are the step we recommend. */}
                  <Button
                    className="bg-foreground text-background hover:bg-foreground/90"
                    disabled={busy || (required && !reason)}
                    onClick={() => setStep("confirm")}
                  >
                    Cancel subscription
                  </Button>
                  <Button disabled={busy || (required && !reason)} onClick={showOffers}>
                    Continue
                  </Button>
                </>
              ) : (
                <Button disabled={busy || (required && !reason)} onClick={() => setStep("confirm")}>
                  Continue
                </Button>
              )}
            </>
          ) : step === "offers" ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Keep subscription
              </Button>
              {/* Ink, not the merchant's colour: the brand fill is for the action we recommend. */}
              <Button
                className="bg-foreground text-background hover:bg-foreground/90"
                disabled={busy}
                onClick={() => setStep("confirm")}
              >
                Cancel subscription
              </Button>
            </>
          ) : step === "confirm" ? (
            <>
              <Button variant="outline" onClick={onClose} disabled={busy}>
                Keep subscription
              </Button>
              <Button variant="destructive" onClick={() => void confirmCancel()} disabled={busy}>
                {busy ? "Cancelling…" : "Cancel subscription"}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
