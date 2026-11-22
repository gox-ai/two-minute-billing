"use client";

import * as React from "react";
import { paymentMethodTypeLabel } from "@/lib/filter-options";
import { toast } from "sonner";
import { AlertCircle, CheckCircle2, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { NO_SESSION } from "@/lib/checkout-strings";
import { CouponBox, CouponRefusals } from "./coupon-box";
import { RollingNumber } from "@/components/ui/rolling-number";
import { BusyLabel } from "../../storefront-motion";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { AddressFields } from "@/components/customers/address-fields";
import type { Country } from "@/lib/api/geo";
import {
  checkoutSetCustomerAction,
  checkoutBeginSetupAction,
  checkoutCompleteAction,
  checkoutGatewaysAction,
  checkoutPaymentMethodsAction,
  checkoutInvoiceStateAction,
  checkoutSetItemAction,
  checkoutRecordViewAction,
} from "./actions";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { CheckboxField } from "@/components/ui/checkbox";
import { Turnstile } from "@/components/turnstile";
import { useRouter } from "next/navigation";
import { MethodTypeChoice, type MethodType } from "../../method-choice";
import { privacyText, railsForCurrency } from "../../storefront-text";
import { useDefaultState } from "@/lib/use-default-state";
import { useReportInstrument } from "../../storefront-footer";
import { AchAuthorization } from "../../ach-authorization";
import { PaymentMark, paymentMarkKey } from "@/components/brand/payment-mark";
import {
  clearPendingVaultSetup,
  consumeSetupReturn,
  readPendingVaultSetup,
  savePendingVaultSetup,
} from "@/lib/pending-vault-setup";
import { readSdkReturnResult } from "@/lib/return-params";
import {
  openRazorpayCheckout,
  vaultSetupDescription,
  type RazorpayCheckoutDescriptor,
} from "@/lib/razorpay-checkout";
import {
  formPostTargetIsSafe,
  openGatewaySdk,
  submitFormPost,
  type FormPostDescriptor,
  type GatewaySdkDescriptor,
} from "@/lib/gateway-sdk";
import { money } from "@/lib/format";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import { creditNarrativeFromPreview } from "@/lib/credit-legs";
import { INCLUDED_TAX_LABEL, splitTax } from "@/lib/tax-rows";
import { Chip } from "@/components/patterns/chip";
import {
  BrandTheme,
  Glyph,
  NoticeCard,
  ProductGlyph,
  Steps,
  StorefrontFooter,
  StorefrontHeader,
  StorefrontSection,
  instrumentLabel,
} from "../../chrome";
import {
  PaymentDialog,
  PaymentDialogFooter,
  RefusalAlert,
  StripeIntentForm,
  refusalMessage,
} from "../../payment-dialog";
import { TruncatedText } from "../../truncated-text";
import { contactBusiness } from "@/lib/gateway-errors";
import { clearActiveIntent, reportBuyerError, setActiveIntent } from "@/lib/buyer-error-report";
import type {
  CheckoutView,
  CheckoutChangePreview,
  CheckoutNextPayment,
  CheckoutChangeMandate,
  CheckoutComplete,
  CheckoutCompletion,
  CheckoutCustomerDetails,
  CheckoutAddressDetails,
  CheckoutPaymentMethod,
  CheckoutVaultSetup,
  CheckoutGateway,
  CheckoutPurchase,
} from "@/lib/checkout-api";

/** The change applied but its invoice is open — see `CheckoutComplete.unpaid_invoice`. */
type UnpaidInvoice = NonNullable<CheckoutComplete["unpaid_invoice"]>;
/** The capture was refused AFTER the subscription existed — see `payment_error`. */
type PaymentError = NonNullable<CheckoutComplete["payment_error"]>;

/**
 * Everything a settled completion produced, in one shape.
 *
 * `paymentError` used to be dropped on the floor: the action returned it and nobody read
 * it, so a signup whose first charge was refused after the subscription existed reported
 * a plain green success. It is a THIRD outcome alongside `unpaidInvoice`, not a variant
 * of it — a create-mode completion carries no `unpaid_invoice` (that field is change
 * mode's), so folding the two would have lost it again.
 */
interface CompletionOutcome {
  subscriptionId: string;
  /** A purchase's invoice — it creates no subscription. */
  invoiceId?: string;
  unpaidInvoice?: UnpaidInvoice | null;
  paymentError?: PaymentError | null;
}

/** What the buyer typed on the details step, for the gateway's own sheet. */
interface BuyerPrefill {
  name?: string | null;
  email?: string | null;
  contact?: string | null;
  /** The billing address the page already took, so a gateway form need not ask again. */
  address?: {
    line1: string | null;
    city: string | null;
    state: string | null;
    state_code: string | null;
    postal_code: string | null;
    country: string | null;
  };
}

/**
 * The toast for a finished completion — ONE definition, because every call site goes
 * through the completion hook below and they have to say the same thing.
 *
 * Four outcomes, not two. `processing` is a live gateway attempt (an async mandate
 * debit), so it is neither a success to celebrate nor a failure to warn about: the
 * money is moving and the done screen is about to wait for it. Warning-toasting that
 * one told buyers their payment had failed while it was still in flight. A
 * `paymentError` is the opposite — a refusal that HAS happened, on a subscription that
 * exists — and it never reached a toast at all until now.
 */
/** The engine's refusal while a gateway's approval has not reached us yet (checkout/service.ts). */
const NOT_YET_APPROVED = /Complete the (payment step|authentication) first/;
const RETURN_AUTO_RETRIES = 4;

/** `url` with the session id and outcome appended, keeping its own query. Null if unparseable. */
function withSessionOutcome(
  url: string | null,
  id: string,
  state: "succeeded" | "cancelled",
): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    u.searchParams.set("id", id);
    u.searchParams.set("state", state);
    return u.toString();
  } catch {
    return null;
  }
}

/** Confirm-button wording for a reactivation: say "pay" only when money moves today. */
function reactivateLabel(preview: CheckoutChangePreview | undefined): string {
  return preview?.immediateCharge && preview.amountDueMinor > 0
    ? "Reactivate and pay"
    : "Reactivate";
}

/** The billing interval of the plan line ("month", "3 months"), or null. */
function planInterval(view: CheckoutView): string | null {
  const item =
    view.items.find((i) => i.kind === "plan" && i.interval) ?? view.items.find((i) => i.interval);
  if (item?.interval) return item.interval;
  return view.offer?.lines.find((l) => l.quantity > 0 && l.interval)?.interval ?? null;
}

/** The product the buyer subscribes to: the plan line's name. */
function planName(view: CheckoutView): string | null {
  const offerPlan = view.offer?.lines.find((l) => l.quantity > 0);
  return (
    view.items.find((i) => i.kind === "plan")?.name ??
    view.items[0]?.name ??
    offerPlan?.name ??
    null
  );
}

/** "14 days", "1 month". */
function trialLength(t: { count: number; unit: string }): string {
  return `${t.count} ${t.unit}${t.count === 1 ? "" : "s"}`;
}

/** What the one commit button says, and the line under it that dates the money. */
interface CommitCopy {
  label: string;
  busy: string;
  summary: string | null;
}

function commitCopy(view: CheckoutView): CommitCopy {
  const tz = view.business.timezone;
  if (view.mode === "purchase" && view.purchase) {
    const due = view.purchase.amount_due_minor;
    return {
      label: due > 0 ? `Pay ${money(due, view.purchase.currency)}` : "Complete purchase",
      busy: due > 0 ? "Paying…" : "Completing…",
      summary: null,
    };
  }
  if (view.mode === "change") {
    const p = view.change?.preview;
    const reactivate = view.change?.reactivation != null;
    const payNow = p && p.immediateCharge && p.amountDueMinor > 0 ? p.amountDueMinor : 0;
    const label = reactivate
      ? payNow > 0
        ? `Reactivate and pay ${money(payNow, p!.currency)}`
        : "Reactivate"
      : view.change?.itemsUnchanged && view.coupons.length === 0
        ? "Confirm"
        : payNow > 0
          ? `Confirm change and pay ${money(payNow, p!.currency)}`
          : "Confirm change";
    const every = planInterval(view);
    const regular = view.nextPayment;
    const next =
      p?.nextRenewalAt && p.nextRenewalAmountDueMinor != null
        ? ` Your next payment is ${money(p.nextRenewalAmountDueMinor, p.currency)} on ${fmtDate(p.nextRenewalAt, tz)}.`
        : // A fresh term renews one period after it starts: the regular amount, no date to
          // invent. Not while an introductory discount runs, which this figure excludes.
          reactivate && regular && every && !regular.intro
          ? ` Then ${money(regular.totalMinor, regular.currency)} every ${every}${regular.excludesUsage ? ", plus usage" : ""}.`
          : "";
    const today = p
      ? payNow > 0
        ? `You pay ${money(payNow, p.currency)} today.`
        : "You pay nothing today."
      : "";
    return {
      label,
      busy: reactivate ? "Reactivating…" : "Confirming…",
      summary: `${today}${next}`.trim() || null,
    };
  }
  const due = view.dueToday;
  if (due?.trial) {
    const when = due.firstChargeAt ? fmtDate(due.firstChargeAt, tz) : null;
    return {
      label: "Start free trial",
      busy: "Starting…",
      summary: when
        ? due.firstChargeMinor != null
          ? `You pay nothing today. Your first payment of ${money(due.firstChargeMinor, due.currency)} is on ${when}.`
          : `You pay nothing today. Your first payment is on ${when}.`
        : "You pay nothing today.",
    };
  }
  if (due) {
    const amt = due.amountDueMinor;
    return {
      label: amt > 0 ? `Subscribe and pay ${money(amt, due.currency)}` : "Subscribe",
      busy: "Subscribing…",
      summary: `You pay ${money(amt, due.currency)} today.${
        due.nextChargeAt ? ` Your next payment is on ${fmtDate(due.nextChargeAt, tz)}.` : ""
      }`,
    };
  }
  return { label: "Subscribe", busy: "Subscribing…", summary: null };
}

/**
 * A proration line in the buyer's words. The engine writes "Remaining time on X ×1" for the
 * operator's ledger; the buyer reads the product and the dates it covers.
 */
function buyerLineLabel(description: string, until: string | null): string {
  const q = (n: string | undefined) => (n && n !== "1" ? ` × ${n}` : "");
  const rest = until ? `today to ${until}` : "rest of this billing period";
  let m = /^Remaining time on (.+?) ×(\d+)$/.exec(description);
  if (m) return `${m[1]}${q(m[2])}, ${rest}`;
  m = /^(.+?) - Prorated Charges(?: ×(\d+))?$/.exec(description);
  if (m) return `${m[1]}${q(m[2])}, ${rest}`;
  m = /^Unused time on (.+?) ×(\d+)$/.exec(description);
  if (m) return `Credit for unused time on ${m[1]}${q(m[2])}`;
  m = /^(.+?) ×(\d+) \(new term\)$/.exec(description);
  if (m) return `${m[1]}${q(m[2])}, new billing period`;
  m = /^(.+?) ×(\d+)$/.exec(description);
  if (m) return `${m[1]}${q(m[2])}`;
  return description;
}

/**
 * The credit a change gives back, in the buyer's words. Same legs as `creditLegSentences`
 * (they account for all of the credit), without the operator's vocabulary.
 */
function buyerCreditSentences(
  n: ReturnType<typeof creditNarrativeFromPreview>,
  fmt: (minor: number) => string,
  when: (iso: string) => string,
  oldPlan: string | null,
): string[] {
  if (n.grossMinor <= 0) return [];
  const out = [
    `You get ${fmt(n.grossMinor)} back for the time that you do not use on ${
      oldPlan ?? "your current plan"
    }${n.periodEnd ? `, from today to ${when(n.periodEnd)}` : ""}.`,
  ];
  const order = {
    open_invoice: 0,
    this_invoice: 1,
    balance: 2,
    payment_method: 3,
    buckets: 4,
    none: 5,
  };
  const legs = [...n.destinations]
    .filter((d) => d.amount_minor > 0)
    .sort((a, b) => order[a.destination] - order[b.destination]);
  const all = legs.length === 1 && legs[0]!.amount_minor === n.grossMinor;
  for (const d of legs) {
    const amt = all ? "All of it" : `${fmt(d.amount_minor)} of it`;
    switch (d.destination) {
      case "open_invoice":
        out.push(`${amt} pays your unpaid invoice${d.invoice ? ` ${d.invoice}` : ""}.`);
        break;
      case "this_invoice":
        out.push(`${amt} lowers what you pay today.`);
        break;
      case "balance":
        out.push(`${amt} stays on your account and lowers your next payment.`);
        break;
      case "payment_method":
        out.push(`${amt} goes back to your payment method.`);
        break;
      case "buckets":
        out.push(`${amt} goes back to the promotional credit that it came from.`);
        break;
      case "none":
        out.push(`${amt} cannot be used on your account.`);
        break;
    }
  }
  return out;
}

/**
 * ── The FIRST-CHARGE challenge stash ──────────────────────────────────────────────
 *
 * A redirect-mode challenge on the first charge (PayPal) takes the buyer off-site in THIS
 * tab, so the two things leg 2 needs — the completion leg 1 sent, and OUR `pi_…` — have to
 * survive a full page load. Same mechanism, same reasoning and the same per-tab lifetime as
 * `lib/pending-vault-setup.ts`, which carries a VAULT approval across the identical hop;
 * kept separate from it because they are different objects with different lifetimes (a
 * vault stash outlives the completion that spends it; this one is spent by it) and one key
 * holding both would have each clear the other.
 *
 * ⚠️ Not `lib/pending-vault-setup.ts` itself: that module is shared with the portal, and
 * this is a hosted-checkout concern. If the portal's "Pay now" ever wants the same thing,
 * that is the moment to promote it — not before.
 *
 * ⚠️ NON-SECRET, like its neighbour. The key is the checkout session's PUBLIC id (it only
 * has to tell two buyers sharing a browser apart) and the value holds public ids and a
 * provider setup token — never the session credential, which lives in an HttpOnly cookie.
 */
interface PendingPaymentChallenge {
  /** Leg 1's completion, repeated verbatim — see `usePaymentChallenge`. */
  completion: CheckoutCompletion;
  gatewayAccount?: string;
  /**
   * OUR `pi_…`. Never the provider's — PayPal echoes its ORDER id on the return URL as
   * `token`, and the engine consumes its own intent, so that echo is not a fallback for
   * this and must never be treated as one.
   */
  paymentIntent: string;
}

const challengeKey = (scope: string) => `tmb:pending-charge:${scope}`;

/**
 * Whether this browser can carry a challenge across a same-tab redirect AT ALL.
 *
 * Asked BEFORE leg 1 posts, because leg 1 is what fixes the gateway's `return_url`: by the
 * time the 402 comes back the PayPal order already exists and where it returns the buyer is
 * settled. Deciding late would let the two halves disagree — a `return_url` sent to a
 * browser that then cannot resume, which is a worse dead end than the one this fixes.
 */
