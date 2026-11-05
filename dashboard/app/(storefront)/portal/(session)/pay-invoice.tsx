"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { openRazorpayCheckout, type RazorpayCheckoutDescriptor } from "@/lib/razorpay-checkout";
import { formPostTargetIsSafe, openGatewaySdk, submitFormPost } from "@/lib/gateway-sdk";
import { PaymentDialog, StripeIntentForm, refusalMessage } from "../../payment-dialog";
import { portalPayInvoiceAction, portalPayGatewaysAction } from "./actions";
import type { PortalMe } from "@/lib/portal-api";
import { accountHolderName } from "@/lib/names";
import {
  PAYMENT_PROCESSING_EVENT,
  clearPendingPayment,
  markPaymentProcessing,
  paymentProcessingLeft,
  savePendingPayment,
} from "@/lib/pending-payment";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { PaymentMark } from "@/components/brand/payment-mark";

/** One row of the Pay now chooser: a provider's own sheet, or Apple Pay on its hosted page. */
type PayChoice = { key: string; gateway: string; wallet?: "apple_pay"; label: string };

/** Apple Pay can open in this browser (Safari with a card in the wallet). */
function applePayReady(): boolean {
  try {
    const s = (window as { ApplePaySession?: { canMakePayments?: () => boolean } }).ApplePaySession;
    return typeof s?.canMakePayments === "function" && s.canMakePayments() === true;
  } catch {
    return false;
  }
}

/**
 * "Pay now" on a single open invoice.
 *
 * ── Why this is on-session and not a one-click charge of the saved card ──────────
 * India caps an UNATTENDED debit at ₹15,000 (RBI's additional-factor rule), so a
 * button that quietly reused the saved mandate would refuse exactly the invoices a
 * buyer most wants to settle by hand — and there is no way for them to fix that from
 * here. Paying on-session puts the buyer in front of their bank's challenge, which is
 * what the rule asks for, and then any amount goes through. It is also the only
 * self-service way out of a `mandate_ceiling_exceeded` park that does not require
 * re-registering the mandate at a higher ceiling.
 *
 * The trade is a few extra seconds and an OTP. That is the right trade for a button
 * whose whole purpose is "I want to clear this bill now".
 */
