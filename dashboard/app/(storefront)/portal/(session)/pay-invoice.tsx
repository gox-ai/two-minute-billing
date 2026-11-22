"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { openRazorpayCheckout, type RazorpayCheckoutDescriptor } from "@/lib/razorpay-checkout";
import { formPostTargetIsSafe, openGatewaySdk, submitFormPost } from "@/lib/gateway-sdk";
import {
  PaymentDialog,
  PaymentDialogFooter,
  RefusalAlert,
  SdkFrame,
  StripeIntentForm,
  refusalMessage,
} from "../../payment-dialog";
import { portalPayInvoiceAction, portalPayGatewaysAction, portalPayOptionsAction } from "./actions";
import type { PortalGateway, PortalMe, PortalPayOptions } from "@/lib/portal-api";
import { instrumentLabel } from "@/lib/instrument-label";
import { paymentMethodTypeLabel } from "@/lib/filter-options";
import { accountHolderName } from "@/lib/names";
import { clearActiveIntent, setActiveIntent } from "@/lib/buyer-error-report";
import {
  PAYMENT_PROCESSING_EVENT,
  clearPendingPayment,
  markPaymentProcessing,
  paymentProcessingLeft,
  savePendingPayment,
} from "@/lib/pending-payment";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import { Landmark } from "lucide-react";
import { PaymentMark, paymentMarkKey, type PaymentMarkKey } from "@/components/brand/payment-mark";
import { CheckboxField } from "@/components/ui/checkbox";
import { money } from "@/lib/format";
import { privacyText } from "../../storefront-text";

/** A new Pay now try on an invoice (`detail`: its id). */
const PAY_RETRY_EVENT = "tmb:pay-retry";

/** One row of the Pay now chooser: a provider's own sheet, or Apple Pay on its hosted page. */
type PayChoice = {
  key: string;
  /** gwa_… for a new method; absent for a saved one (it pays where it is held). */
  gateway?: string;
  wallet?: "apple_pay";
  /** pm_… — a saved method. */
  paymentMethod?: string;
  /** `debit`: taken through its mandate, settles later. */
  kind?: "now" | "debit";
  /** A new card typed into the gateway's form. */
  newCard?: boolean;
  /** Pay and save on this row (`portal_save_new_method`), or absent. */
  save?: PortalPayOptions["new_methods"][number]["save"];
  /** `paypal` for a new PayPal account: the save box names it. */
  method?: string;
  label: string;
  primary?: boolean;
  hint?: string | null;
  disabled?: boolean;
  /** Logos at the row's end: the card brands its gateway takes, or the method's own mark. */
  marks?: PaymentMarkKey[];
  /** A saved method's own brand, before its name. */
  lead?: PaymentMarkKey | null;
  /** A bank debit: a plain bank icon, no brand. */
  bank?: boolean;
  /** One line in the open row: where the buyer goes next, when the form is not ours to show. */
  note?: string | null;
  /** Its gateway's form opens in our dialog (Stripe Elements): the button reads Continue. */
  formHere?: boolean;
  /** The open row's gateway form shows its own card logos (see FORM_SHOWS_CARD_LOGOS). */
  formLogos?: boolean;
};

/**
 * The card brands each gateway takes, as shown on its card row. Others: the two networks.
 * Stripe India takes Visa and Mastercard on INR (no Amex, no RuPay); Amex only cross-border
 * (support.stripe.com, "Supported payment methods … for Stripe accounts in India").
 */
function cardMarks(gatewayKey: string | undefined, currency: string): PaymentMarkKey[] {
  if (gatewayKey === "razorpay") return ["visa", "mastercard", "rupay"];
  if (gatewayKey === "stripe" && currency.toUpperCase() !== "INR")
    return ["visa", "mastercard", "amex"];
  return ["visa", "mastercard"];
}
/** Gateways whose card form opens in their own window, not in our dialog. */
const OWN_WINDOW = new Set(["razorpay", "cashfree", "authorizenet"]);
/** Gateways whose own card form shows the card logos before anything is typed: an open row of
 * theirs hides ours, so the logos do not show twice. */
const FORM_SHOWS_CARD_LOGOS = new Set(["stripe", "braintree", "checkoutcom"]);

function rowMarks(
  method: string,
  gatewayKey: string | undefined,
  currency: string,
): PaymentMarkKey[] {
  if (method === "card") return cardMarks(gatewayKey, currency);
  if (method === "upi") return ["upi"];
  if (method === "paypal") return ["paypal"];
  return [];
}

