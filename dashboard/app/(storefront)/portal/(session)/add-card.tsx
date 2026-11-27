"use client";

import { useEmbed } from "@/components/embed-bridge";
import { embedNotify } from "@/components/embed-bridge";
import { paymentMethodTypeLabel } from "@/lib/filter-options";
import { CLOSE_ADD_METHOD_EVENT } from "./section-link";
import * as React from "react";
import { money } from "@/lib/format";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import type { Country } from "@/lib/api/geo";
import { InlineBillingDetails } from "./inline-billing-details";
import { portalBeginSetupAction, portalCompleteVaultAction } from "./actions";
import { usePortalSession } from "./portal-session-context";
import { withPortalSession } from "@/lib/portal-path";
import { AddMethodResult } from "./add-method-result";
import type { AddMethodOutcome } from "./portal-state";
import { savePendingVaultSetup, clearPendingVaultSetup } from "@/lib/pending-vault-setup";
import {
  openRazorpayCheckout,
  vaultSetupDescription,
  type RazorpayCheckoutDescriptor,
} from "@/lib/razorpay-checkout";
import {
  formPostTargetIsSafe,
  openGatewaySdk,
  submitFormPost,
  type GatewaySdkDescriptor,
} from "@/lib/gateway-sdk";
import type { PortalMe, PortalVaultSetup, PortalGateway } from "@/lib/portal-api";
import { accountHolderName } from "@/lib/names";
import { clearActiveIntent, setActiveIntent } from "@/lib/buyer-error-report";
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { Landmark } from "lucide-react";
import { PaymentMark, type PaymentMarkKey } from "@/components/brand/payment-mark";
import { railsForCurrency, type MethodType } from "../../method-choice";
import { useReportInstrument } from "../../storefront-footer";
import { CommitBar } from "../../chrome";
import { AchAuthorization } from "../../ach-authorization";
import {
  PaymentDialog,
  PaymentDialogFooter,
  PaymentPrivacyNote,
  RefusalAlert,
  SdkFrame,
  StripeIntentForm,
  useInlineFrame,
  refusalMessage,
} from "../../payment-dialog";

/** A one-rail account is named by its rail; several rails keep the account label. */
/** One row of Add a payment method: a rail, and the account that takes it. */
type AddRow = {
  key: string;
  gateway: string;
  gatewayKey: string;
  method: MethodType;
  label: string;
  marks: PaymentMarkKey[];
  bank: boolean;
  note: string | null;
  /** A card form we draw in our page: it opens inside the row, with no second step. */
  formHere: boolean;
};
const BANK_RAILS = new Set(["us_bank_account", "sepa_debit", "bank_transfer", "bacs_debit"]);
/** Gateways whose form opens in their own window, not in our page. */
const OWN_WINDOW = new Set(["razorpay", "cashfree", "authorizenet"]);
/** Gateways whose own card form shows the card logos before anything is typed: an open row of
 * theirs hides ours, so the logos do not show twice. */
const FORM_SHOWS_CARD_LOGOS = new Set(["stripe", "braintree", "checkoutcom"]);

/** Gateways that take the buyer to their own page and back. */
const REDIRECTS = new Set(["paypal", "mollie", "gocardless", "payu"]);

function addRowLabel(method: string, gatewayKey: string): string {
  if (method === "card") return "Credit or debit card";
  if (method === "upi") return "UPI Autopay";
  if (method === "paypal") return "PayPal";
  if (method === "us_bank_account") return "US bank account";
  if (method === "bank_transfer" && gatewayKey === "razorpay") return "Netbanking e-Mandate";
  return paymentMethodTypeLabel(method);
}

/** Stripe India takes Visa and Mastercard on INR (no Amex, no RuPay): see pay-invoice.tsx. */
function addRowMarks(
  method: string,
  gatewayKey: string,
  currency?: string | null,
): PaymentMarkKey[] {
  if (method === "card")
    return gatewayKey === "razorpay"
      ? ["visa", "mastercard", "rupay"]
      : gatewayKey === "stripe" && (currency ?? "").toUpperCase() !== "INR"
        ? ["visa", "mastercard", "amex"]
        : ["visa", "mastercard"];
  if (method === "upi") return ["upi"];
  if (method === "paypal") return ["paypal"];
  return [];
}