export function PayInvoiceButton({
  invoice,
  currency,
  me,
  scope,
  focus = false,
}: {
  invoice: string;
  /** THIS invoice's currency — which provider can take it is a per-invoice question. */
  currency: string;
  me: PortalMe;
  /** Non-secret per-buyer key for the redirect stash — the customer's public id. */
  scope: string;
  /** A "pay this invoice" link (Phase 4b) landed here: bring the button into view and focus it. */
  focus?: boolean;
}) {
  const btnRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!focus) return;
    btnRef.current?.scrollIntoView({ block: "center" });
    btnRef.current?.focus();
  }, [focus]);
  const [busy, setBusy] = React.useState(false);
  // A payment the buyer just approved for this invoice: no second "Pay now" while it settles.
  const [processing, setProcessing] = React.useState(false);
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      const left = paymentProcessingLeft(scope, invoice);
      setProcessing(left > 0);
      if (left > 0) timer = setTimeout(check, left);
    };
    check();
    window.addEventListener(PAYMENT_PROCESSING_EVENT, check);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(PAYMENT_PROCESSING_EVENT, check);
    };
  }, [scope, invoice]);
  /**
   * The providers that can take this invoice, once more than one can.
   *
   * One provider is not a choice, so nothing is shown — same rule the add-card group
   * follows. Two IS a choice, and the buyer is the one who should make it: the router
   * refuses to guess between them and a single business-wide default can only ever
   * settle one currency. Asking is also the honest answer, because "card" and "PayPal"
   * are different things to a payer, not an implementation detail.
   */
  const [choices, setChoices] = React.useState<PayChoice[] | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  // A Stripe card that needs 3DS answers `client_secret`; the challenge is Elements in
  // our own modal — the same overlay RazorPay puts up, rather than a redirect.
  const [stripeChallenge, setStripeChallenge] = React.useState<{
    clientSecret: string;
    publishableKey: string;
    intentId: string;
    /** `?pay=return` on this portal, where `PaymentReturn` runs leg 2 after a bank page. */
    returnUrl: string;
  } | null>(null);
  const router = useRouter();

  /** A capture the gateway holds for review leaves the invoice open: not "received" yet. */
  const finish = (result: { status?: string }, pending = false) => {
    if (result.status === "paid") toast.success("Payment received");
    else if (pending) toast("Your bank is processing the payment. This can take some days.");
    else toast("We are confirming your payment.");
    // The invoice row, its badge and the amount due all live in the server component.
    router.refresh();
  };

  /**
   * Ask first, but only when there is something to ask. The list is fetched on click,
   * not with the page: it is per-invoice and most buyers never need it.
   */
  const startPay = async () => {
    setBusy(true);
    const listed = await portalPayGatewaysAction(currency);
    // A failed lookup must not block the payment — with one match the router resolves it
    // alone, and that is the common case. Only a genuine tie needs the buyer.
    const gws = listed.ok ? listed.gateways : [];
    // Apple Pay opens on the gateway's own page, so it is a choice of its own. Shown only
    // where the browser can pay with it.
    const wallets: PayChoice[] = applePayReady()
      ? gws
          .filter((g) => g.apple_pay_hosted)
          .map((g) => ({
            key: `apple_pay:${g.id}`,
            gateway: g.id,
            wallet: "apple_pay" as const,
            label: gws.length > 1 ? `Apple Pay (${g.label})` : "Apple Pay",
          }))
      : [];
    if (gws.length > 1 || wallets.length > 0) {
      const sheets: PayChoice[] = gws.map((g) => ({
        key: g.id,
        gateway: g.id,
        label: gws.length > 1 ? g.label : "Card or other method",
      }));
      const all = [...wallets, ...sheets];
      setPicked(all[0]!.key);
      setChoices(all);
      setBusy(false);
      return;
    }
    await pay();
  };

  const pay = async (gatewayAccount?: string, wallet?: "apple_pay") => {
    setBusy(true);
    try {
      const res = await portalPayInvoiceAction(
        invoice,
        window.location.origin,
        undefined,
        gatewayAccount,
        undefined,
        wallet,
      );
      if (!res.ok) return void toast.error(res.error);

      // Settled outright — an instrument that needed no challenge (a Stripe card the
      // issuer waved through, or credit already covering the balance). Discriminated on
      // `object`: both arms carry a `status`, so that field narrows nothing.
      if (res.result.object !== "invoice_collection") {
        if (res.result.payment_error) return void toast.error(res.result.payment_error.message);
        return finish(res.result);
      }
      const pending = res.result;

      const action = pending.next_action ?? pending.payment_intent.next_action;
      if (!action)
        return void toast.error(
          "We could not confirm the payment. The provider sent no instructions.",
        );

      // RazorPay: the challenge is their embedded modal, opened from this click. It
      // must be opened synchronously off the user gesture, which is why the whole
      // flow lives in the client rather than redirecting through the server.
      if (action.mode === "checkout" && action.checkout) {
        const result = await openRazorpayCheckout(action.checkout as RazorpayCheckoutDescriptor, {
          businessName: me.business.name,
          // Names what this sheet is FOR. `description` used to be hardcoded to "Save
          // this card for future payments" inside the helper, which is a lie here — the
          // buyer is settling an invoice, not saving an instrument — and it read that way
          // inside RazorPay's own modal at the moment they paid. It is a parameter now,
          // and the default is nothing rather than a plausible wrong sentence.
          description: `Payment for invoice ${invoice}`,
          prefill: {
            // The human at the keyboard, so the ACCOUNT HOLDER — not the billing
            // contact. The buyer is authenticating a payment in their own name;
            // prefilling their finance team's would make them correct it or abandon.
            name: accountHolderName(me.customer),
            email: me.customer.email,
            contact: me.customer.phone ?? me.customer.address.phone,
          },
        });
        if (result.status === "dismissed") return;
        if (result.status === "failed") return void toast.error(result.message);
        // Re-post the SAME call carrying the authorized intent; the server consumes it
        // against this invoice.
        const done = await portalPayInvoiceAction(
          invoice,
          window.location.origin,
          pending.payment_intent.id,
        );
        if (!done.ok) return void toast.error(done.error);
        if (done.result.object !== "invoice_collection" && done.result.payment_error) {
          return void toast.error(done.result.payment_error.message);
        }
        return finish(done.result);
      }

      // A gateway's own browser SDK. Same shape as the RazorPay arm above, plus the
      // client result on leg 2.
      if (action.mode === "sdk" && action.sdk) {
        // Its 3DS step may send the whole page to `?pay=return` (Checkout.com Flow).
        savePendingPayment(scope, { invoice, paymentIntent: pending.payment_intent.id });
        const result = await openGatewaySdk(action.sdk, {
          businessName: me.business.name,
          purpose: "payment",
          prefill: {
            name: accountHolderName(me.customer),
            email: me.customer.email,
            contact: me.customer.phone ?? me.customer.address.phone,
          },
        });
        // Finished on this page: the return leg has nothing to do.
        clearPendingPayment(scope);
        if (result.status === "dismissed") return;
        if (result.status === "failed") return void toast.error(result.message);
        const done = await portalPayInvoiceAction(
          invoice,
          window.location.origin,
          pending.payment_intent.id,
          undefined,
          result.clientResult,
        );
        if (!done.ok) return void toast.error(done.error);
        if (done.result.object !== "invoice_collection" && done.result.payment_error) {
          return void toast.error(done.result.payment_error.message);
        }
        return finish(done.result);
      }

      // A hosted approval page (an auth link, PayPal). We leave the site; the buyer
      // returns to `?pay=return`, where `PaymentReturn` runs leg 2.
      //
      // The stash is what makes that possible. Leg 2 is `(invoice, intent)` and neither
      // survives a top-level navigation on its own — so before this existed the portal
      // sent a `return_url` nothing could act on: the buyer came back, nothing ran, and
      // the payment settled only when `harvestInvoiceIntent` reached the same intent from
      // the webhook. Written BEFORE the navigation, because after it this code is gone.
      if (action.mode === "redirect" && action.approvalUrl) {
        savePendingPayment(scope, { invoice, paymentIntent: pending.payment_intent.id });
        window.location.href = action.approvalUrl;
        return;
      }

      // The redirect arm's twin for a gateway that takes a signed POST: same stash first.
      if (
        action.mode === "form_post" &&
        action.formPost &&
        formPostTargetIsSafe(action.formPost.action)
      ) {
        savePendingPayment(scope, { invoice, paymentIntent: pending.payment_intent.id });
        submitFormPost(action.formPost);
        return;
      }

      // Stripe: the intent is created unconfirmed, so the buyer selects the method and
      // confirms in Elements here — a card (with 3DS when the issuer asks), or a bank
      // method that redirects to `returnUrl` and finishes in `PaymentReturn`.
      if (action.mode === "client_secret" && action.clientSecret) {
        if (!action.publishableKey) {
          return void toast.error(
            "This payment provider is not fully configured. Contact support.",
          );
        }
        setStripeChallenge({
          clientSecret: action.clientSecret,
          publishableKey: action.publishableKey,
          intentId: pending.payment_intent.id,
          returnUrl: `${window.location.origin}/portal?pay=return`,
        });
        return;
      }

      toast.error("We cannot confirm this payment method here yet. Add a card instead.");
    } finally {
      setBusy(false);
    }
  };

  if (processing) return <span className="text-xs text-muted-foreground">Payment processing…</span>;
  return (
    <>
      <Button ref={btnRef} size="sm" onClick={startPay} disabled={busy}>
        {busy ? "Paying…" : "Pay now"}
      </Button>
      <PaymentDialog
        open={choices != null}
        onClose={() => setChoices(null)}
        title="How do you want to pay?"
        description="Select how to pay. You enter your details on the secure page of the payment provider."
      >
        {choices ? (
          <div className="flex flex-col gap-4">
            {/* The gateway KEY is deliberately not rendered — "RAZORPAY" / "TMTEST" is our
                routing detail and means nothing to a payer. Same rule as the add-card
                provider group, whose row treatment this matches. */}
            <RadioGroup
              value={picked}
              onValueChange={setPicked}
              aria-label="Payment provider"
              className="flex flex-col gap-2"
            >
              {choices.map((c) => (
                <div
                  key={c.key}
                  className={`rounded-md border px-3.5 py-3 transition-colors ${
                    picked === c.key
                      ? "border-primary/70 ring-1 ring-primary/30"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <RadioOption
                    value={c.key}
                    label={<span className="truncate">{c.label}</span>}
                    {...(c.wallet
                      ? {
                          icon: <PaymentMark mark="applepay" />,
                          hint: "You pay on the secure page of the payment provider. Then you come back here.",
                        }
                      : {})}
                  />
                </div>
              ))}
            </RadioGroup>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setChoices(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy || !picked}
                onClick={() => {
                  const chosen = choices?.find((c) => c.key === picked);
                  setChoices(null);
                  void pay(chosen?.gateway, chosen?.wallet);
                }}
              >
                Continue
              </Button>
            </div>
          </div>
        ) : null}
      </PaymentDialog>
      {/* A dialog, not an inline panel: the invoice row's action slot is sized for a
          28px button, and rendering a card form into it collapsed the invoice text to a
          narrow column and pushed the actions outside the sheet. A short confirm flow is
          the Modal archetype. */}
      <PaymentDialog
        open={stripeChallenge != null}
        onClose={() => setStripeChallenge(null)}
        title="Confirm your payment"
        description="Your bank must verify this payment before we can take it."
      >
        {stripeChallenge ? (
          <StripeIntentForm
            purpose="payment"
            clientSecret={stripeChallenge.clientSecret}
            publishableKey={stripeChallenge.publishableKey}
            brandColor={me.business.brand_color}
            confirmLabel="Confirm payment"
            busyLabel="Confirming…"
            returnUrl={stripeChallenge.returnUrl}
            // A bank page leaves this tab, so leg 2 must survive it — same stash the
            // redirect arm above writes.
            onBeforeConfirm={() =>
              savePendingPayment(scope, { invoice, paymentIntent: stripeChallenge.intentId })
            }
            onCancel={() => setStripeChallenge(null)}
            // The authorized intent id comes back from Elements, but the second leg is
            // keyed on OUR intent (`challenge.intentId`) — that is what the server
            // consumes against this invoice. A refusal is returned, so the dialog shows it.
            onAuthorized={async (_token, { pending: inFlight }) => {
              const done = await portalPayInvoiceAction(
                invoice,
                window.location.origin,
                stripeChallenge.intentId,
              );
              if (!done.ok)
                return refusalMessage(
                  "We could not take your payment.",
                  done.error,
                  "Select Confirm payment to try again.",
                );
              clearPendingPayment(scope);
              if (done.result.object !== "invoice_collection" && done.result.payment_error) {
                // The gateway's own decline, as the buyer would read it on its page.
                return done.result.payment_error.message;
              }
              setStripeChallenge(null);
              if (inFlight) markPaymentProcessing(scope, invoice);
              finish(done.result, inFlight);
            }}
          />
        ) : null}
      </PaymentDialog>
    </>
  );
}