function canResumeAcrossRedirect(): boolean {
  try {
    const probe = `${challengeKey("probe")}:w`;
    sessionStorage.setItem(probe, "1");
    const ok = sessionStorage.getItem(probe) === "1";
    sessionStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

/** False = it did not stick, so the caller must hold the buyer itself. Read back, not assumed. */
function savePendingPaymentChallenge(scope: string, pending: PendingPaymentChallenge): boolean {
  try {
    sessionStorage.setItem(challengeKey(scope), JSON.stringify(pending));
    return sessionStorage.getItem(challengeKey(scope)) !== null;
  } catch {
    return false;
  }
}

function readPendingPaymentChallenge(scope: string): PendingPaymentChallenge | null {
  try {
    const raw = sessionStorage.getItem(challengeKey(scope));
    return raw ? (JSON.parse(raw) as PendingPaymentChallenge) : null;
  } catch {
    return null;
  }
}

function clearPendingPaymentChallenge(scope: string): void {
  try {
    sessionStorage.removeItem(challengeKey(scope));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Read the charge-side return-leg param and strip the whole query, so a reload cannot
 * re-run leg 2 and PayPal's `token`/`PayerID` echoes do not linger in the address bar.
 *
 * `pay`, not `setup`: the two legs are deliberately distinguishable, because a vault
 * approval and a first-charge authentication come back to the same page and mean different
 * things. `consumeSetupReturn` ignores `?pay=…` and this ignores `?setup=…`, so whichever
 * one is in the URL is the only one that fires.
 */
function consumePaymentReturn(cleanPath: string): "return" | "cancel" | null {
  const pay = new URLSearchParams(window.location.search).get("pay");
  if (pay !== "return" && pay !== "cancel") return null;
  window.history.replaceState({}, "", cleanPath);
  return pay;
}

/**
 * The buyer's PO number (Hosted pages → collect PO number). Typed on the details or
 * confirm step and sent with every completion; kept in sessionStorage so a gateway
 * redirect does not lose it.
 */
interface PoNumberState {
  collect: boolean;
  required: boolean;
  value: string;
  setValue: (v: string) => void;
  /** What to send: the field, or — on a fresh page after a gateway redirect — the stored copy. */
  current: () => string;
  /** A payment was refused for an empty required field: the field shows the error. */
  missing: boolean;
  /** Show the error at the field and bring it into view. False when the field is not on the page. */
  flag: () => boolean;
}
const NO_PO: PoNumberState = {
  collect: false,
  required: false,
  value: "",
  setValue: () => {},
  current: () => "",
  missing: false,
  flag: () => false,
};
const PO_MISSING = "Enter your PO number.";
const PoNumberContext = React.createContext<PoNumberState>(NO_PO);
const poStorageKey = (scope: string) => `tmb.checkout.po.${scope}`;

function usePoNumberState(scope: string, view: CheckoutView): PoNumberState {
  const collect = view.collect_po_number === true;
  const required = collect && view.field_config?.["invoice.po_number"] === "mandatory";
  const [value, setRaw] = React.useState<string | null>(null);
  const [missing, setMissing] = React.useState(false);
  const flag = React.useCallback(() => {
    // `Field` gives the input its name as its id.
    const input = document.getElementById("po_number");
    if (!input || input.getClientRects().length === 0) return false;
    setMissing(true);
    input.scrollIntoView({ block: "center" });
    input.focus({ preventScroll: true });
    return true;
  }, []);
  const setValue = React.useCallback(
    (v: string) => {
      setRaw(v);
      setMissing(false);
      try {
        window.sessionStorage.setItem(poStorageKey(scope), v);
      } catch {
        // Storage blocked: the value still lives in memory for this page.
      }
    },
    [scope],
  );
  const current = React.useCallback(() => {
    if (value !== null) return value;
    try {
      return window.sessionStorage.getItem(poStorageKey(scope)) ?? "";
    } catch {
      return "";
    }
  }, [value, scope]);
  return React.useMemo(
    () => ({ collect, required, value: value ?? "", setValue, current, missing, flag }),
    [collect, required, value, setValue, current, missing, flag],
  );
}

/**
 * The consent boxes (Hosted pages → Consent at checkout). Kept in sessionStorage like the PO
 * number, so a gateway redirect does not lose them. The engine checks them again.
 */
type ConsentAnswers = { recurring: boolean; terms: boolean; marketing: boolean };
/** What is sent: the answers, plus the exact sentence the buyer agreed to. */
type ConsentPost = ConsentAnswers & { recurring_text?: string };
interface ConsentState {
  recurringText: string | null;
  termsRequired: boolean;
  termsUrl: string | null;
  privacyUrl: string | null;
  marketingOffered: boolean;
  answers: ConsentAnswers;
  set: (key: keyof ConsentAnswers, v: boolean) => void;
  current: () => ConsentAnswers;
  /** The engine asked for a Turnstile check; the widget shows until the payment goes through. */
  botCheck: boolean;
  setBotCheck: (v: boolean) => void;
  /** A payment was refused for a missing box: each missing box shows its own error. */
  showErrors: boolean;
  /** Show the errors on the boxes and bring them into view. */
  flag: () => void;
}
const NO_ANSWERS: ConsentAnswers = { recurring: false, terms: false, marketing: false };
const NO_CONSENT: ConsentState = {
  recurringText: null,
  termsRequired: false,
  termsUrl: null,
  privacyUrl: null,
  marketingOffered: false,
  answers: NO_ANSWERS,
  set: () => {},
  current: () => NO_ANSWERS,
  botCheck: false,
  setBotCheck: () => {},
  showErrors: false,
  flag: () => {},
};
const ConsentContext = React.createContext<ConsentState>(NO_CONSENT);
const consentStorageKey = (scope: string) => `tmb.checkout.consent.${scope}`;

function readStoredConsent(scope: string): ConsentAnswers | null {
  try {
    const raw = window.sessionStorage.getItem(consentStorageKey(scope));
    return raw ? { ...NO_ANSWERS, ...(JSON.parse(raw) as Partial<ConsentAnswers>) } : null;
  } catch {
    return null;
  }
}

function useConsentState(scope: string, view: CheckoutView): ConsentState {
  const c = view.consent;
  const [answers, setAnswers] = React.useState<ConsentAnswers | null>(null);
  const [botCheck, setBotCheck] = React.useState(false);
  const [showErrors, setShowErrors] = React.useState(false);
  const flag = React.useCallback(() => {
    setShowErrors(true);
    requestAnimationFrame(() =>
      document
        .getElementById("checkout-consent")
        ?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }, []);
  const set = React.useCallback(
    (key: keyof ConsentAnswers, v: boolean) => {
      setAnswers((prev) => {
        const next = { ...(prev ?? readStoredConsent(scope) ?? NO_ANSWERS), [key]: v };
        try {
          window.sessionStorage.setItem(consentStorageKey(scope), JSON.stringify(next));
        } catch {
          // Storage blocked: the answers still live in memory for this page.
        }
        return next;
      });
    },
    [scope],
  );
  const current = React.useCallback(
    () => answers ?? readStoredConsent(scope) ?? NO_ANSWERS,
    [answers, scope],
  );
  return React.useMemo(
    () => ({
      recurringText: c?.recurring_text ?? null,
      termsRequired: c?.terms_required === true,
      termsUrl: c?.terms_url ?? null,
      privacyUrl: c?.privacy_url ?? null,
      marketingOffered: c?.marketing_offered === true,
      answers: answers ?? NO_ANSWERS,
      set,
      current,
      botCheck,
      setBotCheck,
      showErrors,
      flag,
    }),
    [c, answers, set, current, botCheck, showErrors, flag],
  );
}

/** The answers to post, or undefined when the page asks for no consent. */
function consentPost(consent: ConsentState): ConsentPost | undefined {
  if (!consent.recurringText && !consent.termsRequired && !consent.marketingOffered) return;
  const answers = consent.current();
  return consent.recurringText ? { ...answers, recurring_text: consent.recurringText } : answers;
}

/** The refusal for a missing required box, or null when the answers are enough. */
function consentRefusal(consent: ConsentState, a: ConsentAnswers): string | null {
  if (consent.recurringText && !a.recurring)
    return "Select the box to agree to the recurring charge.";
  if (consent.termsRequired && !a.terms) return "Select the box to accept the terms.";
  return null;
}

function ConsentBoxes() {
  const consent = React.useContext(ConsentContext);
  if (!consent.recurringText && !consent.termsRequired && !consent.marketingOffered) return null;
  const a = consent.answers;
  const err = (missing: boolean, text: string) =>
    consent.showErrors && missing ? (
      <p className="mt-1 pl-6 text-xs font-medium text-destructive" role="alert">
        {text}
      </p>
    ) : null;
  return (
    <div id="checkout-consent" className="flex flex-col gap-3">
      {consent.recurringText ? (
        <div>
          <CheckboxField
            checked={a.recurring}
            onCheckedChange={(v) => consent.set("recurring", v === true)}
            label={consent.recurringText}
          />
          {err(!a.recurring, "Select this box to agree to the recurring charge.")}
        </div>
      ) : null}
      {consent.termsRequired && consent.termsUrl ? (
        <div>
          <CheckboxField
            checked={a.terms}
            onCheckedChange={(v) => consent.set("terms", v === true)}
            label={
              <span>
                I accept the{" "}
                <a
                  href={consent.termsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  Terms of service
                </a>
                {consent.privacyUrl ? (
                  <>
                    {" "}
                    and the{" "}
                    <a
                      href={consent.privacyUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      Privacy policy
                    </a>
                  </>
                ) : null}
                .
              </span>
            }
          />
          {err(!a.terms, "Select this box to accept the terms.")}
        </div>
      ) : null}
      {consent.marketingOffered ? (
        <CheckboxField
          checked={a.marketing}
          onCheckedChange={(v) => consent.set("marketing", v === true)}
          label="Send me news and offers by email."
          hint="Optional."
        />
      ) : null}
    </div>
  );
}

/** The Turnstile token the widget wrote, or undefined before it is solved. */
function turnstileToken(): string | undefined {
  const el = document.querySelector<HTMLInputElement>(
    '#checkout-bot-check input[name="turnstile_token"]',
  );
  return el?.value ? el.value : undefined;
}

function BotCheck() {
  const consent = React.useContext(ConsentContext);
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  if (!consent.botCheck || !siteKey) return null;
  return (
    <StorefrontSection title="Check that you are a person">
      <div id="checkout-bot-check" className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Complete the check, then select the payment button again.
        </p>
        <Turnstile siteKey={siteKey} />
      </div>
    </StorefrontSection>
  );
}

function PoNumberInput() {
  const po = React.useContext(PoNumberContext);
  if (!po.collect) return null;
  return (
    <Field
      name="po_number"
      label="PO number"
      required={po.required}
      help="Your purchase order number, shown on your invoices."
      error={po.missing ? PO_MISSING : undefined}
    >
      <Input
        name="po_number"
        value={po.value}
        onChange={(e) => po.setValue(e.target.value)}
        required={po.required}
        maxLength={100}
        autoComplete="off"
      />
    </Field>
  );
}

/**
 * Post `/checkout/v1/complete` and, when the gateway asks the buyer to authenticate,
 * put the challenge in front of them and re-post.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────────
 * The engine has answered **402** with `payment_intent` + `next_action` since 2026-08-10
 * (`CheckoutActionRequiredError`), and no client implemented the second leg: every call
 * site folded it into `toast.error(...)`, so a buyer whose issuer challenged the first
 * charge read "This payment needs your authentication before the subscription can be
 * created" and had nowhere to go. The session is correctly released to `open`, so they
 * could retry the same card and be refused identically, forever.
 *
 * ── The state machine ─────────────────────────────────────────────────────────────
 *   leg 1  POST /complete
 *     ├ 201 ─────────────────► settled (onCompleted)
 *     ├ 402 + next_action
 *     │   ├ 'checkout'      ─► RazorPay's sheet over this page ─┐
 *     │   ├ 'client_secret' ─► Stripe Elements in a PaymentDialog ─┤
 *     │   └ 'redirect'      ─► THIS TAB goes to the approval page, ─┤
 *     │                        returns to `?pay=return`, resumes    │
 *     │                        (no stash ⇒ new tab + panel instead) │
 *     │                                                          ▼
 *     │                        leg 2  POST /complete { …same completion, payment_intent }
 *     │                          └ 201 ─► settled     (a second 402 is NOT re-challenged)
 *     └ anything else ──────► toast + onFailed
 *
 * Leg 2 repeats the FIRST leg's completion verbatim and adds `payment_intent`. It cannot
 * send the intent alone: create mode still refuses a completion with no instrument, and
 * re-sending the same `setup_intent` is safe because `completeVaultFromIntent` resolves
 * the row an already-consumed intent names rather than vaulting a second one.
 *
 * ⚠️ Leg 2 is keyed on OUR `pi_…`, never on the id the provider's SDK returns. The
 * engine consumes its own intent; the gateway's reference means nothing to it. Same rule
 * the portal's "Pay now" spells out (`pay-invoice.tsx`), whose components this reuses.
 *
 * ── Why the redirect arm changed (2026-08-30) ─────────────────────────────────────
 * It used to open the approval page in a NEW TAB and keep this one alive holding the
 * intent, because `POST /checkout/v1/complete` accepted no `return_url`: the PayPal order
 * carried no `experience_context`, so the buyer approved and was never sent anywhere, and
 * navigating this tab would have thrown the checkout away. The route takes the pair now
 * (F-45), so the buyer is returned to `?pay=return` and leg 2 runs by itself.
 *
 * The two are mutually exclusive, which is what settled it: send a `return_url` AND open a
 * new tab and PayPal returns the buyer into THAT tab, onto a hosted checkout with no memory
 * of the challenge — a fresh, empty flow inviting them to start over and pay twice. So the
 * new tab survives in exactly one place: as the fallback for a browser whose sessionStorage
 * cannot carry the stash, decided by `canResumeAcrossRedirect()` BEFORE leg 1 posts, where
 * no `return_url` is sent either and the old behaviour is reproduced whole.
 *
 * ⚠️ NOT the same code path as `awaitingMandate` in `CardStep`, which also holds a tab
 * open. That one is a vault SETUP on RazorPay's netbanking e-mandate rail, where
 * `subscription_registration/auth_links` IGNORES `callback_url` (measured three times,
 * 2026-08-14) — a provider defect no field of ours can fix. It is untouched by this and
 * must stay that way.
 */
function usePaymentChallenge({
  scope,
  businessName,
  brandColor,
  isChange,
  reactivate = false,
  purchase,
  prefill,
  onSessionEnded,
  onCompleted,
  onFailed,
  quiet,
  showsRefusal = false,
  po: poOverride,
  consent: consentOverride,
}: {
  /** Non-secret per-session key for the redirect-leg stash — the checkout's public id. */
  scope: string;
  businessName: string;
  /** The merchant's brand hex, for the Elements iframe — see `stripeAppearance`. */
  brandColor: string | null;
  isChange: boolean;
  /** This change reactivates a cancelled subscription — wording only. */
  reactivate?: boolean;
  /** A one-time purchase — wording only. */
  purchase?: boolean;
  /** Buyer details for the gateway's own sheet, when we know them.  */
  prefill?: BuyerPrefill;
  /** The engine says the session is gone — terminal, so the caller takes over. */
  onSessionEnded: () => void;
  onCompleted: (outcome: CompletionOutcome) => void;
  /** A refusal the buyer was told about. Not called when they simply close a challenge. */
  onFailed?: (error: string) => void;
  /** A failure the caller handles itself (an automatic retry): no error toast. */
  quiet?: (error: string) => boolean;
  /** The caller renders `refusal` beside its Pay button, so a refusal is not also a toast. */
  showsRefusal?: boolean;
  /** For a caller outside `PoNumberContext` (the flow's own return leg). */
  po?: PoNumberState;
  /** For a caller outside `ConsentContext` (the flow's own return leg). */
  consent?: ConsentState;
}) {
  const poFromContext = React.useContext(PoNumberContext);
  const po = poOverride ?? poFromContext;
  const consentFromContext = React.useContext(ConsentContext);
  const consent = consentOverride ?? consentFromContext;
  const router = useRouter();
  const [stripeChallenge, setStripeChallenge] = React.useState<{
    clientSecret: string;
    publishableKey: string;
    intentId: string;
  } | null>(null);
  /** `url` for a redirect, `formPost` for a signed POST — exactly one is set. */
  const [redirectChallenge, setRedirectChallenge] = React.useState<{
    url?: string;
    formPost?: FormPostDescriptor;
    intentId: string;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  /** The last refusal, kept on the page beside Pay: a toast closes itself, and a buyer reading
   *  the card after it would see an unchanged page with no reason the payment did not happen. */
  const [refusal, setRefusal] = React.useState<string | null>(null);
  /** Leg 1's completion, held for leg 2 to repeat verbatim. */
  const repeat = React.useRef<{ completion: CheckoutCompletion; gatewayAccount?: string } | null>(
    null,
  );
  /** Tell the buyer once: inline when the caller shows `refusal`, else a toast. */
  const refuse = (error: string) => {
    if (showsRefusal) setRefusal(error);
    else {
      toast.error(error);
      reportBuyerError(error, { step: "pay" });
    }
    onFailed?.(error);
    return error;
  };

  /**
   * Returns the refusal when there was one, else null. `inline`: the caller is the Stripe
   * dialog, which shows the refusal itself, so no toast and no `onFailed`.
   */
  async function post(
    given: CheckoutCompletion,
    gatewayAccount: string | undefined,
    leg: 1 | 2,
    inline = false,
  ): Promise<string | null> {
    // A stashed completion already carries its PO number; a fresh one takes the field's.
    let completion = given;
    if (po.collect && given.poNumber === undefined) {
      const poNumber = po.current().trim();
      if (po.required && !poNumber) {
        // At the field when it is on this page; beside Pay when it is not. Never silent.
        if (!po.flag()) return refuse(PO_MISSING);
        onFailed?.(PO_MISSING);
        return PO_MISSING;
      }
      if (poNumber) completion = { ...given, poNumber };
    }
    if (
      given.consent === undefined &&
      (consent.recurringText || consent.termsRequired || consent.marketingOffered)
    ) {
      const answers = consent.current();
      const refusal = consentRefusal(consent, answers);
      if (refusal) {
        // On the boxes themselves, not a toast at the top of the page.
        consent.flag();
        onFailed?.(refusal);
        return refusal;
      }
      const post: ConsentPost = consent.recurringText
        ? { ...answers, recurring_text: consent.recurringText }
        : answers;
      completion = { ...completion, consent: post };
    }
    /**
     * Decided HERE, before the post, and used again by the redirect arm below — one answer
     * for both halves. Sending a `return_url` we cannot honour would return the buyer to a
     * page that has forgotten them; withholding it from a browser that could have resumed
     * only costs a click. `post` never runs during render, so touching `window` is safe.
     */
    if (consent.botCheck && completion.botCheckToken === undefined) {
      const botCheckToken = turnstileToken();
      if (botCheckToken) completion = { ...completion, botCheckToken };
    }
    const canReturn = canResumeAcrossRedirect();
    const res = await checkoutCompleteAction(
      completion,
      gatewayAccount,
      canReturn ? window.location.origin : undefined,
    );
    if (!res.ok && res.botCheck) consent.setBotCheck(true);
    // Matches resolveCheckoutConsent's text; reword both together. The price moved, so show
    // the new sentence and ask again.
    if (!res.ok && res.error?.startsWith("The amount changed after you agreed")) {
      consent.set("recurring", false);
      router.refresh();
    }
    if (res.ok) {
      consent.setBotCheck(false);
      setRefusal(null);
      setStripeChallenge(null);
      setRedirectChallenge(null);
      const outcome: CompletionOutcome = {
        subscriptionId: res.subscriptionId ?? "",
        ...(res.invoiceId ? { invoiceId: res.invoiceId } : {}),
        unpaidInvoice: res.unpaidInvoice ?? null,
        paymentError: res.paymentError ?? null,
      };
      // No toast: the done card that replaces the form says the same, once.
      clearActiveIntent();
      onCompleted(outcome);
      return null;
    }
    if (res.error === NO_SESSION) {
      onSessionEnded();
      return null;
    }
    /**
     * A second 402 is not re-challenged. The buyer has already authenticated once; asking
     * again would be a loop they cannot win, and the engine's own sentence is the most
     * useful thing left to say.
     */
    if (!res.actionRequired || leg > 1) {
      const error = res.error ?? "We could not complete the checkout.";
      if (inline) return error;
      if (quiet?.(error)) {
        onFailed?.(error);
        return error;
      }
      return refuse(error);
    }
    const { paymentIntentId, nextAction, message } = res.actionRequired;
    setActiveIntent(paymentIntentId);
    // A client result answers the intent it came with, so no later leg repeats it.
    completion = { ...completion };
    delete completion.clientResult;
    repeat.current = { completion, ...(gatewayAccount ? { gatewayAccount } : {}) };
    // The gateway's answer can reach us seconds after its sheet closes: ask again with the
    // SAME intent before saying anything, so the buyer is never sent to start a second payment.
    const second = async (clientResult?: Record<string, string>) => {
      for (let retries = 0; ; retries++) {
        const error = await post(
          {
            ...completion,
            paymentIntent: paymentIntentId,
            ...(clientResult ? { clientResult } : {}),
          },
          gatewayAccount,
          2,
          true,
        );
        if (error == null) return null;
        if (!NOT_YET_APPROVED.test(error)) return refuse(error);
        if (retries < RETURN_AUTO_RETRIES) {
          await new Promise((wake) => setTimeout(wake, 2500 * (retries + 1)));
          continue;
        }
        return refuse(
          `${failed} yet. The payment provider has not confirmed the payment. Do not pay again. We will email you when it is confirmed. ${contactBusiness(businessName)}`,
        );
      }
    };

    // RazorPay: the challenge is their embedded sheet, opened over this page — the same
    // component the portal's "Pay now" opens for exactly this.
    if (nextAction.mode === "checkout" && nextAction.checkout) {
      const result = await openRazorpayCheckout(nextAction.checkout, {
        purpose: "payment",
        businessName,
        // A CHARGE, not a vault setup: this sheet is where the money moves, so it must
        // not borrow the add-card caption (see `vaultSetupDescription`).
        description: purchase
          ? "Confirm your payment"
          : isChange && !reactivate
            ? "Confirm your plan change"
            : "Confirm your subscription payment",
        ...(prefill ? { prefill } : {}),
      });
      // Closed without the sheet's answer. The answer can be lost (a bank popup that cannot
      // reach this page), so ask once, quietly: the engine reads the order at the gateway,
      // and a paid one completes here. Otherwise the buyer is where they were, with no
      // toast, because nothing failed.
      if (result.status === "dismissed") {
        setBusy(true);
        try {
          await post({ ...completion, paymentIntent: paymentIntentId }, gatewayAccount, 2, true);
        } finally {
          setBusy(false);
        }
        return null;
      }
      if (result.status === "failed")
        return refuse(
          refusalMessage(
            "We could not take your payment.",
            result.message,
            "Try again, or use a different payment method.",
          ),
        );
      setBusy(true);
      try {
        return await second(result.status === "authorized" ? result.clientResult : undefined);
      } finally {
        setBusy(false);
      }
    }

    // A gateway's own browser client: the RazorPay arm's rules, plus its result on leg 2.
    if (nextAction.mode === "sdk" && nextAction.sdk) {
      // Its 3DS step may send the whole page to `?pay=return` (Checkout.com Flow).
      if (canReturn)
        savePendingPaymentChallenge(scope, {
          completion,
          ...(gatewayAccount ? { gatewayAccount } : {}),
          paymentIntent: paymentIntentId,
        });
      const result = await openGatewaySdk(nextAction.sdk, {
        businessName,
        purpose: "payment",
        ...(prefill ? { prefill } : {}),
      });
      if (result.status === "dismissed") return null;
      if (result.status === "failed")
        return refuse(
          refusalMessage(
            "We could not take your payment.",
            result.message,
            "Try again, or use a different payment method.",
          ),
        );
      setBusy(true);
      try {
        return await second(result.clientResult);
      } finally {
        setBusy(false);
      }
    }

    // Stripe 3DS. Elements in our own dialog rather than a redirect, so the order summary
    // the buyer is approving stays on screen behind it.
    if (nextAction.mode === "client_secret" && nextAction.clientSecret) {
      if (!nextAction.publishableKey)
        return refuse(
          `We could not take your payment. The payment setup of ${businessName} is not complete. Contact ${businessName}.`,
        );
      setStripeChallenge({
        clientSecret: nextAction.clientSecret,
        publishableKey: nextAction.publishableKey,
        intentId: paymentIntentId,
      });
      return null;
    }

    /**
     * A hosted approval page (PayPal). SAME TAB, because the engine now tells the gateway
     * where to send the buyer back — see the arm's note in this hook's docblock.
     *
     * The stash is written and READ BACK first: it is what leg 2 is rebuilt from on the
     * other side, and navigating away without it would strand a buyer who had just
     * approved a payment. A browser that refuses it never got a `return_url` either
     * (`canReturn` above), so it lands on the new-tab panel with everything held in memory
     * — today's behaviour, unchanged, for exactly the case that needs it.
     */
    if (nextAction.mode === "redirect" && nextAction.approvalUrl) {
      const stashed =
        canReturn &&
        savePendingPaymentChallenge(scope, {
          completion,
          ...(gatewayAccount ? { gatewayAccount } : {}),
          paymentIntent: paymentIntentId,
        });
      if (stashed) {
        window.location.href = nextAction.approvalUrl;
        return null;
      }
      setRedirectChallenge({ url: nextAction.approvalUrl, intentId: paymentIntentId });
      return null;
    }

    // The redirect arm for a gateway that takes a signed POST: same stash, same fallback.
    if (
      nextAction.mode === "form_post" &&
      nextAction.formPost &&
      formPostTargetIsSafe(nextAction.formPost.action)
    ) {
      const stashed =
        canReturn &&
        savePendingPaymentChallenge(scope, {
          completion,
          ...(gatewayAccount ? { gatewayAccount } : {}),
          paymentIntent: paymentIntentId,
        });
      if (stashed) {
        submitFormPost(nextAction.formPost);
        return null;
      }
      setRedirectChallenge({ formPost: nextAction.formPost, intentId: paymentIntentId });
      return null;
    }

    return refuse(message);
  }

  /**
   * A STABLE `run` over a per-render `post`: the return-leg effect below holds onto it,
   * and an identity that changed every render would re-run that effect.
   */
  const impl = React.useRef(post);
  React.useLayoutEffect(() => {
    impl.current = post;
  });
  const run = React.useCallback((completion: CheckoutCompletion, gatewayAccount?: string) => {
    setRefusal(null);
    return impl.current(completion, gatewayAccount, 1);
  }, []);

  /**
   * Leg 2 for a challenge that OUTLIVED the page.
   *
   * `resumeAfterChallenge` below reads `repeat.current`, which is gone with the tab that
   * held it once the buyer has been to PayPal and back. This one is handed the completion
   * from the stash instead, and enters at leg 2 so a second 402 is reported rather than
   * re-challenged — the buyer has already authenticated once.
   */
  const resume = React.useCallback(
    (completion: CheckoutCompletion, gatewayAccount: string | undefined, paymentIntent: string) =>
      impl.current({ ...completion, paymentIntent }, gatewayAccount, 2),
    [],
  );

  /** What failed, in the buyer's terms — the same four cases as the dialog's description. */
  const failed = purchase
    ? "We could not complete your purchase"
    : reactivate
      ? "We could not reactivate your subscription"
      : isChange
        ? "We could not change your plan"
        : "We could not start your subscription";
  const dialogRefusal = (error: string) =>
    NOT_YET_APPROVED.test(error)
      ? `${failed} yet. Your bank may still be sending us the approval. Wait a moment. Then select Confirm payment again. We will not charge you twice.`
      : refusalMessage(`${failed}.`, error, "Select Confirm payment to try again.");

  /**
   * `inline` (the Stripe dialog): "not yet approved" is retried first, as the return leg
   * does, because the approval can reach us seconds after the buyer's confirm. Whatever
   * is still refused after that comes back as the dialog's message.
   */
  const resumeAfterChallenge = async (intentId: string, inline = false) => {
    const held = repeat.current;
    if (!held) return null;
    setBusy(true);
    try {
      for (let retries = 0; ; retries++) {
        const error = await post(
          { ...held.completion, paymentIntent: intentId },
          held.gatewayAccount,
          2,
          inline,
        );
        if (!inline || error == null) return error;
        if (NOT_YET_APPROVED.test(error) && retries < RETURN_AUTO_RETRIES) {
          await new Promise((wake) => setTimeout(wake, 2500 * (retries + 1)));
          continue;
        }
        return dialogRefusal(error);
      }
    } finally {
      setBusy(false);
    }
  };

  const dialog = (
    <PaymentDialog
      open={stripeChallenge != null}
      onClose={() => setStripeChallenge(null)}
      title="Confirm your payment"
      description={
        purchase
          ? "Your bank must verify this payment before we can complete your purchase."
          : reactivate
            ? "Your bank must verify this payment before we can reactivate your subscription."
            : isChange
              ? "Your bank must verify this payment before we can change your plan."
              : "Your bank must verify this payment before your subscription can start."
      }
    >
      {stripeChallenge ? (
        <StripeIntentForm
          purpose="payment"
          clientSecret={stripeChallenge.clientSecret}
          publishableKey={stripeChallenge.publishableKey}
          brandColor={brandColor}
          confirmLabel="Confirm payment"
          busyLabel="Confirming…"
          returnUrl={`${window.location.origin}/checkout?pay=return`}
          // A method that redirects leaves this tab; the pay return leg re-posts from this.
          onBeforeConfirm={() => {
            const held = repeat.current;
            if (held)
              savePendingPaymentChallenge(scope, {
                ...held,
                paymentIntent: stripeChallenge.intentId,
              });
          }}
          onCancel={() => setStripeChallenge(null)}
          // The authorized intent comes back from Elements, but leg 2 is keyed on OURS.
          onAuthorized={async () => {
            const refused = await resumeAfterChallenge(stripeChallenge.intentId, true);
            clearPendingPaymentChallenge(scope);
            return refused ?? undefined;
          }}
        />
      ) : null}
    </PaymentDialog>
  );

  /** Non-null only for a redirect challenge, which REPLACES the step it interrupted. */
  const panel = redirectChallenge ? (
    <div className="flex flex-col gap-3">
      <Alert tone="info" title="Approve this payment with your provider">
        {/* Only ever rendered when this browser could not carry the checkout across a
            redirect (see the redirect arm), so "come back here" is the literal truth: this
            tab is the only thing holding the intent leg 2 completes through. */}
        <p>
          Your provider&apos;s approval page opens in a new tab. Approve the payment there. Then
          return to this tab and select Continue after approval. This page keeps your place.
        </p>
        <p className="mt-2">
          {purchase
            ? "We did not charge you yet."
            : reactivate
              ? "We did not charge you yet. Your subscription is not reactivated yet."
              : `We did not charge you yet. ${isChange ? "We did not apply the change yet." : "We did not create your subscription yet."}`}{" "}
          Continue on this page to finish.
        </p>
      </Alert>
      {/* An anchor, not a scripted redirect: this tab must survive — it holds the intent
          the checkout completes through — and a buyer-initiated `target=_blank` is the one
          way to open a page no popup blocker can veto. A signed POST gets the same as a
          form the buyer submits into a new tab. */}
      {redirectChallenge.formPost ? (
        <button
          type="button"
          onClick={() => submitFormPost(redirectChallenge.formPost!, { newTab: true })}
          className="self-start text-sm font-medium text-primary hover:underline"
        >
          Open the approval page
        </button>
      ) : (
        <a
          href={redirectChallenge.url}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-sm font-medium text-primary hover:underline"
        >
          Open the approval page
        </a>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => resumeAfterChallenge(redirectChallenge.intentId)} disabled={busy}>
          {busy ? "Checking…" : "Continue after approval"}
        </Button>
        <Button variant="outline" onClick={() => setRedirectChallenge(null)} disabled={busy}>
          Use a different method
        </Button>
      </div>
    </div>
  ) : null;

  /** For a gateway step outside `run` (its own sheet refused): beside Pay, like a refusal. */
  const showRefusal = setRefusal;
  return { run, resume, dialog, panel, busy, refusal, showRefusal };
}

/**
 * Money on this page is `lib/format`'s `money`, imported — NOT a local copy.
 *
 * There used to be one here that returned "INR 5,435.08" while every other buyer-facing
 * surface (the portal, the invoice, this page's own item rows, which are formatted
 * server-side) returned "₹5,435.08". A CDP render caught the result: the same add-on
 * printed as ₹4,606.00 in the item card and INR 4,606.00 in the preview 40px below it,
 * on one screen.
 *
 * ⚠️ Whatever formats money here must keep its LOCALE PINNED to 'en'. The local copy
 * existed for that reason and the shared one satisfies it (`Intl.NumberFormat('en', …)`):
 * `toLocaleString(undefined, …)` asks each runtime for its own locale, and this component
 * is server-rendered then hydrated — Node grouped ₹2,54,129.52 (en-IN lakh grouping) where
 * the browser gave 254,129.52, and React threw "Hydration failed…" and discarded the whole
 * tree. Caught in a CDP render on 2026-08-27, on six-figure INR amounts; the grouping is
 * identical below ₹1,00,000, which is why it hid for so long.
 */

/**
 * Buyer hosted-checkout flow (#10d, + change mode #10b). Multi-step, all
 * client-side state.
 *
 * CREATE mode (a new subscription):
 *   1. Plan summary → the buyer sees what they're subscribing to.
 *   2. Details → email + name + billing address (required by card networks).
 *   3. Card → begins a vault setup on the business's gateway and branches on
 *      mode (mirrors the portal add-card exactly), collecting in a MODAL over the
 *      order summary so the buyer can still see what they are paying for:
 *        - client_secret + Stripe → Stripe Elements confirmSetup (PAN goes
 *          provider-direct; PCI SAQ-A), then complete with the confirmed pm_….
 *        - otherwise (tmtest / any client_secret provider) → test-token input.
 *   4. Success → shows the created subscription id.
 *
 * CHANGE mode (upgrade/downgrade an existing subscription): there is NO details
 * step — the customer is pinned to the subscription server-side and the API
 * refuses to reassign it. The buyer instead sees current plan → new plan with a
 * proration preview, and confirms. A card is only requested when none is on file.
 */
export function CheckoutFlow({ view, countries }: { view: CheckoutView; countries: Country[] }) {
  const router = useRouter();
  const isChange = view.mode === "change";
  /** A one-time purchase: a paid invoice, no subscription. */
  const isPurchase = view.mode === "purchase";
  const purchase = view.purchase;
  /** Completing this change restarts a cancelled subscription — see `change.reactivation`. */
  const reactivation = isChange ? view.change?.reactivation : undefined;
  const reactivate = reactivation != null;
  /** Non-secret per-session key for the redirect-leg stash — see lib/pending-vault-setup.ts. */
  const scope = view.id;
  const successUrl = withSessionOutcome(view.redirect_url, view.id, "succeeded");
  const cancelUrl = withSessionOutcome(view.cancel_url, view.id, "cancelled");
  // Change mode starts at confirm (no details to collect); create mode at details.
  const [step, setStep] = React.useState<"details" | "confirm" | "card" | "pay" | "done">(
    isChange ? "confirm" : "details",
  );
  /** One page: details and payment together (Hosted pages → layout). Plan changes keep their review step. */
  const onePage = view.layout === "one_page" && !isChange;
  const [detailsSavedHere, setDetailsSaved] = React.useState(false);
  const detailsSaved = view.customer != null || detailsSavedHere;
  React.useEffect(() => {
    void checkoutRecordViewAction(onePage ? "one_page" : "steps", deviceClassOf(window));
    // Recorded once, for the layout of the first view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /**
   * Where "edit billing details" was entered FROM.
   *
   * A plan change starts at `confirm` and could only ever go forward to `card`, so a buyer had no
   * way back to their own billing details — which is a dead end the moment the gateway needs
   * something the details hold. RazorPay refuses to vault a card for recurring payments without a
   * phone number, and the error says "add a phone number to the customer": an OPERATOR action,
   * offered to a BUYER who cannot perform it.
   *
   * Create mode still lands on `card` after details, because that is the flow's forward path;
   * only an explicit edit returns to its origin.
   */
  const [detailsReturnTo, setDetailsReturnTo] = React.useState<"confirm" | "card" | "pay" | null>(
    null,
  );
  /**
   * Where the CARD step was entered from, so it has a way back.
   *
   * "Manage cards" replaced the whole Confirm section with no return path — a buyer who
   * wanted to re-read the proration they were about to approve, or who opened it out of
   * curiosity, was stuck on the payment step. Same shape as `detailsReturnTo` below, and for
   * the same reason: a step reached by a side door needs the door to swing both ways.
   */
  const [cardReturnTo, setCardReturnTo] = React.useState<"confirm" | null>(null);
  const editDetails = React.useCallback((from: "confirm" | "card" | "pay") => {
    setDetailsReturnTo(from);
    setStep("details");
  }, []);
  // The id is not shown to the buyer; only whether a subscription came back matters.
  const [, setSubscriptionId] = React.useState<string | null>(null);
  /**
   * The change applied and its invoice did NOT collect.
   *
   * Kept in state and rendered on the final step rather than toasted, because it outlives
   * the toast: the buyer needs the amount and where to settle it, and a green "Plan
   * updated" over a parked invoice is the exact misreport this closes.
   */
  const [unpaid, setUnpaid] = React.useState<UnpaidInvoice | null>(null);
  /**
   * The subscription exists and its first charge was REFUSED — the engine's
   * `payment_error`. Returned by the action since the intent path was built and read by
   * nobody until now, which is why a signup whose capture failed reported plain success.
   */
  const [paymentError, setPaymentError] = React.useState<PaymentError | null>(null);
  /** The completion itself came back paid — the only outcome that auto-redirects. */
  const [cleanCompletion, setCleanCompletion] = React.useState(false);
  const done = (outcome: CompletionOutcome) => {
    setSubscriptionId(outcome.subscriptionId || null);
    setUnpaid(outcome.unpaidInvoice ?? null);
    setPaymentError(outcome.paymentError ?? null);
    setCleanCompletion(!outcome.unpaidInvoice && !outcome.paymentError);
    setStep("done");
  };
  // Let the success card register before leaving; its "Continue" link is the fallback.
  React.useEffect(() => {
    if (step !== "done" || !cleanCompletion || !successUrl) return;
    const timer = setTimeout(() => window.location.assign(successUrl), 1500);
    return () => clearTimeout(timer);
  }, [step, cleanCompletion, successUrl]);
  /**
   * What the buyer typed on the details step, forwarded to the gateway's own sheet.
   *
   * The portal prefills RazorPay's modal from `me.customer` and this surface prefilled
   * nothing, so a buyer who had just typed their name, email and phone into OUR form was
   * asked for all three again inside the gateway's. Create mode only: a change session's
   * customer is pinned server-side and never reaches this page.
   */
  const [buyer, setBuyer] = React.useState<BuyerPrefill | null>(null);
  /**
   * The billing details the details step prefills from — seeded from the server-rendered
   * view, then replaced by whatever the buyer last saved.
   *
   * Held here rather than read off `view` at the point of use because `view` is rendered
   * once, on page load: a buyer who edits their details and comes back to the step a second
   * time (the card step's "Edit billing details" is a round-trip, not a one-way door) would
   * otherwise be shown the pre-edit values and re-save them over their own change.
   */
  const po = usePoNumberState(scope, view);
  const consent = useConsentState(scope, view);
  const [details, setDetails] = React.useState<CheckoutCustomerDetails | null>(
    view.customer ?? null,
  );
  /**
   * The processing poll ran out of patience. NOT a failure — the debit is still live,
   * we simply stopped watching, so the copy changes from "this takes a moment" to
   * "we'll email you". Separate from `unpaid.state` because the invoice's own state
   * has not changed: only our willingness to keep asking has.
   */
  const [settleTimedOut, setSettleTimedOut] = React.useState(false);
  /**
   * Wait for a LIVE payment to land before calling it anything.
   *
   * The completion is a snapshot of a race. An async debit — UPI Autopay, an e-mandate
   * presentation, ACH — is answered `created` by the gateway and settles by webhook,
   * usually within seconds; the engine books it `in_progress` and leaves the invoice
   * open meanwhile. Publishing that snapshot as "we could not collect INR 15,528.80"
   * is a lie told at the worst possible moment, and it was routinely told seconds
   * before the money arrived (observed on a RazorPay change checkout, 2026-08-28).
   *
   * So: poll for ~20s, which covers the overwhelming majority of these, then hand over
   * to the receipt email rather than spinning forever. A poll that answers `paid`
   * clears `unpaid` entirely and the buyer gets the ordinary success card; one that
   * answers `outstanding` swaps in the real refusal, reason and all.
   */
  React.useEffect(() => {
    if (step !== "done" || unpaid?.state !== "processing") return;
    const invoice = unpaid.id;
    let cancelled = false;
    let attempts = 0;
    /** ~20s: 10 polls, 2s apart. Long enough for a webhook, short enough to not strand. */
    const MAX_ATTEMPTS = 10;
    const timer = setInterval(() => {
      attempts += 1;
      void (async () => {
        const res = await checkoutInvoiceStateAction(invoice);
        if (cancelled) return;
        // A poll that FAILS is not an outcome — the invoice is unchanged and the
        // interval simply tries again until it runs out of attempts.
        if (res.ok && res.invoice.state !== "processing") {
          clearInterval(timer);
          if (res.invoice.state === "paid") {
            setUnpaid(null);
            return void toast.success("Payment received.");
          }
          setUnpaid({
            id: res.invoice.id,
            amount_due_minor: res.invoice.amount_due_minor,
            currency: res.invoice.currency,
            state: "outstanding",
            ...(res.invoice.failure ? { failure: res.invoice.failure } : {}),
          });
          return void toast.warning("Payment not received.");
        }
        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(timer);
          setSettleTimedOut(true);
        }
      })();
    }, 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `unpaid.id`/`state`, not `unpaid`: re-running on a new object identity would
    // restart the poll on every render that reseats the same invoice.
  }, [step, unpaid?.id, unpaid?.state]);

  // Two different redirects come back to this page and both are finished here:
  //   `?setup=return` — a redirect-mode vault SETUP (a PayPal wallet approval), which
  //                     returns with a setup token to complete the checkout with.
  //   `?pay=return`   — a redirect-mode CHALLENGE on the first charge, which returns with
  //                     nothing but the fact of approval; leg 2 is rebuilt from the stash.
  // Either way the buyer must not land on a page that just sits there.
  const [returning, setReturning] = React.useState(false);
  /** Between automatic retries of a payment return: the spinner stays up. */
  const [retryingReturn, setRetryingReturn] = React.useState(false);
  const returnRetries = React.useRef(0);
  const retryNotYetApproved = (error: string) =>
    returnKindRef.current === "payment" &&
    NOT_YET_APPROVED.test(error) &&
    returnRetries.current < RETURN_AUTO_RETRIES;
  /**
   * WHICH of the two is in flight, so the two notices below can name the right thing.
   *
   * "We could not finish setting up your payment method" is exactly wrong for a buyer who
   * has a payment method and has just authenticated a CHARGE with their bank — it would
   * send them looking for a card problem that does not exist.
   *
   * Mirrored into a ref because `onFailed` is captured by the challenge hook and must read
   * the CURRENT kind, not the one that existed when the hook was created.
   */
  const [returnKind, setReturnKind] = React.useState<"setup" | "payment">("setup");
  const returnKindRef = React.useRef<"setup" | "payment">("setup");
  /**
   * The redirect leg failed AFTER the buyer approved at the provider.
   *
   * Held as state with a retry rather than a toast, because this is the worst moment in the
   * flow to be vague: their payment method is already approved on the provider's side, so
   * "something went wrong" leaves them unable to tell whether they have been charged. The
   * setup token stays in scope, so the retry is a real retry of the same completion — not a
   * restart that would risk a second payment method.
   */
  const [returnError, setReturnError] = React.useState<string | null>(null);
  const retryReturn = React.useRef<(() => void) | null>(null);
  /**
   * A session that died mid-checkout. Terminal: nothing on this page can succeed afterwards,
   * so every step is replaced by the same card the entry path shows for an expired link.
   * Without this a 24-hour-old tab just answers every click with a red toast.
   */
  const [sessionEnded, setSessionEnded] = React.useState(false);
  /**
   * The completion the redirect-return leg runs — through the shared challenge machine,
   * because a vault approval that comes back and then meets a 3DS first charge is the
   * same 402 as everywhere else, and used to die here as one more red toast.
   */
  const returnChallenge = usePaymentChallenge({
    scope,
    po,
    consent,
    businessName: view.business.name,
    brandColor: view.business.brand_color,
    isChange,
    reactivate,
    purchase: isPurchase,
    ...(buyer ? { prefill: buyer } : {}),
    onSessionEnded: () => setSessionEnded(true),
    onCompleted: (outcome) => {
      // Spent — and only now. Until the completion actually lands, the stash is what a
      // second return (a retry inside the gateway's own sheet) has to work with.
      clearPendingVaultSetup(scope);
      clearPendingPaymentChallenge(scope);
      done(outcome);
    },
    // A charge return that is not approved yet gets its card below: never a toast as well.
    quiet: (error) => returnKindRef.current === "payment" && NOT_YET_APPROVED.test(error),
    onFailed: (error) => {
      /**
       * A failed CHARGE return is not a card problem, so it must not be answered with the
       * card step. The likeliest cause is the one race this leg has: the intent is
       * `authorized` only once the gateway's webhook lands, and the buyer can beat it back
       * here by a second or two, which the engine reports as "complete the authentication
       * first". Retrying the identical completion is what fixes that, and the stash is
       * deliberately still there to make the retry real.
       */
      if (returnKindRef.current === "payment") {
        // The gateway's approval webhook can take ~15 s; retry before asking the buyer to.
        if (retryNotYetApproved(error)) {
          returnRetries.current += 1;
          setRetryingReturn(true);
          setTimeout(() => retryReturn.current?.(), 2500 * returnRetries.current);
          return;
        }
        // Only the approval race reads as "not yet". Any other refusal is the gateway's own
        // reason, and the buyer must read it.
        setReturnError(
          NOT_YET_APPROVED.test(error)
            ? "We could not confirm your payment yet. Your bank may still be sending us the approval. If you try again, we will not charge you twice."
            : refusalMessage(
                "We could not confirm your payment.",
                error,
                "Try again, or use a different payment method.",
              ),
        );
        return;
      }
      // A dead session is terminal and handled above; anything else is a refusal the buyer
      // can act on, so put them back on the step that lets them.
      setStep("card");
    },
  });
  // Destructured because they are the STABLE half: naming the whole hook result in the deps
  // below would re-run the return legs on every render.
  const { run: runReturnCompletion, resume: resumeReturnChallenge } = returnChallenge;
  const handledReturn = React.useRef(false);
  React.useEffect(() => {
    if (handledReturn.current) return;
    const ret = consumeSetupReturn("/checkout");
    if (!ret) return;
    handledReturn.current = true;

    const pending = readPendingVaultSetup(scope);
    /**
     * Cleared on CANCEL and on SUCCESS — never before the attempt, and never on failure.
     *
     * It used to be cleared here, unconditionally, the moment the buyer came back. A
     * buyer whose first attempt is refused inside the gateway's own sheet retries THERE
     * and returns a second time; by then the stash was gone, so the second return had no
     * setup token and no intent to complete through and could only say "please try
     * again" — for a payment method the gateway had just approved.
     */
    if (ret.outcome === "cancel") {
      clearPendingVaultSetup(scope);
      setStep("card");
      toast("Payment setup cancelled");
      return;
    }
    const setupToken = pending?.setupToken ?? ret.approvalToken;
    if (!setupToken) {
      setStep("card");
      const text = "We could not finish adding your payment method. Try again.";
      toast.error(text);
      reportBuyerError(text, { step: "setup_return" });
      return;
    }
    const finish = () => {
      setReturnError(null);
      setReturning(true);
      void (async () => {
        try {
          // Through the setup INTENT when one was stashed: the provider's webhook may have
          // harvested the same approval while the buyer was being redirected back, and the
          // intent's atomic claim is what makes whichever lands second a no-op rather than a
          // second payment method. The approved token stays as the fallback.
          //
          // The gateway rides along too: the token must be exchanged on the SAME account the
          // setup ran on, and completing on the business default would look it up on the
          // wrong one — the portal's return leg has always passed it.
          await runReturnCompletion(
            {
              ...(pending?.paymentIntent ? { setupIntent: pending.paymentIntent } : {}),
              providerToken: setupToken,
              ...(pending?.paymentIntent && ret.clientResult
                ? { clientResult: ret.clientResult }
                : {}),
            },
            pending?.gateway,
          );
        } catch {
          // THROWN, not returned: `checkoutComplete` only catches its JSON parse, so a network
          // failure propagates all the way here. Before this, that left `setReturning(false)`
          // unreachable and the buyer on a permanent spinner — right after approving payment.
          setReturnError(
            "We could not save your payment method. The request did not finish. If you try again, we will not charge you twice.",
          );
        } finally {
          setReturning(false);
        }
      })();
    };
    retryReturn.current = finish;
    finish();
  }, [scope, runReturnCompletion]);

  /**
   * The CHARGE-side return leg: the buyer authenticated the first charge at the provider
   * and `return_url` brought them back here (F-45 — the engine can say where "here" is now).
   *
   * Everything leg 2 needs comes from the stash the redirect arm wrote, because this is a
   * cold page load: the tab that held leg 1's completion in memory was replaced. The stash
   * is CLEARED only on a landed completion (in `onCompleted`) or an explicit cancel — never
   * before the attempt and never on failure, exactly as the vault leg above learned to do,
   * so "Try again" retries the same completion instead of a fresh charge.
   *
   * Separate effect from the vault one on purpose: `consumeSetupReturn` matches `?setup=…`
   * and `consumePaymentReturn` matches `?pay=…`, so at most one of them fires per load and
   * neither can eat the other's params.
   */
  const [payReturnOrphan, setPayReturnOrphan] = React.useState(false);
  const handledPayReturn = React.useRef(false);
  React.useEffect(() => {
    if (handledPayReturn.current) return;
    // An sdk gateway that left for its own 3DS page names the result. Read before the strip.
    const clientResult = readSdkReturnResult(window.location.search);
    const ret = consumePaymentReturn("/checkout");
    if (!ret) return;
    handledPayReturn.current = true;

    const pending = readPendingPaymentChallenge(scope);
    if (ret === "cancel") {
      clearPendingPaymentChallenge(scope);
      setStep("card");
      toast("Payment not approved");
      return;
    }
    /**
     * Approved, but this tab knows nothing about it.
     *
     * Reachable when the redirect arm fell back to the NEW-TAB panel and the provider then
     * returned the buyer inside that second tab anyway (the write failed after the probe
     * said it would not), or when the return URL is opened somewhere else entirely. Not an
     * error and emphatically not a restart — the tab that IS holding the checkout can still
     * finish it, and telling this one to start over is how a buyer pays twice.
     */
    if (!pending) {
      setPayReturnOrphan(true);
      return;
    }
    setReturnKind("payment");
    returnKindRef.current = "payment";
    const finish = () => {
      setReturnError(null);
      setRetryingReturn(false);
      setReturning(true);
      void (async () => {
        try {
          await resumeReturnChallenge(
            // An sdk gateway that left for its own 3DS page names the result on the URL.
            clientResult ? { ...pending.completion, clientResult } : pending.completion,
            pending.gatewayAccount,
            pending.paymentIntent,
          );
        } catch {
          // Thrown rather than returned — a network failure propagates out of
          // `checkoutComplete`, and without this the buyer sat on a spinner forever
          // moments after approving a payment (the vault leg's own lesson).
          setReturnError(
            "We could not confirm your payment. The request did not finish. If you try again, we will not charge you twice.",
          );
        } finally {
          setReturning(false);
        }
      })();
    };
    retryReturn.current = finish;
    finish();
  }, [scope, resumeReturnChallenge]);

  /**
   * The mandate this change needs. Absent = nothing to say (no instrument, or one on no
   * mandate rail), which is also how an international buyer never sees any of this.
   */
  const mandate = view.change?.mandate;
  /**
   * A card on file that CANNOT carry this change is the same situation as no card at all:
   * the buyer has to authorise again, because no rail lets a ceiling be raised. So the
   * payment step is part of the rail rather than an optional detour.
   */
  const mustReauthorize = Boolean(mandate?.reauthorizationRequired);
  /** A purchase pays on its own step unless the business always keeps the method. Nothing
   *  due means no method to keep, so the pay step only completes it. */
  const purchasePayStep =
    purchase?.save_payment_method === "always" && purchase.amount_due_minor > 0 ? "card" : "pay";
  const commit = commitCopy(view);
  const trialInfo = view.mode === "create" && view.dueToday?.trial ? view.dueToday : null;
  const name = planName(view);
  /** One page: the details form is valid (or not shown). The commit waits while it is not. */
  const [detailsValid, setDetailsValid] = React.useState(true);
  const blockedByDetails = onePage && !detailsValid;
  /**
   * The payment step keeps the buyer's details on screen as a summary, so details and
   * payment read as one page rather than two — the form folds up, it does not go away.
   */
  const detailsSummary =
    !isChange && details ? (
      <DetailsSummary
        details={details}
        countries={countries}
        onEdit={() => editDetails(step === "pay" ? "pay" : "card")}
      />
    ) : null;
  /** A change confirmed on the card on file has no payment step to show; adding one later
   *  ("Manage cards") does not grow the stepper. */
  const changeHasCardStep = !(view.change?.hasPaymentMethod ?? false) || mustReauthorize;
  const steps = isPurchase
    ? [
        { key: "details", label: "Your details" },
        { key: step === "card" ? "card" : "pay", label: "Payment" },
        { key: "done", label: "Confirmation" },
      ]
    : isChange
      ? [
          { key: "confirm", label: "Review" },
          ...(changeHasCardStep ? [{ key: "card", label: "Payment" }] : []),
          { key: "done", label: "Confirmation" },
        ]
      : [
          { key: "details", label: "Your details" },
          { key: "card", label: "Payment" },
          { key: "done", label: "Confirmation" },
        ];
  const stepperAt = isChange && !changeHasCardStep && step === "card" ? "confirm" : step;
  /** What is due today, for the phone's pay bar. */
  const dueNow: { minor: number; currency: string } | null = isPurchase
    ? purchase
      ? { minor: purchase.amount_due_minor, currency: purchase.currency }
      : null
    : isChange
      ? view.change?.preview
        ? {
            minor: view.change.preview.immediateCharge ? view.change.preview.amountDueMinor : 0,
            currency: view.change.preview.currency,
          }
        : null
      : view.dueToday
        ? { minor: view.dueToday.amountDueMinor, currency: view.dueToday.currency }
        : null;
  const live = step !== "done" && !sessionEnded && !returning && !returnError;
  /** A change's money, priced, ABOVE its confirm button: the buyer reads the total first. */
  // Confirm would refuse this change: show why instead of figures for a change that cannot happen.
  const changeBlocked = isChange ? (view.change?.blocked ?? null) : null;
  const changePreview = changeBlocked ? (
    <Alert tone="warning" title="You cannot make this change here">
      <p>{changeBlocked.message}</p>
    </Alert>
  ) : isChange && view.change?.preview ? (
    <>
      {view.change.preview.heldInvoice && view.change.preview.heldExpiresAt ? (
        <HeldChangeNotice preview={view.change.preview} tz={view.business.timezone} />
      ) : null}
      <PreviewCard
        preview={view.change.preview}
        tz={view.business.timezone}
        oldPlan={view.change.currentPlan?.name ?? null}
        {...(reactivation ? { reactivation } : {})}
        // Only a charge that succeeded: a pending or lost gateway answer stays "Due today",
        // and a zero-total term has nothing to call paid.
        paid={
          step === "done" &&
          !unpaid &&
          !paymentError &&
          !!view.change.preview.immediateCharge &&
          view.change.preview.amountDueMinor > 0
        }
      />
    </>
  ) : null;

  /** A priced reactivation with no coupon box and no regular cost has no order card of its
   *  own: "Your new term" IS the order, so it takes the order's column (decided 2026-11-17). */
  const previewInRail =
    reactivate &&
    view.change?.preview != null &&
    changeBlocked == null &&
    !view.allow_coupons &&
    view.coupons.length === 0 &&
    !view.nextPayment;

  return (
    <BrandTheme brand={view.business}>
      <PoNumberContext.Provider value={po}>
        <ConsentContext.Provider value={consent}>
          <div
            className="flex w-full flex-col gap-4 pb-20 sm:gap-5 sm:pb-0"
            data-checkout-step={step}
          >
            <StorefrontHeader
              brand={view.business}
              subtitle={
                isPurchase
                  ? "Complete your purchase."
                  : reactivate
                    ? "Reactivate your subscription."
                    : isChange
                      ? changeBlocked
                        ? "Review your plan change."
                        : "Review and confirm your plan change."
                      : trialInfo?.trialPeriod
                        ? `Start your ${trialInfo.trialPeriod.count}-${trialInfo.trialPeriod.unit} free trial${name ? ` of ${name}` : ""}.`
                        : name
                          ? `Subscribe to ${name}.`
                          : "Subscribe."
              }
              aside={
                cancelUrl && step !== "done" && !sessionEnded ? (
                  <a
                    data-document-link
                    href={cancelUrl}
                    className="text-sm text-muted-foreground hover:underline"
                  >
                    {/* On a change or reactivation, "Cancel" reads as "cancel my subscription". */}
                    {isChange ? "Go back" : "Cancel"}
                  </a>
                ) : undefined
              }
            />

            {/* Only with two or more real steps: a review that is one press needs no map
                (decided 2026-11-17). "Confirmation" is a result, not a step. */}
            {onePage || steps.filter((st) => st.key !== "done").length < 2 ? null : (
              <Steps steps={steps} current={stepperAt} />
            )}

            {/*
          Two columns above 1000px: what the buyer ACTS on down the left, what they are
          buying down the right, sticky while they fill in a card. Below that the order
          comes first, then the step. Layout lives in `globals.css` under `.checkout-panes`.
        */}
            <div className="checkout-panes sf-enter">
              <div className="checkout-rail">
                {previewInRail ? (
                  changePreview
                ) : (
                  <OrderCard
                    view={view}
                    locked={step === "done" || sessionEnded}
                    sessionEnded={sessionEnded}
                    title={
                      isPurchase
                        ? "Your order"
                        : reactivate
                          ? "Your subscription"
                          : isChange
                            ? "Your plan change"
                            : "Your order"
                    }
                  />
                )}
              </div>

              <div className="checkout-main">
                {/* TERMINAL, and checked first: once the session is gone nothing below can succeed, so
            drawing the steps would just invite clicks that all fail the same way. Same wording
            as the entry path's expired card — the two must not drift. */}
                {sessionEnded ? (
                  <NoticeCard
                    icon={<Clock />}
                    title="This checkout link is not valid or is expired"
                  >
                    Checkout links are valid for a limited time. Ask for a new link.
                  </NoticeCard>
                ) : returnChallenge.panel ? (
                  /* An authentication challenge raised by the RETURN leg — the vault approval came
             back and the first charge then asked for one. It replaces the step it
             interrupted, the way the e-mandate panel does, because the buyer has exactly
             one thing to do and it is not on this page. */
                  <StorefrontSection title="Payment">{returnChallenge.panel}</StorefrontSection>
                ) : payReturnOrphan ? (
                  /* They approved, but in a tab that is not the one holding the checkout — see the
             charge-return effect. `info`, not an error: nothing is wrong, and the one tab
             that can finish this is still open. Deliberately offers no "start again": doing
             so from here is how the same payment gets approved twice. */
                  <NoticeCard icon={<CheckCircle2 />} title="Payment approved">
                    Return to the tab where you started this checkout. Select{" "}
                    <span className="font-medium">Continue after approval</span> to finish. You can
                    close this tab.
                  </NoticeCard>
                ) : returnError ? (
                  /* The buyer has ALREADY approved at the provider, so this offers a real retry of the
             same completion rather than sending them back to start — restarting risks a second
             payment method for a mandate they have already authorised, or a second charge for
             an authentication they have already passed. */
                  <NoticeCard
                    icon={<AlertCircle />}
                    title={
                      returnKind === "payment"
                        ? "We could not finish your payment"
                        : "We could not finish the setup"
                    }
                  >
                    <p>{returnError}</p>
                    <Button
                      className="mt-3"
                      onClick={() => retryReturn.current?.()}
                      disabled={returning}
                    >
                      {returning ? "Trying again…" : "Try again"}
                    </Button>
                  </NoticeCard>
                ) : returning || retryingReturn ? (
                  <NoticeCard
                    icon={<Loader2 className="animate-spin" />}
                    title={returnKind === "payment" ? "Finishing your payment" : "Finishing setup"}
                  >
                    {returnKind === "payment"
                      ? "We are confirming the payment that you approved. This takes a few seconds."
                      : "We are confirming your payment method with the provider. This takes a few seconds."}
                  </NoticeCard>
                ) : step === "done" && isPurchase ? (
                  unpaid?.state === "processing" ? (
                    <NoticeCard
                      icon={<Loader2 className="animate-spin" />}
                      title="Payment in progress"
                    >
                      <p>
                        We are waiting for confirmation of the{" "}
                        <span className="font-medium tabular-nums">
                          {money(unpaid.amount_due_minor, unpaid.currency)}
                        </span>{" "}
                        payment.{" "}
                        {settleTimedOut
                          ? "This takes longer than usual. You do not have to do anything. We will email your receipt when the payment completes."
                          : "You do not have to do anything. This usually takes a few seconds."}
                      </p>
                    </NoticeCard>
                  ) : unpaid ? (
                    // The order went through but its invoice is still open: never "received".
                    <NoticeCard icon={<AlertCircle />} title="Payment not received">
                      <p>
                        {unpaid.failure ? "We could not collect" : "Amount due:"}{" "}
                        <span className="font-medium tabular-nums">
                          {money(unpaid.amount_due_minor, unpaid.currency)}
                        </span>
                        {unpaid.failure ? `. Reason: ${unpaid.failure.message}` : "."}
                      </p>
                      {/* The completion carries the invoice id only, never its number: no raw id here. */}
                      <p className="mt-2">
                        The invoice stays open on your account. The billing email for this invoice
                        has its number and a secure link. Use the link to pay the invoice.
                      </p>
                    </NoticeCard>
                  ) : (
                    <DoneCard
                      title="Payment received"
                      body="We will email your receipt."
                      backUrl={successUrl}
                      businessName={view.business.name}
                    />
                  )
                ) : step === "done" && unpaid?.state === "processing" ? (
                  /* NOT a failure, and the distinction is the whole point: the gateway has the
             debit and has not answered yet. An Indian mandate presentation can take
             seconds (usual) or days (a bank holiday) — either way nobody was refused,
             the buyer has nothing to do, and the poll above is still watching. */
                  <NoticeCard
                    icon={<Loader2 className="animate-spin" />}
                    title={
                      reactivate
                        ? "Your subscription is reactivated. Payment in progress"
                        : isChange
                          ? "Your plan changed. Payment in progress"
                          : "You are subscribed. Payment in progress"
                    }
                  >
                    <p>
                      {reactivate
                        ? "Your subscription is active again."
                        : isChange
                          ? "Your plan is changed."
                          : "Your subscription is active."}{" "}
                      We are confirming the{" "}
                      <span className="font-medium tabular-nums">
                        {money(unpaid.amount_due_minor, unpaid.currency)}
                      </span>{" "}
                      payment with the payment provider.
                    </p>
                    <p className="mt-2">
                      {settleTimedOut
                        ? "This takes longer than usual. Do not pay again. We will email you when we know the result. If the payment did not go through, the email tells you how to pay."
                        : "Do not pay again. This usually takes a few seconds."}
                    </p>
                  </NoticeCard>
                ) : step === "done" && unpaid ? (
                  /* Two true things at once, and both have to be said: the plan DID change (the
             items moved, the buyer is being served) and the payment for it did not go
             through. `warning`, not `error` — nothing here needs undoing, one thing needs
             paying — and not `success`, which is what this screen used to claim while the
             invoice sat parked.

             Two sentences, because two different things land here. WITH a failure the
             gateway refused and we say so. WITHOUT one nothing was ever attempted (auto
             collection off, or no instrument on file) — "we could not collect" claims a
             refusal that never happened, and it is what a buyer saw for an amount their
             bank had not been asked for. */
                  <NoticeCard
                    icon={<AlertCircle />}
                    title={`${reactivate ? "Your subscription is reactivated" : "Your plan changed"}. Payment ${unpaid.failure ? "not received" : "is due"}`}
                  >
                    <p>
                      {reactivate
                        ? "Your subscription is active again."
                        : isChange
                          ? "Your plan is changed."
                          : "Your subscription is active."}{" "}
                      {unpaid.failure ? "We could not collect" : "Amount due:"}{" "}
                      <span className="font-medium tabular-nums">
                        {money(unpaid.amount_due_minor, unpaid.currency)}
                      </span>
                      {unpaid.failure ? `. Reason: ${unpaid.failure.message}` : "."}
                    </p>
                    {/* ⚠️ This used to say the invoice "is waiting in your billing portal" and render
                NO link — and the buyer holds none: a checkout link is public and mints no
                portal session, so they were pointed at a destination they could not reach.
                The invoice email is the route they actually have (`invoice_generated` →
                `invoice_issued`, whose CTA is a pre-authenticated portal entry), so that is
                what this names. Give them a real link here only when the engine can mint
                one on the completion. */}
                    <p className="mt-2">
                      The invoice stays open on your account. The billing email for this invoice has
                      its number and a secure link. Use the link to pay the invoice or to change
                      your payment method.
                    </p>
                  </NoticeCard>
                ) : step === "done" && paymentError ? (
                  /* The subscription EXISTS and its first charge was refused — the engine's
             `payment_error`, which reaches the page only on the intent path (a completion
             that consumed an authorization whose capture the gateway then declined). It was
             returned by the action and read by nobody, so this screen said "You're all set"
             over a refusal. `warning`, not `error`: the signup stands, one thing needs
             paying. */
                  <NoticeCard
                    icon={<AlertCircle />}
                    title={
                      reactivate
                        ? "Your subscription is reactivated. Your bank refused the payment"
                        : isChange
                          ? "Your plan changed. Your bank refused the payment"
                          : "You are subscribed. Your bank refused the first payment"
                    }
                  >
                    <p>
                      {reactivate
                        ? "Your subscription is active again."
                        : isChange
                          ? "Your plan is changed."
                          : "Your subscription is active."}{" "}
                      Your bank refused the payment. Reason: {paymentError.message}
                    </p>
                    <p className="mt-2">
                      The invoice stays open on your account. The billing email for this invoice has
                      a secure link. Use it to pay the invoice or to change your payment method.
                    </p>
                  </NoticeCard>
                ) : step === "done" ? (
                  /* The result in plain words, with the next payment when the engine knows
                     it, and a real way back to the business (decided 2026-11-17). No badge,
                     no "Thank you!": a statement, as a bank would write it. */
                  <DoneCard
                    title={
                      reactivate
                        ? "Subscription reactivated"
                        : isChange
                          ? view.change?.itemsUnchanged
                            ? "Discount applied"
                            : "Plan changed"
                          : "Subscription started"
                    }
                    body={`${
                      reactivate
                        ? "Your subscription is active again."
                        : isChange
                          ? view.change?.itemsUnchanged
                            ? "Your subscription is updated."
                            : "Your new plan is active."
                          : "Your subscription is active."
                    }${doneNextPayment(view)}`}
                    backUrl={successUrl}
                    businessName={view.business.name}
                  />
                ) : onePage && (step === "details" || step === "card" || step === "pay") ? (
                  <div className="flex flex-col gap-4">
                    <DetailsStep
                      autoSave
                      customer={details}
                      onValidity={setDetailsValid}
                      onDone={(prefill, saved) => {
                        setBuyer(prefill);
                        setDetails(saved);
                        // The totals and tax are priced from this address, so read them again.
                        router.refresh();
                        setDetailsSaved(true);
                      }}
                      lockEmail={view.customer_pinned ?? purchase?.customer_pinned ?? false}
                      onSessionEnded={() => setSessionEnded(true)}
                      countries={countries}
                      fieldConfig={view.field_config ?? {}}
                    />
                    {!detailsSaved ? (
                      <StorefrontSection title="Payment">
                        <p className="text-sm text-muted-foreground">
                          Enter your email and billing address to see the payment methods.
                        </p>
                      </StorefrontSection>
                    ) : purchase && purchasePayStep === "pay" && step !== "card" ? (
                      <PurchasePayStep
                        scope={scope}
                        purchase={purchase}
                        commit={commit}
                        blocked={blockedByDetails}
                        businessName={view.business.name}
                        brandColor={view.business.brand_color}
                        {...(buyer ? { prefill: buyer } : {})}
                        onDone={done}
                        onSaveMethod={() => setStep("card")}
                        onSessionEnded={() => setSessionEnded(true)}
                      />
                    ) : (
                      <CardStep
                        scope={scope}
                        businessName={view.business.name}
                        brandColor={view.business.brand_color}
                        isChange={isChange}
                        purchase={isPurchase}
                        commit={commit}
                        blocked={blockedByDetails}
                        moneyDueToday={(dueNow?.minor ?? 0) > 0}
                        currency={
                          dueNow?.currency ?? view.items[0]?.currency ?? purchase?.currency ?? null
                        }
                        {...(reactivate
                          ? { reactivateLabel: reactivateLabel(view.change?.preview) }
                          : {})}
                        preferNew={mustReauthorize}
                        {...(buyer ? { prefill: buyer } : {})}
                        onDone={done}
                        onSessionEnded={() => setSessionEnded(true)}
                        {...(cardReturnTo
                          ? {
                              onBack: () => {
                                setCardReturnTo(null);
                                setStep(cardReturnTo);
                              },
                            }
                          : {})}
                      />
                    )}
                  </div>
                ) : step === "details" ? (
                  <DetailsStep
                    customer={details}
                    onDone={(prefill, saved) => {
                      // Held for the gateway's own sheet — see `buyer`.
                      setBuyer(prefill);
                      // …and for the next visit to this step, which must show what the buyer just
                      // typed rather than what the server rendered on page load.
                      setDetails(saved);
                      // Totals, tax and the consent sentence are priced from this address.
                      router.refresh();
                      const back = detailsReturnTo;
                      setDetailsReturnTo(null);
                      setStep(back ?? (isPurchase ? purchasePayStep : "card"));
                    }}
                    onCancel={
                      detailsReturnTo
                        ? () => {
                            const back = detailsReturnTo;
                            setDetailsReturnTo(null);
                            setStep(back);
                          }
                        : undefined
                    }
                    isChange={isChange}
                    lockEmail={view.customer_pinned ?? purchase?.customer_pinned ?? false}
                    onSessionEnded={() => setSessionEnded(true)}
                    countries={countries}
                    fieldConfig={view.field_config ?? {}}
                  />
                ) : step === "pay" && purchase ? (
                  <div key="step-pay" className="sf-step flex flex-col gap-4">
                    {detailsSummary}
                    <PurchasePayStep
                      scope={scope}
                      purchase={purchase}
                      commit={commit}
                      businessName={view.business.name}
                      brandColor={view.business.brand_color}
                      {...(buyer ? { prefill: buyer } : {})}
                      onDone={done}
                      onSaveMethod={() => setStep("card")}
                      onSessionEnded={() => setSessionEnded(true)}
                    />
                  </div>
                ) : step === "confirm" ? (
                  <div key="step-confirm" className="sf-step flex flex-col gap-4">
                    {previewInRail ? null : changePreview}
                    <ConfirmChangeStep
                      scope={scope}
                      commit={commit}
                      itemsUnchanged={view.change?.itemsUnchanged === true}
                      {...(reactivation ? { reactivation } : {})}
                      preview={view.change?.preview}
                      tz={view.business.timezone}
                      businessName={view.business.name}
                      brandColor={view.business.brand_color}
                      hasPaymentMethod={view.change?.hasPaymentMethod ?? false}
                      paymentMethod={view.change?.paymentMethod}
                      mandate={mandate}
                      blocked={changeBlocked != null}
                      onDone={done}
                      onNeedCard={() => {
                        setCardReturnTo("confirm");
                        setStep("card");
                      }}
                      onEditDetails={() => editDetails("confirm")}
                      onSessionEnded={() => setSessionEnded(true)}
                    />
                  </div>
                ) : (
                  <div key="step-card" className="sf-step flex flex-col gap-4">
                    {isChange ? (previewInRail ? null : changePreview) : detailsSummary}
                    <CardStep
                      scope={scope}
                      businessName={view.business.name}
                      brandColor={view.business.brand_color}
                      isChange={isChange}
                      purchase={isPurchase}
                      commit={commit}
                      moneyDueToday={(dueNow?.minor ?? 0) > 0}
                      currency={
                        dueNow?.currency ?? view.items[0]?.currency ?? purchase?.currency ?? null
                      }
                      {...(isChange ? { onEditDetails: () => editDetails("card") } : {})}
                      {...(reactivate
                        ? { reactivateLabel: reactivateLabel(view.change?.preview) }
                        : {})}
                      preferNew={mustReauthorize}
                      {...(buyer ? { prefill: buyer } : {})}
                      onDone={done}
                      onSessionEnded={() => setSessionEnded(true)}
                      {...(cardReturnTo
                        ? {
                            onBack: () => {
                              setCardReturnTo(null);
                              setStep(cardReturnTo);
                            },
                          }
                        : {})}
                    />
                  </div>
                )}
              </div>
            </div>

            <BotCheck />

            {/* Always mounted, opened only while the return leg is being challenged. */}
            {returnChallenge.dialog}

            {live && dueNow ? (
              <PhonePayBar
                name={name}
                isChange={isChange}
                amount={money(dueNow.minor, dueNow.currency)}
              />
            ) : null}

            <StorefrontFooter
              business={view.business.name}
              supportEmail={view.business.support_email ?? null}
              website={view.business.website ?? null}
            />
          </div>
        </ConsentContext.Provider>
      </PoNumberContext.Provider>
    </BrandTheme>
  );
}

/** An amount never breaks, sign included; only a " / month" after it may wrap. */
function unbreakable(value: React.ReactNode): React.ReactNode {
  if (typeof value !== "string") return value;
  const at = value.indexOf(" /");
  if (at < 0) return <span className="whitespace-nowrap">{value}</span>;
  return (
    <>
      <span className="whitespace-nowrap">{value.slice(0, at)}</span>{" "}
      <span className="whitespace-nowrap">{value.slice(at + 1)}</span>
    </>
  );
}

/** One figure row of the order card: label left, amount right, both on one line. */
function Figure({
  label,
  value,
  strong = false,
  credit = false,
  hint,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
  credit?: boolean;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div
        className={cn(
          "flex items-baseline justify-between gap-3",
          strong ? "text-sm font-medium" : "text-sm text-muted-foreground",
        )}
      >
        <span className="min-w-0">{label}</span>
        {/* Not shrink-0: an amount never breaks, but its "/ month" may wrap under it. */}
        <span
          className={cn(
            "text-right tabular-nums",
            strong && "text-lg font-semibold text-foreground",
            credit && "text-success",
          )}
        >
          {unbreakable(value)}
        </span>
      </div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** "3 × $12.00 / month", "Billed every month", "One-time payment". */
function lineSubline(
  l: {
    quantity: number;
    unit_amount_minor?: number | null;
    interval?: string | null;
    amount: string;
  },
  currency: string,
): string {
  if (l.unit_amount_minor === undefined) return l.amount; // an older engine: the summary only
  const every = l.interval ? ` / ${l.interval}` : "";
  if (l.unit_amount_minor != null && l.quantity > 1)
    return `${l.quantity} × ${money(l.unit_amount_minor, currency)}${every}`;
  if (l.unit_amount_minor == null) return l.amount;
  return l.interval ? `Billed every ${l.interval}` : "One-time payment";
}

/** One order line: the product, how it is priced, and what it adds up to. */
function OrderLine({
  name,
  subline,
  total,
  image,
  muted = false,
  struck = false,
  children,
}: {
  name: React.ReactNode;
  subline: React.ReactNode;
  total: React.ReactNode;
  image?: string | null;
  muted?: boolean;
  struck?: boolean;
  /** Controls under the line (a payment link's stepper). */
  children?: React.ReactNode;
}) {
  return (
    <li className={cn("px-5 py-3.5", muted && "text-muted-foreground")}>
      <div className="flex items-start gap-3">
        <ProductGlyph src={image ?? null} />
        <div className="min-w-0 flex-1">
          <div className={cn("text-sm font-medium wrap-break-word", struck && "line-through")}>
            {name}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">{subline}</div>
        </div>
        <div
          className={cn(
            "shrink-0 text-sm font-semibold tabular-nums",
            struck && "font-normal line-through",
          )}
        >
          {total}
        </div>
      </div>
      {children ? <div className="mt-2 flex justify-end">{children}</div> : null}
    </li>
  );
}

/**
 * The order: every line with its quantity and total, then the figures that add up to what
 * is due today and what is charged after. On a phone a multi-line order folds behind a
 * toggle; a single line always shows, so the buyer sees what they buy before they pay.
 */
/** " Your next payment is $X on D." when the engine priced and dated it, else "". */
function doneNextPayment(view: CheckoutView): string {
  const tz = view.business.timezone;
  const p = view.change?.preview;
  if (view.mode === "change")
    return p?.nextRenewalAt && p.nextRenewalAmountDueMinor != null
      ? ` Your next payment is ${money(p.nextRenewalAmountDueMinor, p.currency)} on ${fmtDate(p.nextRenewalAt, tz)}.`
      : "";
  const due = view.dueToday;
  if (due?.trial && due.firstChargeAt)
    return due.firstChargeMinor != null
      ? ` Your first payment of ${money(due.firstChargeMinor, due.currency)} is on ${fmtDate(due.firstChargeAt, tz)}.`
      : ` Your first payment is on ${fmtDate(due.firstChargeAt, tz)}.`;
  return due?.nextChargeAt ? ` Your next payment is on ${fmtDate(due.nextChargeAt, tz)}.` : "";
}

/** The finished checkout: what happened, what comes next, and the way back. */
function DoneCard({
  title,
  body,
  backUrl,
  businessName,
}: {
  title: string;
  body: string;
  backUrl: string | null;
  businessName: string;
}) {
  return (
    <section className="sf-rise rounded-xl border bg-card px-5 py-5 sm:px-6">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{body}</p>
      {/* The fallback if the automatic redirect is blocked or slow. */}
      {backUrl ? (
        <Button asChild className="mt-4">
          <a data-document-link href={backUrl}>
            Back to {businessName}
          </a>
        </Button>
      ) : null}
    </section>
  );
}

function OrderCard({
  view,
  title,
  locked,
  sessionEnded,
}: {
  view: CheckoutView;
  title: string;
  locked: boolean;
  sessionEnded: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const isChange = view.mode === "change";
  const isPurchase = view.mode === "purchase";
  const reactivate = view.change?.reactivation != null;
  const unchanged = view.change?.itemsUnchanged === true;
  const currency =
    view.purchase?.currency ??
    view.dueToday?.currency ??
    view.items[0]?.currency ??
    view.nextPayment?.currency ??
    "";
  const rows: Array<{ key: string; name: string; node: React.ReactNode }> = [];
  const current = view.change?.currentPlan;
  // A reactivation lists its own lines, the plan among them: a "current plan" row repeats it.
  // So does the priced "Your new term" beside this card (decided 2026-11-17).
  const pricedReactivation = reactivate && view.change?.preview != null && !view.change?.blocked;
  if (isChange && current && !(reactivate && (view.items.length > 0 || pricedReactivation))) {
    const swaps = !unchanged && !reactivate && view.items.some((i) => i.kind === "plan");
    rows.push({
      key: "current",
      name: current.name,
      node: (
        <OrderLine
          key="current"
          name={current.name}
          subline={reactivate ? "Plan" : swaps ? "Current plan" : "Current plan · does not change"}
          total={current.amount}
          muted={swaps}
          struck={swaps}
        />
      ),
    });
  }
  for (const [i, item] of (view.change?.removedItems ?? []).entries()) {
    rows.push({
      key: `removed-${i}`,
      name: item.name,
      node: (
        <OrderLine
          key={`removed-${i}`}
          name={`${item.name}${item.quantity > 1 ? ` × ${item.quantity}` : ""}`}
          subline="Removed"
          total={item.amount}
          muted
          struck
        />
      ),
    });
  }
  if (view.offer) {
    for (const l of view.offer.lines) {
      rows.push({
        key: l.price,
        name: l.name,
        node: <OfferLine key={l.price} line={l} currency={currency} locked={locked} />,
      });
    }
  } else if (!unchanged && !pricedReactivation) {
    // A reactivation's lines are already priced in "Your new term" beside this card, so they
    // are not listed twice (decided 2026-11-17); this card keeps the coupon box and the
    // regular cost.
    for (const [i, item] of view.items.entries()) {
      const sub = lineSubline(item, item.currency);
      rows.push({
        key: `item-${i}`,
        name: item.name,
        node: (
          <OrderLine
            key={`item-${i}`}
            name={item.name}
            subline={isChange && item.kind === "plan" && !reactivate ? `New plan · ${sub}` : sub}
            total={
              item.line_total_minor != null
                ? money(item.line_total_minor, item.currency)
                : item.amount
            }
            image={item.image_url ?? null}
          />
        ),
      });
    }
  }
  // A priced reactivation with nothing else to say (no coupon box, no regular cost) would be
  // a card holding one sentence: "Your new term" beside it is the whole order.
  if (pricedReactivation && !view.allow_coupons && view.coupons.length === 0 && !view.nextPayment)
    return null;
  const chosen = view.offer ? view.offer.lines.filter((l) => l.quantity > 0).length : rows.length;
  const folds = rows.length > 1;
  const first = rows.find((r) => r.key !== "current")?.name ?? rows[0]?.name ?? "";
  return (
    <StorefrontSection title={title} bodyClassName="p-0">
      {folds ? (
        <div className="flex items-center justify-between gap-3 border-b px-5 py-3 sm:hidden">
          <span className="min-w-0 text-sm">
            {isChange && current && !reactivate && first !== current.name ? (
              <span className="text-muted-foreground">{current.name} to </span>
            ) : null}
            <span className="font-medium">{first}</span>
            {(isChange && current ? chosen - 1 : chosen) > 1 ? (
              <span className="text-muted-foreground">
                {" "}
                and {(isChange && current ? chosen - 1 : chosen) - 1} more{" "}
                {(isChange && current ? chosen - 1 : chosen) - 1 === 1 ? "item" : "items"}
              </span>
            ) : null}
          </span>
          <button
            type="button"
            className="shrink-0 text-sm text-primary hover:underline"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? "Hide items" : "Show items"}
          </button>
        </div>
      ) : null}
      <div className={folds && !open ? "hidden sm:block" : undefined}>
        <ul className="divide-y">
          {rows.map((r) => r.node)}
          {rows.length === 0 || (unchanged && rows.length === 1) ? (
            <li className="px-5 py-3 text-sm text-muted-foreground">
              {reactivate
                ? unchanged
                  ? "Your plan does not change."
                  : "The lines and today's amount are in Your new term."
                : isChange
                  ? view.coupons.length > 0
                    ? "This link applies a discount to your subscription. Your plan does not change."
                    : "This link does not change your plan."
                  : "Every line on this order is free of charge."}
            </li>
          ) : null}
        </ul>
        {view.allow_coupons && !sessionEnded ? (
          <CouponBox applied={view.coupons} refusals={view.coupon_refusals ?? {}} />
        ) : view.coupons.length > 0 ? (
          <div className="space-y-2 border-t bg-muted/40 px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {view.coupons.length > 1 ? "Discounts applied" : "Discount applied"}
              </span>
              {view.coupons.map((c) => (
                <Chip key={c} className="max-w-full shrink font-mono wrap-anywhere">
                  {c}
                </Chip>
              ))}
            </div>
            <CouponRefusals refusals={view.coupon_refusals ?? {}} />
          </div>
        ) : null}
      </div>
      {isPurchase && view.purchase ? <PurchaseTotal purchase={view.purchase} /> : null}
      {view.mode === "create" ? <CreateTotals view={view} /> : null}
      {isChange && view.nextPayment ? (
        <ChangeRecurring
          next={view.nextPayment}
          // A refused change has no next payment of its own: the preview prices the change.
          preview={view.change?.blocked ? undefined : view.change?.preview}
          tz={view.business.timezone}
          reactivate={reactivate}
          unchanged={unchanged}
          interval={planInterval(view)}
        />
      ) : null}
    </StorefrontSection>
  );
}

/**
 * A signup's money, in the order the buyer pays it: today's invoice line by line, then
 * the payments after it. Every figure is the engine's; a figure it cannot state yet (no
 * address, so no tax) is left out with a line that says why.
 */
function CreateTotals({ view }: { view: CheckoutView }) {
  const tz = view.business.timezone;
  const due = view.dueToday;
  const next = view.nextPayment;
  const every = planInterval(view);
  const cur = due?.currency ?? next?.currency ?? view.items[0]?.currency ?? "";
  const totals = (
    view.offer
      ? view.offer.lines.filter((l) => l.quantity > 0).map((l) => l.line_total_minor)
      : view.items.map((i) => i.line_total_minor)
  ) as Array<number | null | undefined>;
  const subtotal =
    totals.length > 0 && totals.every((t) => typeof t === "number")
      ? (totals as number[]).reduce((a, b) => a + b, 0)
      : null;
  const intro = next?.intro ?? null;
  const later: React.ReactNode[] = [];
  if (next && every) {
    if (intro && intro.periods > 1) {
      const n = intro.periods - 1;
      later.push(
        <Figure
          key="intro"
          label={`Next ${n} ${n === 1 ? "payment" : "payments"}, with your discount`}
          value={`${money(intro.totalMinor, cur)}${n > 1 ? " each" : ""}`}
        />,
      );
    }
    const from = due?.regularFrom ?? (!intro ? due?.nextChargeAt : undefined);
    later.push(
      <Figure
        key="regular"
        label={`Then every ${every}${from ? ` from ${fmtDate(from, tz)}` : ""}`}
        value={money(next.totalMinor, cur)}
        hint={
          [
            !from && intro ? "After your discount ends." : null,
            next.taxMinor > 0 ? `Includes ${money(next.taxMinor, cur)} tax.` : null,
            next.excludesUsage ? "We bill usage in addition to this amount." : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
      />,
    );
  }
  const noAddress = (
    <p className="text-xs text-muted-foreground">
      {view.coupons.length > 0
        ? "We show your discount and the tax when you enter your billing address."
        : "We show the tax when you enter your billing address."}
    </p>
  );
  if (due?.trial) {
    const when = due.firstChargeAt ? fmtDate(due.firstChargeAt, tz) : null;
    const firstAmount = due.firstChargeMinor;
    return (
      <div className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4">
        {due.trialPeriod ? (
          <Figure
            label="Free trial"
            value={trialLength(due.trialPeriod)}
            hint={
              due.trialEndsAt ? `Your trial ends on ${fmtDate(due.trialEndsAt, tz)}.` : undefined
            }
          />
        ) : null}
        <Figure label="Due today" value={money(0, cur)} strong />
        <div className="mt-1 flex flex-col gap-2 border-t pt-3">
          <Figure
            label={when ? `First payment on ${when}` : "First payment, when your trial ends"}
            value={firstAmount != null ? money(firstAmount, cur) : ""}
            hint={
              firstAmount != null && intro && next
                ? "With your discount."
                : firstAmount == null && subtotal != null
                  ? `${money(subtotal, cur)} before tax and discounts.`
                  : undefined
            }
          />
          {intro ? later : null}
          {!intro && next && every ? (
            <Figure
              label={`Then every ${every}`}
              value={money(next.totalMinor, cur)}
              hint={next.excludesUsage ? "We bill usage in addition to this amount." : undefined}
            />
          ) : null}
          {firstAmount == null ? noAddress : null}
        </div>
      </div>
    );
  }
  if (!due) {
    return (
      <div className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4">
        {subtotal != null ? <Figure label="Subtotal" value={money(subtotal, cur)} strong /> : null}
        {noAddress}
      </div>
    );
  }
  const credit = due.totalMinor - due.amountDueMinor;
  const included = splitTax(due.taxMinor, due.taxLines).includedMinor;
  return (
    <div className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4">
      {due.subtotalMinor != null ? (
        <Figure label="Subtotal" value={money(due.subtotalMinor, cur)} />
      ) : null}
      {(due.discountLines ?? []).map((d, i) => (
        <Figure
          key={`d-${i}`}
          label={d.label === "Discounts" ? "Discounts" : `Discount (${d.label})`}
          value={`−${money(d.amountMinor, cur)}`}
          credit
          className="sf-slide"
        />
      ))}
      {(due.taxLines ?? []).map((t, i) => (
        <Figure key={`t-${i}`} label={t.label} value={money(t.amountMinor, cur)} />
      ))}
      {!due.taxLines && due.taxMinor > 0 ? (
        <Figure label="Tax" value={money(due.taxMinor, cur)} />
      ) : null}
      {included > 0 ? <Figure label={INCLUDED_TAX_LABEL} value={money(included, cur)} /> : null}
      {credit > 0 ? (
        <Figure label="Account credit" value={`−${money(credit, cur)}`} credit />
      ) : null}
      <div className="mt-1 border-t pt-2">
        <Figure
          label="Due today"
          value={<RollingNumber value={money(due.amountDueMinor, cur)} />}
          strong
        />
      </div>
      {later.length > 0 ? (
        <div className="mt-1 flex flex-col gap-2 border-t pt-3">{later}</div>
      ) : null}
    </div>
  );
}

/**
 * What the subscription costs after a change: the regular amount (only discounts that never
 * end are in it), and the next payment the engine prices for it, dated.
 */
function ChangeRecurring({
  next,
  preview,
  tz,
  reactivate,
  unchanged = false,
  interval = null,
}: {
  next: CheckoutNextPayment;
  preview?: CheckoutChangePreview | undefined;
  tz: string | null;
  reactivate: boolean;
  unchanged?: boolean;
  /** The plan's billing interval ("month", "3 months"): the figure is per this period. */
  interval?: string | null;
}) {
  const cur = next.currency;
  const notes = [
    next.taxMinor > 0 ? `Includes ${money(next.taxMinor, cur)} tax.` : null,
    next.includesExistingItems ? "This is for all items on your subscription." : null,
    next.limitedDiscountsExcluded ? "This amount does not include discounts that end." : null,
    next.excludesUsage ? "We bill usage in addition to this amount." : null,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4">
      <Figure
        label={
          reactivate
            ? "Your subscription costs"
            : unchanged
              ? "Your plan costs"
              : "Your plan costs after the change"
        }
        value={`${money(next.totalMinor, cur)}${interval ? ` /\u00a0${interval.replace(/ /g, "\u00a0")}` : ""}`}
        strong
        hint={notes.join(" ") || undefined}
      />
      {preview?.nextRenewalAt && preview.nextRenewalAmountDueMinor != null ? (
        <p className="text-xs text-muted-foreground">
          Your next payment is{" "}
          <span className="font-medium text-foreground tabular-nums">
            {money(preview.nextRenewalAmountDueMinor, preview.currency)}
          </span>{" "}
          on {fmtDate(preview.nextRenewalAt, tz)}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A payment-link line: priced like every other order line (total on the right), with the
 * controls the link allows on their own row under it. Every change is a server write and a
 * refresh, so the totals below are always the engine's.
 */
function OfferLine({
  line: l,
  currency,
  locked,
}: {
  line: NonNullable<CheckoutView["offer"]>["lines"][number];
  currency: string;
  locked: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const set = async (quantity: number) => {
    setBusy(true);
    const res = await checkoutSetItemAction(l.price, quantity);
    setBusy(false);
    if (!res.ok) return void toast.error(res.error ?? "We could not change your order.");
    router.refresh();
  };
  const chosen = l.quantity > 0;
  const controls =
    locked || (!l.optional && !(chosen && l.adjustable)) ? null : (
      <div className="flex items-center gap-3">
        {chosen && l.adjustable ? (
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={`Fewer ${l.name}`}
              disabled={busy || l.quantity <= l.min}
              onClick={() => void set(l.quantity - 1)}
            >
              −
            </Button>
            <span className="w-8 text-center text-sm tabular-nums" aria-live="polite">
              {l.quantity}
            </span>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              aria-label={`More ${l.name}`}
              disabled={busy || l.quantity >= l.max}
              onClick={() => void set(l.quantity + 1)}
            >
              +
            </Button>
          </div>
        ) : null}
        {l.optional ? (
          chosen ? (
            <button
              type="button"
              className="text-sm text-primary hover:underline disabled:opacity-60"
              disabled={busy}
              onClick={() => void set(0)}
            >
              Remove
            </button>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void set(l.adjustable ? l.min || 1 : l.min)}
            >
              Add
            </Button>
          )
        ) : null}
      </div>
    );
  const unit =
    l.unit_amount_minor != null
      ? `${money(l.unit_amount_minor, currency)}${l.interval ? ` / ${l.interval}` : ""}`
      : l.amount;
  return (
    <OrderLine
      name={l.name}
      subline={chosen ? lineSubline(l, currency) : `Optional · ${unit}`}
      total={
        chosen ? (l.line_total_minor != null ? money(l.line_total_minor, currency) : l.amount) : ""
      }
      image={l.image_url ?? null}
      muted={!chosen}
    >
      {controls}
    </OrderLine>
  );
}

/**
 * The one place a payment is committed: a full-width button, and under it one line that
 * says what is charged and when. The same treatment for a subscription, a change and a
 * purchase.
 */
function CommitArea({ summary, children }: { summary?: string | null; children: React.ReactNode }) {
  return (
    <div id="checkout-commit" className="flex flex-col gap-2 pt-1">
      {children}
      {summary ? <p className="text-center text-xs text-muted-foreground">{summary}</p> : null}
    </div>
  );
}

/**
 * Phones: the total and a way to the payment step stay at the bottom of the screen, because
 * the commit sits a long scroll below the order. Hidden while the commit itself is in view.
 */
function PhonePayBar({
  name,
  isChange,
  amount,
}: {
  name: string | null;
  isChange: boolean;
  amount: string;
}) {
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => {
    let io: IntersectionObserver | null = null;
    const attach = () => {
      const target = document.getElementById("checkout-commit");
      if (!target) return false;
      io = new IntersectionObserver(([e]) => setHidden(Boolean(e?.isIntersecting)));
      io.observe(target);
      return true;
    };
    if (attach()) return () => io?.disconnect();
    // The commit mounts once the details are saved: watch for it.
    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      io?.disconnect();
    };
  }, []);
  if (hidden) return null;
  const go = () => {
    const target =
      document.getElementById("checkout-commit") ??
      document.getElementById("checkout-details") ??
      document.getElementById("checkout-payment");
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  };
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card px-4 py-3 shadow-lg sm:hidden">
      {/* Wraps: a very large amount puts the button on its own line. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        {/* Sized by the amount alone: the name line never pushes the button down. */}
        <div className="flex-[1_1_0%]">
          <TruncatedText
            value={`${name ? `${name} · ` : ""}${isChange ? "Due now" : "Due today"}`}
            className="text-xs text-muted-foreground contain-[inline-size]"
          />
          <div className="text-base font-semibold whitespace-nowrap tabular-nums">{amount}</div>
        </div>
        <Button onClick={go} className="ml-auto shrink-0">
          Go to payment
        </Button>
      </div>
    </div>
  );
}

/**
 * What this change actually does to the buyer's money — the heading, the total's
 * label, and any qualifier the amount alone would misstate.
 *
 * There are FOUR outcomes, and `immediateCharge` distinguishes only the first.
 * "Nothing is collected now" is a CREDIT on a downgrade and a DEFERRED CHARGE
 * inside a trial: opposite news, same flag. This card used to read the flag alone
 * and then `Math.abs()` the total, so a trialing buyer upgrading LITE → PRO was
 * told "Credited to your balance ₹28,215.00" — the new plan's full price,
 * presented as money they had received. Nothing was credited: the engine had
 * correctly quoted `amountDueMinor: 0` and raised no invoice, and their balance
 * was empty. Measured in a browser, 2026-08-24.
 *
 * So the trial case is decided by `dueAtTrialEnd` (which the engine sets and the
 * preview now carries), never by inference from the sign.
 *
 * ⚠ The sign is still the arbiter for the remaining two, and that is SAFE across the
 * 2026-08-31 debt-relief fix, which turned some formerly-negative totals positive: the
 * engine derives `immediate_charge` as `total > 0` from the SAME corrected total, so a
 * change that now wants money reaches the first branch ("Due today") rather than heading
 * a payable figure "Credit from this change". `totalMinor < 0` still means credit reaches
 * the balance, because the relieved slice is subtracted before the total is formed —
 * `refundableCreditAddedMinor` is its balance-side twin and is 0 whenever this is not a
 * credit. Checked against the 7165432 / 8866444 / 2209813 case, which lands on 508801
 * positive and therefore on "Due today" / "Total due now".
 *
 * The ladder reshape later that day did NOT touch this function, and the check above
 * still holds: `totalMinor` and `immediateCharge` are unchanged: what moved is which
 * credit figure the COLUMN renders (`credits_applied` instead of the gross note). The
 * footer reads `amountDueMinor` on the `immediateCharge` branch, which was already net
 * of applied credit before the reshape.
 */
function previewOutcome(
  preview: CheckoutChangePreview,
  tz: string | null,
  reactivate = false,
): { title: string; footer: string; note: string | null } {
  // A reactivation quotes the fresh term's own invoice: no proration, no credit.
  if (reactivate) {
    if (preview.immediateCharge) {
      return { title: "Your new term", footer: "Due today", note: null };
    }
    if (preview.dueAtTrialEnd) {
      const when = fmtDate(preview.dueAtTrialEnd, tz);
      return {
        title: "Due when your trial ends",
        footer: `Due ${when}`,
        note: `Your subscription reactivates now. We do not charge you today. Your first invoice on ${when} shows this amount.`,
      };
    }
    if (preview.totalMinor > 0) {
      return {
        title: "Your new term",
        footer: "Billed on your invoice",
        note: "We do not charge you today. We bill this amount on your invoice for the new term.",
      };
    }
    return { title: "Your new term", footer: "Due today", note: null };
  }
  if (preview.immediateCharge) {
    return { title: "What you pay today", footer: "Due today", note: null };
  }
  if (preview.dueAtTrialEnd) {
    const when = fmtDate(preview.dueAtTrialEnd, tz);
    return {
      title: "Due when your trial ends",
      footer: `Due ${when}`,
      // The plan moves NOW even though the money doesn't — saying only "nothing is
      // charged today" would leave a buyer unsure the change took effect at all.
      note: `Your plan changes now. We do not charge you today. Your first invoice on ${when} shows this amount.`,
    };
  }
  if (preview.totalMinor < 0) {
    return { title: "Credit from this change", footer: "Credited to your balance", note: null };
  }
  if (preview.totalMinor > 0) {
    // Auto-collection off, or any other path that defers: still a charge, just not
    // one taken today. Never call it a credit.
    return {
      title: "Your next invoice",
      footer: "Added to your next invoice",
      note: "We do not charge you today. We bill this amount on your next invoice.",
    };
  }
  return { title: "This change costs nothing today", footer: "Due today", note: null };
}

/** What a ship-to needs: the engine's `SHIPPING_ADDRESS_REQUIREMENTS`. */
const SHIP_REQUIRED = {
  line1: "mandatory",
  city: "mandatory",
  state_code: "mandatory",
  postal_code: "mandatory",
  country: "mandatory",
} as const;

/** The separate ship-to form: the parcel fields required, the contact optional. */
const SHIP_FIELD_STATES = {
  ...SHIP_REQUIRED,
  last_name: "show",
  company: "show",
  phone: "show",
  line2: "show",
  line3: "show",
  state: "show",
} as const;

const ADDRESS_KEYS = [
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "state_code",
  "postal_code",
  "country",
  "first_name",
  "last_name",
  "company",
  "phone",
] as const;

function sameAddress(
  a: Partial<Record<(typeof ADDRESS_KEYS)[number], string | null>> | null,
  b: Partial<Record<(typeof ADDRESS_KEYS)[number], string | null>> | null,
): boolean {
  if (!a || !b) return false;
  return ADDRESS_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null));
}

function withNulls(
  a: Partial<Record<(typeof ADDRESS_KEYS)[number], string | undefined>>,
): CheckoutAddressDetails {
  const out = {} as CheckoutAddressDetails;
  for (const k of ADDRESS_KEYS) out[k] = a[k] ?? null;
  return out;
}

/** The buyer's saved details, folded to a few lines above the payment step. */
function DetailsSummary({
  details,
  countries,
  onEdit,
}: {
  details: CheckoutCustomerDetails;
  countries: Country[];
  onEdit: () => void;
}) {
  const a = details.address;
  const name = [a?.first_name, a?.last_name].filter(Boolean).join(" ");
  const countryName = (code: string | null | undefined) =>
    code ? (countries.find((c) => c.code === code)?.name ?? code) : null;
  const place = (x: CheckoutAddressDetails | null | undefined) =>
    x
      ? [
          x.line1,
          x.line2,
          x.city,
          [x.state ?? x.state_code, x.postal_code].filter(Boolean).join(" "),
          countryName(x.country),
        ]
          .filter(Boolean)
          .join(", ")
      : "";
  const billTo = place(a);
  const shipTo = place(details.shipping_address);
  return (
    <StorefrontSection
      title="Your details"
      action={
        <button type="button" onClick={onEdit} className="text-sm text-primary hover:underline">
          Edit
        </button>
      }
    >
      <div className="min-w-0 text-sm wrap-break-word">
        {name || a?.company ? (
          <div className="font-medium">{[name, a?.company].filter(Boolean).join(" · ")}</div>
        ) : null}
        {details.email ? <div className="text-muted-foreground">{details.email}</div> : null}
        {billTo ? <div className="text-muted-foreground">{billTo}</div> : null}
        {shipTo ? <div className="text-muted-foreground">Ship to: {shipTo}</div> : null}
        {details.tax_registration_number ? (
          <div className="text-muted-foreground">Tax ID: {details.tax_registration_number}</div>
        ) : null}
      </div>
    </StorefrontSection>
  );
}

/** A purchase's total, itemised the way its invoice will be. */
function PurchaseTotal({ purchase }: { purchase: CheckoutPurchase }) {
  const cur = purchase.currency;
  const credit = purchase.total_minor - purchase.amount_due_minor;
  const included = splitTax(purchase.tax_minor, purchase.tax_lines).includedMinor;
  return (
    <div className="flex flex-col gap-2 border-t bg-muted/40 px-5 py-4">
      <Figure label="Subtotal" value={money(purchase.subtotal_minor, cur)} />
      {(purchase.discounts ?? []).map((d) => (
        <Figure
          key={`d-${d.code}`}
          label={`Discount (${d.label})`}
          value={`−${money(d.amount_minor, cur)}`}
          credit
        />
      ))}
      {purchase.tax_lines.map((t, i) => (
        <Figure key={`${t.label}-${i}`} label={t.label} value={money(t.amount_minor, cur)} />
      ))}
      {included > 0 ? <Figure label={INCLUDED_TAX_LABEL} value={money(included, cur)} /> : null}
      {credit > 0 ? (
        <Figure label="Account credit" value={`−${money(credit, cur)}`} credit />
      ) : null}
      <div className="mt-1 border-t pt-2">
        <Figure label="Due today" value={money(purchase.amount_due_minor, cur)} strong />
      </div>
      {!purchase.tax_known ? (
        <p className="text-xs text-muted-foreground">
          We show the tax when you enter your billing address.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Pay for a purchase without keeping the method: the gateway's own sheet collects it (card,
 * UPI, wallet), through the same challenge machine as every other charge on this page.
 * When the business asks the buyer, this step offers to save the method instead.
 */
function PurchasePayStep({
  scope,
  purchase,
  commit,
  blocked = false,
  businessName,
  brandColor,
  prefill,
  onDone,
  onSaveMethod,
  onSessionEnded,
}: {
  scope: string;
  purchase: CheckoutPurchase;
  commit: CommitCopy;
  /** One page: the details above are not valid, so nothing can be paid yet. */
  blocked?: boolean;
  businessName: string;
  brandColor: string | null;
  prefill?: BuyerPrefill;
  onDone: (outcome: CompletionOutcome) => void;
  /** The buyer wants to keep the method: continue on the card step, which saves it. */
  onSaveMethod: () => void;
  onSessionEnded: () => void;
}) {
  const [save, setSave] = React.useState(false);
  /** Nothing to pay: no provider opens and no method is kept. */
  const free = purchase.amount_due_minor <= 0;
  const challenge = usePaymentChallenge({
    ...(prefill ? { prefill } : {}),
    scope,
    businessName,
    brandColor,
    isChange: false,
    purchase: true,
    showsRefusal: true,
    onSessionEnded,
    onCompleted: onDone,
  });
  return (
    <StorefrontSection title="Payment">
      {challenge.panel ?? (
        <div id="checkout-payment" className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            {free
              ? "You pay nothing for this purchase."
              : "Your payment provider opens over this page. You select how you pay there."}
          </p>
          {/* A choice about the payment method, kept apart from the consent boxes. */}
          {purchase.save_payment_method === "ask" && !free ? (
            <CheckboxField
              checked={save}
              onCheckedChange={setSave}
              label="Save my payment method for my next purchases"
              hint="Optional."
            />
          ) : null}
          <ConsentBoxes />
          {blocked ? <DetailsBlockedNote /> : null}
          <CommitArea summary={commit.summary}>
            {save && !free ? (
              <Button onClick={onSaveMethod} disabled={blocked} className="w-full" size="lg">
                Continue to card details
              </Button>
            ) : (
              <Button
                onClick={() => void challenge.run({})}
                disabled={blocked || challenge.busy}
                className="h-auto min-h-10 w-full py-2 whitespace-normal"
                size="lg"
              >
                <BusyLabel busy={challenge.busy}>
                  {challenge.busy ? commit.busy : commit.label}
                </BusyLabel>
              </Button>
            )}
          </CommitArea>
        </div>
      )}
      <PaymentRefusal message={challenge.refusal} />
      {challenge.dialog}
    </StorefrontSection>
  );
}

/** One page: the commit waits for valid details, and says so beside the button. */
function DetailsBlockedNote() {
  return (
    <Alert tone="warning">Correct the highlighted fields in your details. Then you can pay.</Alert>
  );
}

/** The last refused payment, kept on the card after its toast closes. */
function PaymentRefusal({ message }: { message: string | null }) {
  return <RefusalAlert message={message} className="mt-4" step="pay" />;
}

/**
 * The change already waits for payment (`apply_when_paid`), from this session or an earlier
 * one: paying here pays that same invoice, and the change expires unpaid at `heldExpiresAt`.
 */
function HeldChangeNotice({ preview, tz }: { preview: CheckoutChangePreview; tz: string | null }) {
  const until = fmtDateTime(preview.heldExpiresAt!, tz);
  return (
    <Alert tone="info" title="This change waits for payment">
      <p>
        {preview.amountDueMinor > 0
          ? `Pay ${money(preview.amountDueMinor, preview.currency)} before ${until} to complete this change. Until then, your plan does not change.`
          : "Your payment is in progress. Your plan changes when the payment is complete."}
      </p>
    </Alert>
  );
}

/** Proration preview: what's charged now, what's credited, and the net. On a reactivation,
 *  the fresh term's invoice instead. */
function PreviewCard({
  preview,
  tz,
  oldPlan,
  reactivation,
  paid = false,
}: {
  preview: CheckoutChangePreview;
  /** Business timezone from the session payload — see the fmtDate call below. */
  tz: string | null;
  /** The plan being left, named in the credit sentence. */
  oldPlan: string | null;
  reactivation?: { startsAt: string | null };
  /** The checkout is finished: what was due today is now paid. */
  paid?: boolean;
}) {
  const total = Math.abs(preview.immediateCharge ? preview.amountDueMinor : preview.totalMinor);
  const outcome = previewOutcome(preview, tz, reactivation != null);
  // ── ONE LADDER ACROSS ALL THREE SURFACES ────────────────────────────────────
  // The operator's rail and confirm dialog read the same ladder as this page. They used to
  // read the same word, `Subtotal`, off a DIFFERENT number: the estimate's `subtotal_minor`,
  // which is net of the credit. Same change, same label, ₹44,368.00 on one screen and
  // −₹752.00 on another — and the CGST row then sat under a −752 subtotal while being 9% of
  // 44,368, so no row related to the one above it. That much is unchanged: one ladder, and
  // `subtotal_minor` is still not in it (`invoiceTotalMinor` exists because
  // `subtotal + tax` goes NEGATIVE on a downgrade).
  //
  // WHAT CHANGED, 2026-08-31 — the table is now PURE CHARGES: the immediate charges and
  // their total, nothing else. The GROSS credit leaves the ladder entirely and becomes
  // prose beneath it, and the only credit row is `invoice_estimate.credits_applied` — the
  // slice that offsets THIS invoice. This replaces the previous shape, which stated the
  // gross credit in the ladder and then ADDED BACK the slice that went elsewhere
  // (`+₹22,098.13`). That was arithmetically sound and landed on the right total; it was
  // abandoned because it put two documents in one column and made a buyer read a `+` under
  // a credit. See the removed comment's argument preserved in `docs/PROGRESS.md` — it was a
  // real position, not an oversight, and it lost to clarity, not to a bug.
  const narrative = creditNarrativeFromPreview(preview);
  const creditNoteMinor = narrative.grossMinor;
  // The engine's `credits_applied`. ⚠ NOT `gross − appliedToOpenInvoices`: that is right
  // only where every other leg is zero, which is true of the unpaid-term shape this page was
  // debugged against (₹88,664.44 − ₹22,098.13 = ₹66,566.31) and false as soon as a downgrade
  // overflows to the balance or the router strands a residue. The engine reports it.
  const creditAppliedHereMinor = preview.creditAppliedToThisInvoiceMinor ?? 0;
  const chargeLinesMinor = preview.lines.reduce(
    (sum, l) => (l.amountMinor > 0 ? sum + l.amountMinor : sum),
    0,
  );
  // Negative lines are the credit, and the credit is prose now — but only filter when there
  // IS a note to explain them. Filtering unconditionally would silently swallow a negative
  // line on some future shape that produces one without a credit note.
  const shownLines =
    creditNoteMinor > 0 ? preview.lines.filter((l) => l.amountMinor > 0) : preview.lines;
  // The invoice's OWN total, from the engine. The local reconstruction is a fallback for a
  // preview produced before the field existed, and is correct for exactly the shape this
  // page renders (charge lines − promo + tax).
  const couponOffMinor = preview.couponDiscountMinor ?? 0;
  const invoiceTotalMinor =
    preview.invoiceTotalMinor ??
    chargeLinesMinor - couponOffMinor - preview.promotionalDiscountMinor + preview.taxMinor;
  // `fmtDate` and not `toLocaleDateString`: the credited period is rendered on a page that
  // hydrates, and Node and the browser disagree on the default locale — see the note on the
  // renewal date below, which threw the whole tree away over exactly this.
  const creditSentences = buyerCreditSentences(
    narrative,
    (m) => money(m, preview.currency),
    (iso) => fmtDate(iso, tz),
    oldPlan,
  );
  /** Where the charged lines end: this period's end, as the renewal dates it. */
  const until = preview.termReset
    ? null
    : preview.nextRenewalAt
      ? fmtDate(preview.nextRenewalAt, tz)
      : preview.creditedPeriodEnd
        ? fmtDate(preview.creditedPeriodEnd, tz)
        : null;
  /** The invoice total is its own row only when tax or a discount makes it differ. */
  const showInvoiceTotal =
    invoiceTotalMinor !== (creditNoteMinor > 0 ? chargeLinesMinor : preview.subtotalMinor);
  return (
    <StorefrontSection title={outcome.title} bodyClassName="p-0">
      <div className="flex flex-col gap-2 px-5 py-4 text-sm">
        {/* A CREDIT reads `success`; a charge stays neutral ink. The design system
            pairs credits with charges as success/destructive on the OPERATOR's
            proration screen, but painting every line of a buyer's own upgrade red
            makes a normal purchase look like a failure. The two are still
            distinguished, which is the part that matters. */}
        {shownLines.map((l, i) => (
          <div key={i} className="flex items-start justify-between gap-3">
            <span className="min-w-0 text-muted-foreground">
              {buyerLineLabel(l.description, until)}
            </span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                l.amountMinor < 0 ? "text-success" : "text-foreground",
              )}
            >
              {money(l.amountMinor, preview.currency)}
            </span>
          </div>
        ))}
        {/* The same ladder the INVOICE prints — subtotal, discount, tax rows, balance,
            total — so the quote the buyer confirms and the document they are sent can be
            read against each other line by line. Hidden only when there is nothing above
            it to sum (a pure credit with a single line). */}
        {shownLines.length > 1 || creditNoteMinor > 0 ? (
          <div className="flex items-center justify-between gap-3 border-t pt-2">
            <span className="text-muted-foreground">Subtotal</span>
            <span className="shrink-0 tabular-nums">
              {/* The CHARGE LINES, so the tax rows below are a readable percentage of it.
                  `preview.subtotalMinor` is the NET of charges and credit and belongs to
                  neither document — it goes negative on a downgrade, which is how the CGST row
                  once sat under a −752 subtotal while being 9% of 44,368.

                  ⚠ DELIBERATELY NOT `invoiceSubtotalMinor`. That field is POST-discount (it
                  matches `serializeInvoice`, so `subtotal + tax == invoice_total`), while this
                  column prints `Promotional credits` as its own row directly below. Using the
                  post-discount figure here would subtract the discount twice on screen — once
                  invisibly inside the subtotal and once in the row under it. The field is the
                  right one for a ladder with NO discount row; this is not that ladder. */}
              {money(
                creditNoteMinor > 0 ? chargeLinesMinor : preview.subtotalMinor,
                preview.currency,
              )}
            </span>
          </div>
        ) : null}
        {/* Each coupon by the name its invoice prints; one unnamed row only as a fallback. */}
        {couponOffMinor > 0
          ? (preview.couponDiscountLines?.length
              ? preview.couponDiscountLines
              : [{ label: "Discount", amountMinor: couponOffMinor }]
            ).map((d, i) => (
              <div key={`${d.label}-${i}`} className="flex items-center justify-between gap-3">
                <span className="min-w-0 text-muted-foreground">{d.label}</span>
                <span className="shrink-0 text-success tabular-nums">
                  −{money(d.amountMinor, preview.currency)}
                </span>
              </div>
            ))
          : null}
        {/* ABOVE tax: promotional credit is applied before tax and shrinks the taxable
            base, so the tax below is charged on what is left after it. Without the row the
            footer total was smaller than the lines plus tax by an unnamed amount. */}
        {preview.promotionalDiscountMinor > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Promotional credit</span>
            <span className="shrink-0 text-success tabular-nums">
              −{money(preview.promotionalDiscountMinor, preview.currency)}
            </span>
          </div>
        ) : null}
        {/* Named as the INVOICE names them — CGST + SGST intra-state, IGST inter-state — so
            an Indian buyer can match this quote against the document they are sent. One
            lump "Tax" row is the fallback for a tax with no component breakdown (and for a
            preview produced before `taxLines` existed). */}
        {preview.taxLines.length > 0
          ? preview.taxLines.map((t, i) => (
              <div key={`${t.label}-${i}`} className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">{t.label}</span>
                <span className="shrink-0 tabular-nums">
                  {money(t.amountMinor, preview.currency)}
                </span>
              </div>
            ))
          : null}
        {splitTax(preview.taxMinor, preview.taxLines).includedMinor > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">{INCLUDED_TAX_LABEL}</span>
            <span className="shrink-0 tabular-nums">
              {money(splitTax(preview.taxMinor, preview.taxLines).includedMinor, preview.currency)}
            </span>
          </div>
        ) : null}
        {/* THE ROW THAT MAKES THIS LADDER ADD UP ON A CREDITED CHANGE.
            `subtotalMinor` is net of the credit's PRE-tax amount, and the tax rows above are
            the INVOICE's tax, gross of it — so the credit note's own tax is in neither, and
            the ladder lands short of `totalMinor` by exactly that. Before 2026-08-30 the two
            errors cancelled (the total carried the same mistake), so the column summed
            correctly to a wrong number; fixing the total exposed the gap rather than
            creating it.

            Derived, not a new field: the note's tax is its face value less the credit lines
            already shown above. −752.00 + 7,986.24 − 8,121.60 = −887.36. */}
        {creditNoteMinor > 0 ? (
          <>
            {showInvoiceTotal ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Total before credit</span>
                <span className="shrink-0 tabular-nums">
                  {money(invoiceTotalMinor, preview.currency)}
                </span>
              </div>
            ) : null}
            {/* THE ONLY CREDIT ROW — `invoice_estimate.credits_applied`, the slice that
                offsets THIS invoice. `invoiceTotal − this = amount due`, so the column now
                subtracts once and lands on the footer with no add-back.

                What was here before: the GROSS credit (−₹88,664.44) followed by a
                `+₹22,098.13` row adding back the slice that went to the term's own unpaid
                invoice. Both figures were right and the pair netted correctly, but it put two
                documents in one column and asked a buyer to read a `+` under a credit. The
                charges table stays pure and states the gross in prose instead, which is
                what the sentences below now do.

                `success`, because it is unambiguously money off this bill — the earlier
                shape had to render its add-back row muted precisely because a green `+`
                would have read as a second credit. That problem is gone with the row. */}
            {creditAppliedHereMinor > 0 ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Credit for unused time</span>
                <span className="shrink-0 text-success tabular-nums">
                  −{money(creditAppliedHereMinor, preview.currency)}
                </span>
              </div>
            ) : null}
          </>
        ) : null}
        {preview.creditsAppliedMinor > 0 ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground">Account credit</span>
            <span className="shrink-0 text-success tabular-nums">
              −{money(preview.creditsAppliedMinor, preview.currency)}
            </span>
          </div>
        ) : null}
      </div>
      <div className="flex items-baseline justify-between gap-3 border-t bg-muted/40 px-5 py-3.5">
        <span className="text-sm font-medium">
          {paid && outcome.footer === "Due today" ? "Paid today" : outcome.footer}
        </span>
        <span className="text-xl font-semibold tracking-tight tabular-nums">
          {money(total, preview.currency)}
        </span>
      </div>
      {/* ── CREDITS, AS ITS OWN NAMED SECTION ──────────────────────────────────────
          A `Credits` heading after the charges total, explaining the credit in sentences:
          face value, the period it covers, and where it goes. It sits BELOW the footer
          total because the credit no longer participates in the column above it — only
          `credits_applied` does, and that row is already in the ladder.

          Every non-zero leg gets a sentence, and they account for 100% of the gross — see
          `creditLegSentences`, which the operator's rail and the confirm dialog also read so
          the three surfaces cannot drift into three explanations of one split.

          The type ("prorated adjustment credits"), the invoice number and the credited period
          all come from the engine's `credit_destinations[]`. None of them is inferred here:
          a change can raise BOTH an adjustment and a refundable note, which is precisely
          the shape that guessing the type from a non-zero amount mislabels. */}
      {creditSentences.length > 0 ? (
        <div className="border-t px-5 py-4">
          <div className="mb-1.5 text-sm font-medium">Credit for unused time</div>
          <div className="flex flex-col gap-1.5 text-sm text-muted-foreground">
            {creditSentences.map((s, i) => (
              <p key={i}>{s}</p>
            ))}
          </div>
        </div>
      ) : null}
      {outcome.note ||
      preview.termReset ||
      (reactivation && (reactivation.startsAt || preview.newPeriodEnd)) ? (
        <div className="flex flex-col gap-1 border-t px-5 py-3 text-xs text-muted-foreground">
          {outcome.note ? <p>{outcome.note}</p> : null}
          {/* "Starts when you confirm" is said once, by the payment section below. */}
          {reactivation ? (
            reactivation.startsAt || preview.newPeriodEnd ? (
              <p>
                {reactivation.startsAt
                  ? `Your new term starts on ${fmtDate(reactivation.startsAt, tz)}${preview.newPeriodEnd ? `, renewing ${fmtDate(preview.newPeriodEnd, tz)}` : ""}.`
                  : `Your new term renews on ${fmtDate(preview.newPeriodEnd!, tz)}.`}
              </p>
            ) : null
          ) : preview.termReset ? (
            <p>
              This starts a new billing term
              {/* `toLocaleDateString()` here was a live HYDRATION FAILURE on this page:
                  Node and the browser disagree on the default locale, so the server sent
                  "21/09/2026" and the client rendered "21/9/2026" and React threw the
                  whole tree away. `fmtDate` pins en-GB and an EXPLICIT zone, so both
                  sides agree — the business timezone is a fixed string from the session
                  payload, not the viewer's, so it stays hydration-safe while no longer
                  quoting a renewal date a day off the one the operator sees. */}
              {preview.newPeriodEnd ? `, renewing ${fmtDate(preview.newPeriodEnd, tz)}` : ""}.
            </p>
          ) : null}
        </div>
      ) : null}
    </StorefrontSection>
  );
}

/**
 * Change-mode confirm. With a card already on file the buyer just confirms (no
 * token — the API reuses the vaulted card); otherwise they're routed to the card
 * step first, since auto-collection means the proration invoice must be payable.
 */
function ConfirmChangeStep({
  scope,
  commit,
  itemsUnchanged,
  reactivation,
  preview,
  tz,
  businessName,
  brandColor,
  hasPaymentMethod,
  paymentMethod,
  mandate,
  blocked = false,
  onDone,
  onNeedCard,
  onEditDetails,
  onSessionEnded,
}: {
  /** Non-secret per-session key for the redirect-leg stash. */
  scope: string;
  commit: CommitCopy;
  /** The link asks for the items the subscription already has. */
  itemsUnchanged: boolean;
  /** Present when confirming reactivates a cancelled subscription. */
  reactivation?: { startsAt: string | null };
  preview: CheckoutChangePreview | undefined;
  tz: string | null;
  businessName: string;
  /** The merchant's brand hex, for the Elements iframe — see `stripeAppearance`. */
  brandColor: string | null;
  hasPaymentMethod: boolean;
  /** The instrument this change will be billed to — named, not implied. */
  paymentMethod?: NonNullable<CheckoutView["change"]>["paymentMethod"];
  /** Absent = no mandate is involved; see the field's note in lib/checkout-api.ts. */
  mandate?: CheckoutChangeMandate;
  /** Confirm would refuse the change; the reason shows above, so offer no confirm. */
  blocked?: boolean;
  onDone: (outcome: CompletionOutcome) => void;
  onNeedCard: () => void;
  /** Back to the buyer's own billing details — the way out of a gateway error that needs them. */
  onEditDetails: () => void;
  /** Raised when the engine says the session is gone — terminal, so the parent takes over. */
  onSessionEnded: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  /**
   * Through the same machine as every other completion, for the OUTCOME reporting rather
   * than for the challenge: it is what makes a refused capture (`payment_error`) reach the
   * buyer here too, instead of a green "Plan updated".
   *
   * ⚠️ The 402 arm is inert on this path today, and deliberately kept: `completePlanChange`
   * reports a refused collection as `unpaid_invoice` and never raises
   * `CheckoutActionRequiredError`, which only the create path throws. It costs nothing, and
   * a change that ever does need authentication will be handled rather than toasted.
   *
   * No prefill — a change session's customer is pinned server-side and never reaches this
   * page, so there is nothing honest to put in the gateway's fields.
   */
  const challenge = usePaymentChallenge({
    scope,
    businessName,
    brandColor,
    isChange: true,
    reactivate: reactivation != null,
    showsRefusal: true,
    onSessionEnded,
    onCompleted: onDone,
  });
  const startsOn = reactivation?.startsAt ? fmtDate(reactivation.startsAt, tz) : null;
  void preview;
  if (blocked) return null;
  const confirm = async () => {
    setBusy(true);
    try {
      await challenge.run({});
    } finally {
      setBusy(false);
    }
  };
  if (challenge.panel) {
    return <StorefrontSection title="Payment">{challenge.panel}</StorefrontSection>;
  }
  /**
   * The auto-debit authorisation on file is too small for what this change will cost.
   *
   * NOT offered as a warning beside a working "Confirm change": the charge would be
   * refused by the buyer's own bank before it reached the gateway, and the change would
   * still have been applied — plan moved, invoice unpayable, nobody told. And no rail lets
   * a ceiling be raised, so the only route through is a fresh authorisation, which the
   * buyer is standing in exactly the right place to give.
   */
  const reauth = Boolean(mandate?.reauthorizationRequired);
  return (
    <StorefrontSection title={reactivation ? "Payment" : "Confirm your change"}>
      <div className="flex flex-col gap-3">
        <PoNumberInput />
        {reauth && mandate ? (
          <>
            <Alert tone="warning" title="Your auto-debit limit is too low for this plan">
              <p>
                {paymentMethod
                  ? `${instrumentLabel(paymentMethod)} is `
                  : "Your payment method is "}
                approved for automatic payments of up to{" "}
                <span className="font-medium tabular-nums">
                  {money(mandate.currentCeilingMinor ?? 0, mandate.currency)}
                </span>{" "}
                per charge. Payments for this plan reach{" "}
                <span className="font-medium tabular-nums">
                  {money(mandate.largestDebitMinor, mandate.currency)}
                </span>
                . Your bank would decline them.
              </p>
              <p className="mt-2">
                Your bank does not let us increase the limit. The next step creates a new
                authorization for up to{" "}
                <span className="font-medium tabular-nums">
                  {money(mandate.requiredCeilingMinor, mandate.currency)}
                </span>{" "}
                per charge. Your existing payment method stays on your account.
              </p>
            </Alert>
            <CommitArea>
              <Button onClick={onNeedCard} className="w-full" size="lg">
                Set up a new authorization
              </Button>
            </CommitArea>
          </>
        ) : hasPaymentMethod ? (
          <>
            <p className="text-sm text-muted-foreground">
              {reactivation
                ? "Your subscription reactivates when you confirm."
                : itemsUnchanged
                  ? preview
                    ? "Your plan does not change. Your discount applies when you confirm."
                    : "Your plan does not change."
                  : "Your plan changes when you confirm."}{" "}
              Pay with{" "}
              {paymentMethod ? (
                <span className="font-medium text-foreground">
                  {instrumentLabel(paymentMethod)}
                </span>
              ) : (
                "the card on your account"
              )}
              .{startsOn ? ` Your new billing period starts on ${startsOn}.` : ""}
            </p>
            {/* The limit this change will be debited against, when the instrument rides a
                mandate and can carry it. Said plainly BEFORE the buyer confirms, because a
                figure they authorised months ago is the one thing on this page they cannot
                look up — and it is what decides whether the charge goes through. */}
            {mandate?.currentCeilingMinor != null ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                Auto-debit approved up to {money(mandate.currentCeilingMinor, mandate.currency)} per
                charge · payments for this plan reach{" "}
                {money(mandate.largestDebitMinor, mandate.currency)}
              </p>
            ) : null}
            <CommitArea summary={commit.summary}>
              {/* `challenge.busy` too: leg 2 of an authentication runs after `confirm` has
                  already returned, and a re-enabled button there would post a third leg. */}
              <Button
                onClick={confirm}
                disabled={busy || challenge.busy}
                className="h-auto min-h-10 w-full py-2 whitespace-normal"
                size="lg"
              >
                <BusyLabel busy={busy || challenge.busy}>
                  {busy || challenge.busy ? commit.busy : commit.label}
                </BusyLabel>
              </Button>
            </CommitArea>
            {/* Lists the methods the buyer holds before offering to add another. */}
            <button
              type="button"
              onClick={onNeedCard}
              disabled={busy || challenge.busy}
              className="self-center text-sm text-primary hover:underline disabled:opacity-60"
            >
              Use a different payment method
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {reactivation
                ? "Add a card to reactivate your subscription."
                : "Add a card to complete this change."}
              {startsOn ? ` Your new term starts on ${startsOn}.` : ""}
            </p>
            <CommitArea>
              <Button onClick={onNeedCard} className="w-full" size="lg">
                Continue to payment method
              </Button>
            </CommitArea>
            {/* The way OUT of a gateway error that needs the buyer's own details.
                RazorPay refuses to vault a card for recurring payments without a phone number and
                says "add a phone number to the customer" — an operator action, shown to a buyer
                who cannot perform it. A plan change starts at this step and only ever went
                forward to `card`, so there was no route back to the details at all. */}
            <button
              type="button"
              onClick={onEditDetails}
              className="self-start text-xs text-primary hover:underline"
            >
              Edit billing details
            </button>
          </>
        )}
      </div>
      <PaymentRefusal message={challenge.refusal} />
      {challenge.dialog}
    </StorefrontSection>
  );
}

/** Good enough to catch typos without rejecting a real address — the server is the boundary. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function DetailsStep({
  onDone,
  onCancel,
  onValidity,
  autoSave = false,
  isChange,
  lockEmail,
  onSessionEnded,
  countries,
  customer,
  fieldConfig,
}: {
  /**
   * Reports what the buyer typed, so the gateway's own sheet can be prefilled with it
   * rather than asking for the same three fields again — see `buyer`.
   *
   * `saved` is the same details echoed back for the FLOW to hold, so a second visit to this
   * step prefills what the buyer just typed rather than what the server rendered on page
   * load — see `details` in `CheckoutFlow`.
   */
  onDone: (prefill: BuyerPrefill, saved: CheckoutCustomerDetails) => void;
  /** Present only when this step was reached by an explicit edit — see `detailsReturnTo`. */
  onCancel?: () => void;
  /** One page: whether the form is valid now, so the commit below can wait for it. */
  onValidity?: (valid: boolean) => void;
  /**
   * One-page layout: save by itself once the form is valid and the buyer pauses, so the
   * payment section below can open without a Continue click. Identical data is not re-sent.
   */
  autoSave?: boolean;
  /** Change mode: the customer — and their email — is pinned, so identity is not editable here. */
  isChange?: boolean;
  /** A purchase for a known customer: their email is fixed, the rest is editable. */
  lockEmail?: boolean;
  /** Raised when the engine says the session is gone — terminal, so the parent takes over. */
  onSessionEnded: () => void;
  countries: Country[];
  /**
   * What is already on the session's customer. **Load-bearing, not a convenience.**
   *
   * The save below REPLACES the address (`applyAddress` nulls every column it is not
   * given), so a blank form the buyer partly fills wipes the rest of their record —
   * company, address lines 2/3, state, last name, and the tax registration number an
   * Indian B2B buyer needs on the invoice to claim input tax credit. This step used to
   * render blank every time, including on the "Edit billing details" round-trip from the
   * card step, which is the path a buyer is most likely to take. The portal's equivalent
   * form has always prefilled (`billing-details.tsx` passes `me.customer.address`); this
   * surface was ported from it without the data.
   *
   * Null before the session has a customer — a create-mode buyer on their first pass.
   */
  customer?: CheckoutCustomerDetails | null;
  /** The business's field matrix. Fields listed in lib/checkout-field-rules.ts ignore Hidden. */
  fieldConfig: NonNullable<CheckoutView["field_config"]>;
}) {
  const state = (k: string) => fieldConfig[k];
  // First name is not here: `requireContactName` always asks for it (checkout-field-rules).
  const fieldStates = {
    last_name: state("customer.last_name"),
    company: state("customer.company"),
    phone: state("customer.phone"),
    line1: state("billing.line1"),
    line2: state("billing.line2"),
    line3: state("billing.line3"),
    city: state("billing.city"),
    state: state("billing.state"),
    state_code: state("billing.state_code"),
    postal_code: state("billing.postal_code"),
    country: state("billing.country"),
  };
  const taxIdState = state("customer.tax_registration_number");
  /**
   * Ship-to section (`shipping.address`). Mandatory: a "Ship to my billing address" box,
   * checked by default. Show: the buyer first opts in with "Add a shipping address".
   * A details post under `show` without one clears the ship-to, so both boxes are real.
   */
  const shipping = state("shipping.address") ?? "hide";
  const savedShip = customer?.shipping_address ?? null;
  const [addShipping, setAddShipping] = React.useState(savedShip != null);
  const [shipToBilling, setShipToBilling] = React.useState(
    savedShip == null || sameAddress(savedShip, customer?.address ?? null),
  );
  const wantsShipping = shipping === "mandatory" || (shipping === "show" && addShipping);
  // Shipping to the billing address needs the parts a parcel needs.
  const billingStates =
    wantsShipping && shipToBilling ? { ...fieldStates, ...SHIP_REQUIRED } : fieldStates;
  const emailLocked = isChange || lockEmail === true;
  const [busy, setBusy] = React.useState(false);
  const [showTaxId, setShowTaxId] = React.useState(Boolean(customer?.tax_registration_number));
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const formRef = React.useRef<HTMLFormElement>(null);
  const lastSent = React.useRef<string | null>(null);
  const autoTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savedHere, setSavedOnce] = React.useState(false);
  const savedOnce = customer != null || savedHere;
  /** The fields to correct, named; null until a save is tried on an invalid form. */
  const [problems, setProblems] = React.useState<string[] | null>(null);
  /** The country selected in the address, for the tax ID's help. */
  const [country, setCountry] = useDefaultState<string>(customer?.address?.country ?? "");
  const readCountry = () => {
    const v = formRef.current?.querySelector<HTMLInputElement>('input[name="country"]')?.value;
    if (v !== undefined && v !== country) setCountry(v);
  };
  React.useEffect(() => {
    const input = formRef.current?.querySelector<HTMLInputElement>('input[name="country"]');
    if (!input) return;
    const mo = new MutationObserver(() => setCountry(input.value));
    mo.observe(input, { attributes: true, attributeFilter: ["value"] });
    return () => mo.disconnect();
  }, [setCountry]);
  /**
   * Every fault on the form, in our words: the fields this step renders get their own
   * error; the address fields (a shared component) are named in the summary and
   * highlighted by the browser's own invalid state.
   */
  const validate = (form: HTMLFormElement) => {
    const fd = new FormData(form);
    const errors: Record<string, string> = {};
    const list: string[] = [];
    if (!emailLocked) {
      const email = String(fd.get("email") ?? "").trim();
      if (!email) errors.email = "Enter your email address.";
      else if (!EMAIL_RE.test(email))
        errors.email = "Enter a valid email address, for example name@example.com.";
      if (errors.email) list.push(errors.email);
    }
    if (!String(fd.get("first_name") ?? "").trim() && !String(fd.get("company") ?? "").trim())
      list.push("Enter the name to show on your invoices.");
    const countryValue = String(fd.get("country") ?? "").trim();
    if (!countryValue && state("billing.country") === "mandatory")
      list.push("Select your country.");
    for (const el of Array.from(form.elements)) {
      const input = el as HTMLInputElement;
      if (!input.name || input.type === "hidden" || input.name === "email") continue;
      if (input.name === "first_name" || input.willValidate === false) continue;
      if (input.checkValidity()) continue;
      // Already named above.
      if (input.name === "country" && list.includes("Select your country.")) continue;
      const { name, picked } = fieldLabelOf(form, input);
      if (input.name === "tax_registration_number" || input.name === "po_number")
        errors[input.name] = input.validity.valueMissing
          ? `Enter your ${name}.`
          : `Check your ${name}.`;
      // "Address line 1" → "address line 1"; an acronym ("ZIP code") keeps its case.
      const lower = /^[A-Z][A-Z]/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
      const verb = picked ? "Select" : "Enter";
      list.push(input.validity.valueMissing ? `${verb} ${lower}.` : `Check ${lower}.`);
    }
    return { errors, list };
  };
  const report = (form: HTMLFormElement) => {
    const { errors, list } = validate(form);
    setFieldErrors(errors);
    setProblems(list.length > 0 ? list : null);
    onValidity?.(list.length === 0);
    return list.length === 0;
  };
  /** Debounced: after each edit, save if the form is valid and differs from the last save. */
  const scheduleAutoSave = () => {
    readCountry();
    if (!autoSave) return;
    if (autoTimer.current) clearTimeout(autoTimer.current);
    autoTimer.current = setTimeout(() => {
      const form = formRef.current;
      if (!form || busy) return;
      // Before the first save the form is still being filled: say nothing until a field
      // is left or Enter is pressed. After it, an edit that breaks the form shows at once,
      // and the commit below waits for it.
      const { list } = validate(form);
      if (list.length > 0) {
        if (savedOnce) report(form);
        else onValidity?.(false);
        return;
      }
      setProblems(null);
      setFieldErrors({});
      onValidity?.(true);
      const snapshot = JSON.stringify([...new FormData(form).entries()]);
      if (snapshot === lastSent.current) return;
      form.requestSubmit();
    }, 900);
  };
  /** Leaving the email field checks it, so a typo shows before the buyer reaches Pay. */
  const onBlurField = (e: React.FocusEvent<HTMLFormElement>) => {
    const t = e.target as unknown as HTMLInputElement;
    if (t.name === "email" && !emailLocked) {
      const v = t.value.trim();
      setFieldErrors((prev) => {
        const next = { ...prev };
        if (v && !EMAIL_RE.test(v))
          next.email = "Enter a valid email address, for example name@example.com.";
        else delete next.email;
        return next;
      });
    }
    scheduleAutoSave();
  };
  React.useEffect(
    () => () => {
      if (autoTimer.current) clearTimeout(autoTimer.current);
    },
    [],
  );
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    // Change mode renders no email field — the customer is pinned — so `validate` skips it.
    // Every fault shows on the form: its field highlighted, and named in the summary.
    if (!report(form)) {
      const first = form.querySelector<HTMLElement>(":invalid:not(fieldset), [aria-invalid=true]");
      first?.focus();
      return;
    }
    const fd = new FormData(form);
    const email = String(fd.get("email") ?? "").trim();
    const line1 = String(fd.get("line1") ?? "").trim();
    const country = String(fd.get("country") ?? "")
      .trim()
      .toUpperCase();
    const opt = (k: string) => {
      const v = String(fd.get(k) ?? "").trim();
      return v === "" ? undefined : v;
    };
    const addressFrom = (p: string) => {
      const country = opt(`${p}country`)?.toUpperCase();
      return {
        line1: opt(`${p}line1`),
        line2: opt(`${p}line2`),
        line3: opt(`${p}line3`),
        city: opt(`${p}city`),
        state: opt(`${p}state`),
        state_code: opt(`${p}state_code`),
        postal_code: opt(`${p}postal_code`),
        country,
        first_name: opt(`${p}first_name`),
        last_name: opt(`${p}last_name`),
        company: opt(`${p}company`),
        phone: opt(`${p}phone`),
      };
    };
    const shippingAddress = wantsShipping ? addressFrom(shipToBilling ? "" : "ship_") : undefined;
    lastSent.current = JSON.stringify([...fd.entries()]);
    setBusy(true);
    const res = await checkoutSetCustomerAction({
      // Omitted entirely in change mode: an empty string is not a valid email and would be
      // rejected by the schema even though the engine ignores it there.
      ...(emailLocked ? {} : { email }),
      // No `name`: this form does not collect `customers.name` any more. It is our own
      // display fallback, never printed — the name on the
      // invoice is the billing contact below (`src/modules/customers/names.ts`), which
      // this form asked for twice until now.
      address: {
        line1: line1 || undefined,
        line2: opt("line2"),
        line3: opt("line3"),
        city: opt("city"),
        state: opt("state"),
        state_code: opt("state_code"),
        postal_code: opt("postal_code"),
        country: country || undefined,
        first_name: opt("first_name"),
        last_name: opt("last_name"),
        company: opt("company"),
        phone: opt("phone"),
      },
      tax_registration_number: opt("tax_registration_number"),
      ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      if (res.error === NO_SESSION) return void onSessionEnded();
      setProblems([res.error ?? "We could not save your details. Try again."]);
      onValidity?.(false);
      return;
    }
    setProblems(null);
    onValidity?.(true);
    /**
     * The name for the gateway's sheet is the BILLING CONTACT the buyer just typed — the
     * same rule the portal's `accountHolderName` applies, resolved from this form's own
     * fields because there is no customer object on this surface yet. Company is the
     * fallback for a business buyer who filled that instead of a first name (the form
     * accepts either).
     */
    const holder = [opt("first_name"), opt("last_name")].filter(Boolean).join(" ");
    setSavedOnce(true);
    onDone(
      {
        name: holder || opt("company") || null,
        // Change mode renders no email field and the customer is pinned, so there is
        // nothing to forward — `undefined` in, nothing prefilled, which is honest.
        email: emailLocked ? null : email,
        contact: opt("phone") ?? null,
        address: {
          line1: line1 || null,
          city: opt("city") ?? null,
          state: opt("state") ?? null,
          state_code: opt("state_code") ?? null,
          postal_code: opt("postal_code") ?? null,
          country: country || null,
        },
      },
      /**
       * Echo the saved details back so a SECOND visit to this step prefills them. The
       * response body carries only the identity fields, and re-fetching the whole view
       * for something this page just wrote would be a round-trip to learn what it already
       * knows — so the form reports what it sent. `?? null` throughout because the
       * prefill shape is nullable columns, not optional keys.
       */
      {
        ...(emailLocked ? {} : { email }),
        address: {
          line1: line1 || null,
          line2: opt("line2") ?? null,
          line3: opt("line3") ?? null,
          city: opt("city") ?? null,
          state: opt("state") ?? null,
          state_code: opt("state_code") ?? null,
          postal_code: opt("postal_code") ?? null,
          country: country || null,
          first_name: opt("first_name") ?? null,
          last_name: opt("last_name") ?? null,
          company: opt("company") ?? null,
          phone: opt("phone") ?? null,
        },
        tax_registration_number: opt("tax_registration_number") ?? null,
        ...(shipping === "hide"
          ? {}
          : { shipping_address: shippingAddress ? withNulls(shippingAddress) : null }),
      },
    );
  };
  return (
    <StorefrontSection
      title="Your details"
      description="Card networks require a billing name and address."
    >
      <form
        ref={formRef}
        id="checkout-details"
        noValidate
        onSubmit={submit}
        onChange={scheduleAutoSave}
        onInput={scheduleAutoSave}
        onBlurCapture={onBlurField}
        className="flex flex-col gap-3 [&_input:user-invalid]:border-destructive [&_input:user-invalid]:ring-destructive/20"
      >
        {/* Identity is not editable on a change checkout: that session is pinned to the target
            subscription's owner at mint time, and the engine refuses to repoint it from a PUBLIC
            link. Rendering an email box here would be a control that cannot do what it appears
            to — the buyer would type a new address and the engine would ignore it. */}
        {emailLocked ? null : (
          <Field name="email" label="Email" required error={fieldErrors.email}>
            <Input
              name="email"
              type="email"
              defaultValue={customer?.email ?? ""}
              required
              autoComplete="email"
              inputMode="email"
            />
          </Field>
        )}
        {/* Same shared field set + validation as the operator/portal pages, with the
            portal's buyer-only additions: the contact block IS the name field here, so
            first name is required and the heading says where it ends up. */}
        <AddressFields
          countries={countries}
          value={customer?.address ?? null}
          requireContactName
          contactHeading="Your name (printed on your invoices)"
          fieldStates={billingStates}
        />
        {/*
          The buyer's OWN registration number. Shown, hidden or required by the field
          matrix, never gated on country: the column is generic (GSTIN in India, other
          regimes elsewhere), and a field that appears once a country is picked would
          shift the form mid-fill.
        */}
        {taxIdState === "hide" ? (
          // Hidden, not omitted: the save replaces the record, so keep what is stored.
          <input
            type="hidden"
            name="tax_registration_number"
            value={customer?.tax_registration_number ?? ""}
          />
        ) : taxIdState !== "mandatory" && !showTaxId ? (
          <>
            <input type="hidden" name="tax_registration_number" value="" />
            <button
              type="button"
              onClick={() => setShowTaxId(true)}
              className="self-start text-sm text-primary hover:underline"
            >
              + Add a tax ID
            </button>
          </>
        ) : (
          <Field
            name="tax_registration_number"
            label={country === "IN" ? "GSTIN" : "Tax ID"}
            required={taxIdState === "mandatory"}
            error={fieldErrors.tax_registration_number}
            help={
              country === "IN"
                ? "We print it on your invoices, so that you can claim input tax credit."
                : "We print it on your invoices."
            }
          >
            <Input
              name="tax_registration_number"
              defaultValue={customer?.tax_registration_number ?? ""}
              required={taxIdState === "mandatory"}
              maxLength={50}
              autoComplete="off"
              className="max-w-72"
            />
          </Field>
        )}
        {shipping === "hide" ? null : (
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Shipping address</h3>
            {shipping === "show" ? (
              <CheckboxField
                checked={addShipping}
                onCheckedChange={setAddShipping}
                label="Add a shipping address"
                hint="Optional."
              />
            ) : null}
            {wantsShipping ? (
              <CheckboxField
                checked={shipToBilling}
                onCheckedChange={setShipToBilling}
                label="Ship to my billing address"
              />
            ) : null}
            {wantsShipping && !shipToBilling ? (
              <AddressFields
                countries={countries}
                value={savedShip}
                prefix="ship_"
                contactHeading="Recipient"
                autoCompleteSection="shipping"
                fieldStates={SHIP_FIELD_STATES}
              />
            ) : null}
          </section>
        )}
        {/* Change mode asks on the confirm step, which every change passes through. */}
        {isChange ? null : <PoNumberInput />}
        {problems ? (
          <Alert tone="error" title="Correct the highlighted fields.">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {/* One page: details save themselves once valid; a status line replaces the button.
              The hidden submit keeps Enter working, which checks the form. */}
          {autoSave ? (
            <>
              <button type="submit" className="sr-only" tabIndex={-1} aria-hidden>
                Save
              </button>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {busy
                  ? "Saving…"
                  : problems
                    ? ""
                    : savedOnce
                      ? "Details saved."
                      : "We save your details when they are complete."}
              </span>
            </>
          ) : (
            <Button type="submit" disabled={busy}>
              {/* Reached by an explicit edit, the forward word is wrong: the buyer came from the
                  confirm or card step and is going back there, not onward to payment. */}
              {busy ? "Saving…" : onCancel ? "Save and return" : "Continue to payment"}
            </Button>
          )}
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="text-xs text-primary hover:underline"
            >
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </StorefrontSection>
  );
}

function CardStep({
  scope,
  businessName,
  brandColor,
  isChange,
  purchase,
  commit,
  blocked = false,
  moneyDueToday,
  currency,
  reactivateLabel: reactivateCta,
  preferNew,
  prefill,
  onBack,
  onDone,
  onEditDetails,
  onSessionEnded,
}: {
  /** What the committing button says, and the line under it. */
  commit: CommitCopy;
  /** One page: the details above are not valid, so nothing can be committed yet. */
  blocked?: boolean;
  /** Money is taken today (names the method chooser). */
  moneyDueToday: boolean;
  /** The currency the buyer pays in: rails that cannot move it are not offered. */
  currency: string | null;
  /** Non-secret per-session key for the redirect-leg stash. */
  scope: string;
  businessName: string;
  /** The merchant's brand hex, for the Elements iframe — see `stripeAppearance`. */
  brandColor: string | null;
  isChange: boolean;
  /** A one-time purchase: the method is saved, then charged once. */
  purchase?: boolean;
  /** Set on a reactivation: the confirm label, which also switches the copy. */
  reactivateLabel?: string;
  /**
   * What the buyer typed on the details step, for the gateway's own sheet. Absent in
   * change mode (the customer is pinned server-side and never reaches this page), which
   * is the same "say nothing rather than guess" rule the rest of this surface follows.
   */
  prefill?: BuyerPrefill;
  /**
   * Start on "add a new one" rather than on a saved card. Set when the buyer is here
   * BECAUSE the instrument on file cannot carry the change — preselecting that same card
   * would offer them the one thing already known not to work.
   */
  preferNew?: boolean;
  /** Present when this step was reached by a side door (from Review) that must swing back. */
  onBack?: () => void;
  onDone: (outcome: CompletionOutcome) => void;
  /**
   * Back to the buyer's own billing details — the way out of a gateway error that needs
   * them. Only where the details are not already on screen (a plan change).
   */
  onEditDetails?: () => void;
  /** Raised when the engine says the session is gone — terminal, so the parent takes over. */
  onSessionEnded: () => void;
}) {
  const [setup, setSetup] = React.useState<CheckoutVaultSetup | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  /**
   * The buyer's payment options — ported from the portal's add-card step (0186).
   *
   * This surface used to render one "Add card" button and send no `method_type`, so the
   * API's `['card']` default decided the rail. A buyer arriving through a hosted checkout
   * therefore could not choose UPI Autopay or a netbanking e-mandate — the two rails most
   * Indian buyers want, and the only ones that collect unattended above the RBI ceiling.
   * They had to sign up on a card and then change it from the portal afterwards.
   */
  const [gateways, setGateways] = React.useState<CheckoutGateway[] | null>(null);
  const [selectedGateway, setSelectedGateway] = React.useState("");
  const [methodType, setMethodType] = React.useState<MethodType>("card");
  const [expectedDebitMinor, setExpectedDebitMinor] = React.useState(0);
  const [unattendedLimitMinor, setUnattendedLimitMinor] = React.useState<number | null>(null);
  const [debitCurrency, setDebitCurrency] = React.useState("INR");
  /**
   * The ceiling this session's mandate will be registered with, and the rails that cannot
   * carry it — sized server-side from the session's own items.
   *
   * Fetched HERE rather than read off `view.change.mandate`, and that is the point: the
   * view is server-rendered on page load, when a create-mode session has no customer yet
   * (the details step has not been submitted), so a signup buyer would always have seen
   * null. This endpoint is called by this step, after the customer exists, in both modes.
   */
  const [requiredCeilingMinor, setRequiredCeilingMinor] = React.useState<number | null>(null);
  const [railsOverCap, setRailsOverCap] = React.useState<string[]>([]);
  /**
   * What the buyer already holds. The step offered exactly two doors before — confirm on
   * whatever the engine picks, or add a NEW card — so someone with two cards, one of which
   * suits the new plan, could only get there by adding a third.
   */
  const [saved, setSaved] = React.useState<CheckoutPaymentMethod[] | null>(null);
  /** A `pm_…` the buyer picked, or `new` for "add one". */
  const [chosen, setChosen] = React.useState<string>("new");
  /**
   * A netbanking e-mandate the buyer is authorising in ANOTHER TAB.
   *
   * RazorPay's `subscription_registration/auth_links` **ignores `callback_url`** — measured
   * three times, 2026-08-14, fields verified present in `gateway_request_logs`. The buyer
   * finishes on RazorPay's own "MANDATE REGISTRATION COMPLETED" screen and is never sent
   * anywhere. Navigating this tab to that link therefore threw the checkout away: the
   * mandate registered, the webhook vaulted the instrument, and `/checkout/v1/complete` was
   * never posted — so the buyer authorised an auto-debit and got no subscription, and the
   * session sat open until it expired.
   *
   * So this rail opens in a new tab and this one stays put, holding the intent that
   * completion needs. Kept in state rather than the sessionStorage stash because we are no
   * longer leaving: the stash exists for a tab that gets replaced.
   */
  const [awaitingMandate, setAwaitingMandate] = React.useState<{
    intent?: string;
    token: string;
    url: string;
  } | null>(null);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const res = await checkoutPaymentMethodsAction();
      if (!live) return;
      // A failure here is not fatal: the add-a-method half of this step still works, which
      // is what it did before saved methods were offered at all.
      const methods = res.ok ? res.methods : [];
      setSaved(methods);
      // Preselect what they would most likely want: their primary card — unless they are
      // here precisely because the card on file cannot carry the change.
      if (!preferNew && methods.length > 0) {
        setChosen(methods.find((m) => m.is_default)?.id ?? methods[0]!.id);
      }
    })();
    return () => {
      live = false;
    };
  }, [preferNew]);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      const res = await checkoutGatewaysAction();
      if (!live) return;
      if (!res.ok) {
        // Not a toast: the button below is still usable — omitting `gateway_account`
        // falls back to the business default, which is exactly what this step did
        // before the picker existed. Degrading to that beats blocking the sale.
        setGateways([]);
        return;
      }
      setGateways(res.gateways.data);
      setExpectedDebitMinor(res.gateways.expected_debit_minor);
      setUnattendedLimitMinor(res.gateways.unattended_debit_limit_minor);
      setRequiredCeilingMinor(res.gateways.required_mandate_ceiling_minor);
      setRailsOverCap(res.gateways.rails_over_cap);
      // The engine names the currency now. It used to be inferred from the AFA limit being
      // non-null, which was INR only by coincidence of that rule being an RBI one.
      if (res.gateways.debit_currency) setDebitCurrency(res.gateways.debit_currency);
      else if (res.gateways.unattended_debit_limit_minor != null) setDebitCurrency("INR");
      // Preselect rather than making the buyer choose when there is nothing to choose.
      if (res.gateways.data.length > 0) setSelectedGateway(res.gateways.data[0]!.id);
    })();
    return () => {
      live = false;
    };
  }, []);

  const activeGateway = gateways?.find((g) => g.id === selectedGateway);
  const isRazorpay = activeGateway?.gateway_key === "razorpay";
  // Gateways whose setup registers a mandate with a per-charge ceiling.
  const registersMandate = isRazorpay || activeGateway?.gateway_key === "payu";
  /**
   * What this gateway actually supports, straight from the engine. The portal hardcodes a
   * `['card','upi','bank_transfer']` fallback because its own endpoint drops
   * `method_types`; ours returns it, so the options offered are the real ones — and a
   * gateway that narrows its list cannot have a dead radio rendered for it.
   */
  const allowedMethods = railsForCurrency(
    activeGateway?.method_types && activeGateway.method_types.length > 0
      ? activeGateway.method_types
      : // `card` alone, not the Indian set: the server resolves the real list
        // (`effectiveMethodTypes`), so a fallback that invents UPI for a Stripe buyer is a
        // guess we no longer have any reason to make.
        ["card"],
    // A rail that cannot move this currency (UPI for a buyer paying in dollars) is not offered.
    currency,
  );

  /**
   * The gateway picker names what each gateway accepts here ("Card", "Card, UPI or …"),
   * never the provider. Two gateways that accept the same methods are one choice for the
   * buyer: we keep the first (the business's order) and route through it.
   */
  const gatewayChoices: Array<{ id: string; label: string }> = [];
  for (const g of gateways ?? []) {
    const rails = railsForCurrency(
      g.method_types && g.method_types.length > 0 ? g.method_types : ["card"],
      currency,
    ).map(paymentMethodTypeLabel);
    const label =
      rails.length <= 1
        ? (rails[0] ?? "Card")
        : `${rails.slice(0, -1).join(", ")} or ${rails[rails.length - 1]}`;
    if (!gatewayChoices.some((c) => c.label === label)) gatewayChoices.push({ id: g.id, label });
  }

  // Above the ceiling a card/UPI mandate needs the payer's approval on EVERY debit,
  // while a netbanking e-mandate authenticates once here and then runs unattended.
  // Advice, never a block — all three work, and the choice is the buyer's.
  // `expectedDebitMinor` is this SESSION's debit now (see the endpoint's own note), so a
  // signup finally gets the advice and a change gets it about the plan being moved TO.
  const needsAuthPerDebit =
    unattendedLimitMinor != null && expectedDebitMinor > unattendedLimitMinor;
  /**
   * A rail that cannot be REGISTERED this high at all — NPCI caps a UPI Autopay mandate at
   * ₹1,00,000, and asking for more is refused at the order, so the adapter clamps it and
   * every renewal above the clamp is then declined. Distinct from `needsAuthPerDebit`,
   * which is about a rail that works but stops to ask.
   *
   * Steering, not blocking: the rail still collects smaller debits perfectly well, and the
   * choice stays the buyer's.
   */
  /**
   * DERIVED, never the raw state: switching gateway would otherwise leave a rail selected
   * that the new one cannot do — pick SEPA on Stripe, switch to RazorPay, and the state
   * still says `sepa_debit` while the chooser shows nothing selected. This keeps the value
   * rendered and the value submitted as one thing.
   */
  const activeMethodType = (
    allowedMethods.includes(methodType) ? methodType : (allowedMethods[0] ?? "card")
  ) as MethodType;
  useReportInstrument(activeMethodType);
  const railForMethod = activeMethodType === "bank_transfer" ? "emandate" : activeMethodType;
  /** Our bank debit authorization, when this gateway leaves it to us and a bank account is picked. */
  const achText =
    activeMethodType === "us_bank_account" ? (activeGateway?.ach_authorization ?? null) : null;
  const [achAccepted, setAchAccepted] = React.useState(false);
  const methodOverCap = railsOverCap.includes(railForMethod);
  /** "a card" only when a card is what the buyer adds. */
  const instrumentNoun = activeMethodType === "card" ? "a card" : "a payment method";
  /**
   * The ceiling the mandate really registers: the gateway may cap this rail lower than the
   * sized ceiling (PayU UPI: ₹15,000), and the setup route asks for the lower of the two.
   */
  const railCap = activeGateway?.mandate_ceiling_cap_minor?.[activeMethodType];
  const shownCeilingMinor =
    requiredCeilingMinor != null && railCap != null
      ? Math.min(requiredCeilingMinor, railCap)
      : requiredCeilingMinor;

  // RazorPay card + UPI: the mandate is authorized in their embedded modal, and what
  // comes back is a payment id the server resolves to the mandate token. The netbanking
  // e-mandate is a hosted auth link instead, and leaves by the redirect branch below.
  /**
   * Every completion this step makes goes through the challenge machine: the first charge
   * is the one the buyer's issuer is most likely to want 3DS for, and until now a 402
   * there was a red toast on a step with nowhere left to go.
   */
  const challenge = usePaymentChallenge({
    scope,
    businessName,
    brandColor,
    isChange,
    reactivate: reactivateCta != null,
    purchase,
    ...(prefill ? { prefill } : {}),
    showsRefusal: true,
    onSessionEnded,
    onCompleted: onDone,
  });
  /** The committing action, with its amount ("Subscribe and pay $252.04", "Start free trial"). */
  const cta = commit.label;
  const busyCta = commit.busy;
  /** A decline on a step that also charges is a payment that failed, not a save. */
  const failLead = moneyDueToday
    ? "We could not take your payment."
    : "We could not save your payment method.";

  const runEmbeddedCheckout = async (
    descriptor: RazorpayCheckoutDescriptor,
    paymentIntent?: string,
  ) => {
    const result = await openRazorpayCheckout(descriptor, {
      businessName,
      description: vaultSetupDescription(descriptor.method),
      ...(prefill ? { prefill } : {}),
    });
    if (result.status === "dismissed") {
      clearPendingVaultSetup(scope);
      return;
    }
    /**
     * A refusal is NOT the end of the setup, and the stash must survive it.
     *
     * RazorPay keeps its sheet open on a failure so the buyer can try again, and their
     * next attempt may well succeed — server-side, through the very setup intent this
     * stash names (`harvestSetupIntent`). Clearing here is what left the recovery leg with
     * nothing to complete through, so a card the gateway had just approved could only be
     * reported as "please try again". Cleared on a dismissal (they left) and on success
     * (it is spent); a failure keeps it, exactly as the redirect return leg does.
     */
    if (result.status === "failed")
      return void challenge.showRefusal(
        refusalMessage(failLead, result.message, "Try again, or use a different payment method."),
      );
    // A setup always names its payment; "unconfirmed" is only for a charge.
    if (result.status !== "authorized") return;
    setSaving(true);
    // The setup intent, not the payment id — see the return-leg note above.
    await complete(result.paymentId, paymentIntent, result.clientResult);
    clearPendingVaultSetup(scope);
    setSaving(false);
  };

  /** `runEmbeddedCheckout`'s stash rules, for a gateway's own browser client. */
  const runGatewaySdk = async (sdk: GatewaySdkDescriptor, paymentIntent?: string) => {
    const result = await openGatewaySdk(sdk, {
      businessName,
      purpose: "setup",
      // The gateway's commit says what this page says ("Subscribe and pay $X").
      confirmLabel: cta,
      ...(prefill ? { prefill } : {}),
    });
    if (result.status === "dismissed") {
      clearPendingVaultSetup(scope);
      return;
    }
    // Beside Pay and kept there: the gateway's sheet is closed, and a toast goes by itself.
    if (result.status === "failed")
      return void challenge.showRefusal(
        refusalMessage(failLead, result.message, "Try again, or use a different payment method."),
      );
    setSaving(true);
    await complete(undefined, paymentIntent, result.clientResult);
    clearPendingVaultSetup(scope);
    setSaving(false);
  };

  /** Finish a setup authorized on our own page, through the intent when there is one. */
  const complete = async (
    providerToken: string | undefined,
    paymentIntent?: string,
    clientResult?: Record<string, string>,
  ) =>
    challenge.run(
      {
        ...(paymentIntent ? { setupIntent: paymentIntent } : {}),
        ...(providerToken ? { providerToken } : {}),
        ...(clientResult ? { clientResult } : {}),
        ...(achText && achAccepted ? { achAuthorizationVersion: achText.version } : {}),
      },
      // The gateway the buyer picked. Masked whenever an intent is present (the intent
      // names its own gateway), so its absence only bit a provider with no setup intent —
      // where it is a silent vault failure, the one the portal's comment warns about.
      selectedGateway || undefined,
    );

  /**
   * Complete on an instrument the buyer ALREADY holds — the "Manage cards" pick.
   *
   * Nothing is vaulted and no gateway is called: the engine is told which existing
   * `pm_…` to use, validates it against the session's pinned customer, and points the
   * subscription at it before billing. The mandate on THAT instrument is what the charge
   * is then checked against, which is the whole point of offering the choice.
   *
   * No `gateway_account`: nothing is being vaulted here, so naming one would only say
   * where to exchange a token there isn't.
   */
  const useSaved = async () => {
    if (consentBlocked()) return;
    if (chosen === "new") return;
    setSaving(true);
    try {
      await challenge.run({ paymentMethod: chosen });
    } finally {
      setSaving(false);
    }
  };

  const consentState = React.useContext(ConsentContext);
  /** A missing required box stops the payment before any gateway step opens. */
  const consentBlocked = () => {
    const refusal = consentRefusal(consentState, consentState.current());
    if (refusal) consentState.flag();
    return refusal !== null;
  };
  const begin = async () => {
    if (consentBlocked()) return;
    /**
     * Opened SYNCHRONOUSLY, inside the click, and only for the rail that needs it: a
     * popup blocker judges by the user gesture, and the gesture is gone by the time the
     * server action resolves. Blank now, pointed at the approval URL below.
     */
    const strandedRail = isRazorpay && activeMethodType === "bank_transfer";
    const authTab = strandedRail ? window.open("", "_blank") : null;
    challenge.showRefusal(null);
    setStarting(true);
    const res = await checkoutBeginSetupAction(
      window.location.origin,
      selectedGateway || undefined,
      /**
       * The buyer's pick, for EVERY gateway. `isRazorpay ? … : undefined` was the second
       * half of the same bug as the hidden chooser: even with the control rendered, a
       * Stripe buyer's choice was dropped on the way to the server and the setup fell back
       * to `card`. A control whose value is discarded is worse than a missing one.
       */
      activeMethodType,
      consentPost(consentState),
    );
    setStarting(false);
    if (!res.ok) {
      authTab?.close();
      // Often the gateway's own refusal (a phone number it will not take): kept beside Pay.
      return void challenge.showRefusal(res.error);
    }
    setActiveIntent(res.setup.payment_intent);
    /**
     * The rail RazorPay never returns from: hold THIS tab and put the authorization
     * somewhere else. The panel below always renders the link as an anchor, so a blocked
     * popup is a non-event — a buyer-initiated `target=_blank` anchor cannot be blocked,
     * while `window.open` can be, and falling back to navigating this tab would recreate
     * exactly the dead end this fixes.
     */
    if (strandedRail && res.setup.mode === "redirect" && res.setup.approval_url) {
      setAwaitingMandate({
        token: res.setup.setup_token,
        url: res.setup.approval_url,
        ...(res.setup.payment_intent ? { intent: res.setup.payment_intent } : {}),
      });
      if (authTab) authTab.location.href = res.setup.approval_url;
      return;
    }
    if (res.setup.mode === "redirect" && res.setup.approval_url) {
      // Leaving the site for the provider's approval page — stash what the return
      // leg (the effect in CheckoutFlow) needs to exchange the approved token. The
      // GATEWAY included: completion must vault on the same account the setup ran on,
      // and the portal's stash has always carried it.
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selectedGateway ? { gateway: selectedGateway } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      window.location.href = res.setup.approval_url;
      return;
    }
    if (
      res.setup.mode === "form_post" &&
      res.setup.form_post &&
      formPostTargetIsSafe(res.setup.form_post.action)
    ) {
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selectedGateway ? { gateway: selectedGateway } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      submitFormPost(res.setup.form_post);
      return;
    }
    if (res.setup.mode === "checkout" && res.setup.checkout) {
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selectedGateway ? { gateway: selectedGateway } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      await runEmbeddedCheckout(res.setup.checkout, res.setup.payment_intent);
      return;
    }
    if (res.setup.mode === "sdk" && res.setup.sdk) {
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selectedGateway ? { gateway: selectedGateway } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      await runGatewaySdk(res.setup.sdk, res.setup.payment_intent);
      return;
    }
    setSetup(res.setup);
  };

  const stripeSetup =
    setup?.mode === "client_secret" &&
    setup.provider === "stripe" &&
    setup.client_secret &&
    setup.publishable_key
      ? setup
      : null;

  /**
   * The buyer is authorising a netbanking e-mandate in another tab and has to come back
   * here to finish, because RazorPay will not send them (see `awaitingMandate`).
   *
   * A button rather than a poll, deliberately. Completion posts through the setup INTENT,
   * whose atomic claim already makes the buyer and the gateway's webhook harvest contend
   * for one instrument — so pressing this after the webhook has landed is a no-op on the
   * vault and simply finishes the checkout. Polling the same route would need a fresh
   * Idempotency-Key per attempt and would log a 4xx every few seconds for the entire time
   * a bank takes, which on this rail can be until the next working day.
   */
  const finishMandate = async () => {
    if (!awaitingMandate) return;
    setSaving(true);
    try {
      await challenge.run(
        awaitingMandate.intent
          ? { setupIntent: awaitingMandate.intent }
          : { providerToken: awaitingMandate.token },
        selectedGateway || undefined,
      );
    } finally {
      setSaving(false);
    }
  };

  /* Checked FIRST: a challenge is the newer thing asked of the buyer — "I've authorised —
     continue" can itself come back needing authentication — and two panels claiming the
     same step would leave them answering the older one. */
  if (challenge.panel) {
    return <StorefrontSection title="Payment">{challenge.panel}</StorefrontSection>;
  }

  if (awaitingMandate) {
    return (
      <StorefrontSection title="Payment">
        <div className="flex flex-col gap-3">
          <Alert tone="info" title="Authorize the auto-debit with your bank">
            <p>
              Your bank&apos;s authorization page opens in a new tab. Approve it there. Then return
              to this tab and continue. Your bank does not return you to this page automatically.
            </p>
            <p className="mt-2">
              Some banks confirm a netbanking e-mandate on the next working day. If you cannot
              continue yet, your authorization stays valid. We receive it when your bank confirms
              it.
            </p>
          </Alert>
          {/* An anchor, not a scripted redirect. This tab must survive — it holds the setup
              intent the checkout completes through — and a buyer-initiated `target=_blank`
              is the one way to open a page that no popup blocker can veto. */}
          <a
            href={awaitingMandate.url}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start text-sm font-medium text-primary hover:underline"
          >
            Open your bank&apos;s authorization page
          </a>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={finishMandate} disabled={saving || challenge.busy}>
              {saving || challenge.busy ? "Checking…" : "Continue after authorization"}
            </Button>
            <Button
              variant="outline"
              onClick={() => setAwaitingMandate(null)}
              disabled={saving || challenge.busy}
            >
              Use a different method
            </Button>
          </div>
        </div>
      </StorefrontSection>
    );
  }

  /**
   * The provider + rail choosers that belong to "Add a new payment method" — pulled out
   * so the SAME markup can render in two different places depending on whether there is a
   * saved-methods list above it: nested inside that radio option's own card while it is
   * selected (mirroring `method-choice.tsx`'s own notice-inside-the-selected-card pattern,
   * so the dependency reads as "these belong to the row above them" rather than as two more
   * page-level choices), or standalone when this step IS the add-a-method step (every
   * signup, nothing saved yet — there is no group above it to nest under).
   */
  const addNewMethodFields = (
    <>
      {/* More than one gateway is a real choice, so it gets a picker. Exactly one is
      not — a single-option radio group is a control that cannot do anything, so
      it is omitted and the id still rides along on `begin`. (The portal renders
      the list unconditionally; this is a deliberate departure.) */}
      {gatewayChoices.length > 1 ? (
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">Pay with</div>
          {/* Methods, never the provider: which gateway carries the payment is our routing. */}
          <RadioGroup
            value={selectedGateway}
            onValueChange={setSelectedGateway}
            aria-label="Pay with"
            className="flex flex-col gap-2"
          >
            {gatewayChoices.map((g) => (
              <div
                key={g.id}
                /* The whole row selects, same as the rail chooser below it — see the note
                   in `method-choice.tsx`. Without it only the 16px radio and the label
                   text worked, on a box drawn to look like a button. */
                onClick={() => setSelectedGateway(g.id)}
                className={cn(
                  "cursor-pointer rounded-md border px-3.5 py-3 transition-colors",
                  selectedGateway === g.id
                    ? /* Lighter than a top-level selection ring on purpose: when this
                         renders nested inside "Add a new payment method" it is a
                         sub-choice, not a sibling of it, and the full-strength ring
                         used above is exactly what made the step read as three
                         competing selections in the first place. */
                      "border-primary/70 ring-1 ring-primary/30"
                    : "hover:bg-muted/50",
                )}
              >
                <RadioOption
                  value={g.id}
                  label={<span className="wrap-break-word">{g.label}</span>}
                />
              </div>
            ))}
          </RadioGroup>
        </div>
      ) : null}

      {/* Offered whenever the gateway has more than one rail. This was `isRazorpay`, which
          computed the correct list two hundred lines above — from the engine's own
          `method_types`, with a comment about not rendering a dead radio — and then
          withheld it from every Stripe buyer, so ACH and SEPA were unreachable at
          checkout despite the engine doing both end to end. One option is not a choice,
          so a single-rail gateway still renders nothing. */}
      {allowedMethods.length > 1 ? (
        <MethodTypeChoice
          value={activeMethodType}
          onValueChange={setMethodType}
          allowed={allowedMethods}
          /* Buyer language. "Select mandate type for Razorpay" named our provider and a
         piece of NPCI vocabulary in one line; what the payer is choosing is where
         the money comes from. */
          heading={moneyDueToday ? "Payment method" : "Payment method for future payments"}
          currency={currency}
          /* Null, not an empty fragment: the chooser renders the notice slot when it is
         truthy, and a fragment with nothing in it is still truthy — an empty gap
         under the selected rail. */
          notice={
            (needsAuthPerDebit && activeMethodType !== "bank_transfer") ||
            (methodOverCap && requiredCeilingMinor != null) ? (
              <>
                {needsAuthPerDebit && activeMethodType !== "bank_transfer" ? (
                  /* Same warning as the portal's, one word apart: `expectedDebitMinor` is
               THIS SESSION's debit here (see the endpoint's note) and the customer's
               largest recurring debit there, so this says "this plan" where the
               portal says "your renewal". */
                  <Alert tone="warning" title="You must approve every payment.">
                    Banks can auto-debit{" "}
                    {activeMethodType === "upi" ? "a UPI Autopay mandate" : "a card"} only up to{" "}
                    {money(unattendedLimitMinor!, debitCurrency)}. This plan is{" "}
                    {money(expectedDebitMinor, debitCurrency)} per payment, so you must approve each
                    payment.
                    {/* ONLY WHEN THAT RAIL IS ACTUALLY ON THIS PAGE. The sentence was
                        unconditional, so on a gateway offering only Card and UPI the buyer
                        was told the way out was "here" — naming a choice they cannot make
                        and promising it is on screen. Measured on a RazorPay account with
                        `method_types` = card + upi (2026-09-15). This is CLAUDE.md's
                        copy-UI rule inverted: not a control that does nothing, but one
                        that does not exist. */}
                    {allowedMethods.includes("bank_transfer")
                      ? " If you use Netbanking e-Mandate, you approve it once on this page. After that, payments are automatic."
                      : ""}
                  </Alert>
                ) : null}
                {/* The rail cannot be authorised for what this plan costs — a different
              failure from the one above, and the only one where the rail is the
              wrong choice rather than an inconvenient one. */}
                {methodOverCap && requiredCeilingMinor != null ? (
                  <Alert tone="warning" className="mt-2">
                    {activeMethodType === "upi" ? "UPI Autopay" : "This method"} has a bank limit
                    below {money(requiredCeilingMinor, debitCurrency)} per charge. Your bank would
                    decline payments for this plan.{" "}
                    {allowedMethods.includes("bank_transfer")
                      ? "Select Netbanking e-Mandate or a card."
                      : allowedMethods.includes("card")
                        ? "Select a card."
                        : "Select a different payment method."}
                  </Alert>
                ) : null}
              </>
            ) : null
          }
        />
      ) : null}

      {/* The same commit bar the portal's add-a-method block ends on — see
          `CommitBar`. This step used to end on a bare left-aligned button, so the
          identical choice looked like two different products depending on whether
          the buyer reached it through the checkout or through their portal. */}
      {achText ? (
        <AchAuthorization text={achText} accepted={achAccepted} onAcceptedChange={setAchAccepted} />
      ) : null}

      {/* The gateway collects the card in its own form, and its button commits ("Subscribe
          and pay …"). This one opens that form, and says so. */}
      {blocked ? <DetailsBlockedNote /> : null}
      <CommitArea summary={commit.summary}>
        <Button
          onClick={begin}
          disabled={
            blocked || starting || saving || challenge.busy || (achText != null && !achAccepted)
          }
          className="w-full"
          size="lg"
        >
          <BusyLabel busy={starting || saving}>
            {starting
              ? "Starting…"
              : saving
                ? "Saving…"
                : activeGateway?.gateway_key === "paypal" || activeMethodType === "paypal"
                  ? "Continue with PayPal"
                  : activeMethodType === "venmo"
                    ? "Continue with Venmo"
                    : activeGateway?.gateway_key === "gocardless"
                      ? "Set up Direct Debit"
                      : activeGateway?.gateway_key === "mollie"
                        ? "Continue to Mollie"
                        : activeMethodType === "upi"
                          ? "Authorize UPI Autopay"
                          : isRazorpay && activeMethodType === "bank_transfer"
                            ? "Authorize Netbanking e-Mandate"
                            : achText
                              ? "Enter bank account details"
                              : activeMethodType === "card"
                                ? "Enter card details"
                                : "Continue"}
          </BusyLabel>
        </Button>
      </CommitArea>
    </>
  );

  return (
    <StorefrontSection title="Payment">
      {/* The summary above stays on screen: a buyer typing a card number is entitled
          to see what they are about to be charged for, and this is the same overlay
          RazorPay puts up for a mandate. */}
      <div id="checkout-payment" className="flex flex-col gap-3">
        {/* With saved methods listed below, the buyer selects one or adds another. */}
        <p className="text-sm text-muted-foreground">
          {saved && saved.length > 0
            ? purchase
              ? "Select a payment method, or add a new one. We save a new payment method for your next purchases."
              : "Select a payment method, or add a new one."
            : purchase
              ? "Add a payment method. We save it for your next purchases."
              : reactivateCta
                ? `Add ${instrumentNoun} to reactivate your subscription.`
                : isChange
                  ? `Add ${instrumentNoun} to complete your plan change.`
                  : commit.label === "Start free trial"
                    ? `Add ${instrumentNoun} to start your free trial. We charge it when the trial ends.`
                    : `Add ${instrumentNoun} to activate your subscription.`}
        </p>
        <ConsentBoxes />
        {/* The ceiling the buyer is about to authorise, said BEFORE the provider's own modal
            says it. RazorPay states "up to ₹X" inside its sheet, and a number the buyer meets
            there for the first time reads like a surprise; met here, beside the plan it was
            derived from, it reads like the plan.
            ⚠️ Gated on the GATEWAY, not just on the sizing: only RazorPay and PayU register a
            mandate here, and telling a Stripe cardholder they are "approving automatic payments of up
            to $X" would describe an authorisation that does not exist on their card. The
            engine sizes a ceiling for every session because the setup route needs one; whether
            a MANDATE is involved is the rail's answer, not the amount's. */}
        {shownCeilingMinor != null && registersMandate ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            You will approve automatic payments of up to {money(shownCeilingMinor, debitCurrency)}{" "}
            per charge
            {expectedDebitMinor > 0
              ? `. This covers the ${money(expectedDebitMinor, debitCurrency)} payments for this plan and small increases to them`
              : ""}
            .
          </p>
        ) : null}
        {/* WHAT THEY ALREADY HAVE, before being asked for anything new. Each row states its
            own auto-debit limit, and a limit that cannot carry this plan is marked — which is
            the fact that makes this list worth showing: a buyer whose card A is capped below
            the new plan can see at a glance that card B is not. */}
        {saved && saved.length > 0 ? (
          <div className="flex flex-col gap-2">
            {/* Covers both kinds of row now: the saved instruments AND "Add a new payment
                method", which is not one of them — the old heading named only the former
                while the group contained both. */}
            <div className="text-sm font-medium">Pay with</div>
            <RadioGroup
              value={chosen}
              onValueChange={setChosen}
              aria-label="Pay with"
              className="flex flex-col gap-2"
            >
              {saved.map((m) => {
                const ceiling = m.mandate?.max_amount_minor ?? null;
                const cur = m.mandate?.currency ?? debitCurrency;
                // Same rule as the engine's: a null ceiling is UNKNOWN, not unlimited, and a
                // ceiling in another currency cannot be compared to this debit.
                const tooSmall =
                  ceiling != null &&
                  expectedDebitMinor > 0 &&
                  (!m.mandate?.currency || m.mandate.currency === debitCurrency) &&
                  expectedDebitMinor > ceiling;
                return (
                  <div
                    key={m.id}
                    className={cn(
                      "rounded-md border px-3.5 py-3 transition-colors",
                      chosen === m.id ? "border-primary ring-1 ring-primary" : "hover:bg-muted/50",
                    )}
                  >
                    <RadioOption
                      value={m.id}
                      /* The same mark the portal's saved rows wear, for the same reason:
                         at the moment of paying, a buyer picks their card by its logo. */
                      icon={(() => {
                        const mark = paymentMarkKey({
                          brand: m.brand,
                          type: m.type,
                          mandateRail: m.mandate?.rail,
                        });
                        return mark ? (
                          <Glyph className="bg-card">
                            <PaymentMark mark={mark} />
                          </Glyph>
                        ) : undefined;
                      })()}
                      label={
                        <span className="wrap-break-word">
                          {instrumentLabel({
                            type: m.type,
                            brand: m.brand,
                            last4: m.last4,
                            mandateRail: m.mandate?.rail,
                          })}
                          {/* Same word as the portal chip and the operator dashboard. */}
                          {m.is_default ? (
                            <span className="whitespace-nowrap text-muted-foreground">
                              {" "}
                              · primary
                            </span>
                          ) : null}
                        </span>
                      }
                      hint={
                        ceiling != null ? (
                          <span className={cn("tabular-nums", tooSmall && "text-warning")}>
                            {tooSmall
                              ? `Auto-debit limit ${money(ceiling, cur)}. Too low for this plan`
                              : `Auto-debit up to ${money(ceiling, cur)} per charge`}
                          </span>
                        ) : m.exp_month && m.exp_year ? (
                          <span className="tabular-nums">
                            Expires {String(m.exp_month).padStart(2, "0")}/{m.exp_year}
                          </span>
                        ) : undefined
                      }
                    />
                  </div>
                );
              })}
              <div
                className={cn(
                  "rounded-md border px-3.5 py-3 transition-colors",
                  chosen === "new" ? "border-primary ring-1 ring-primary" : "hover:bg-muted/50",
                )}
              >
                <RadioOption value="new" label="Add a new payment method" />
                {/* The provider + rail choosers belong to THIS option, not to the group it
                    sits in — nested here, the same way `method-choice.tsx` renders its own
                    notice inside the selected card, so the dependency is visible instead of
                    reading as two more page-level selections stacked under this one. */}
                {chosen === "new" ? (
                  <div className="mt-3 flex flex-col gap-4">{addNewMethodFields}</div>
                ) : null}
              </div>
            </RadioGroup>
            {chosen !== "new" ? (
              /* The same commit bar the add-a-new-method half ends on, so the step does not
                 change shape when the buyer switches between a saved card and a new one. */
              <>
                {blocked ? <DetailsBlockedNote /> : null}
                <CommitArea summary={commit.summary}>
                  {/* `challenge.busy` too: leg 2 of an authentication runs after `useSaved`
                      has already returned, so the button must stay held until it settles. */}
                  <Button
                    onClick={useSaved}
                    disabled={blocked || saving || challenge.busy}
                    className="w-full"
                    size="lg"
                  >
                    <BusyLabel busy={saving || challenge.busy}>
                      {saving || challenge.busy ? busyCta : cta}
                    </BusyLabel>
                  </Button>
                </CommitArea>
              </>
            ) : null}
          </div>
        ) : null}

        {/* Both secondary ways OUT of this step, kept together at the bottom. `order-last`
            pins them below whatever the step grows above them. */}
        {onBack || onEditDetails ? (
          <div className="order-last flex flex-wrap items-center gap-4">
            {/* Present only when this step was reached from Review — which is exactly when
                replacing that section with no return path stranded the buyer. */}
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="text-sm text-primary hover:underline"
              >
                Back to review
              </button>
            ) : null}
            {/* The gateway error that needs a phone number is raised HERE, when the vault
                setup starts, so a plan change (no details on screen) needs a way to them. */}
            {onEditDetails ? (
              <button
                type="button"
                onClick={onEditDetails}
                className="text-sm text-primary hover:underline"
              >
                Edit billing details
              </button>
            ) : null}
          </div>
        ) : null}
        {/* Standalone placement: this step IS the add-a-method step (every signup, nothing
            saved yet), so there is no "Pay with" group above to nest under. When there IS a
            saved-methods list, these same fields render nested inside its "Add a new payment
            method" row instead (above) — never both, `chosen === "new"` decides which. */}
        {!(saved && saved.length > 0) ? addNewMethodFields : null}
      </div>
      <PaymentDialog
        open={setup != null}
        onClose={() => setSetup(null)}
        title={
          reactivateCta
            ? "Reactivate your subscription"
            : isChange
              ? "Confirm your plan change"
              : "Add a payment method"
        }
        description={stripeSetup ? privacyText(businessName, "card") : undefined}
      >
        {stripeSetup ? (
          <StripeIntentForm
            purpose="setup"
            clientSecret={stripeSetup.client_secret!}
            publishableKey={stripeSetup.publishable_key!}
            brandColor={brandColor}
            confirmLabel={cta}
            busyLabel={busyCta}
            returnUrl={`${window.location.origin}/checkout?setup=return`}
            failureLead={failLead}
            // A method that redirects leaves this tab; the setup return leg completes it.
            onBeforeConfirm={() =>
              savePendingVaultSetup(scope, {
                setupToken: stripeSetup.setup_token,
                provider: stripeSetup.provider,
                ...(selectedGateway ? { gateway: selectedGateway } : {}),
                ...(stripeSetup.payment_intent
                  ? { paymentIntent: stripeSetup.payment_intent }
                  : {}),
              })
            }
            onCancel={() => setSetup(null)}
            // A refusal is returned, so the dialog shows it: the alert beside Pay is under it.
            onAuthorized={async (pm) => {
              const refused = await complete(pm, stripeSetup.payment_intent);
              clearPendingVaultSetup(scope);
              return refused ?? undefined;
            }}
          />
        ) : setup && setup.provider === "tmtest" ? (
          <TokenSetup
            label={cta}
            busyLabel={busyCta}
            // The typed card goes as the token, without the setup intent: completing
            // through the intent saves the gateway's default card and drops this one. No
            // double save: tmtest's intent is never approved on this path.
            onSubmit={async (value) => {
              // Closed on a refusal, so the alert beside the button is in view.
              if (await complete(value)) setSetup(null);
            }}
            onCancel={() => setSetup(null)}
          />
        ) : setup ? (
          /* A live gateway that came back without what its own form needs (a Stripe account
             with no publishable key). Never the test token field: say what happened. */
          <div className="flex flex-col gap-4">
            <Alert tone="error">
              We could not open the card form. The payment setup of {businessName} is not complete.
              Contact {businessName}, or try again later.
            </Alert>
            <PaymentDialogFooter>
              <Button variant="outline" onClick={() => setSetup(null)}>
                Close
              </Button>
            </PaymentDialogFooter>
          </div>
        ) : null}
      </PaymentDialog>
      {/* The 3DS sheet for the FIRST CHARGE — a different dialog from the add-card one
          above, and both can be reached in one visit: add the card, then authenticate the
          payment it is about to make. */}
      <PaymentRefusal message={challenge.refusal} />
      {challenge.dialog}
    </StorefrontSection>
  );
}

