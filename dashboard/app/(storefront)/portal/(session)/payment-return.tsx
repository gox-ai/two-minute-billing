"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { money } from "@/lib/format";
import { NoticeCard } from "../../chrome";
import { portalInvoiceStateAction, portalPayInvoiceAction } from "./actions";
import {
  clearPendingPayment,
  consumePaymentReturn,
  markPaymentProcessing,
  readPendingPayment,
} from "@/lib/pending-payment";
import { readSdkReturnResult } from "@/lib/return-params";

/** The engine's refusal while the gateway's approval has not reached us (payment-intents). */
const NOT_YET_CONFIRMED = /did not tell us yet that this payment is complete/;
const AUTO_RETRIES = 4;
/** How long the card watches a payment settle: 40 reads, 3 s apart. */
const POLLS = 40;
const POLL_MS = 3000;

type Watch = {
  invoice: string;
  number: string | null;
  amountMinor: number | null;
  currency: string | null;
  state: "finishing" | "processing" | "paid" | "failed";
  slow: boolean;
};

/**
 * Completes a redirect-mode "Pay now" after the provider sends the buyer back to
 * `?pay=return` — the money-side twin of `SetupReturn` beside it.
 *
 * ── The gap this closes ──────────────────────────────────────────────────────
 * `portalPayInvoiceAction` has always sent `return_url: …?pay=return`, and **nothing on
 * the portal read it**. Only a comment in `pay-invoice.tsx` mentioned the parameter. So a
 * buyer sent to a hosted approval page (a PayPal order, a bank auth link) approved, came
 * back, and no second leg ran: the intent was never consumed by their browser.
 *
 * It looked fine because it usually was — the invoice list is server-rendered and
 * `harvestInvoiceIntent` consumes the same intent from the gateway's webhook, which is
 * exactly why the webhook harvest exists ("the browser sometimes never comes back",
 * measured 2026-08-14 on a ₹20,000 Pay now). But that made the redirect leg decorative,
 * and when the webhook is slow the buyer lands on an unchanged invoice with nothing to
 * show they paid. The two settlers are meant to race; only one of them was running.
 *
 * ── Losing that race is not a failure ────────────────────────────────────────
 * The collect route already treats a consumed intent as the outcome it produced rather
 * than a collision (`settledElsewhere`), so leg 2 arriving second reports the invoice as
 * it stands instead of erroring. That is what makes it safe to run both.
 *
 * ── Until it settles ─────────────────────────────────────────────────────────
 * A capture can stay in flight (a PayPal review), so the card READS the invoice until it
 * is paid or the payment fails, and holds the invoice's "Pay now" off for as long as it
 * is in flight — not on a timer, and not on a list refresh landing.
 */