/** The open row's one line, where the buyer leaves our page; null where the form is ours. */
function rowNote(method: string, gatewayKey: string | undefined): string | null {
  if (method === "paypal") return "You complete the payment on PayPal, then come back here.";
  if (method === "upi") return "You approve the payment in your UPI app.";
  if (OWN_WINDOW.has(gatewayKey ?? ""))
    return method === "card"
      ? "You enter your card in a secure window."
      : "You complete the payment in a secure window.";
  return null;
}

/** What the save box names: the method the row keeps. */
function saveNoun(method?: string): string {
  if (method === "paypal") return "PayPal account";
  if (method === "upi") return "UPI ID";
  if (method === "us_bank_account" || method === "sepa_debit") return "bank account";
  return "card";
}

/** A definite refusal on the gateway's own side: another gateway may take the payment. */
const GATEWAY_SIDE = new Set(["gateway_request_rejected", "gateway_error", "processing_error"]);

/** Above this, an India card or UPI debit needs the buyer's approval every time (RBI). */
const INR_AFA_LIMIT_MINOR = 1_500_000;

/** A new method's row: what the buyer pays WITH, never the provider's name. */
function newMethodLabel(
  n: PortalPayOptions["new_methods"][number],
  gws: PortalGateway[],
  savedPaypal = false,
  savedCard = false,
): string {
  // Beside a saved row of the same kind, "Another …" says it is not that one.
  if (n.method === "paypal") return savedPaypal ? "Another PayPal account" : "PayPal";
  if (n.method === "card") return savedCard ? "Another card" : "Credit or debit card";
  // The method, never the provider (Phase B): "UPI", "Direct debit (SEPA)".
  const named = paymentMethodTypeLabel(n.method);
  return named !== n.method
    ? named
    : (gws.find((g) => g.id === n.gateway_account)?.label ?? n.method);
}

