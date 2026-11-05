"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { portalAbandonAuthenticationAction } from "./actions";
import { canCancelAtGateway } from "./gateway-cancel";

/**
 * The buyer releases the authentication-pending debit that is holding their invoice.
 *
 * ── Why this control had to exist ────────────────────────────────────────────
 * An INR debit over ₹15,000 pauses for the buyer's bank to authenticate it, and while
 * it is pending the engine blocks any second attempt on the invoice — correctly, since
 * two live attempts on one invoice is how you charge someone twice. The bank's link is
 * valid 72 hours. So a buyer who has decided not to use that mandate (wrong account,
 * the link never arrived, they would rather pay by card) previously had exactly one
 * option: wait three days for a payment they had already decided against. The row's
 * old comment said no button was possible because we cannot re-send the bank's
 * request. True — but that was the wrong button. This one does not ask the bank for
 * anything; it releases OUR hold, which is the half that is actually ours to release.
 *
 * ── Why it says "Pay now" when it does not pay ───────────────────────────────
 * It used to say "I won't approve this" — a negative framing of a decision the buyer
 * has already made, sitting in a row that offers them nothing else. What they want is
 * to pay another way, and releasing the hold is the only thing standing between them
 * and that. So the trigger promises the outcome and the dialog explains the step: the
 * ACTION is unchanged, and it must stay unchanged — paying is still a second click on
 * the real Pay now the row renders once the hold is gone.
 *
 * ── Why it confirms, and why the confirm says what it says ───────────────────
 * ⚠️ CORRECTED 2026-09-10. This block used to open "We cannot cancel the debit at the
 * gateway", generalising RazorPay's behaviour to every rail. It is false on Stripe:
 * measured that day, an India e-mandate debit rests at `requires_action` while its
 * pre-debit notification runs and cancels cleanly from there — `capabilities.intentVoid`
 * has always said so, and `VOIDABLE_STATUSES` in `providers/stripe.ts` lists exactly that
 * status. RazorPay is the one that cannot (`intentVoid: false`, a recurring payment stuck
 * in `created`). So the promise is now per gateway — see `CAN_CANCEL_AT_GATEWAY` in `gateway-cancel.ts`.
 *
 * What survives the correction is the WARNING, on both branches. Cancellability is
 * time-dependent: once the gateway presents the debit it leaves the cancellable state, and
 * within the bank's 72 hours the buyer could still approve one we failed to cancel, which
 * would capture on top of whatever they pay here. The engine cannot prevent that, so the
 * dialog does the only thing that works — tells them plainly to decline the bank's request
 * if it still turns up. A confirm that hid this to look tidier would be the failure this
 * whole change is about.
 *
 * Server-side, the gateway is asked before anything is believed, so `settled` is a
 * real outcome and it is the happy one: they were about to pay for something that had
 * already gone through.
 */

/**
 * Two rows can hold a live authentication request, and only one of them is owed money.
 * Same action, same warning — the promise on the trigger has to differ, because
 * "Pay now" on an invoice the row itself calls settled would be a lie.
 */