/** The open row's one line, where the buyer leaves our page; null where the form is ours. */
function addRowNote(method: string, gatewayKey: string): string | null {
  if (method === "paypal") return "You continue on PayPal, then come back here.";
  if (method === "upi") return "You approve it in your UPI app.";
  if (method === "bank_transfer" && gatewayKey === "razorpay")
    return "You approve the mandate on your bank's page.";
  if (OWN_WINDOW.has(gatewayKey)) return "You enter your card in a secure window.";
  if (REDIRECTS.has(gatewayKey))
    return "You continue on the provider's secure page, then come back here.";
  return null;
}

/**
 * Buyer add-card flow (P14). First lets the buyer pick WHICH of the business's
 * configured gateways to add the card through, then begins a vault setup on that
 * gateway and branches on mode:
 *  - client_secret + Stripe → Stripe Elements confirmSetup (PAN goes
 *    provider-direct; PCI SAQ-A), then complete with the confirmed pm_….
 *  - client_secret + tmtest → test-token input (TM Test Gateway magic tokens).
 *  - checkout → RazorPay's own overlay, opened off this click.
 *  - redirect → send the buyer to the provider's approval page.
 *  - sdk → the gateway's browser client (`openGatewaySdk`), opened off this click.
 *  - form_post → the redirect arm, as a signed top-level POST.
 *
 * Every mode that stays on our page renders in a MODAL over the picker, the way
 * RazorPay's overlay does — see `PaymentDialog`. The picker used to be replaced by
 * the card form, so a buyer mid-flow could no longer see which gateway they had
 * chosen, and the same journey looked like two products depending on the gateway.
 */