export function PaymentReturn({ scope }: { scope: string }) {
  const router = useRouter();
  const [watch, setWatch] = React.useState<Watch | null>(null);
  // Exactly once per return, even under StrictMode's double-invoked effects in dev.
  const ran = React.useRef(false);

  React.useEffect(() => {
    if (ran.current) return;
    // An sdk gateway that left for its own 3DS page names the result. Read before the strip.
    const clientResult = readSdkReturnResult(window.location.search) ?? undefined;
    // Stripe appends its verdict for a method that redirected. Read before the strip.
    const redirectStatus = new URLSearchParams(window.location.search).get("redirect_status");
    const ret = consumePaymentReturn("/portal");
    if (!ret) return;
    ran.current = true;

    const pending = readPendingPayment(scope);
    if (ret === "cancel") {
      clearPendingPayment(scope);
      toast("Payment not completed");
      return;
    }
    // The bank refused it. Nothing to complete, and the intent stays open for Pay now.
    if (redirectStatus === "failed" && pending) {
      clearPendingPayment(scope);
      setWatch({
        invoice: pending.invoice,
        number: null,
        amountMinor: null,
        currency: null,
        state: "failed",
        slow: false,
      });
      return;
    }
    /**
     * Approved, but this tab knows nothing about it — storage was blocked, or the return
     * URL was opened somewhere else. NOT a restart: the intent is authorized at the
     * gateway and the webhook harvest still settles it, so inviting a second payment here
     * is the one genuinely harmful thing this component could do.
     */
    if (!pending) {
      toast("Payment approved. It shows here when your bank confirms it.");
      router.refresh();
      return;
    }

    const invoice = pending.invoice;
    // Approved at the gateway: no second "Pay now" on this invoice while it settles.
    markPaymentProcessing(scope, invoice);
    const base: Watch = {
      invoice,
      number: null,
      amountMinor: null,
      currency: null,
      state: "finishing",
      slow: false,
    };
    setWatch(base);
    const settle = (state: "paid" | "failed") => {
      markPaymentProcessing(scope, invoice, false);
      setWatch((w) => (w ? { ...w, state } : w));
      router.refresh();
    };

    /** Read the invoice until it is paid, or its in-flight payment is gone without paying it. */
    const follow = async (sawInFlight: boolean) => {
      setWatch((w) => (w ? { ...w, state: "processing" } : w));
      for (let i = 0; i < POLLS; i++) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const read = await portalInvoiceStateAction(invoice);
        if (!read.ok) continue;
        const inv = read.invoice;
        setWatch((w) =>
          w
            ? {
                ...w,
                number: w.number ?? inv.number,
                amountMinor: w.amountMinor ?? (inv.amount_due_minor || inv.total_minor),
                currency: w.currency ?? inv.currency,
              }
            : w,
        );
        if (inv.status === "paid") return settle("paid");
        if (inv.payment_in_flight) {
          if (!sawInFlight) router.refresh();
          sawInFlight = true;
          markPaymentProcessing(scope, invoice);
          continue;
        }
        // Not in flight and not paid: before it was ever in flight that is the gateway's
        // approval still on its way; after, the gateway refused it.
        if (sawInFlight) return settle("failed");
      }
      setWatch((w) => (w ? { ...w, slow: true } : w));
      router.refresh();
    };

    void (async () => {
      // The approval webhook can land ~15 s after the buyer is back: retry before saying so.
      const leg2 = () =>
        portalPayInvoiceAction(
          invoice,
          window.location.origin,
          pending.paymentIntent,
          undefined,
          clientResult,
        );
      let res = await leg2();
      for (let i = 1; i <= AUTO_RETRIES && !res.ok && NOT_YET_CONFIRMED.test(res.error); i++) {
        await new Promise((r) => setTimeout(r, 2500 * i));
        res = await leg2();
      }
      /**
       * Cleared on SUCCESS and on cancel only — the rule the vault leg learned the hard
       * way. A buyer who retried inside the provider's own page comes back a SECOND time,
       * and a stash cleared on the first failure leaves that return with no intent to
       * complete through.
       */
      if (res.ok) clearPendingPayment(scope);
      // The URL keeps `?pay=return` on purpose. Changing it here — `router.replace` or the
      // patched `history.replaceState` — re-keys the page segment, so the next refresh does
      // not match the router's tree and Next reloads the whole page, taking this card and
      // its polling with it (measured on Next 16.3). A reload that replays leg 2 is safe:
      // the stash is cleared on success and a consumed intent reports what it produced.
      /**
       * REFRESH EITHER WAY. Our leg failing does not mean the money did not land: the
       * webhook harvest is the documented other settler for this same intent, and it can
       * arrive after we have given up. Refreshing only on success is what made a manual
       * reload look like the thing that fixed it on the add-card side.
       */
      router.refresh();
      const refused = (message: string, quiet = false) => {
        markPaymentProcessing(scope, invoice, false);
        setWatch(null);
        if (quiet) toast(message);
        else toast.error(message);
      };
      // "You do not need to do anything": the webhook still settles it, so keep watching.
      if (!res.ok && NOT_YET_CONFIRMED.test(res.error)) return void follow(false);
      if (!res.ok) return refused(res.error);
      // A second `action_required` would mean the gateway wants another challenge; the
      // invoice row is the honest place to start that again rather than looping here.
      if (res.result.object === "invoice_collection")
        return refused("Your bank needs one more step. Open Pay now again to finish.", true);
      if (res.result.payment_error) return refused(res.result.payment_error.message);
      const inv = res.result;
      setWatch((w) =>
        w
          ? {
              ...w,
              number: inv.number,
              amountMinor: inv.amount_due_minor || inv.total_minor,
              currency: inv.currency,
            }
          : w,
      );
      if (inv.status === "paid") return settle("paid");
      // A capture the gateway holds for review leaves the invoice open: not "received" yet.
      void follow(false);
    })();
  }, [scope, router]);

  if (!watch) return null;
  const amount =
    watch.amountMinor != null && watch.currency ? money(watch.amountMinor, watch.currency) : null;
  const label = watch.number ?? watch.invoice;
  return (
    <div className="mb-6">
      {watch.state === "finishing" ? (
        <NoticeCard icon={<Loader2 className="animate-spin" />} title="Finishing your payment">
          We are confirming the payment that you approved. This takes a few seconds.
        </NoticeCard>
      ) : watch.state === "processing" ? (
        <NoticeCard icon={<Loader2 className="animate-spin" />} title="Payment in progress">
          <p>
            Your bank is still confirming the{" "}
            {amount ? <span className="font-medium tabular-nums">{amount}</span> : null} payment for
            invoice <span className="font-mono">{label}</span>.{" "}
            {watch.slow
              ? "This takes longer than usual. You do not have to do anything. We will email your receipt when the payment completes."
              : "You do not have to do anything. This usually takes a few seconds."}
          </p>
        </NoticeCard>
      ) : watch.state === "paid" ? (
        <NoticeCard icon={<CheckCircle2 />} tone="success" title="Payment received">
          Thank you. Invoice <span className="font-mono">{label}</span> is paid.
        </NoticeCard>
      ) : (
        <NoticeCard icon={<AlertCircle />} title="Payment not received">
          Your bank did not accept the payment for invoice{" "}
          <span className="font-mono">{label}</span>. Select Pay now to try again, or use a
          different payment method.
        </NoticeCard>
      )}
    </div>
  );
}