/**
 * The words a buyer reads for an invalid input. A combobox posts through an unlabelled
 * input beside its trigger, so its label is the trigger's. Never the input's `name`.
 */
function fieldLabelOf(
  form: HTMLFormElement,
  input: HTMLInputElement,
): { name: string; picked: boolean } {
  const labelFor = (id: string | null | undefined) =>
    id ? form.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : undefined;
  const trigger = input.parentElement?.querySelector<HTMLElement>('[role="combobox"]');
  const text =
    labelFor(input.id) ||
    input.getAttribute("aria-label") ||
    labelFor(trigger?.id) ||
    trigger?.getAttribute("aria-label") ||
    "the highlighted field";
  return { name: text.replace(/\*/g, "").trim(), picked: trigger != null };
}

/** The test gateway only (`setup.provider === "tmtest"`): a magic card number, typed. */
function TokenSetup({
  label,
  busyLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  busyLabel: string;
  onSubmit: (value: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(value.trim());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <Field
        name="test_card"
        label="Test card number"
        help="This is a test. No money moves and no real card is saved. Enter a test card number, for example 4242424242424242."
      >
        <Input
          name="test_card"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="4242424242424242"
          inputMode="numeric"
          autoComplete="off"
          className="tabular-nums"
        />
      </Field>
      <PaymentDialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy || !value.trim()}>
          {busy ? busyLabel : label}
        </Button>
      </PaymentDialogFooter>
    </div>
  );
}

/** Coarse device class for the conversion report: touch plus width, no user-agent parsing. */
function deviceClassOf(w: Window): "mobile" | "tablet" | "desktop" {
  const touch = w.matchMedia("(pointer: coarse)").matches;
  const width = w.innerWidth;
  if (touch && width < 768) return "mobile";
  if (touch && width < 1200) return "tablet";
  return width < 768 ? "mobile" : "desktop";
}