export function AddCard({
  scope,
  me,
  gateways,
  expectedDebitMinor,
  unattendedLimitMinor,
  currency,
  routes,
  countries,
}: {
  /** For the inline billing details form, shown while details are missing. */
  countries: Country[];
  /** The server's rail → account routing (order, business routing, customer override). */
  routes?: { method: string; gateway_account: string }[] | null;
  /** Non-secret per-buyer key for the redirect-leg stash — see lib/pending-vault-setup.ts. */
  scope: string;
  /** The currency this buyer is billed in, when known: a rail that cannot move it is not offered. */
  currency?: string | null;
  me: PortalMe;
  gateways: PortalGateway[];
  /** The customer's largest recurring debit, from the gateway-list envelope. */
  expectedDebitMinor: number;
  /** Above this a mandate debit needs the payer's bank approval; null outside INR. */
  unattendedLimitMinor: number | null;
}) {
  const session = usePortalSession();
  const router = useRouter();
  const embedded = useEmbed().origin != null;
  /** Embedded: a provider's approval page opened in a new tab; the frame waits for the buyer. */
  const [awaitingApproval, setAwaitingApproval] = React.useState<{
    /** A redirect's approval page, which the buyer can open again; null for a signed POST. */
    url: string | null;
    provider: string | null;
  } | null>(null);
  const [setup, setSetup] = React.useState<PortalVaultSetup | null>(null);
  /** What the new method did to the open invoices, shown once it is saved. */
  const [outcome, setOutcome] = React.useState<AddMethodOutcome | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  /**
   * One row per METHOD across every account (option C), never per provider: the first
   * account that offers a rail takes it (the server lists the business default first).
   */
  const methodRows = React.useMemo(() => {
    const rows: AddRow[] = [];
    // The server's routing, when it sent one: its order and its account for each rail.
    if (routes?.length) {
      for (const r of routes) {
        const g = gateways.find((x) => x.id === r.gateway_account);
        if (!g || rows.some((x) => x.method === r.method)) continue;
        rows.push({
          key: `${g.id}:${r.method}`,
          gateway: g.id,
          gatewayKey: g.gateway_key,
          method: r.method as MethodType,
          label: addRowLabel(r.method, g.gateway_key),
          marks: addRowMarks(r.method, g.gateway_key, currency),
          bank: BANK_RAILS.has(r.method),
          note: addRowNote(r.method, g.gateway_key),
          formHere: r.method === "card" && addRowNote(r.method, g.gateway_key) == null,
        });
      }
      if (rows.length) return rows;
    }
    for (const g of gateways) {
      const rails =
        g.gateway_key === "paypal"
          ? ["paypal"]
          : railsForCurrency(g.method_types?.length ? g.method_types : ["card"], currency);
      for (const m of rails) {
        if (rows.some((r) => r.method === m)) continue;
        rows.push({
          key: `${g.id}:${m}`,
          gateway: g.id,
          gatewayKey: g.gateway_key,
          method: m as MethodType,
          label: addRowLabel(m, g.gateway_key),
          marks: addRowMarks(m, g.gateway_key, currency),
          bank: BANK_RAILS.has(m),
          note: addRowNote(m, g.gateway_key),
          formHere: m === "card" && addRowNote(m, g.gateway_key) == null,
        });
      }
    }
    return rows.sort((a, b) => Number(b.method === "card") - Number(a.method === "card"));
  }, [gateways, currency, routes]);
  const [selectedKey, setSelectedKey] = React.useState<string | null>(methodRows[0]?.key ?? null);
  const selectedRow = methodRows.find((r) => r.key === selectedKey) ?? methodRows[0];
  /** gwa_… of the selected row: where the setup runs. */
  const selected = selectedRow?.gateway ?? null;
  const selectedGw = gateways.find((g) => g.id === selected);
  const selectedGwKey = selectedGw?.gateway_key;
  const activeMethodType = (selectedRow?.method ?? "card") as MethodType;
  useReportInstrument(activeMethodType);
  /** Our bank debit authorization, when this gateway leaves it to us and a bank account is picked. */
  const achText =
    activeMethodType === "us_bank_account" ? (selectedGw?.ach_authorization ?? null) : null;
  const [achAccepted, setAchAccepted] = React.useState(false);
  /** The e-mandate authorization URL, while the buyer is approving it — see `begin`. */
  /**
   * The last refusal, shown beside Add card and kept there until the next try. A toast went
   * by itself after the gateway's sheet had closed, and the page then looked unchanged.
   */
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [awaitingMandate, setAwaitingMandate] = React.useState<string | null>(null);
  /** The row whose gateway form is mounted in place (option C), and its host element. */
  const [inlineKey, setInlineKey] = React.useState<string | null>(null);
  const inlineHost = React.useRef<HTMLDivElement | null>(null);
  /** The current setup draws in the open row, not in the dialog. */
  const [setupInline, setSetupInline] = React.useState(false);
  const inlineSig = selectedRow?.formHere ? selectedRow.key : null;
  const beginRef = React.useRef<((inlineFor?: string) => Promise<void>) | null>(null);
  /** Details missing: the buyer fills them in first, then this row starts its setup. */
  const complete = me.customer.billing_details_complete;
  React.useEffect(() => {
    setRefusal(null);
    setSetup(null);
    setSetupInline(false);
    if (!inlineSig || !complete) return void setInlineKey(null);
    setInlineKey(inlineSig);
    // After the row's host element is in the DOM.
    const t = setTimeout(() => void beginRef.current?.(inlineSig), 0);
    return () => clearTimeout(t);
  }, [inlineSig, complete]);

  /**
   * Finish a setup that was authorized on our own page (a Stripe `pm_…`, a RazorPay
   * payment id, a test token) THROUGH THE INTENT — see the note in
   * `runEmbeddedCheckout` for why the intent and not the raw token.
   *
   * Returns the refusal and does not show it: a caller whose dialog is still open shows it
   * there, where the buyer is looking. The others use `completeVaultInline`.
   */
  const completeVault = async (
    providerToken: string | undefined,
    paymentIntent?: string,
    clientResult?: Record<string, string>,
  ) => {
    const res = await portalCompleteVaultAction(
      session,
      {
        ...(paymentIntent ? { paymentIntent } : {}),
        ...(providerToken ? { providerToken } : {}),
        ...(clientResult ? { clientResult } : {}),
        ...(achText && achAccepted ? { achAuthorizationVersion: achText.version } : {}),
      },
      selected ?? undefined,
    );
    if (!res.ok) return res.error ?? "We could not save your payment method.";
    clearActiveIntent();
    if (res.outcome) setOutcome(res.outcome);
    else {
      embedNotify("payment_method_changed", { change: "added" });
      toast.success("Payment method added.");
      window.dispatchEvent(new Event(CLOSE_ADD_METHOD_EVENT));
    }
    setSetup(null);
    router.refresh();
    return null;
  };
  /** For a gateway whose own sheet has already closed: the refusal shows beside Add card. */
  const completeVaultInline = async (...args: Parameters<typeof completeVault>) => {
    const refused = await completeVault(...args);
    if (refused) refuse(refused);
  };
  /** The gateway's or the engine's words, kept whole, then the next step unless they say one. */
  const refuse = (reason: string) =>
    setRefusal(
      refusalMessage(
        "We could not save your payment method.",
        reason,
        /try again|contact/i.test(reason) ? "" : "Try again, or use a different payment method.",
      ).trim(),
    );

  const begin = async (inlineFor?: string) => {
    if (!selected) return;
    /**
     * The buyer's pick, whatever the gateway. This pinned `card` for every non-RazorPay
     * gateway, which is why Stripe's ACH and SEPA rails were unreachable from the portal
     * even though the engine has supported them end to end for a while. `activeMethodType`
     * is clamped to what this gateway advertises, so it cannot ask for a rail it lacks.
     */
    /**
     * The netbanking e-mandate is the one rail the buyer never comes BACK from: RazorPay's
     * auth-link endpoint ignores `callback_url` (measured three times, 2026-08-14 — see
     * `createEmandateAuthLink`), so they finish on RazorPay's "MANDATE REGISTRATION
     * COMPLETED" page and stay there. Navigating this tab away therefore dumped the buyer
     * out of their own billing portal for good.
     *
     * Here the instrument still lands — `harvestSetupIntent` vaults it from the
     * `payment.authorized` webhook with no browser involved — so the only thing that was
     * actually lost was the portal. Opened in a new tab, this one survives and the buyer can
     * refresh to see the method appear.
     *
     * The tab is opened SYNCHRONOUSLY, inside the click: a popup blocker judges by the user
     * gesture, and the gesture is gone once the server action resolves.
     */
    const strandedRail =
      selectedGw?.gateway_key === "razorpay" && activeMethodType === "bank_transfer";
    // Embedded: every provider page opens in a new tab, opened inside the click for the same reason.
    const authTab = strandedRail || embedded ? window.open("", "_blank") : null;
    setRefusal(null);
    setStarting(true);
    const res = await portalBeginSetupAction(
      session,
      window.location.origin,
      selected,
      activeMethodType,
    ).catch(() => ({
      ok: false as const,
      // A server action that throws (the network) must not leave the button looking untouched.
      error: "We could not start adding your payment method. The request did not finish.",
    }));
    setStarting(false);
    if (!res.ok) {
      authTab?.close();
      return void refuse(res.error);
    }
    setActiveIntent(res.setup.payment_intent);
    if (strandedRail && res.setup.mode === "redirect" && res.setup.approval_url) {
      // The panel renders the link as an anchor too, so a blocked popup is a non-event —
      // navigating this tab instead would put the buyer back out of their own portal.
      if (authTab) authTab.location.href = res.setup.approval_url;
      setAwaitingMandate(res.setup.approval_url);
      return;
    }
    if (embedded && res.setup.mode === "redirect" && res.setup.approval_url) {
      // The frame keeps the stash (its own storage) and finishes through `?setup=return` when the
      // buyer selects Continue after approval; the provider's tab only lands on /portal/approved.
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selected ? { gateway: selected } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      if (authTab) authTab.location.href = res.setup.approval_url;
      setAwaitingApproval({
        url: res.setup.approval_url,
        provider: res.setup.provider === "paypal" ? "PayPal" : null,
      });
      return;
    }
    authTab?.close();
    if (res.setup.mode === "redirect" && res.setup.approval_url) {
      // We're about to leave the site for the provider's approval page. Stash what
      // the return leg (setup-return.tsx) needs to exchange the approved token —
      // without it the buyer comes back and nothing completes.
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selected ? { gateway: selected } : {}),
        // The return leg completes through the INTENT when there is one — see
        // `PendingVaultSetup.paymentIntent`.
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
        ...(selected ? { gateway: selected } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      // Embedded: the signed POST goes to a new tab, and the frame waits as for a redirect.
      submitFormPost(res.setup.form_post, { newTab: embedded });
      if (embedded) setAwaitingApproval({ url: null, provider: null });
      return;
    }
    // RazorPay card + UPI: the mandate is authorized in their embedded modal, opened
    // straight from this click. The netbanking e-mandate does NOT come through here —
    // it is a hosted auth link, so it leaves by the `mode: 'redirect'` branch above.
    if (res.setup.mode === "checkout" && res.setup.checkout) {
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selected ? { gateway: selected } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      await runEmbeddedCheckout(res.setup.checkout, res.setup.payment_intent);
      return;
    }
    if (res.setup.mode === "sdk" && res.setup.sdk) {
      savePendingVaultSetup(scope, {
        setupToken: res.setup.setup_token,
        provider: res.setup.provider,
        ...(selected ? { gateway: selected } : {}),
        ...(res.setup.payment_intent ? { paymentIntent: res.setup.payment_intent } : {}),
      });
      await runGatewaySdk(res.setup.sdk, res.setup.payment_intent, inlineFor != null);
      return;
    }
    setSetupInline(inlineFor != null);
    setSetup(res.setup);
  };

  /** `runEmbeddedCheckout`'s stash rules, for a gateway's own browser client. */
  const runGatewaySdk = async (
    sdk: GatewaySdkDescriptor,
    paymentIntent?: string,
    inline = false,
  ) => {
    const result = await openGatewaySdk(sdk, {
      businessName: me.business.name,
      purpose: "setup",
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
      confirmLabel: "Save payment method",
      ...(inline && inlineHost.current ? { inline: inlineHost.current } : {}),
    });
    if (result.status === "dismissed") {
      clearPendingVaultSetup(scope);
      return;
    }
    if (result.status === "failed") return void refuse(result.message);
    setSaving(true);
    await completeVaultInline(undefined, paymentIntent, result.clientResult);
    clearPendingVaultSetup(scope);
    setSaving(false);
  };

  const runEmbeddedCheckout = async (
    descriptor: RazorpayCheckoutDescriptor,
    paymentIntent?: string,
  ) => {
    const result = await openRazorpayCheckout(descriptor, {
      businessName: me.business.name,
      // Rail-aware and honest: this sheet is a VAULT SETUP, and "save this card" is the
      // wrong caption for a UPI Autopay mandate. The string used to be hardcoded in
      // `razorpay-checkout.ts` for every caller, charges included.
      description: vaultSetupDescription(descriptor.method),
      prefill: {
        // The human at the keyboard, so the ACCOUNT HOLDER — not the billing contact.
        // The buyer is about to authenticate a card in their own name; prefilling
        // their finance team's would make them correct the field or abandon.
        name: accountHolderName(me.customer),
        email: me.customer.email,
        contact: me.customer.phone ?? me.customer.address.phone,
      },
    });
    if (result.status === "dismissed") {
      clearPendingVaultSetup(scope);
      return;
    }
    /**
     * A refusal KEEPS the stash — the same rule `setup-return.tsx` documents for the
     * redirect leg, and for the same reason. RazorPay leaves its sheet open after a
     * failure so the buyer can try again, and that retry can succeed server-side through
     * this very setup intent (`harvestSetupIntent`); clearing here threw away the only
     * thing the recovery had to complete through. Cleared on a dismissal (they left) and
     * on success (spent) — never on a failure.
     */
    if (result.status === "failed") return void refuse(result.message);
    // Complete through the setup INTENT, not the payment id. RazorPay's own
    // `payment.authorized` webhook harvests the same intent for the buyer who closes the
    // tab, and only the intent's atomic claim keeps the two from each vaulting the
    // mandate — measured 2026-08-21, posting the payment id here produced two identical
    // UPI payment methods 15s apart. The payment id rides along as the fallback for a
    // provider with no intent.
    // A setup always names its payment; "unconfirmed" is only for a charge.
    if (result.status !== "authorized") return;
    setSaving(true);
    await completeVaultInline(result.paymentId, paymentIntent, result.clientResult);
    clearPendingVaultSetup(scope);
    setSaving(false);
  };

  React.useLayoutEffect(() => {
    beginRef.current = begin;
  });

  // Card networks (and Indian gateways in particular — export regulations) need a billing name
  // and the address fields this portal requires before an instrument can be vaulted.
  //
  // The missing ones are asked HERE, inline, by `InlineBillingDetails`: the same fields, the same
  // `portalUpdateMeAction` and the same engine check (`billing_details_missing`) as the Billing
  // details editor, so what this refuses and what that form collects cannot disagree. A save
  // refreshes `me`; `complete` flips and the effect above continues into the gateway form.
  if (!complete) {
    return <InlineBillingDetails me={me} countries={countries} />;
  }

  // No gateway configured for this business — nothing to add a card through.
  if (gateways.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {me.business.name} has no payment provider yet. You cannot add a card now. Contact{" "}
        {me.business.name}.
      </p>
    );
  }

  // Facts from the engine, not a rule re-derived here: a non-INR customer gets a null
  // limit and no advice at all.
  const needsAuthPerDebit =
    unattendedLimitMinor != null && expectedDebitMinor > unattendedLimitMinor;
  const stripeSetup =
    setup?.mode === "client_secret" && setup.provider === "stripe" && setup.client_secret
      ? setup
      : null;

  /**
   * Authorising in the other tab. Nothing here has to complete it — the
   * `payment.authorized` webhook vaults the instrument on its own — so this offers a
   * refresh rather than a "finish" button, and says plainly that closing the page is safe.
   * A netbanking e-mandate can take until the next working day to confirm, which is far
   * longer than anyone will sit on this screen.
   */
  if (awaitingApproval) {
    const name = awaitingApproval.provider;
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="info" title={`Approve with ${name ?? "your provider"} in the new tab`}>
          <p>
            {name ?? "Your provider"} opens in a new tab. Approve the payment method there. Then
            return to this page and select Continue after approval.
          </p>
        </Alert>
        {awaitingApproval.url ? (
          <a
            href={awaitingApproval.url}
            target="_blank"
            rel="noopener noreferrer"
            className="self-start text-sm font-medium text-primary hover:underline"
          >
            {`Open ${name ?? "the approval page"} again`}
          </a>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-document-link
            onClick={() =>
              window.location.assign(withPortalSession("/portal?setup=return", session))
            }
          >
            Continue after approval
          </Button>
          <Button variant="outline" onClick={() => setAwaitingApproval(null)}>
            Add a different method
          </Button>
        </div>
      </div>
    );
  }

  if (awaitingMandate) {
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="info" title="Authorize the auto-debit with your bank">
          <p>
            Your bank&apos;s authorization page opens in a new tab. Approve the auto-debit there.
            Your bank does not return you to this page automatically, so this page stays open.
          </p>
          <p className="mt-2">
            After you approve, you can close this page. The payment method shows here automatically.
            This usually takes less than a minute. Some banks take until the next working day.
          </p>
        </Alert>
        {/* An anchor, so no popup blocker can veto it — and this page must survive, because
            navigating it away is what put the buyer out of their own portal. */}
        <a
          href={awaitingMandate}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start text-sm font-medium text-primary hover:underline"
        >
          Open your bank&apos;s authorization page
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => router.refresh()}>Check now</Button>
          <Button variant="outline" onClick={() => setAwaitingMandate(null)}>
            Add a different method
          </Button>
        </div>
      </div>
    );
  }

  /** The setup's form: in the dialog, or inside the open row when the row draws its form. */
  const setupBody = (
    <>
      {stripeSetup ? <PaymentPrivacyNote business={me.business.name} /> : null}
      {stripeSetup ? (
        // No publishable key means Elements cannot mount. Say so, rather than
        // falling through to the token box: that box is the TM Test gateway's
        // magic-token input, it cannot vault a Stripe card, and a buyer shown it on
        // a real Stripe gateway has no way to know the control is inert. Measured
        // 2026-08-14 — the key was missing for months behind exactly this fallback.
        stripeSetup.publishable_key ? (
          <StripeIntentForm
            purpose="setup"
            clientSecret={stripeSetup.client_secret!}
            publishableKey={stripeSetup.publishable_key}
            brandColor={me.business.brand_color}
            confirmLabel="Save card"
            busyLabel="Saving…"
            returnUrl={`${window.location.origin}${withPortalSession("/portal?setup=return", session)}`}
            // A method that redirects leaves this tab; `SetupReturn` completes it.
            onBeforeConfirm={() =>
              savePendingVaultSetup(scope, {
                setupToken: stripeSetup.setup_token,
                provider: stripeSetup.provider,
                ...(selected ? { gateway: selected } : {}),
                ...(stripeSetup.payment_intent
                  ? { paymentIntent: stripeSetup.payment_intent }
                  : {}),
              })
            }
            onCancel={() => setSetup(null)}
            // A refusal is returned, so the Stripe dialog shows it: it stays open over the page.
            onAuthorized={async (pm) => {
              const refused = await completeVault(pm, stripeSetup.payment_intent);
              clearPendingVaultSetup(scope);
              return refused
                ? refusalMessage(
                    "We could not save your payment method.",
                    refused,
                    "Select Save card to try again.",
                  )
                : undefined;
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            The payment setup of {me.business.name} is not complete. You cannot enter a card now.
            Contact {me.business.name}.
          </p>
        )
      ) : setup ? (
        // tmtest (and any client_secret provider without a browser SDK): complete
        // with the typed test token alone. Through the setup intent the gateway saves
        // its default card and drops this one; the intent is never approved here.
        <TokenSetup onSubmit={(value) => completeVault(value)} onCancel={() => setSetup(null)} />
      ) : null}
    </>
  );

  return (
    <>
      <div className="flex flex-col gap-5">
        {/* One list (the payment element pattern): every way to pay is a row with its logos,
            the selected row opens in place with what the buyer must read before the
            gateway's step; one button below. */}
        <RadioGroup
          value={selectedRow?.key ?? ""}
          onValueChange={(v) => {
            setSelectedKey(v);
            setRefusal(null);
          }}
          aria-label="Payment method"
          className="flex flex-col gap-0 overflow-hidden rounded-xl border"
        >
          {methodRows.map((r) => {
            const open = r.key === selectedRow?.key;
            const afa =
              open &&
              needsAuthPerDebit &&
              (r.method === "card" || r.method === "upi") &&
              unattendedLimitMinor != null;
            return (
              <div
                key={r.key}
                className={`border-b px-3.5 py-3 transition-colors last:border-b-0 ${
                  open ? "bg-muted/40 ring-1 ring-primary/50 ring-inset" : "hover:bg-muted/50"
                }`}
              >
                <RadioOption
                  value={r.key}
                  label={
                    <span className="flex w-full items-center gap-2">
                      <span className="wrap-break-word">{r.label}</span>
                      <span className="ml-auto flex shrink-0 items-center gap-1">
                        {/* The open row's gateway form shows its own card logos. */}
                        {open && r.formHere && FORM_SHOWS_CARD_LOGOS.has(r.gatewayKey)
                          ? null
                          : r.marks.map((m) => <PaymentMark key={m} mark={m} />)}
                        {r.bank ? (
                          <Landmark className="size-4 text-muted-foreground" aria-hidden />
                        ) : null}
                      </span>
                    </span>
                  }
                />
                {open && (r.note || afa || achText || r.formHere) ? (
                  <div className="mt-3 flex flex-col gap-3 pl-7">
                    {r.note ? <p className="text-xs text-muted-foreground">{r.note}</p> : null}
                    {/* Above ₹15,000 a card or UPI mandate needs the payer's approval on every
                        debit (RBI); a netbanking e-mandate does not. Advice, never a block. */}
                    {afa ? (
                      <Alert tone="warning" title="You must approve every payment.">
                        Banks can auto-debit{" "}
                        {r.method === "upi" ? "a UPI Autopay mandate" : "a card"} only up to{" "}
                        {money(unattendedLimitMinor!, "INR")}. Your renewal is{" "}
                        {money(expectedDebitMinor, "INR")}, so you must approve each payment. If you
                        use Netbanking e-Mandate, you approve it once on this page. After that,
                        payments are automatic.
                      </Alert>
                    ) : null}
                    {achText ? (
                      <AchAuthorization
                        text={achText}
                        accepted={achAccepted}
                        onAcceptedChange={setAchAccepted}
                      />
                    ) : null}
                    {r.formHere && inlineKey === r.key ? (
                      <>
                        <RefusalAlert message={refusal} step="add_method" />
                        {refusal && !starting && !saving ? (
                          <Button
                            variant="outline"
                            size="sm"
                            className="self-start"
                            onClick={() => {
                              setRefusal(null);
                              setSetup(null);
                              setSetupInline(false);
                              void begin(r.key);
                            }}
                          >
                            Try again
                          </Button>
                        ) : null}
                        {starting ? (
                          <p className="text-xs text-muted-foreground">Loading the secure form…</p>
                        ) : null}
                        {saving ? <p className="text-xs text-muted-foreground">Saving…</p> : null}
                        {setup && setupInline ? (
                          <SdkFrame inline open onClose={() => undefined} title="">
                            {setupBody}
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

        {/* The commit bar — shared with the checkout's card step, see `CommitBar`. A row
            that draws its form in place has that form's own button instead. */}
        {selectedRow?.formHere ? null : (
          <CommitBar>
            <Button
              onClick={() => void begin()}
              disabled={starting || saving || !selected || (achText != null && !achAccepted)}
              className="sm:shrink-0"
            >
              {starting
                ? "Starting…"
                : saving
                  ? "Saving…"
                  : selectedGwKey === "paypal" || activeMethodType === "paypal"
                    ? "Continue with PayPal"
                    : activeMethodType === "venmo"
                      ? "Continue with Venmo"
                      : selectedGwKey === "gocardless"
                        ? "Set up Direct Debit"
                        : selectedGwKey === "mollie"
                          ? "Continue to Mollie"
                          : activeMethodType === "upi"
                            ? "Authorize UPI Autopay"
                            : selectedGwKey === "razorpay" && activeMethodType === "bank_transfer"
                              ? "Authorize Netbanking e-Mandate"
                              : achText
                                ? "Add bank account"
                                : "Add card"}
            </Button>
          </CommitBar>
        )}
        {selectedRow?.formHere ? null : <RefusalAlert message={refusal} step="add_method" />}
      </div>

      <AddMethodResult
        outcome={outcome}
        onClose={() => {
          setOutcome(null);
          window.dispatchEvent(new Event(CLOSE_ADD_METHOD_EVENT));
        }}
        me={me}
        scope={scope}
      />

      <PaymentDialog
        open={setup != null && !setupInline}
        onClose={() => setSetup(null)}
        title="Add a payment method"
      >
        {setupBody}
      </PaymentDialog>
    </>
  );
}

/** Shows a refusal in this dialog, not as a toast behind it. */
function TokenSetup({
  onSubmit,
  onCancel,
}: {
  /** The refusal, or null when the card was saved. */
  onSubmit: (value: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const inline = useInlineFrame();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const refused = await onSubmit(value.trim());
      if (refused)
        setError(refusalMessage("We could not save your payment method.", refused, "Try again."));
    } catch {
      setError(
        refusalMessage(
          "We could not save your payment method.",
          "The request did not finish",
          "Try again.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="portal-test-card-token" className="text-sm font-medium">
          Test card number
        </label>
        <Input
          id="portal-test-card-token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="4242424242424242"
          className="font-mono"
        />
        <p className="m-0 text-xs text-muted-foreground">
          This is a test. No money moves and no real card is saved. Enter a test card number, for
          example 4242424242424242.
        </p>
      </div>
      <RefusalAlert message={error} step="add_method" />
      <PaymentDialogFooter>
        {inline ? null : (
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button onClick={submit} disabled={busy || !value.trim()}>
          {busy ? "Saving…" : "Save card"}
        </Button>
      </PaymentDialogFooter>
    </div>
  );
}