/** The one button: what pressing it does for the selected row. */
function payButtonLabel(c: PayChoice | undefined, amount: string): string {
  if (!c || c.paymentMethod) return `Pay ${amount}`;
  if (c.method === "paypal") return "Continue to PayPal";
  if (c.wallet) return "Continue to Apple Pay";
  // The gateway's form opens next, in this dialog: its own button takes the payment.
  if (c.formHere) return "Continue";
  return `Pay ${amount}`;
}

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
  amountMinor,
  me,
  scope,
  focus = false,
  variant = "default",
  refusalSlot,
  size = "sm",
  headless,
}: {
  invoice: string;
  /** THIS invoice's currency — which provider can take it is a per-invoice question. */
  currency: string;
  /** What is due on it now: the button and the chooser name it. */
  amountMinor: number;
  /** `outline` where a filled "Pay" for the same money is already on screen. */
  variant?: "default" | "outline";
  me: PortalMe;
  /** Non-secret per-buyer key for the redirect stash — the customer's public id. */
  scope: string;
  /** A "pay this invoice" link (Phase 4b) landed here: bring the button into view and focus it. */
  focus?: boolean;
  /**
   * The id of an element the page renders on its own line beside this button (an invoice
   * row's action slot is sized for buttons). A refusal is shown there. Without it, the
   * refusal takes a full line after the button in its flex-wrap row.
   */
  refusalSlot?: string;
  /** `default` beside a full-height button (the amount-due card), so the two match. */
  size?: "sm" | "default";
  /**
   * Started by another control (the Add card result): no button of its own; it starts on
   * mount and reports back, so that control can close while the payment runs and show a
   * refusal itself.
   */
  headless?: {
    onPaid: () => void;
    onRefused: (message: string) => void;
    /** Nothing is open any more and nothing was paid (the buyer cancelled). */
    onIdle: () => void;
  };
}) {
  const btnRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!focus) return;
    btnRef.current?.scrollIntoView({ block: "center" });
    btnRef.current?.focus();
  }, [focus]);
  const [busy, setBusy] = React.useState(false);
  /**
   * The last refusal, shown beside the button and kept until the next try. A toast went by
   * itself after the gateway's sheet had closed, and the invoice then looked unchanged.
   */
  const [refusal, setRefusal] = React.useState<string | null>(null);
  /** gwa_… whose gateway failed on its side: Try again routes the new method elsewhere. */
  const [retryAvoid, setRetryAvoid] = React.useState<string | null>(null);
  const [started, setStarted] = React.useState(false);
  /** The page is going to a gateway's page: not "the buyer left without paying". */
  const leaving = React.useRef(false);
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  // The same invoice has a Pay button in the balance card and in its row: a new try on
  // either one replaces the old refusal on both.
  React.useEffect(() => {
    const clear = (e: Event) => {
      if ((e as CustomEvent<string>).detail === invoice) setRefusal(null);
    };
    window.addEventListener(PAY_RETRY_EVENT, clear);
    return () => window.removeEventListener(PAY_RETRY_EVENT, clear);
  }, [invoice]);
  React.useEffect(() => {
    setSlot(refusalSlot ? document.getElementById(refusalSlot) : null);
  }, [refusalSlot]);
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
  /** Pay and save: the buyer's answer for the picked new-method row. */
  const [keep, setKeep] = React.useState(false);
  const pickedChoice = choices?.find((c) => c.key === picked);
  React.useEffect(() => {
    setKeep(pickedChoice?.save?.checked === true);
  }, [pickedChoice?.key, pickedChoice?.save?.checked]);
  // A Stripe card that needs 3DS answers `client_secret`; the challenge is Elements in
  // our own modal — the same overlay RazorPay puts up, rather than a redirect.
  const [stripeChallenge, setStripeChallenge] = React.useState<{
    clientSecret: string;
    publishableKey: string;
    intentId: string;
    /** `?pay=return` on this portal, where `PaymentReturn` runs leg 2 after a bank page. */
    returnUrl: string;
    /** A saved card the bank wants to check; otherwise the buyer enters a new method. */
    saved: boolean;
    /** Drawn inside the open row of step 1 (option C), not in its own dialog. */
    inline?: boolean;
  } | null>(null);
  /** Step 1's open row whose gateway form is mounted inline, and that form's refusal. */
  const [inlineKey, setInlineKey] = React.useState<string | null>(null);
  const [inlineError, setInlineError] = React.useState<string | null>(null);
  const inlineHost = React.useRef<HTMLDivElement | null>(null);
  /** Set while `pay` runs for an inline row: its refusals show in the row, not on the page. */
  const inlineRun = React.useRef<string | null>(null);
  const router = useRouter();

  /** A capture the gateway holds for review leaves the invoice open: not "received" yet. */
  const finish = (
    result: { status?: string; saved_payment_method?: unknown; save_failed?: boolean },
    pending = false,
  ) => {
    // Paid from an inline form: step 1 closes with it.
    setChoices(null);
    setInlineKey(null);
    clearActiveIntent();
    headless?.onPaid();
    // Pay and save: say what was kept, or that it was not, beside the payment's own result.
    if (result.save_failed)
      toast("We could not save your payment method. Add it under Payment methods.");
    if (result.status === "paid" && result.saved_payment_method)
      toast.success("Payment received. We saved your payment method for future invoices.");
    else if (result.status === "paid") toast.success("Payment received");
    else if (pending) toast("Your bank is processing the payment. This can take some days.");
    else toast("We are confirming your payment.");
    // The invoice row, its badge and the amount due all live in the server component.
    router.refresh();
  };

  /** The gateway's or the engine's words, kept whole, then the next step unless they say one. */
  const refuse = (reason: string) => {
    if (inlineRun.current) {
      setInlineError(reason);
      return;
    }
    const message = refusalMessage(
      "We could not take your payment.",
      reason,
      /try again|add a card|contact|do not pay/i.test(reason)
        ? ""
        : `Select Pay ${money(amountMinor, currency)} to try again, or use a different payment method.`,
    ).trim();
    if (headless) headless.onRefused(message);
    else setRefusal(message);
  };

  /**
   * Ask first, but only when there is something to ask. The list is fetched on click,
   * not with the page: it is per-invoice and most buyers never need it.
   */
  const startPay = async (avoidGateway?: string) => {
    window.dispatchEvent(new CustomEvent(PAY_RETRY_EVENT, { detail: invoice }));
    setRetryAvoid(null);
    setStarted(true);
    setBusy(true);
    const [opts, listed] = await Promise.all([
      portalPayOptionsAction(invoice, avoidGateway).catch(() => ({
        ok: false as const,
        error: "",
      })),
      portalPayGatewaysAction(currency).catch(() => ({ ok: false as const, error: "" })),
    ]);
    const gws = listed.ok ? listed.gateways : [];
    // Apple Pay opens on the gateway's own page. Shown only where the browser can pay with it.
    const wallets: PayChoice[] = applePayReady()
      ? gws
          .filter((g) => g.apple_pay_hosted)
          .map((g) => ({
            key: `apple_pay:${g.id}`,
            gateway: g.id,
            wallet: "apple_pay" as const,
            label: "Apple Pay",
            marks: ["applepay"] as PaymentMarkKey[],
            note: "You pay on the secure page of the payment provider. Then you come back here.",
          }))
      : [];
    // The buyer's own methods first (primary first), then new ones with the gateway picked.
    const saved: PayChoice[] = opts.ok
      ? opts.options.saved.map((o) => ({
          key: `pm:${o.payment_method}`,
          paymentMethod: o.payment_method,
          kind: o.kind,
          label: instrumentLabel({
            type: o.type,
            brand: o.brand,
            last4: o.last4,
            mandateRail: o.mandate_rail,
          }),
          primary: o.primary,
          hint: o.available ? o.hint : o.reason,
          disabled: !o.available,
          lead: paymentMarkKey({ type: o.type, brand: o.brand, mandateRail: o.mandate_rail }),
        }))
      : [];
    const fresh: PayChoice[] = opts.ok
      ? opts.options.new_methods.map((n) => {
          const gk = gws.find((g) => g.id === n.gateway_account)?.gateway_key;
          const note = rowNote(n.method, gk);
          return {
            key: `new:${n.gateway_account}:${n.method}`,
            gateway: n.gateway_account,
            newCard: n.method === "card",
            method: n.method,
            save: n.save ?? null,
            label: newMethodLabel(
              n,
              gws,
              opts.options.saved.some((o) => o.type === "paypal"),
              opts.options.saved.some((o) => o.type === "card"),
            ),
            marks: rowMarks(n.method, gk, currency),
            bank: ["us_bank_account", "sepa_debit", "bank_transfer"].includes(n.method),
            note,
            formHere: note == null,
            formLogos: gk != null && FORM_SHOWS_CARD_LOGOS.has(gk),
          };
        })
      : // Options did not load: the old provider list still lets the buyer pay.
        gws.map((g) => ({
          key: g.id,
          gateway: g.id,
          label: gws.length > 1 ? g.label : "Card or other method",
        }));
    const all = [...saved, ...wallets, ...fresh];
    // Nothing saved and one way to pay: no question to ask, open the gateway's form. Unless
    // that way offers to save the method: then step 1 asks (an `always` save just goes).
    const only = fresh[0];
    if (
      saved.length === 0 &&
      wallets.length === 0 &&
      fresh.length <= 1 &&
      only?.save?.mode !== "offer"
    )
      return void pay(
        only?.gateway,
        undefined,
        undefined,
        false,
        only?.save ? { keep: true, textVersion: only.save.text_version } : undefined,
        only?.method,
      );
    const usable = saved.find((c) => !c.disabled);
    // INR above ₹15,000 with no working saved method: nothing preselected (decision 1).
    const highInr = currency.toUpperCase() === "INR" && amountMinor > INR_AFA_LIMIT_MINOR;
    setPicked(usable?.key ?? (highInr ? null : (all.find((c) => !c.disabled)?.key ?? null)));
    setChoices(all);
    setBusy(false);
  };

  const pay = async (
    gatewayAccount?: string,
    wallet?: "apple_pay",
    paymentMethod?: string,
    /** A mandate debit: it settles later, so the result is "in progress", not "received". */
    debit = false,
    /** Pay and save: keep the new method (consent text version shown). */
    save?: { keep: boolean; textVersion: string },
    /** The rail of the new-method row: the gateway's form is pinned to it. */
    methodType?: string,
    /** Step 1's row key: draw the gateway's form inside that row (option C). */
    inlineFor?: string,
  ) => {
    inlineRun.current = inlineFor ?? null;
    if (!inlineFor) setBusy(true);
    try {
      const res = await portalPayInvoiceAction(
        invoice,
        window.location.origin,
        undefined,
        gatewayAccount,
        undefined,
        wallet,
        paymentMethod,
        save,
        methodType,
      );
      if (!res.ok) return void refuse(res.error);

      // Settled outright — an instrument that needed no challenge (a Stripe card the
      // issuer waved through, or credit already covering the balance). Discriminated on
      // `object`: both arms carry a `status`, so that field narrows nothing.
      if (res.result.object !== "invoice_collection") {
        if (res.result.payment_error) {
          // The gateway failed on its side (not the bank, not an unknown outcome): a new
          // method can try another gateway. A saved method stays where it is held.
          if (gatewayAccount && !paymentMethod && GATEWAY_SIDE.has(res.result.payment_error.code))
            setRetryAvoid(gatewayAccount);
          return void refuse(res.result.payment_error.message);
        }
        if (res.result.collection_scheduled) {
          clearActiveIntent();
          headless?.onPaid();
          toast(res.result.collection_scheduled.message);
          router.refresh();
          return;
        }
        return finish(res.result, debit && res.result.status !== "paid");
      }
      const pending = res.result;
      setActiveIntent(pending.payment_intent.id);

      const action = pending.next_action ?? pending.payment_intent.next_action;
      if (!action)
        return void refuse(
          "We could not take your payment. The payment provider did not send the next step.",
        );

      // RazorPay: the challenge is their embedded modal, opened from this click. It
      // must be opened synchronously off the user gesture, which is why the whole
      // flow lives in the client rather than redirecting through the server.
      if (action.mode === "checkout" && action.checkout) {
        const result = await openRazorpayCheckout(action.checkout as RazorpayCheckoutDescriptor, {
          purpose: "payment",
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
        if (result.status === "failed") return void refuse(result.message);
        // Re-post the SAME call carrying the authorized intent; the server consumes it
        // against this invoice.
        const done = await portalPayInvoiceAction(
          invoice,
          window.location.origin,
          pending.payment_intent.id,
          undefined,
          result.status === "authorized" ? result.clientResult : undefined,
        );
        if (!done.ok) return void refuse(done.error);
        if (done.result.object !== "invoice_collection" && done.result.payment_error) {
          return void refuse(done.result.payment_error.message);
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
            address: {
              line1: me.customer.address.line1,
              city: me.customer.address.city,
              state: me.customer.address.state,
              state_code: me.customer.address.state_code,
              postal_code: me.customer.address.postal_code,
              country: me.customer.address.country,
            },
          },
          confirmLabel: `Pay ${money(amountMinor, currency)}`,
          ...(inlineFor && inlineHost.current ? { inline: inlineHost.current } : {}),
        });
        // Finished on this page: the return leg has nothing to do.
        clearPendingPayment(scope);
        if (result.status === "dismissed") return;
        if (result.status === "failed") return void refuse(result.message);
        const done = await portalPayInvoiceAction(
          invoice,
          window.location.origin,
          pending.payment_intent.id,
          undefined,
          result.clientResult,
        );
        if (!done.ok) return void refuse(done.error);
        if (done.result.object !== "invoice_collection" && done.result.payment_error) {
          return void refuse(done.result.payment_error.message);
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
        leaving.current = true;
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
        leaving.current = true;
        submitFormPost(action.formPost);
        return;
      }

      // Stripe: the intent is created unconfirmed, so the buyer selects the method and
      // confirms in Elements here — a card (with 3DS when the issuer asks), or a bank
      // method that redirects to `returnUrl` and finishes in `PaymentReturn`.
      if (action.mode === "client_secret" && action.clientSecret) {
        if (!action.publishableKey) {
          return void refuse(
            `The payment setup of ${me.business.name} is not complete. Contact ${me.business.name}.`,
          );
        }
        setStripeChallenge({
          clientSecret: action.clientSecret,
          publishableKey: action.publishableKey,
          intentId: pending.payment_intent.id,
          returnUrl: `${window.location.origin}/portal?pay=return`,
          saved: paymentMethod != null,
          ...(inlineFor ? { inline: true } : {}),
        });
        return;
      }

      refuse("We cannot confirm this payment method here yet. Add a card instead.");
    } catch {
      // A server action that throws (the network) must not leave the button looking untouched.
      refuse("We could not take your payment. The request did not finish.");
    } finally {
      setBusy(false);
    }
  };

  /**
   * Option C: when the open row's gateway draws its form in our page, start that payment
   * and mount the form inside the row. Again when the save box changes (the gateway is told
   * at creation whether to keep the method); the server voids the old one.
   */
  const inlineChoice =
    choices && pickedChoice?.formHere && !pickedChoice.paymentMethod ? pickedChoice : null;
  const inlineSig = inlineChoice
    ? `${inlineChoice.key}|${inlineChoice.save && (inlineChoice.save.mode === "always" || keep) ? 1 : 0}`
    : null;
  const payRef = React.useRef<typeof pay | null>(null);
  React.useLayoutEffect(() => {
    payRef.current = pay;
  });
  React.useEffect(() => {
    setStripeChallenge((c) => (c?.inline ? null : c));
    setInlineError(null);
    if (!inlineSig || !inlineChoice) return void setInlineKey(null);
    setInlineKey(inlineChoice.key);
    const keepIt = inlineSig.endsWith("|1");
    // After the row's host element is in the DOM.
    const t = setTimeout(() => {
      void payRef.current?.(
        inlineChoice.gateway,
        undefined,
        undefined,
        false,
        inlineChoice.save
          ? { keep: keepIt, textVersion: inlineChoice.save.text_version }
          : undefined,
        inlineChoice.method,
        inlineChoice.key,
      );
    }, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the choice signature only
  }, [inlineSig]);

  // Headless: start once on mount, and report when the buyer leaves without paying.
  const startRef = React.useRef(startPay);
  React.useLayoutEffect(() => {
    startRef.current = startPay;
  });
  const autoStart = headless != null;
  React.useEffect(() => {
    if (autoStart) void startRef.current();
  }, [autoStart]);
  const idleRef = React.useRef(headless?.onIdle);
  React.useLayoutEffect(() => {
    idleRef.current = headless?.onIdle;
  });
  React.useEffect(() => {
    if (started && !busy && choices == null && stripeChallenge == null && !leaving.current)
      idleRef.current?.();
  }, [started, busy, choices, stripeChallenge]);

  const amount = money(amountMinor, currency);
  if (processing)
    return headless ? null : (
      <span className="text-xs text-muted-foreground">Payment processing…</span>
    );
  /** The Stripe form: in its own dialog (a saved card's check), or inline in step 1's row. */
  const stripeForm = stripeChallenge ? (
    <StripeIntentForm
      purpose="payment"
      clientSecret={stripeChallenge.clientSecret}
      publishableKey={stripeChallenge.publishableKey}
      brandColor={me.business.brand_color}
      confirmLabel={stripeChallenge.inline ? `Pay ${amount}` : "Confirm payment"}
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
          // The gateway's own decline, kept whole, with what failed and the next step.
          return refusalMessage(
            "We could not take your payment.",
            done.result.payment_error.message,
            "Select Confirm payment to try again, or use a different payment method.",
          );
        }
        setStripeChallenge(null);
        if (inFlight) markPaymentProcessing(scope, invoice);
        finish(done.result, inFlight);
      }}
    />
  ) : null;
  return (
    <>
      {/* Step 1 lists the buyer's saved methods (charged with them present, or debited
          through a mandate) and new ones, with the gateway already picked. */}
      {headless ? null : (
        <Button
          ref={btnRef}
          size={size}
          variant={variant}
          onClick={() => void startPay()}
          disabled={busy}
          className="tabular-nums"
        >
          {busy ? "Paying…" : `Pay ${amount}`}
        </Button>
      )}
      {refusal ? (
        slot ? (
          createPortal(<RefusalAlert message={refusal} step="pay_invoice" />, slot)
        ) : (
          <RefusalAlert message={refusal} className="order-last basis-full" step="pay_invoice" />
        )
      ) : null}
      {refusal && retryAvoid && !headless ? (
        <Button
          size={size}
          className="order-last"
          onClick={() => void startPay(retryAvoid)}
          disabled={busy}
        >
          Try again
        </Button>
      ) : null}
      <PaymentDialog
        open={choices != null}
        onClose={() => setChoices(null)}
        title={`Pay ${amount}`}
        description="Select how to pay."
      >
        {choices ? (
          <div className="flex flex-col gap-4">
            {/* One list (the payment element pattern): every way to pay is a row with its
                logos, the selected row opens in place, one button below. Methods, never
                provider names: we pick the gateway. A saved method that cannot pay this
                invoice shows disabled with its reason. */}
            <RadioGroup
              value={picked ?? ""}
              onValueChange={setPicked}
              aria-label="Payment method"
              className="relative isolate flex flex-col gap-0 overflow-hidden rounded-xl border"
            >
              {/* One ring that glides to the selected row and eases to its height. */}
              <SegmentIndicator className="rounded-none bg-muted/40 shadow-none ring-1 ring-primary/50 ease-(--ease-glide) ring-inset" />
              {choices.map((c) => {
                const open = picked === c.key;
                return (
                  <div
                    key={c.key}
                    className={`border-b px-3.5 py-3 transition-colors last:border-b-0 ${
                      open
                        ? "segment-on bg-muted/40 ring-1 ring-primary/50 ring-inset"
                        : c.disabled
                          ? "bg-muted/40"
                          : "hover:bg-muted/50"
                    }`}
                  >
                    <RadioOption
                      value={c.key}
                      disabled={c.disabled}
                      label={
                        <span className="flex w-full items-center gap-2">
                          {c.lead ? <PaymentMark mark={c.lead} className="shrink-0" /> : null}
                          <span className="wrap-break-word">
                            {c.label}
                            {c.primary ? (
                              <span className="ml-2 text-xs text-muted-foreground">Primary</span>
                            ) : null}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1">
                            {/* The open row's gateway form shows its own card logos. */}
                            {c.formHere && c.formLogos && !c.paymentMethod && inlineKey === c.key
                              ? null
                              : (c.marks ?? []).map((m) => <PaymentMark key={m} mark={m} />)}
                            {c.bank ? (
                              <Landmark className="size-4 text-muted-foreground" aria-hidden />
                            ) : null}
                          </span>
                        </span>
                      }
                      {...(c.hint ? { hint: c.hint } : {})}
                    />
                    {open && (c.note || c.save || c.formHere) ? (
                      <div className="sf-expand mt-3 flex flex-col gap-3 pl-7">
                        {c.note ? <p className="text-xs text-muted-foreground">{c.note}</p> : null}
                        {c.save?.mode === "offer" ? (
                          <CheckboxField
                            checked={keep}
                            onCheckedChange={setKeep}
                            label={`Save this ${saveNoun(c.method)} for future payments`}
                            hint={c.save.text}
                          />
                        ) : c.save?.mode === "always" ? (
                          <p className="text-xs text-muted-foreground">{c.save.text}</p>
                        ) : null}
                        {c.formHere && !c.paymentMethod && inlineKey === c.key ? (
                          <>
                            {inlineError ? (
                              <RefusalAlert message={inlineError} step="pay_invoice" />
                            ) : null}
                            {stripeChallenge?.inline ? (
                              <SdkFrame inline open onClose={() => undefined} title="">
                                {stripeForm}
                              </SdkFrame>
                            ) : (
                              <div ref={inlineHost} />
                            )}
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </RadioGroup>
            {inlineChoice ? null : (
              <PaymentDialogFooter>
                <Button
                  disabled={busy || !picked}
                  className="w-full tabular-nums"
                  onClick={() => {
                    const chosen = choices?.find((c) => c.key === picked);
                    setChoices(null);
                    void pay(
                      chosen?.gateway,
                      chosen?.wallet,
                      chosen?.paymentMethod,
                      chosen?.kind === "debit",
                      chosen?.save
                        ? {
                            keep: chosen.save.mode === "always" || keep,
                            textVersion: chosen.save.text_version,
                          }
                        : undefined,
                      chosen?.paymentMethod || chosen?.wallet ? undefined : chosen?.method,
                    );
                  }}
                >
                  {payButtonLabel(pickedChoice, amount)}
                </Button>
              </PaymentDialogFooter>
            )}
          </div>
        ) : null}
      </PaymentDialog>
      {/* A dialog, not an inline panel: the invoice row's action slot is sized for a
          28px button, and rendering a card form into it collapsed the invoice text to a
          narrow column and pushed the actions outside the sheet. A short confirm flow is
          the Modal archetype. */}
      <PaymentDialog
        open={stripeChallenge != null && !stripeChallenge.inline}
        onClose={() => setStripeChallenge(null)}
        title={stripeChallenge?.saved === false ? `Pay ${amount}` : "Confirm your payment"}
        description={
          stripeChallenge?.saved === false
            ? privacyText(me.business.name, "card")
            : "Your bank must verify this payment before we can take it."
        }
      >
        {stripeChallenge && !stripeChallenge.inline ? stripeForm : null}
      </PaymentDialog>
    </>
  );
}