const COPY = {
  pay: {
    label: "Pay now",
    filled: true,
    title: "Skip the bank approval and pay now?",
    /**
     * Names what the bank actually wants — approving an auto-debit — because the row no
     * longer spends two lines on it, and because "we'll stop waiting for your bank" told
     * the buyer what WE would do rather than what they were being asked for.
     *
     * ⚠️ The hedge is per gateway, and `voidedAtGateway` stays an OBSERVED result either
     * way. Stripe cancels cleanly from `requires_action` (measured), so there it promises.
     * The cautious branch survives for gateways that cannot — though those no longer reach
     * this dialog at all, since `canCancelAtGateway` withholds the button from them.
     */
    lead: (canCancel: boolean) =>
      "Your bank asked you to approve this auto-debit. It is faster to pay here. " +
      (canCancel
        ? "We will cancel the bank's request for you."
        : "We will try to cancel the bank's request. This bank often does not allow it."),
    warning:
      "If the approval request still comes to you, decline it. If you do not decline it, we could charge you twice.",
    /** Names the other route rather than the dialog's mechanics: "Go back" is a dead label. */
    cancelLabel: "I will approve with my bank",
    /**
     * NOT "Pay now". This confirm releases our hold; the payment itself is the next step
     * on the refreshed row. Labelling it "Pay now" would promise a card form that does
     * not open here.
     */
    confirmLabel: "Continue to payment",
    busyLabel: "Releasing…",
    released: "Request released. You can pay this invoice now.",
  },
  stop: {
    label: "Stop this request",
    filled: false,
    title: "Stop the auto-debit approval request?",
    lead: (canCancel: boolean) =>
      "Your bank asked you to approve an auto-debit for this invoice, but you owe nothing " +
      "on it. " +
      (canCancel ? "We will cancel the request." : "We will try to cancel the request."),
    warning:
      "If the approval request still comes to you, decline it. If you do not decline it, we could charge you for it.",
    cancelLabel: "Keep request",
    confirmLabel: "Stop the request",
    busyLabel: "Stopping…",
    released: "Request released. We no longer wait for your bank.",
  },
} as const;

function ReleaseHoldButton({
  invoice,
  copy,
  gateway,
}: {
  invoice: string;
  copy: keyof typeof COPY;
  gateway?: string | null;
}) {
  const { label, filled, title, lead, warning, released, cancelLabel, confirmLabel, busyLabel } =
    COPY[copy];
  const canCancel = canCancelAtGateway(gateway);
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const router = useRouter();

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await portalAbandonAuthenticationAction(invoice);
      if (!res.ok) return void toast.error(res.error);
      setOpen(false);
      // Not a success toast: nothing succeeded, a block was lifted. The one case that
      // IS a success is the one where their money had already arrived.
      if (res.result.outcome === "settled")
        toast.success("Your bank confirmed this payment. The invoice is paid.");
      else if (res.result.voided_at_gateway)
        // The intent is genuinely dead, so the dialog's warning no longer applies and
        // repeating it here would frighten a buyer who is not at risk. Say the one thing
        // that changed: their bank's request cannot take money any more.
        toast.success("Your bank cancelled the request. You can pay this invoice now.");
      else toast(released);
      // The row's state, its badge and which control it offers all come from the
      // server component.
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {filled ? (
        // The same shape as the row's real Pay now, because it is the same promise one
        // step earlier. As a text link it read as a footnote to a state the buyer
        // cannot act on.
        <Button size="sm" onClick={() => setOpen(true)}>
          {label}
        </Button>
      ) : (
        <Button
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setOpen(true)}
        >
          {label}
        </Button>
      )}
      <Dialog open={open} onOpenChange={(v) => (busy ? null : setOpen(v))}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{lead(canCancel)}</DialogDescription>
          </DialogHeader>
          {/* Its own paragraph, at full contrast: this is the sentence that stops the
              buyer being charged twice, and muted body copy under a heading is the
              first thing an eye skips. */}
          <p className="text-sm font-medium text-foreground">{warning}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button onClick={confirm} disabled={busy}>
              {busy ? busyLabel : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The invoice is owed and blocked by the pending debit — releasing the hold lets them pay. */
export function PayNowInsteadButton({
  invoice,
  gateway,
}: {
  invoice: string;
  gateway?: string | null;
}) {
  return <ReleaseHoldButton invoice={invoice} copy="pay" gateway={gateway} />;
}

/** The invoice is already settled and the request is stray — there is nothing to pay. */
export function StopBankRequestButton({
  invoice,
  gateway,
}: {
  invoice: string;
  gateway?: string | null;
}) {
  return <ReleaseHoldButton invoice={invoice} copy="stop" gateway={gateway} />;
}
