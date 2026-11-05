"use client";

import { PortalSectionButton } from "./section-link";
import * as React from "react";
import { money } from "@/lib/format";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { portalBeginSetupAction, portalCompleteVaultAction } from "./actions";
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
import { RadioGroup, RadioOption } from "@/components/ui/radio-group";
import { MethodTypeChoice, type MethodType } from "../../method-choice";
import { useReportInstrument } from "../../storefront-footer";
import { CommitBar } from "../../chrome";
import { AchAuthorization } from "../../ach-authorization";
import { PaymentDialog, StripeIntentForm } from "../../payment-dialog";

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
}: {
  /** Non-secret per-buyer key for the redirect-leg stash — see lib/pending-vault-setup.ts. */
  scope: string;
  me: PortalMe;
  gateways: PortalGateway[];
  /** The customer's largest recurring debit, from the gateway-list envelope. */
  expectedDebitMinor: number;
  /** Above this a mandate debit needs the payer's bank approval; null outside INR. */
  unattendedLimitMinor: number | null;
}) {
  const router = useRouter();
  const [setup, setSetup] = React.useState<PortalVaultSetup | null>(null);
  const [starting, setStarting] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [selected, setSelected] = React.useState<string | null>(gateways[0]?.id ?? null);
  const [methodType, setMethodType] = React.useState<MethodType>("card");
  const selectedGw = gateways.find((g) => g.id === selected);
  const selectedGwKey = selectedGw?.gateway_key;
  /**
   * What THIS gateway can offer for THIS currency — resolved server-side by
   * `effectiveMethodTypes`, so the storefront never guesses.
   *
   * The fallback used to be `['card','upi','bank_transfer']`, which is the Indian set: on a
   * Stripe account with nothing configured it would have offered UPI. `card` is the only
   * honest guess when the server told us nothing, and one option renders no chooser at all.
   */
  const allowedMethodTypes =
    selectedGw?.method_types && selectedGw.method_types.length > 0
      ? selectedGw.method_types
      : ["card"];
  /**
   * DERIVED, never the raw state: switching gateway would otherwise submit a rail the new
   * one cannot do — pick SEPA on Stripe, switch to RazorPay, and the state still says
   * `sepa_debit` while the chooser shows nothing selected. Deriving keeps the value that
   * is submitted and the value that is rendered as one thing.
   */
  const activeMethodType = (
    allowedMethodTypes.includes(methodType) ? methodType : (allowedMethodTypes[0] ?? "card")
  ) as MethodType;
  useReportInstrument(activeMethodType);
  /** Our bank debit authorization, when this gateway leaves it to us and a bank account is picked. */
  const achText =
    activeMethodType === "us_bank_account" ? (selectedGw?.ach_authorization ?? null) : null;
  const [achAccepted, setAchAccepted] = React.useState(false);
  /** The e-mandate authorization URL, while the buyer is approving it — see `begin`. */
  const [awaitingMandate, setAwaitingMandate] = React.useState<string | null>(null);

  // Card networks (and Indian gateways in particular — export regulations)
  // need a billing name + address before an instrument can be vaulted.
  //
  // This used to render its own copy of the name + address form. It no longer does:
  // the "Billing details" section above this one is now the single editor for them
  // (see `billing-details.tsx`), and it opens itself when they are missing. Two
  // identical forms on one page is two places for the buyer to submit the same
  // change and two places for the field set to drift — which is why the gate is a
  // POINTER at that section rather than a second form. `billing_details_complete`
  // (`hasBillingName` + line1 + country, server-side) is the only condition, so what
  // this refuses and what that form collects cannot disagree.
  if (!me.customer.billing_details_complete) {
    return (
      /* A BUTTON, not a sentence with a link in it. This is the fallback path now —
         `SetupCard` at the top of the page routes a buyer here in the right order — but
         it is still what someone sees if they tap the tab directly, and a prose
         cross-reference is the weakest affordance we have standing in front of the one
         thing this section exists to do. The pointer names no direction for the reason
         `PortalSectionLink` documents: this section is a different column on a desktop
         and a different tab on a phone. */
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">
          Card networks require a billing name and address before you can save a payment method.
        </p>
        {/* OUTLINE. `SetupCard` at the top of the page renders the same destination as
            the page's one filled call to action, and both are on screen together here —
            a second brand-filled button beside it makes neither read as the primary. */}
        <PortalSectionButton section="details" variant="outline" size="sm">
          Add billing details
        </PortalSectionButton>
      </div>
    );
  }

  /**
   * Finish a setup that was authorized on our own page (a Stripe `pm_…`, a RazorPay
   * payment id, a test token) THROUGH THE INTENT — see the note in
   * `runEmbeddedCheckout` for why the intent and not the raw token.
   */
  const completeVault = async (
    providerToken: string | undefined,
    paymentIntent?: string,
    clientResult?: Record<string, string>,
  ) => {
    const res = await portalCompleteVaultAction(
      {
        ...(paymentIntent ? { paymentIntent } : {}),
        ...(providerToken ? { providerToken } : {}),
        ...(clientResult ? { clientResult } : {}),
        ...(achText && achAccepted ? { achAuthorizationVersion: achText.version } : {}),
      },
      selected ?? undefined,
    );
    if (!res.ok) return void toast.error(res.error ?? "We could not save that card.");
    toast.success("Payment method added");
    setSetup(null);
    router.refresh();
  };

  const begin = async () => {
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
    const authTab = strandedRail ? window.open("", "_blank") : null;
    setStarting(true);
    const res = await portalBeginSetupAction(window.location.origin, selected, activeMethodType);
    setStarting(false);
    if (!res.ok) {
      authTab?.close();
      return void toast.error(res.error);
    }
    if (strandedRail && res.setup.mode === "redirect" && res.setup.approval_url) {
      // The panel renders the link as an anchor too, so a blocked popup is a non-event —
      // navigating this tab instead would put the buyer back out of their own portal.
      if (authTab) authTab.location.href = res.setup.approval_url;
      setAwaitingMandate(res.setup.approval_url);
      return;
    }
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
      submitFormPost(res.setup.form_post);
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
      await runGatewaySdk(res.setup.sdk, res.setup.payment_intent);
      return;
    }
    setSetup(res.setup);
  };

  /** `runEmbeddedCheckout`'s stash rules, for a gateway's own browser client. */
  const runGatewaySdk = async (sdk: GatewaySdkDescriptor, paymentIntent?: string) => {
    const result = await openGatewaySdk(sdk, {
      businessName: me.business.name,
      purpose: "setup",
      prefill: {
        name: accountHolderName(me.customer),
        email: me.customer.email,
        contact: me.customer.phone ?? me.customer.address.phone,
      },
    });
    if (result.status === "dismissed") {
      clearPendingVaultSetup(scope);
      return;
    }
    if (result.status === "failed") return void toast.error(result.message);
    setSaving(true);
    await completeVault(undefined, paymentIntent, result.clientResult);
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
    if (result.status === "failed") return void toast.error(result.message);
    // Complete through the setup INTENT, not the payment id. RazorPay's own
    // `payment.authorized` webhook harvests the same intent for the buyer who closes the
    // tab, and only the intent's atomic claim keeps the two from each vaulting the
    // mandate — measured 2026-08-21, posting the payment id here produced two identical
    // UPI payment methods 15s apart. The payment id rides along as the fallback for a
    // provider with no intent.
    setSaving(true);
    await completeVault(result.paymentId, paymentIntent);
    clearPendingVaultSetup(scope);
    setSaving(false);
  };

  // No gateway configured for this business — nothing to add a card through.
  if (gateways.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This business has no payment provider yet. You cannot add a card now. Contact the business.
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

  return (
    <>
      <div className="flex flex-col gap-5">
        {/* ONE gateway is not a choice — a single-option radio group is a control that
            cannot do anything, so it is omitted and the id still rides along on `begin`.
            (The checkout has always done this; the portal used to render the group
            regardless, which is how a buyer with one gateway was asked to pick it.) */}
        {gateways.length > 1 ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium tracking-widest text-muted-foreground uppercase">
              Payment provider
            </div>
            {/* Selectable rows rather than a plain list: the whole row is the target, and
                the chosen one carries a ring. RadioGroup owns keyboard handling.
                ⚠️ The gateway KEY is deliberately not rendered. "RAZORPAY" / "TMTEST" is
                our routing detail, means nothing to a payer, and reads like an unfinished
                screen — the account's own label is the only part addressed to them. */}
            <RadioGroup
              value={selected}
              onValueChange={setSelected}
              aria-label="Payment provider"
              className="flex flex-col gap-2"
            >
              {gateways.map((g) => (
                <div
                  key={g.id}
                  className={`rounded-md border px-3.5 py-3 transition-colors ${
                    // A SUB-group ring, lighter than the row that owns it — same weight as
                    // the method-type group beneath it and as checkout's provider group.
                    // At full strength the portal painted two selection rings stacked with
                    // nothing saying the lower exists because of the upper (measured over
                    // CDP, 2026-09-01: both read rgb(191,77,0) at alpha 1).
                    selected === g.id
                      ? "border-primary/70 ring-1 ring-primary/30"
                      : "hover:bg-muted/50"
                  }`}
                >
                  <RadioOption value={g.id} label={<span className="truncate">{g.label}</span>} />
                </div>
              ))}
            </RadioGroup>
          </div>
        ) : null}

        {/* Offered whenever this gateway has more than one rail — not only for RazorPay.
            One option is not a choice, so a single-rail gateway still renders nothing. */}
        {allowedMethodTypes.length > 1 ? (
          <MethodTypeChoice
            value={activeMethodType}
            onValueChange={setMethodType}
            allowed={allowedMethodTypes}
            /* No visible heading: the block's own "Choose how you would like to pay for
               future invoices." says it one line above. The checkout, which has no such
               line, passes one. */
            notice={
              /* Above ₹15,000 these three rails stop being interchangeable, and the
                 buyer is the one who pays for the difference: on a card or UPI mandate
                 RBI makes them approve EVERY debit, while a netbanking e-mandate
                 authenticates once here and then collects unattended (measured —
                 ₹66,025 off-session on HDFC). Nobody was told, so someone picking
                 "card" for a ₹56,715 plan was choosing an OTP a month unknowingly.
                 Advice, never a block: all three work, and it is their choice. It sits
                 inside the chosen card now, because it is a fact about THAT rail. */
              needsAuthPerDebit && activeMethodType !== "bank_transfer" ? (
                /* Lead with what happens TO THE BUYER, then why. The old lead —
                   "Your payment is above ₹15,000" — put the CEILING where the amount
                   goes, so the one number on screen looked like the sum being charged.
                   Both numbers are named now: the cap, and their own debit. */
                <Alert tone="warning" title="You must approve every payment.">
                  Banks can auto-debit{" "}
                  {activeMethodType === "upi" ? "a UPI Autopay mandate" : "a card"} only up to{" "}
                  {money(unattendedLimitMinor!, "INR")}. Your renewal is{" "}
                  {money(expectedDebitMinor, "INR")}, so you must approve each payment. If you use
                  Netbanking e-Mandate, you approve it once on this page. After that, payments are
                  automatic.
                </Alert>
              ) : null
            }
          />
        ) : null}

        {achText ? (
          <AchAuthorization
            text={achText}
            accepted={achAccepted}
            onAcceptedChange={setAchAccepted}
          />
        ) : null}

        {/* The commit bar — shared with the checkout's card step, see `CommitBar`. */}
        <CommitBar>
          <Button
            onClick={begin}
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
      </div>

      <PaymentDialog
        open={setup != null}
        onClose={() => setSetup(null)}
        title="Add a payment method"
        description={
          stripeSetup
            ? "Your card details go directly to Stripe. They never reach this page or our servers."
            : undefined
        }
      >
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
              returnUrl={`${window.location.origin}/portal?setup=return`}
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
              onAuthorized={async (pm) => {
                await completeVault(pm, stripeSetup.payment_intent);
                clearPendingVaultSetup(scope);
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              This payment provider is not fully configured. You cannot enter a card now. Contact
              support.
            </p>
          )
        ) : setup ? (
          // tmtest (and any client_secret provider without a browser SDK): complete
          // with a provider test token directly.
          <TokenSetup
            onSubmit={(value) => completeVault(value, setup.payment_intent)}
            onCancel={() => setSetup(null)}
          />
        ) : null}
      </PaymentDialog>
    </>
  );
}

function TokenSetup({
  onSubmit,
  onCancel,
}: {
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
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Card token (test gateway)"
        className="font-mono"
      />
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy || !value.trim()}>
          {busy ? "Saving…" : "Save card"}
        </Button>
      </div>
    </div>
  );
}
