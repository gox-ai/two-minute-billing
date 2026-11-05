// Collection primitives — the payment-method / gateway-account selection and the
// single charge attempt that `collectInvoice` performs, factored out so a charge
// can also be made BEFORE an invoice exists.
//
// Why this file exists: the auto-collect-ON signup must charge the card before the
// subscription (and its invoice) become visible — a refused signup must leave
// NOTHING behind, while compensating after the fact leaves a cancelled
// subscription, a voided invoice and a trail of webhooks that were already
// delivered. Charging first needs exactly the selection `collectInvoice` uses
// (subscription PM → customer primary-role card, the Smart-Routing gateway
// account, the method's own display type, the buyer contact RazorPay demands), so
// that logic lives here once and both callers share it.
//
// Nothing here writes to the database except `markPaymentMethodInvalid` — booking
// the outcome (payments, ledger, transactions, events) stays with the caller.

import { methodTypeOf } from "@/modules/payments/method-type";
import { paceGatewayCharge } from "@/modules/gateway/charge-pace";
import { TERMINATE } from "@/modules/subscriptions/decline-policy";
import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { getProvider, resolveAdapter } from "@/providers/registry";
import { GatewayRouterError, selectGatewayAccount } from "@/modules/gateway/router";
import { setPaymentMethodStatus } from "@/modules/payment-methods/service";
// From the LEAF module directly. `payment-methods/service` re-exports it and would work
// (this file already imports from there), but the mandate vocabulary is pure and the leaf
// is where it is defined — see that file's header for why the split exists.
import {
  mandateChargeability,
  mandateHasExpired,
  MANDATE_MISSING_STATUS,
} from "@/modules/payment-methods/mandate-afa";
import { recordTransaction } from "@/modules/transactions/service";
import { subscriptionChargeDescription } from "./charge-description";
import {
  createPaymentIntent,
  type PaymentAttempt,
  type PaymentIntent,
} from "@/modules/payment-intents/service";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { createLogger } from "@/platform/logger";
import { applyDeclineOverride } from "@/modules/subscriptions/decline-overrides";
import { payerDeclineMessage, PAYER_SAFE_INTERNAL_FAILURE } from "@/providers/decline-codes";
import { formatMoney } from "./document";
import { providerPaymentMethodRef } from "@/modules/payment-methods/provider-ref";
import {
  MANDATE_CURRENCY_CODE,
  mandateCurrencyDiffers,
  mandateCurrencyRefusal,
} from "@/modules/payment-methods/mandate-currency";
export {
  providerPaymentMethodRef,
  MANDATE_CURRENCY_CODE,
  mandateCurrencyDiffers,
  mandateCurrencyRefusal,
};
import type { ChargeInitiator, ChargeInput, ChargeResult } from "@/providers/types";
import {
  PRE_DEBIT_NOT_DUE_CODE,
  ProviderIndeterminateError,
  strandedObjectId,
} from "@/providers/types";
import {
  businesses,
  customers,
  gatewayAccounts,
  payments,
  paymentMethods,
  subscriptions,
} from "@db/schema";
import { needsGatewayNotice, preDebitGate, releaseGatewayNotice } from "./pre-debit";
import { CARD_LIMIT_CODE, CARD_LIMIT_MESSAGE, isCardInstrument, overCardLimit } from "./card-limit";

const log = createLogger("collection");

export type Pm = typeof paymentMethods.$inferSelect;
export type GwAccount = typeof gatewayAccounts.$inferSelect;
type Sub = typeof subscriptions.$inferSelect;

/** Buyer contact + auto-collection flag, read once per collection attempt. */
export interface ChargeContact {
  autoCollection: string | null;
  email: string | null;
  phone: string | null;
}

/**
 * Auto-collection + the buyer contact details that ride along on the charge call
 * itself (RazorPay off-session refuses a charge without them). Phone falls back to the
 * billing-address phone, as `providerContact` does: hosted checkout saves it there only.
 */
export async function loadChargeContact(
  organizationId: string,
  customerId: string,
): Promise<ChargeContact | null> {
  return withTenant(organizationId, async (tx) => {
    const [c] = await tx
      .select({
        ac: customers.autoCollection,
        email: customers.email,
        phone: customers.phone,
        billingPhone: customers.billingPhone,
      })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    return c ? { autoCollection: c.ac, email: c.email, phone: c.phone ?? c.billingPhone } : null;
  });
}

/**
 * The ordered collection candidates (C6): the subscription's PM (or the customer's
 * primary-role card) first, then the customer's BACKUPS, each tried when the one
 * before it declines (`shouldTryBackup`). Every card that is not the primary is a
 * backup unless someone removed it (`role = 'none'`). An explicit override (D3 ad-hoc
 * collect) charges exactly that method, with no backup.
 */
/**
 * Which instrument fills the FIRST candidate slot when no subscription default names
 * one. Pure, over rows already ordered newest-first, so the rule can be tested without
 * a database — the selection is the part that decides where a customer's money comes
 * from, and it was previously only exercised incidentally by fixtures that happened to
 * have a single card.
 *
 * ── A DESIGNATED PRIMARY STANDS WHATEVER ITS STATUS ──────────────────────────
 * This is the one place `invalid` is knowingly ignored, and it is deliberate. `invalid`
 * is our BELIEF and it goes stale — a reissued card behind the same token, a
 * mis-classified transient decline, a wrong `payment_source_expired` — and nothing
 * revalidates an instrument except one narrow un-pause path in `applyMandateUpdate`.
 * Charging it is the only route back for a card we wrote off by mistake, and somebody
 * named it on purpose. `shouldTryBackup` is what stops that costing the fallback.
 *
 * ── WITH NOBODY DESIGNATED, THE NEWEST IS NOT AUTOMATICALLY RIGHT ────────────
 * This used to be `rows.find(role === 'primary') ?? rows[0]`. Two things were wrong
 * with the fallback:
 *  1. a dead card beat a live one for no reason anyone chose; and
 *  2. the newest card can BE the designated backup, which promotes it out of its own
 *     slot — `resolveChargeCandidates` then drops the backup (`bk.id !== primary.id`)
 *     and the customer has ONE candidate where they had arranged two.
 *
 * So: prefer a usable undesignated card, then any usable card, then fall back to the
 * old newest-wins. Taking the backup as first choice is the last resort it always
 * should have been.
 */
export function pickPrimaryCandidate<T extends { role: string | null; status: string | null }>(
  rows: T[],
): T | null {
  const designated = rows.find((r) => r.role === "primary");
  if (designated) return designated;
  // No primary: the best backup. A card taken out of collection (`none`) is never charged.
  const eligible = rows.filter((r) => r.role !== "none");
  return eligible.find((r) => r.status === "valid") ?? eligible[0] ?? null;
}

/**
 * A BACKUP MUST BE A DIFFERENT CARD, NOT JUST A DIFFERENT ROW.
 *
 * This compared `id` only, so a backup carrying the SAME physical card as the primary
 * passed as a genuine fallback — and when the primary declined, collection "fell back" to
 * the card the issuer had just refused. False resilience: the operator sees two
 * instruments, the customer sees two, there is one.
 *
 * Reachable, and measured on the live book 2026-09-12 as soon as `instrument_fingerprint`
 * existed to see it with: one customer had the same card vaulted FOUR times, another
 * twice. The fallback is what carries a ceiling refusal or a mandate decline to a second
 * instrument, so a duplicate there is the difference between collecting and not.
 *
 * ⚠️ A NULL FINGERPRINT NEVER SUPPRESSES A BACKUP. Only Stripe reports one — RazorPay has
 * no equivalent and PayPal's v3 schema has no such field — so for those rails this stays
 * the id check it always was. Unknown means "cannot prove they are the same card", and
 * dropping a real backup on that would cost a collection to prevent a duplicate we never
 * established.
 *
 * Exported and pure for the same reason `pickPrimaryCandidate` is: this decides where a
 * customer's money comes from, and it should be testable without a database.
 */
export function usableBackup<T extends { id: string; instrumentFingerprint?: string | null }>(
  primary: T | null,
  backup: T | null | undefined,
): T | null {
  if (!backup || backup.id === primary?.id) return null;
  const sameCard =
    backup.instrumentFingerprint != null &&
    backup.instrumentFingerprint === primary?.instrumentFingerprint;
  return sameCard ? null : backup;
}

/**
 * At most this many instruments are charged in one collection run. A string of declines
 * across one customer's cards is the pattern gateway fraud screens read as card testing,
 * and every attempt books its own failed transaction.
 */
export const MAX_INSTRUMENTS_PER_RUN = 3;

/** Statuses a backup may be charged in: a card we wrote off or that has expired is skipped. */
const CHARGEABLE_BACKUP = new Set(["valid", "expiring"]);

/**
 * The backups to try after `primary`, in order: chargeable ones only, `valid` before
 * `expiring`, newest first, never the same physical card twice, capped so the whole run
 * stays within `MAX_INSTRUMENTS_PER_RUN`. Pure, over rows ordered newest-first.
 */
export function orderBackups<
  T extends {
    id: string;
    role: string | null;
    status: string | null;
    instrumentFingerprint?: string | null;
  },
>(primary: T | null, rows: T[]): T[] {
  const chargeable = rows.filter(
    (r) => r.role === "backup" && CHARGEABLE_BACKUP.has(r.status ?? ""),
  );
  const ranked = [
    ...chargeable.filter((r) => r.status === "valid"),
    ...chargeable.filter((r) => r.status !== "valid"),
  ];
  const picked: T[] = [];
  for (const r of ranked) {
    if (picked.length >= MAX_INSTRUMENTS_PER_RUN - 1) break;
    if ([primary, ...picked].every((t) => usableBackup(t, r) === r)) picked.push(r);
  }
  return picked;
}

/**
 * A buyer on a checkout page who entered a card chose THAT card: a decline there is
 * shown to them to try another, never silently settled on an older saved one they did
 * not pick. Inside this scope collection charges the primary only.
 */
const chosenCardOnly = new AsyncLocalStorage<true>();
export const runChargingChosenCardOnly = <T>(fn: () => Promise<T>): Promise<T> =>
  chosenCardOnly.run(true, fn);

/**
 * Whether `publicId` is one of THIS customer's saved methods. A chosen card is checked
 * before anything moves: unchecked, a foreign or unknown id resolved to no card and
 * booked a failed payment under a 200.
 */
export async function isCustomerPaymentMethod(
  organizationId: string,
  customerId: string,
  publicId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ id: paymentMethods.id })
      .from(paymentMethods)
      .where(and(eq(paymentMethods.customerId, customerId), eq(paymentMethods.publicId, publicId)))
      .limit(1);
    return Boolean(row);
  });
}

export async function resolveChargeCandidates(input: {
  organizationId: string;
  customerId: string;
  subscription?: Sub | null;
  paymentMethodOverrideId?: string;
  /**
   * The charge currency. A method whose mandate is in another currency, on a gateway that
   * debits it only in that currency (`mandateCurrencyDiffers`), is skipped: it is kept as the
   * primary only when no other method can take this currency, so the refusal
   * (`mandateCurrencyRefusal`) names the reason.
   */
  currency?: string;
}): Promise<{ primary: Pm | null; backups: Pm[] }> {
  const { organizationId, customerId } = input;
  return withTenant(organizationId, async (tx) => {
    if (input.paymentMethodOverrideId) {
      const [row] = await tx
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.customerId, customerId),
            eq(paymentMethods.publicId, input.paymentMethodOverrideId),
          ),
        )
        .limit(1);
      return { primary: row ?? null, backups: [] };
    }
    const rows = await tx
      .select()
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, customerId))
      .orderBy(desc(paymentMethods.createdAt));
    let subDefault: Pm | null = null;
    if (input.subscription?.defaultPaymentMethodId) {
      const [row] = await tx
        .select()
        .from(paymentMethods)
        .where(eq(paymentMethods.id, input.subscription.defaultPaymentMethodId))
        .limit(1);
      subDefault = row ?? null;
    }
    // No explicit sub default → the customer's primary-role card, else the best backup.
    let primaryPm = subDefault ?? pickPrimaryCandidate(rows);
    const chosenOnly = !!chosenCardOnly.getStore();
    const fits = rows.filter((r) => !mandateCurrencyDiffers(r, input.currency));
    if (primaryPm && !chosenOnly && mandateCurrencyDiffers(primaryPm, input.currency)) {
      const other = pickPrimaryCandidate(fits.filter((r) => r.role !== "none"));
      if (other) primaryPm = other;
    }
    const backups = chosenOnly ? [] : orderBackups(primaryPm, fits);
    return { primary: primaryPm, backups };
  });
}

/** The candidates in charge order. */
export const chargeOrder = (c: { primary: Pm | null; backups: Pm[] }): Pm[] =>
  c.primary ? [c.primary, ...c.backups] : [];

/**
 * Resolve the charging adapter for a PM (C10): the gateway account that vaulted it
 * (gateway_accounts) when set, else Smart Routing through the canonical router,
 * else the legacy env-configured provider registry (only for a TEST business with no
 * gateway accounts at all — that registry holds test credentials only).
 *
 * S6 guard: a DISABLED or mode-mismatched vaulting account must never be charged —
 * disabling an account has to actually stop money moving through it.
 */
export async function resolveChargeAdapter(input: {
  organizationId: string;
  businessId: string;
  currency: string;
  pm: Pm;
}): Promise<{ adapter: ReturnType<typeof getProvider>; account: GwAccount | null }> {
  const { organizationId, businessId, currency, pm } = input;
  if (pm.gatewayAccountId) {
    const { acc, bizMode } = await withTenant(organizationId, async (tx) => {
      const [a] = await tx
        .select()
        .from(gatewayAccounts)
        .where(eq(gatewayAccounts.id, pm.gatewayAccountId!))
        .limit(1);
      const [b] = await tx
        .select({ livemode: businesses.livemode })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1);
      return { acc: a ?? null, bizMode: b?.livemode ?? null };
    });
    if (acc) {
      if (acc.status !== "active")
        throw new GatewayRouterError(
          "gateway_disabled",
          `Gateway account ${acc.publicId} is not active`,
        );
      if (bizMode && acc.livemode !== (bizMode === "live"))
        throw new GatewayRouterError(
          "gateway_disabled",
          `Gateway account ${acc.publicId} mode does not match business mode ${bizMode}`,
        );
      return { adapter: resolveAdapter(acc), account: acc };
    }
  }
  // No account bound to the PM: apply Smart Routing (currency × method type) via
  // the canonical router, with its no-silent-fallback semantics
  // (no_gateway_for_currency / ambiguous_gateway rather than guessing). The caller
  // already maps GatewayRouterError to a payment failure.
  //
  // A business with NO gateway_accounts at all is the legacy env-configured
  // provider case — only then fall back to the provider registry.
  const { hasAccounts, bizMode } = await withTenant(organizationId, async (tx) => {
    const rows = await tx
      .select({ id: gatewayAccounts.id })
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.businessId, businessId))
      .limit(1);
    const [b] = await tx
      .select({ livemode: businesses.livemode })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return { hasAccounts: rows.length > 0, bizMode: b?.livemode ?? null };
  });
  if (hasAccounts) {
    const routed = await withTenant(organizationId, (tx) =>
      selectGatewayAccount(tx, { businessId, currency, methodType: pm.type }),
    );
    return { adapter: resolveAdapter(routed), account: routed };
  }
  // TL-6: the env registry is built ONLY from `*_TEST_*` credentials
  // (src/providers/registry.ts), so this fallback is a test-mode facility. Taking it
  // for a LIVE business would charge a real customer against a sandbox and report
  // success — the one failure direction the mode partition exists to prevent. The
  // three other mode guards (router, the account branch above, payment intents) all
  // sit on the gateway-account path and never saw this branch. A live business must
  // hold its own gateway account.
  if (bizMode === "live") {
    throw new GatewayRouterError(
      "gateway_not_found",
      "This live business has no gateway account. The provider registry from the environment is for test businesses only.",
    );
  }
  return { adapter: getProvider(pm.providerKey), account: null };
}

/** One charge attempt against one payment method, through its resolved adapter. */
export interface ChargeAttempt {
  result: ChargeResult;
  account: GwAccount | null;
  gatewayKey: string;
  /**
   * Set instead of a real result when the debit must wait for a gateway pre-debit notice
   * (`preDebitGate`). Nothing reached the gateway; the caller defers, books nothing.
   */
  deferredUntil?: Date;
}

/** What a charge whose answer was lost is found by later (`transactions` 0396). */
export interface LostChargeHandle {
  account: GwAccount | null;
  gatewayKey: string;
  idempotencyKey: string;
  ownershipRef: string;
}

const lostCharges = new WeakMap<object, LostChargeHandle>();

/**
 * The handle `chargeWithMethod` attached to the `ProviderIndeterminateError` it rethrew, or
 * null. A caller books the `timeout` row with it, so the lost-answer sweep can ask the same
 * account by the same key and ref.
 */
export function lostChargeHandle(err: unknown): LostChargeHandle | null {
  return err && typeof err === "object" ? (lostCharges.get(err) ?? null) : null;
}

/** The failure code an instrument with no mandate at all refuses with. See {@link mandateMissingRefusal}. */
export const MANDATE_MISSING_CODE = "mandate_missing";

/**
 * A mandate-bound instrument that carries NO mandate, refused before the gateway sees it.
 *
 * THE HOLE THE OTHER FOUR LEFT. Every refusal below reads a mandate FACT — an end date, a
 * ceiling, a status — so each one opens by returning `null` when its field is absent, and
 * an instrument missing the mandate ENTIRELY satisfies all four. `mandateRefusal`'s second
 * line is the clearest case: `if (ceiling == null) return null`, and no mandate means no
 * ceiling. So the debit went to the gateway, and Stripe answered what we could have
 * answered ourselves — "The parameter `mandate` is not provided or invalid".
 *
 * WHY THAT MATTERS BEYOND A WASTED CALL: the refused confirm leaves a PaymentIntent behind
 * carrying our ownership tag, which `orphaned_gateway_intents` then reports as money armed
 * at a gateway that we cannot explain. Both intents on that alert on 2026-09-06/07 were
 * this. A refusal raised HERE creates no gateway object at all, so there is nothing to
 * strand — which is the only way to stop that alert recurring rather than clear it after.
 * The population is known: the migrated customers whose Stripe mandate did not travel with
 * their payment method (a mandate is bound to the SetupIntent that made it, on that
 * account), each one an orphan per renewal until they re-authorise.
 *
 * ⚠️ GATED ON WHAT THE GATEWAY TOLD US, never on a guess. It fires only once the
 * instrument carries {@link MANDATE_MISSING_STATUS} — written below when a debit came back
 * `mandate_missing` — so the FIRST attempt on any instrument still goes to the gateway and
 * every later one is refused here. Zero false declines by construction: we refuse exactly
 * what this gateway has already refused for this reason.
 *
 * Two earlier cuts guessed, and both were wrong. Gating on the pm row (a rail, a status, a
 * ceiling) refused every tmtest mandate fixture, because only Stripe reads a reference.
 * Gating on the CURRENCY covered the right rows but declined the wrong ones: an
 * international card billed in INR on a Stripe India account needs no RBI e-mandate, and
 * the currency is only a proxy for the issuer's country. Neither could work from our own
 * data — measured, all 13 migrated Stripe methods are bare (rail, status and ceiling all
 * NULL), which makes them indistinguishable from a plain card-on-file. The gateway knows,
 * answers once, and this keeps the answer.
 */
export function mandateMissingRefusal(
  pm: Pm,
  /**
   * `adapter.capabilities` — BOTH flags, unlike its four siblings, which need only
   * `mandates`. A missing reference is only a missing authorization on a gateway that
   * reads one: RazorPay debits with the recurring token alone and tmtest with the vaulted
   * instrument, so refusing those would invent a failure the rail does not have. Measured
   * the hard way — the first cut of this gated on the pm row alone and refused every
   * tmtest mandate fixture in `verify:gateway`, none of which sets a reference because
   * nothing in that adapter reads one.
   */
  caps: { mandates?: boolean; perDebitMandateReference?: boolean },
): ChargeResult | null {
  if (caps.mandates === false) return null;
  if (!caps.perDebitMandateReference) return null;
  if (pm.mandateReference) return null;
  if (mandateChargeability(pm) !== "missing") return null;
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: MANDATE_MISSING_CODE,
      /**
       * ⚠️ BUYER-FACING, by the same route as the other four: it rides `payment_failed` as
       * `declineMessage` inside "We were unable to charge your payment method for X (…)".
       *
       * So it accuses them of nothing — the authorisation went missing on our side of the
       * move, not theirs — asks for the one action that clears it, and says outright that
       * retrying cannot work so nobody waits on a schedule that will never collect. It
       * does not say `mandate`, `SetupIntent` or `pm_…`.
       */
      message:
        `This payment method${pm.mandateRail ? ` (${pm.mandateRail})` : ""} has no auto-debit ` +
        "authorization on file, so we cannot charge it automatically. Authorize it " +
        "again to settle this invoice. A retry of this charge cannot succeed.",
      retriable: false,
    },
    raw: {
      mandate_reference: pm.mandateReference,
      mandate_rail: pm.mandateRail,
      mandate_status: pm.mandateStatus,
      mandate_max_amount_minor: pm.mandateMaxAmountMinor?.toString() ?? null,
      gateway_mandates: caps.mandates ?? null,
    },
  };
}

/** The failure code a lapsed mandate refuses with. See {@link mandateExpiredRefusal}. */
export const MANDATE_EXPIRED_CODE = "mandate_expired";

/**
 * A debit against a mandate whose END DATE has passed, refused before the gateway sees
 * it.
 *
 * ── The axis the other three pre-flights were missing ─────────────────────────
 * This file already refuses on the ceiling (`mandateRefusal`), on a mandate the bank has
 * not confirmed (`mandatePendingRefusal`, F-11) and on a spent single-use one
 * (`mandateSpentRefusal`, F-43). Expiry was the fourth fact we hold and never read:
 * every reference to `mandateExpiresAt` outside the migrations was a WRITE
 * (`webhooks/inbound.ts`, `payment-methods/service.ts`) or a DISPLAY
 * (`payment-methods/serialize.ts`). Nothing in the charge path read it, `expired` is not
 * in `DEAD_MANDATE_STATUSES`, and `paymentSourceSweep` looks only at the card's PRINTED
 * expiry — so a 01/2099 card whose mandate died yesterday was never flagged anywhere.
 * The debit went to the gateway and came back as an ordinary decline, which dunning then
 * retried on a schedule against a mandate that no longer exists.
 *
 * ── What we actually send and store, established by reading the send path ─────
 * ⚠️ An earlier explanation of this defect — "the RazorPay ORDER validity leaks into the
 * mandate end-date field" — was WRONG and is retracted. `providers/razorpay.ts` sends
 * `expire_at = now + 10 years` on every rail (`createMandateOrder`; the auth-link path at
 * :921 does the same, and its `expire_by = now + 7 days` is the LINK's shelf life and
 * reaches no mandate field). We store what the gateway RETURNS, by explicit policy.
 *
 * Measured 2026-09-01 over the dev database: 137 RazorPay card mandates hold THREE
 * distinct end dates, all end-of-day IST and none of them our +10y — 115 at
 * `2026-08-31T18:29:59Z`, 2 at `2026-09-30T18:29:59Z`, 20 at `2030-12-31T18:29:59Z` —
 * while the `upi` and `emandate` rows came back at +10y almost to the second. All 137
 * carry a printed card expiry of 01/2099, so it is not the card's own date. **115 of them
 * were already past their expiry while still reporting `mandate_status: confirmed`.** Test
 * mode only; live is unverified (see {@link mandateHasExpired} for the full measurement
 * and the caveat).
 *
 * ── retriable: FALSE, and the treatment copies `mandate_ceiling_exceeded` ─────
 * Same shape, because it is the same kind of fact: permanent until a human
 * re-authorises, so no retry can succeed and dunning must PARK rather than spend a
 * schedule (`decline-policy.ts` classifies it, in smart mode and in
 * `PARK_EVEN_IN_FIXED_MODE` — without that carve-out a fixed-mode business exhausts on
 * the FIRST attempt and the subscription stays active and unpaid, the measured ₹66,025
 * failure in `planFailureRearm`). Exempted from `isHardDecline` via
 * {@link NOT_THE_INSTRUMENTS_FAULT}: the issuer was never asked, so nothing about the
 * card is `invalid`. The BACKUP instrument is still tried — it may carry a live mandate.
 *
 * Same two exemptions as the pending and spent refusals, for the same reasons: a gateway
 * with no mandate model (`capabilities.mandates === false`) can never be talking about a
 * mandate, and an UNDECLARED capability is not read as false.
 */
export function mandateExpiredRefusal(
  pm: Pm,
  /** `adapter.capabilities.mandates`. Absent means UNKNOWN, never false. */
  gatewayHasMandates: boolean | undefined,
  now: Date = new Date(),
): ChargeResult | null {
  if (gatewayHasMandates === false) return null;
  if (!mandateHasExpired(pm, now)) return null;
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: MANDATE_EXPIRED_CODE,
      /**
       * ⚠️ BUYER-FACING, by the same route as the other three refusals in this file: it
       * rides `payment_failed` as `declineMessage` inside "We were unable to charge your
       * payment method for X (…)" in the mail the payer receives.
       *
       * So it accuses them of nothing — an authorisation ending on the date the bank set
       * is not something they did — and it asks for the one action that clears it. It
       * names the DATE, because that is the fact the payer can check against their own
       * bank, and it says outright that retrying cannot work so nobody waits for a
       * schedule that will never run. It does not say `mandate`, `token` or `pm_…`.
       *
       * No AMOUNT: unlike the ceiling refusal, the figure is irrelevant here — a lapsed
       * authorization carries no debit of any size — and the mail this rides already
       * states the amount in its own opening sentence.
       */
      message:
        `The auto-debit authorization for this payment method${pm.mandateRail ? ` (${pm.mandateRail})` : ""} ` +
        `expired on ${pm.mandateExpiresAt?.toISOString().slice(0, 10) ?? "an earlier date"}, so we can no ` +
        "longer charge it. Authorize a payment method again to settle this invoice. " +
        "A retry of this charge cannot succeed.",
      retriable: false,
    },
    raw: {
      mandate_expires_at: pm.mandateExpiresAt?.toISOString() ?? null,
      mandate_status: pm.mandateStatus,
      mandate_rail: pm.mandateRail,
      mandate_reference: pm.mandateReference,
      gateway_mandates: gatewayHasMandates ?? null,
      now: now.toISOString(),
    },
  };
}

/**
 * A debit the instrument's MANDATE forbids, refused before the gateway sees it.
 *
 * Mandate rails (RazorPay e-mandate/UPI Autopay/card, Stripe's India e-mandate,
 * SEPA, ACH) bind the instrument to a per-debit ceiling agreed with the buyer at
 * registration and enforce it at debit time. `deriveMandateCeiling` sizes it
 * generously (largest active subscription × 3) but an upgrade, a quantity bump or
 * tax becoming applicable can still outgrow it months later.
 *
 * Letting that reach the gateway produces a refusal indistinguishable from an
 * ordinary decline: dunning retries it on a schedule, the backup instrument gets
 * burned, the pm may be marked `invalid` — and none of it can ever succeed, because
 * the mandate itself is the thing that has to change. Refusing here makes the
 * failure name its own remedy (re-authorize the mandate) and costs no gateway call.
 *
 * `retriable: false` is deliberate and means the same thing it means everywhere
 * else in this file (`isHardDecline`): do not keep retrying THIS instrument. The
 * backup card is a legitimate next candidate — it may carry a larger mandate, or
 * none at all.
 *
 * ⚠️ Only applies when the ceiling is KNOWN. A null `mandateMaxAmountMinor` means
 * unknown (no mandate rail, a provider that does not report it, or a row vaulted
 * before 0179), never unlimited — so the check is skipped and the gateway remains
 * the authority, exactly as before.
 */
export function mandateRefusal(
  pm: Pm,
  amountMinor: bigint,
  currency: string,
  /**
   * `adapter.capabilities.afaLinkAboveMandateMax` — the gateway offers the buyer a link
   * to authorise an over-ceiling debit rather than just refusing it.
   *
   * OPT-IN, and the default is what keeps the two call sites correct with one function.
   * The COLLECTION pre-flight passes it: there the alternative to the link is telling a
   * payer to re-register a mandate for a payment the gateway would have collected.
   * The CHECKOUT gate does NOT pass it and must not — that check asks "can this mandate
   * cover the plan this buyer is signing up for", and answering "yes, they can authorise
   * each debit by hand" would sell someone a subscription that needs a tap every cycle.
   */
  gatewayOffersAfaAboveMax?: boolean,
): ChargeResult | null {
  const ceiling = pm.mandateMaxAmountMinor;
  if (ceiling == null) return null;
  // A ceiling in a different currency cannot be compared to this amount, and
  // guessing an FX rate to compare them would be worse than not checking. Where the
  // gateway vouches for the stored currency, `mandateCurrencyRefusal` has already refused
  // the mismatch; elsewhere the gateway decides.
  if (pm.mandateCurrency && pm.mandateCurrency.toUpperCase() !== currency.toUpperCase())
    return null;
  if (amountMinor <= ceiling) return null;
  /**
   * THE SECOND AFA TRIGGER, which we refused locally until 2026-09-10.
   *
   * Narrow on all three axes, because the local refusal is right everywhere else:
   * the gateway must actually offer the link (`afaLinkAboveMandateMax`), and the debit
   * must be the shape Stripe documents it for — an INR card e-mandate, the same gate
   * `indiaCardMandateOptions` uses when registering the ceiling in the first place.
   *
   * What happens next is the point: Stripe answers `requires_action` carrying
   * `card_await_notification` with `customer_approval_required: true`, `bookPending`
   * records that statement, and the portal shows the approval CTA — one tap. If the
   * buyer ignores it the debit stalls its 26 hours and lands as `afa_not_completed`,
   * which parks (in fixed mode too) rather than cancelling. So the downside of being
   * wrong here is a parked invoice, and the upside is a collected one.
   */
  if (
    gatewayOffersAfaAboveMax &&
    currency.toUpperCase() === "INR" &&
    (pm.mandateRail ?? "").toLowerCase() === "card"
  )
    return null;
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: "mandate_ceiling_exceeded",
      /**
       * ⚠️ THIS STRING IS BUYER-FACING. It rides `payment_failed` as `declineMessage` and is
       * printed inside "We were unable to charge your payment method for X (…)" in the mail
       * the payer receives — as well as appearing in the operator's transaction log, which
       * is why it keeps both figures and the rail.
       *
       * It used to name `pm_…` and say "the mandate must be re-authorized by the customer",
       * i.e. it handed the payer our internal id and then described them in the third person
       * in a mail addressed to them. The ids are still available where they belong: `raw`
       * below carries them structurally, and the transaction row carries the payment method.
       */
      message:
        `This charge of ${formatMoney(amountMinor, currency)} is more than the ` +
        `${formatMoney(ceiling, pm.mandateCurrency ?? currency)} per-charge limit approved for this ` +
        `payment method${pm.mandateRail ? ` (${pm.mandateRail})` : ""}. ` +
        "A new authorization with a higher limit is necessary. A retry of this charge cannot succeed.",
      retriable: false,
    },
    raw: {
      mandate_max_amount_minor: ceiling.toString(),
      mandate_currency: pm.mandateCurrency,
      mandate_rail: pm.mandateRail,
      requested_amount_minor: amountMinor.toString(),
    },
  };
}

/** The failure code a not-yet-confirmed mandate refuses with. See {@link mandatePendingRefusal}. */
export const MANDATE_PENDING_CODE = "mandate_pending";

/**
 * How long to wait before re-attempting an invoice whose mandate is still awaiting the
 * bank, and how many times to do that before giving up and letting dunning run.
 *
 * 12 hours × 3 covers a day and a half — the T+1 netbanking confirmation window with room
 * for a bank that misses its own deadline. Both figures are a compromise between two
 * failure modes, and neither is arbitrary:
 *
 *  - Shorter/more: every deferral books a `payments` row and emits `payment_failed`,
 *    which MAILS THE PAYER (`emails/outbox.ts` — there is no per-invoice dedup). An hourly
 *    retry would send someone a dozen mails about a thing they cannot act on.
 *  - Longer/unbounded: a mandate the buyer abandoned at their bank stays `initiated`
 *    FOREVER. Deferring forever means the invoice never dunns, never exhausts, the final
 *    action never fires and the subscription stays active and unpaid — the exact
 *    "parking is dunning switched OFF" failure `sweepExpiredParkedDunning` exists to end.
 *    After the cap the refusal books as an ordinary retriable dunning failure and the
 *    schedule takes over.
 */
export const MANDATE_PENDING_RETRY_MS = 12 * 60 * 60 * 1000;
export const MANDATE_PENDING_MAX_DEFERRALS = 3;

/**
 * A debit against a mandate the bank has NOT CONFIRMED YET, refused before the gateway
 * sees it.
 *
 * `applyMandateUpdate` (`modules/webhooks/inbound.ts`) already handles the two ENDS of the
 * mandate lifecycle: a `DEAD_MANDATE_STATUSES` value flips `payment_methods.status` to
 * `invalid` so collection stops selecting the instrument, and a resume puts it back. The
 * PENDING MIDDLE was deliberately left alone, and it is a real window with real money in
 * it: a netbanking e-mandate is `initiated` from the moment the buyer finishes at their
 * bank until the bank confirms — HDFC and SBI take until T+1 — and for that whole window
 * the instrument is NOT chargeable while the row looks perfectly healthy (`status` valid,
 * `mandate_status` merely not yet live). The buyer portal says exactly this to the payer
 * (`portal-chrome.tsx`, `mandateState`); collection was the surface that did not know.
 *
 * So an invoice falling due inside that window was charged against an unconfirmed
 * mandate, refused at the gateway, and burned a dunning attempt — for an instrument we
 * had already been told is not live.
 *
 * ── retriable: TRUE, and the contrast with `mandateRefusal` is the whole point ────────
 * A ceiling breach is permanent until a human re-authorises at a higher limit, so it is
 * `retriable: false` and no retry can fix it. A pending mandate fixes ITSELF: the bank
 * confirms, `applyMandateUpdate` writes `confirmed`, and the very same debit succeeds.
 * That makes it the one refusal in this file that wants to be tried again unchanged —
 * later, not now, and not at the cost of a dunning slot (see
 * {@link mandatePendingBackoff}).
 *
 * ── What is deliberately NOT refused ─────────────────────────────────────────────────
 *  - An UNKNOWN status. `mandateChargeability` returns `unknown` for anything outside the
 *    three canonical sets, and only `pending` refuses here. Assuming a status we have no
 *    rule for is pending would block collection on a guess.
 *  - No status at all (`none`) — a plain card-on-file, or a rail whose provider never
 *    reports one. The gateway stays the authority, exactly as before.
 *  - A gateway with NO MANDATE MODEL. `capabilities.mandates === false` (PayPal: a
 *    `usage_type: MERCHANT` billing agreement has no per-debit ceiling and no mandate
 *    status to read back) means the absence of mandate data is not missing data, and
 *    nothing this guard could read would ever be about a mandate. It is refused
 *    explicitly rather than left to fall out of the null check, because that null check
 *    is an accident of PayPal not writing the column and this is the statement we
 *    actually mean. `undefined` (an adapter that has not declared the capability) is NOT
 *    read as `false` — same conservative reading the capability's own docstring takes —
 *    so a status that IS present still counts.
 */
export function mandatePendingRefusal(
  pm: Pm,
  /** `adapter.capabilities.mandates`. Absent means UNKNOWN, never false. */
  gatewayHasMandates: boolean | undefined,
): ChargeResult | null {
  if (gatewayHasMandates === false) return null;
  if (mandateChargeability(pm) !== "pending") return null;
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: MANDATE_PENDING_CODE,
      /**
       * ⚠️ BUYER-FACING, for the same reason and by the same route as `mandateRefusal`'s:
       * it rides `payment_failed` as `declineMessage` inside "We were unable to charge
       * your payment method for X (…)" in the mail the payer receives.
       *
       * So it has to end the sentence the mail starts — the payer's question is "what did
       * I do wrong", and the answer is nothing. It names the bank as the party being
       * waited on, gives the T+1 shape of the wait, and says outright that we retry and
       * they need do nothing. It does NOT tell them to re-add their payment method: doing
       * so would register a SECOND mandate and leave the first one dangling at the bank.
       */
      message:
        "Your bank did not confirm the auto-debit authorization for this payment method yet" +
        `${pm.mandateRail ? ` (${pm.mandateRail})` : ""}, so we cannot charge it. ` +
        "Banks usually confirm within one working day. We will try again automatically. " +
        "You do not need to do anything.",
      retriable: true,
    },
    raw: {
      mandate_status: pm.mandateStatus,
      mandate_rail: pm.mandateRail,
      mandate_reference: pm.mandateReference,
      gateway_mandates: gatewayHasMandates ?? null,
    },
  };
}

/** The failure code a used-up single-use mandate refuses with. See {@link mandateSpentRefusal}. */
export const MANDATE_SPENT_CODE = "mandate_spent";

/**
 * A debit against a SINGLE-USE mandate that has already carried its one debit, refused
 * before the gateway sees it (F-43).
 *
 * `spent` is a real, deliberately reported status: `describeStripeMandate` distinguishes
 * Stripe's `inactive` on a `multi_use` mandate (a revocation → `cancelled`) from the same
 * word on a `single_use` one (the ordinary end of a one-shot authorization → `spent`),
 * because mapping the second onto the first would brand a perfectly good instrument
 * `invalid` and push the customer onto their backup for no reason.
 *
 * What that left behind was the mirror-image hole. `spent` belonged to none of the status
 * sets, so `mandateChargeability` answered `unknown`: the pending guard did not refuse it
 * (right — it is not pending), `applyMandateUpdate` did not invalidate on it (right — it
 * is not dead), and so NOTHING stopped collection debiting an authorization that had
 * already been used. Meanwhile the buyer portal's `mandateState` treats every
 * unrecognised status as over and told the payer the authorization was finished. The
 * payer was told one thing and the engine did another.
 *
 * A spent single-use mandate cannot carry another debit — that is what single-use means —
 * so this refusal is the thing that actually stops the charge. Adding `spent` to
 * `DEAD_MANDATE_STATUSES` instead would have written `payment_methods.status = 'invalid'`
 * and STILL sent the debit, because `resolveChargeCandidates` does not filter on that
 * column.
 *
 * ── retriable: FALSE, and not a hard decline either ──────────────────────────────────
 * Non-retriable because no retry can ever work: unlike `mandate_pending` this does not
 * fix itself, and unlike `mandate_ceiling_exceeded` not even a smaller debit succeeds.
 * `isHardDecline` still exempts it, for the same reason it exempts the ceiling refusal —
 * nothing about the INSTRUMENT is wrong, and branding it `invalid` would say the bank
 * refused a card that was never asked. `shouldTryBackup` is deliberately NOT exempted:
 * the backup instrument is a legitimate next candidate and may carry a live mandate.
 *
 * `decline-policy.ts` classifies the code as `park` in smart mode and carries it in
 * `PARK_EVEN_IN_FIXED_MODE`; leaving it unclassified would have exhausted dunning on the
 * FIRST attempt in fixed mode, which is the measured ₹66,025 failure documented in
 * `planFailureRearm`.
 *
 * Same two exemptions as {@link mandatePendingRefusal}, for the same reasons: a gateway
 * with no mandate model (`capabilities.mandates === false`) can never be talking about a
 * mandate, and an UNDECLARED capability is not read as false.
 */
export function mandateSpentRefusal(
  pm: Pm,
  /** `adapter.capabilities.mandates`. Absent means UNKNOWN, never false. */
  gatewayHasMandates: boolean | undefined,
): ChargeResult | null {
  if (gatewayHasMandates === false) return null;
  if (mandateChargeability(pm) !== "spent") return null;
  return {
    status: "failed",
    providerChargeId: "",
    failure: {
      code: MANDATE_SPENT_CODE,
      /**
       * ⚠️ BUYER-FACING, by the same route as the other two refusals in this file: it
       * rides `payment_failed` as `declineMessage` inside "We were unable to charge your
       * payment method for X (…)" in the mail the payer receives.
       *
       * So it must not accuse them of anything — they authorised a single payment and it
       * was taken, exactly as agreed. Unlike the pending refusal it DOES ask for an
       * action, because nothing else will clear this one: the authorization is finished
       * and a new one is needed. It says so in the buyer's terms ("one-time
       * authorization"), never in ours (`single_use`, `mandate`, `pm_…`).
       */
      message:
        "The one-time payment authorization for this payment method is already " +
        `used${pm.mandateRail ? ` (${pm.mandateRail})` : ""}, so we cannot charge it again. ` +
        "Authorize a new payment method to settle this invoice.",
      retriable: false,
    },
    raw: {
      mandate_status: pm.mandateStatus,
      mandate_rail: pm.mandateRail,
      mandate_reference: pm.mandateReference,
      gateway_mandates: gatewayHasMandates ?? null,
    },
  };
}

/**
 * When to come back after a {@link mandatePendingRefusal} — or null, meaning "book this
 * as an ordinary dunning failure and let the schedule have it".
 *
 * ── Why this exists at all: the refusal must not SPEND a dunning attempt ─────────────
 * `recordFailedPayment` advances `invoices.attempt_count` on every non-manual failure, and
 * that counter is the INDEX into the retry offsets (`nextRetryAt`) — so a refusal booked
 * the ordinary way consumes one of the customer's scheduled retries. Burning a slot for
 * an instrument we already knew was not live is precisely the bug (F-11), and refusing
 * locally instead of at the gateway would otherwise fix only the wasted round trip while
 * leaving the expensive half in place.
 *
 * Holding the counter still is NOT enough on its own, and this is the part that is easy
 * to get wrong: the retry offsets are absolute, measured from the invoice DUE DATE, and
 * `nextRetryAt` CLAMPS a candidate in the past to `now`. Re-planning with an unchanged
 * count therefore recomputes the slot the clock has already passed, clamps it to now, and
 * the next pass collects again immediately — a hot loop that mails the payer once per
 * tick. The counter hold needs an explicit backoff beside it, which is what this returns.
 *
 * The caller applies it ONLY on the `retry` branch of `planFailureRearm`, so a merchant's
 * `stop_dunning`, a pause window, an auto-collect-off invoice and an exhausted schedule
 * all keep their existing disposition untouched — a deferral can never resurrect dunning
 * that someone deliberately halted.
 */
export function mandatePendingBackoff(input: {
  failureCode: string;
  /**
   * Deferrals already booked against this invoice, INCLUDING the one being written now
   * (the caller counts `payments` rows carrying {@link MANDATE_PENDING_CODE}, and the row
   * for this attempt is inserted first). So the first refusal arrives here as 1.
   */
  deferralsSoFar: number;
  now: Date;
}): Date | null {
  if (input.failureCode !== MANDATE_PENDING_CODE) return null;
  if (input.deferralsSoFar >= MANDATE_PENDING_MAX_DEFERRALS) return null;
  return new Date(input.now.getTime() + MANDATE_PENDING_RETRY_MS);
}

export async function chargeWithMethod(input: {
  organizationId: string;
  businessId: string;
  currency: string;
  pm: Pm;
  amountMinor: bigint;
  idempotencyKey: string;
  /**
   * OUR public id for the thing this money is for, stamped on the gateway object (#31).
   * REQUIRED, and it comes from the caller rather than being derived here, because only
   * the caller knows which row that is: invoice collection names the INVOICE, the
   * pre-invoice signup names the SUBSCRIPTION (no invoice exists yet). Deriving it here
   * would mean parsing `idempotencyKey`, which is precisely the bridge #31 removes — a
   * key is not a public id and resolves to no row of ours (asserted: verify:gateway
   * #31-B4). Required rather than optional so a new call site cannot silently re-open
   * the fallback; the compiler asks for it.
   */
  ownershipRef: string;
  description: string;
  contact: ChargeContact | null;
  /**
   * Enforce gateway pre-debit notices (`preDebitGate`) for an invoice, a wallet top-up or an
   * automatic credit top-up. The pre-invoice signup charge omits it: on a notice rail it never
   * gets here (`deferred`).
   */
  preDebit?:
    | { invoiceId: string; subscriptionId: string | null }
    | { purpose: "wallet_topup" | "credit_topup" };
  /**
   * Runs once every pre-flight refusal and the notice gate have passed, right before the
   * gateway call. A caller that books its attempt here writes nothing for a deferral.
   */
  beforeGatewayCall?: () => Promise<void>;
  /** Who started the debit (`ChargeInput.initiator`). Absent = unknown. */
  initiator?: ChargeInitiator;
  /** `ChargeInput.invoiceDueDate`: the due day in the business's timezone. Absent = now. */
  invoiceDueDate?: string | null;
}): Promise<ChargeAttempt> {
  const { pm, contact } = input;
  const { adapter, account } = await resolveChargeAdapter({
    organizationId: input.organizationId,
    businessId: input.businessId,
    currency: input.currency,
    pm,
  });
  // Pre-flight AFTER adapter resolution, so the attempt is still attributed to the
  // gateway account that would have taken it — the transaction recorded for this
  // refusal names the right gateway, and analytics do not develop a blind spot.
  //
  // EXPIRY BEFORE THE CEILING, and this order is load-bearing rather than cosmetic.
  // `mandateRefusal`'s buyer-facing message says a smaller charge on the same mandate
  // would succeed — measured, and true of a live mandate (₹13,870 captured on a ₹15,000
  // one that refused ₹66,025). On a LAPSED mandate that sentence is false: no amount
  // collects. Reporting the ceiling first would send the payer to argue with a limit when
  // the authorisation itself is over, and both refusals ask for the same remedy anyway
  // (authorise again), so nothing is lost by answering with the more fundamental fact.
  // MISSING BEFORE EXPIRED, and this order is load-bearing too. With no mandate at all
  // there is no end date, no ceiling and no status, so every refusal below returns null and
  // the debit reaches the gateway — the wasted call that leaves the orphaned PaymentIntent.
  // It is also the only one of the five whose message is TRUE in that state: "expired on
  // <date>" needs a date, and the ceiling message promises a smaller charge would collect.
  // CURRENCY FIRST: no other answer is true of a mandate that cannot debit this currency.
  const wrongCurrency = mandateCurrencyRefusal(pm, input.currency);
  if (wrongCurrency)
    return { result: wrongCurrency, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
  const unauthorised = mandateMissingRefusal(pm, adapter.capabilities);
  if (unauthorised)
    return { result: unauthorised, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
  const lapsed = mandateExpiredRefusal(pm, adapter.capabilities.mandates);
  if (lapsed) return { result: lapsed, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
  // CEILING NEXT, then liveness. Both can be true of one instrument — a mandate is
  // registered with its ceiling and is `initiated` at the same moment — and the ceiling
  // is the more useful of the two answers: it is permanent, and its remedy
  // (re-authorise at a higher limit) is also the remedy for the pending one, whereas
  // reporting "wait for your bank" first would tell the payer to wait for a confirmation
  // that still could not collect this invoice.
  const refused = mandateRefusal(
    pm,
    input.amountMinor,
    input.currency,
    adapter.capabilities.afaLinkAboveMandateMax,
  );
  if (refused)
    return { result: refused, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
  // SPENT before PENDING. They are mutually exclusive (`mandateChargeability` answers
  // one word), so the order is documentation rather than precedence — but it keeps the
  // two liveness answers adjacent and after the ceiling, which owns the case where both
  // a ceiling breach and a liveness problem are true of the same instrument.
  const spent = mandateSpentRefusal(pm, adapter.capabilities.mandates);
  if (spent) return { result: spent, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
  const notLive = mandatePendingRefusal(pm, adapter.capabilities.mandates);
  if (notLive)
    return { result: notLive, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
  let preDebitNotice: ChargeInput["preDebitNotice"];
  if (input.preDebit) {
    const gate = await preDebitGate({
      organizationId: input.organizationId,
      businessId: input.businessId,
      adapter,
      account,
      pm,
      amountMinor: input.amountMinor,
      currency: input.currency,
      contact,
      ...("purpose" in input.preDebit
        ? { purpose: input.preDebit.purpose }
        : {
            purpose: "invoice" as const,
            invoiceId: input.preDebit.invoiceId,
            subscriptionId: input.preDebit.subscriptionId,
          }),
    });
    const gatewayKey = account?.gatewayKey ?? pm.providerKey;
    if (gate.kind === "refused") return { result: gate.result, account, gatewayKey };
    if (gate.kind === "wait")
      return {
        result: { status: "pending", providerChargeId: "" },
        account,
        gatewayKey,
        deferredUntil: gate.until,
      };
    if (gate.kind === "ready") preDebitNotice = gate.notice;
  }
  /**
   * The ONE place every caller's charge goes through, so the one place worth catching a
   * stranded object in.
   *
   * An error the adapter did not recognise is rethrown on purpose — it is our bug and the
   * caller must see it — but it may have left a live object at the gateway, which the
   * adapter now stamps (`markStrandedObject`). Nothing here can honestly BOOK it: this is
   * not a refusal we understand, and inventing a decline would bury the bug. So it is
   * named in the log, where the sweep that reads `gateway_request_logs` can be joined to
   * it, and the error goes on up unchanged.
   */
  await input.beforeGatewayCall?.();
  let result: ChargeResult;
  await paceGatewayCharge(account?.id ?? adapter.key);
  try {
    result = await adapter.charge({
      amountMinor: input.amountMinor,
      currency: input.currency,
      customer: { providerKey: adapter.key, providerCustomerId: pm.providerCustomerId },
      paymentMethod: providerPaymentMethodRef(pm, adapter.key),
      idempotencyKey: input.idempotencyKey,
      ownershipRef: input.ownershipRef,
      // Stripe India rejects an off-session recurring confirm without it (#63). We hold
      // it; the adapter decides whether its own rail needs it.
      mandateReference: pm.mandateReference,
      description: input.description,
      ...(contact?.email ? { email: contact.email } : {}),
      ...(contact?.phone ? { phone: contact.phone } : {}),
      ...(preDebitNotice ? { preDebitNotice } : {}),
      ...(input.initiator ? { initiator: input.initiator } : {}),
      ...(input.invoiceDueDate ? { invoiceDueDate: input.invoiceDueDate } : {}),
    });
  } catch (e) {
    if (e instanceof ProviderIndeterminateError)
      lostCharges.set(e, {
        account,
        gatewayKey: account?.gatewayKey ?? adapter.key,
        idempotencyKey: input.idempotencyKey,
        ownershipRef: input.ownershipRef,
      });
    const stranded = strandedObjectId(e);
    if (stranded) {
      log.error(e as Error, {
        event: "gateway_charge_stranded_object",
        gateway: adapter.key,
        object_at_gateway: stranded,
        payment_method: pm.publicId,
      });
    }
    throw e;
  }

  // Too early, not declined: the notice stays good and the debit waits for it.
  if (
    preDebitNotice &&
    result.status === "failed" &&
    result.failure?.code === PRE_DEBIT_NOT_DUE_CODE
  ) {
    const until = await releaseGatewayNotice({
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentMethodId: pm.id,
      notificationRef: preDebitNotice.notificationRef,
      retryAfterMs: result.failure.retryAfterMs,
    });
    // A caller that booked its attempt before the call keeps the failure on it.
    if (!input.beforeGatewayCall)
      return {
        result: { status: "pending", providerChargeId: "" },
        account,
        gatewayKey: account?.gatewayKey ?? pm.providerKey,
        deferredUntil: until,
      };
  }

  /**
   * REMEMBER a missing mandate, so the next debit never reaches the gateway.
   *
   * The gateway is the only honest source for "this instrument needs an authorization and
   * has none" — our own columns cannot tell a migrated India card from a plain
   * card-on-file (all 13 of the migrated ones are bare). Stripe answers it once, in prose
   * the adapter classifies as `mandate_missing`; this writes the answer down, and
   * `mandateMissingRefusal` reads it on every attempt after.
   *
   * Only the mandate STATUS is touched. The instrument is not branded invalid — nothing
   * was declined, it is un-authorized (see NOT_THE_INSTRUMENTS_FAULT) — and the reference,
   * rail and ceiling stay as they are so a later backfill or re-authorisation can fill
   * them in. Idempotent, and deliberately not fatal: failing a charge because we could not
   * annotate a row would be worse than forgetting.
   */
  if (
    result.status === "failed" &&
    result.failure?.code === MANDATE_MISSING_CODE &&
    mandateChargeability(pm) !== "missing"
  ) {
    try {
      await withTenant(input.organizationId, (tx) =>
        tx
          .update(paymentMethods)
          .set({ mandateStatus: MANDATE_MISSING_STATUS })
          .where(eq(paymentMethods.id, pm.id)),
      );
      log.warn("the gateway reports no mandate for this instrument — remembered", {
        event: "mandate_missing_learned",
        gateway: adapter.key,
        payment_method: pm.publicId,
      });
    } catch (e) {
      log.error(e as Error, {
        event: "mandate_missing_not_recorded",
        payment_method: pm.publicId,
      });
    }
  }
  /**
   * The merchant's own answer, layered on last (#69 stage 3).
   *
   * Here rather than in the adapter because `providers/` may not import from `modules/`
   * and an adapter has no tenant — see `applyDeclineOverride`. Here rather than at the
   * call sites because this is the single place an adapter's answer becomes ours, so a
   * new caller cannot forget it.
   *
   * Only the adapter's answer is overridden: the local refusals above (ceiling, expired,
   * spent, pending) return earlier, which is why this sits on the final return alone. Keyed
   * on the CODE, not only `ruleId`, so a code-level override also reaches a decline the
   * legacy table normalised — the screen offers that lever.
   */
  const overridden =
    result.status === "failed" && result.failure?.code
      ? {
          ...result,
          failure: await withTenant(input.organizationId, (tx) =>
            applyDeclineOverride(tx, {
              businessId: input.businessId,
              gatewayAccountId: account?.id ?? null,
              decline: result.failure!,
            }),
          ),
        }
      : result;
  return { result: overridden, account, gatewayKey: account?.gatewayKey ?? pm.providerKey };
}

/**
 * A HARD decline (bad instrument — mark it `invalid`) is signalled by the adapter
 * marking the failure NON-retriable. This is the single authoritative signal: a
 * retriable failure (insufficient_funds, gateway_error, vault_ok_charge_fails)
 * leaves the instrument `valid` — even if its code happens to be `card_declined`.
 * Whether the backup is tried is `shouldTryBackup`'s call, not this one.
 */
export function isHardDecline(r: {
  status: string;
  failure?: { retriable?: boolean; code?: string };
}): boolean {
  if (r.status !== "failed" || r.failure?.retriable !== false) return false;
  return !NOT_THE_INSTRUMENTS_FAULT.has(r.failure?.code ?? "");
}

/**
 * Non-retriable refusals that must NOT brand the payment method `invalid`.
 *
 * ⚠️ Non-retriable does NOT always mean "bad instrument", and these are the exceptions.
 * All three are refused by OUR pre-flight, before any gateway is asked — so the issuer
 * never said a word about the card, and recording `invalid` would put our inference in
 * the column where a bank's verdict belongs.
 *
 *  - `mandate_ceiling_exceeded` — the AMOUNT was too large, not the instrument broken: a
 *    smaller debit on the very same mandate succeeds (measured: ₹13,870 captured on a
 *    ₹15,000 mandate that refused ₹66,025). Treating it as a hard decline marked the
 *    method `invalid` and took it out of collection for every FUTURE charge too,
 *    including the smaller ones it can still pay — caught by the frontend flow, where a
 *    Business signup refused for exceeding the ceiling left the customer's card flagged
 *    invalid behind it.
 *  - `mandate_expired` — the AUTHORIZATION ended on the date the bank set, which is not a
 *    verdict on the card. The instrument may well be re-authorisable on the spot, and in
 *    the measured RazorPay case the card behind it is a 01/2099 test card in perfect
 *    health. Branding it `invalid` would also outlive the mandate: the row stays written
 *    off long after a new authorisation is registered against the same instrument.
 *    (When the GATEWAY says the mandate is dead, `isDeadMandateDecline` does mark it
 *    `invalid`, as a dead-mandate webhook does — with the renew-authorization email.)
 *  - `mandate_spent` (F-43) — a single-use authorization that was used exactly as agreed.
 *    Nothing about the card is wrong; the AUTHORIZATION is finished, and that fact is
 *    already recorded where it belongs, in `payment_methods.mandate_status`. Writing it a
 *    second time as instrument-level `invalid` would be a lossier copy that cannot tell
 *    "the bank refused this card" from "this one-shot mandate was spent".
 *
 * All three stay non-retriable — retrying can never work — so dunning parks rather than
 * loops (`decline-policy.ts` classifies all three, in smart mode and in fixed). The backup
 * instrument is still tried in every case, because that is `shouldTryBackup`'s call and a
 * different instrument may well carry a live, larger mandate.
 */
const NOT_THE_INSTRUMENTS_FAULT: ReadonlySet<string> = new Set([
  "mandate_ceiling_exceeded",
  // Refused before the gateway: the mandate is good for its own currency.
  MANDATE_CURRENCY_CODE,
  MANDATE_SPENT_CODE,
  MANDATE_EXPIRED_CODE,
  // The card was never asked to pay: the authorisation behind it is absent, which is our
  // record's problem and not a verdict on the instrument.
  MANDATE_MISSING_CODE,
  /**
   * The gateway refused OUR REQUEST, so the issuer was never asked either — and unlike the
   * four above, this one is not even about the mandate. It is in `MERCHANT_SIDE_PARK`
   * precisely because nobody but us can clear it.
   *
   * ⚠️ Added 2026-09-10 after the row contradicted itself: every rule that emits this code
   * carries the message "Nothing is wrong with the customer's payment method", and then
   * `isHardDecline` marked that very payment method `invalid` — pulling a working card out
   * of collection for every FUTURE charge over a fault of ours. Latent in the Stripe rules
   * since #63; reachable for RazorPay the moment `BAD_REQUEST_ERROR` was corrected to this
   * code earlier the same day.
   *
   * Stays NON-retriable, like the others here: re-presenting an identical rejected request
   * cannot succeed, so dunning parks rather than loops. The backup is still tried —
   * `shouldTryBackup`'s call, and a different instrument may route to a different account.
   */
  "gateway_request_rejected",
]);

/**
 * Should the BACKUP instrument be tried after this failure? Yes, for any decline —
 * except when the customer withdrew consent or the issuer flagged fraud.
 *
 * A soft decline (insufficient funds, a gateway hiccup) may clear on this card later,
 * but the backup can pay today — that is what the customer designated it for. Only
 * `isHardDecline` blames the instrument; a soft decline leaves the primary `valid`, so
 * the next renewal and every dunning retry still charge it first.
 *
 * `STOP_FALLBACK` is the exception. A revoked authorization or a disputed debit is the
 * payer telling their bank to stop, and charging their other card straight after is a
 * second debit they did not want; a fraud flag followed by more cards on the same
 * customer is the card-testing pattern gateway risk screens act on.
 *
 * Success, pending and authentication outcomes never reach here as `failed`, so an
 * attempt whose money may still move is never followed by a second charge.
 */
export function shouldTryBackup(r: { status: string; failure?: { code?: string } }): boolean {
  if (r.status !== "failed") return false;
  return !STOP_FALLBACK.has((r.failure?.code ?? "").toLowerCase());
}

const STOP_FALLBACK: ReadonlySet<string> = new Set([
  "revocation_of_authorization",
  "debit_not_authorized",
  "fraudulent",
]);

/**
 * How recoverable a failed attempt leaves the invoice: 0 retry, 1 park (a new or
 * re-authorised instrument recovers it), 2 terminate. When one run declines on several
 * cards, the LOWEST rank governs dunning — the invoice is only as dead as its best card.
 */
export function collectionRank(r: { failure?: { retriable?: boolean; code?: string } }): number {
  if (r.failure?.retriable !== false) return 0;
  return TERMINATE.has((r.failure?.code ?? "").toLowerCase()) ? 2 : 1;
}

/** The tmtest harness's scripted outcome, when the fake gateway supplied one. */
export function tmtestOutcome(r: ChargeResult): string | undefined {
  return (r.raw as { tmtest_outcome?: string } | undefined)?.tmtest_outcome;
}

/**
 * Mark an instrument unusable after a hard decline, and SAY SO.
 *
 * The status write used to be silent: no event, so no webhook and no email for the one
 * payment-method state the customer has to act on. A card that merely expires gets both
 * (`payment_source_expired`, via the C6 sweep) while a card the bank refuses outright got
 * neither — the customer found out when their subscription was cancelled.
 *
 * Emitted inside the same transaction as the status change, so a subscriber can never
 * observe one without the other. No-ops when the row is already `invalid`, otherwise a
 * dunning run that hard-declines on every retry would mail the customer once per attempt.
 */
export async function markPaymentMethodInvalid(
  organizationId: string,
  pmId: string,
  /** `mandate` when the gateway killed the authorization, not the instrument. Routes the
   * customer to the "renew your authorization" email instead of "add a new method". */
  reason?: "mandate",
): Promise<void> {
  await withTenant(organizationId, async (tx) => {
    const [pm] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, pmId)).limit(1);
    if (!pm || pm.status === "invalid") return;
    await setPaymentMethodStatus(tx, organizationId, pmId, "invalid");
    await emitEvent(tx, {
      organizationId,
      businessId: pm.businessId,
      type: "payment_source_invalidated",
      data: buildEventData(
        "payment_source_invalidated",
        { id: pm.publicId, type: pm.type, brand: pm.brand, last4: pm.last4 },
        undefined,
        // Top-level for the same reason as the sweep's `expiry_reason`: the nested
        // resource is replaced on enrichment.
        reason ? { invalid_reason: reason } : undefined,
      ),
    });
  });
}

/**
 * The GATEWAY said the mandate is dead (cancelled, revoked, invalid) — not our own
 * end-date pre-flight, which the payment-source sweep already demotes to `expired`.
 *
 * Same verdict a dead-mandate webhook reaches in `applyMandateUpdate`: the method is
 * `invalid`, so collection stops selecting it and a backup moves up. It stays out of
 * `isHardDecline` because the card behind it is not at fault, which is what decides
 * the email the customer gets.
 */
export function isDeadMandateDecline(
  r: { status: string; failure?: { code?: string } },
  pm: { mandateExpiresAt?: Date | null },
  now: Date = new Date(),
): boolean {
  return (
    r.status === "failed" && r.failure?.code === MANDATE_EXPIRED_CODE && !mandateHasExpired(pm, now)
  );
}

/**
 * Whether a BUYER is present at the other end of the request that triggered this
 * collection.
 *
 * The distinction is the whole reason `requires_action` has two correct answers:
 *  - `off_session` (the DEFAULT everywhere, and the only value the billing clock,
 *    the dunning pass, renewals and every operator-triggered collect ever use):
 *    nobody can complete a 3DS challenge, so `requires_action` is a retriable
 *    dunning failure — unchanged, byte for byte.
 *  - `on_session`: the buyer is in a browser right now (hosted checkout, or an API
 *    caller that says so explicitly), so instead of failing we mint a payment
 *    intent and hand back its `next_action` for them to complete.
 *
 * It is never inferred. A caller states it, or it is off-session.
 */
export type CollectionSession = "on_session" | "off_session";

/**
 * Mint the payment intent + first attempt that carries an ON-SESSION buyer through
 * a `requires_action` challenge.
 *
 * Returns `null` when the gateway cannot represent an intent at all (adapters
 * without `createIntent`, a router that cannot place the charge) — the caller then
 * falls back to the off-session answer, so a gateway gap degrades to today's
 * behaviour instead of erroring the request.
 */
export async function intentForOnSessionChallenge(input: {
  organizationId: string;
  businessId: string;
  pm: Pm;
  amountMinor: bigint;
  currency: string;
  invoicePublicId?: string;
  subscriptionPublicId?: string;
  returnUrl?: string;
  cancelUrl?: string;
}): Promise<{ intent: PaymentIntent; attempt: PaymentAttempt } | null> {
  try {
    return await createPaymentIntent({
      organizationId: input.organizationId,
      businessId: input.businessId,
      purpose: "payment",
      paymentMethodPublicId: input.pm.publicId,
      amountMinor: Number(input.amountMinor),
      currency: input.currency,
      session: "on_session",
      ...(input.invoicePublicId ? { invoicePublicId: input.invoicePublicId } : {}),
      ...(input.subscriptionPublicId ? { subscriptionPublicId: input.subscriptionPublicId } : {}),
      ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
    });
  } catch (e) {
    log.error(e, {
      event: "on_session_intent_failed",
      paymentMethod: input.pm.publicId,
      fallback: "off_session_outcome",
    });
    return null;
  }
}

/** Whether the primary instrument's debits wait on a gateway notice. A routing error says no: the charge path reports it. */
async function primaryNeedsNotice(input: {
  organizationId: string;
  businessId: string;
  currency: string;
  pm: Pm;
}): Promise<boolean> {
  // Refused at the charge, so there is nothing to give notice of.
  if (mandateCurrencyDiffers(input.pm, input.currency)) return false;
  try {
    const { adapter } = await resolveChargeAdapter(input);
    return needsGatewayNotice(adapter, input.pm);
  } catch (e) {
    if (e instanceof GatewayRouterError) return false;
    throw e;
  }
}

/**
 * A charge that has ALREADY been made against the gateway, handed to
 * `commitSubscriptionPeriodInvoice` so it books the money instead of charging
 * again. `outcome` is the settled reading of `result.status` + the tmtest hint:
 * `succeeded` books a paid invoice, `pending` books an unsettled attempt for the
 * inbound reconciler.
 */
export interface CompletedCharge {
  pm: Pm;
  account: GwAccount | null;
  gatewayKey: string;
  result: ChargeResult;
  amountMinor: bigint;
  outcome: "succeeded" | "pending";
  /** For `pending`: which unsettled transaction status to record. */
  pendingStatus?: "in_progress" | "timeout" | "needs_attention";
}

export type PreChargeOutcome =
  | { kind: "charged"; charge: CompletedCharge }
  /**
   * ON-SESSION only: the gateway wants the buyer to authenticate. Nothing was
   * recorded (no payment, no transaction, no event) — the signup has not failed,
   * it is waiting. The caller discards the provisional subscription and hands the
   * intent's `next_action` to the buyer, who completes it and re-creates the
   * subscription passing `payment_intent`.
   */
  | { kind: "action_required"; intent: PaymentIntent; attempt: PaymentAttempt; pm: Pm }
  /**
   * The primary instrument needs a gateway pre-debit notice, so nothing was charged and
   * nothing recorded. The caller commits the invoice and collects it: `preDebitGate`
   * sends the notice and defers the debit, like a renewal.
   */
  | { kind: "deferred"; pm: Pm }
  | {
      kind: "declined";
      failureCode: string;
      /** Operator text. */
      failureMessage: string;
      /** What a buyer may read — after the business's "Tell the customer" override. */
      payerMessage: string;
      pm: Pm | null;
    };

/**
 * Book a refused signup attempt: a failed payment + its gateway transaction +
 * `payment_failed`. The subscription and invoice are discarded, but the CHARGE
 * really was attempted and really did fail, and a merchant needs to see why the
 * signup was refused. The payment carries no invoice (there is none) and nothing
 * is posted to the ledger (no money moved).
 */
async function recordDeclinedSignupAttempt(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  /** No invoice exists yet, so the transaction names the subscription itself. */
  subscriptionId: string;
  currency: string;
  amountMinor: bigint;
  pm: Pm;
  attempt: ChargeAttempt;
}): Promise<void> {
  const { organizationId, businessId, customerId, currency, amountMinor, pm, attempt: a } = input;
  const code =
    a.result.failure?.code ??
    (a.result.status === "requires_action" ? "requires_action" : "charge_failed");
  const message =
    a.result.failure?.message ??
    (a.result.status === "requires_action"
      ? "The payment needs additional authentication."
      : "Charge failed");
  const retriable = a.result.failure?.retriable ?? true;
  await withTenant(organizationId, async (tx) => {
    const [cus] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, customerId))
      .limit(1);
    const [pay] = await tx
      .insert(payments)
      .values({
        organizationId,
        businessId,
        customerId,
        invoiceId: null,
        paymentMethodId: pm.id,
        publicId: publicId("pay"),
        status: "failed",
        amountMinor,
        currency,
        providerKey: a.gatewayKey,
        methodType: methodTypeOf(a.result, pm),
        failureCode: code,
        failureMessage: message,
      })
      .returning();
    await recordTransaction(
      {
        organizationId,
        businessId,
        customerId,
        type: "payment",
        status: "failed",
        amountMinor,
        currency,
        gatewayAccountId: a.account?.id ?? null,
        gatewayKey: a.gatewayKey,
        idAtGateway: a.result.providerChargeId ?? null,
        paymentMethodId: pm.id,
        paymentId: pay!.id,
        subscriptionId: input.subscriptionId,
        errorCode: code,
        errorText: message,
        retriable: a.result.failure?.retriable ?? null,
      },
      tx,
    );
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_failed",
      // No `invoice` ref exists on this one — the signup it belonged to was
      // refused — so the payment carries the CUSTOMER directly instead, which is
      // what the enriched envelope (and any consumer) needs to place it.
      data: buildEventData("payment_failed", {
        id: pay!.publicId,
        status: "failed",
        amount_minor: Number(amountMinor),
        currency,
        customer: cus?.publicId ?? null,
        code,
        message: payerDeclineMessage(
          { code, message, exposedToPayer: a.result.failure?.exposedToPayer },
          message,
        ),
        retriable,
      }),
    });
  });
}

/**
 * Charge a brand-new subscription's first period BEFORE anything about it is
 * persisted-and-visible. Same candidate order and same
 * hard-decline/backup-card rule as `collectInvoice`, but it writes NOTHING: there
 * is no invoice to attach a payment to yet, and a refused signup must leave no
 * trace at all. The caller either commits the invoice WITH the returned charge, or
 * deletes the provisional subscription and answers 402.
 */
export async function chargeBeforeSubscriptionInvoice(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  subscription: Sub;
  amountMinor: bigint;
  currency: string;
  /**
   * Defaults to `off_session` — every existing caller omits it and keeps today's
   * behaviour exactly. `on_session` (hosted checkout, or an API signup that
   * declares the buyer is present) turns a `requires_action` into an intent the
   * buyer can complete rather than a refused signup.
   */
  session?: CollectionSession;
  /** Where the gateway returns the buyer after a redirect challenge (on-session). */
  returnUrl?: string;
  cancelUrl?: string;
  /** What the charge is for, on the gateway's description. Defaults to a signup. */
  flow?: "new_subscription" | "reactivation";
  /**
   * Makes the gateway idempotency key unique to THIS charge. A signup has one first charge
   * per subscription, so it needs none; a reactivation is a later charge on the same
   * subscription and must not reuse the signup's key, or the gateway returns the old charge.
   */
  idempotencyScope?: string;
}): Promise<PreChargeOutcome> {
  const { organizationId, businessId, customerId, subscription } = input;
  const contact = await loadChargeContact(organizationId, customerId);
  const candidates = await resolveChargeCandidates({
    organizationId,
    customerId,
    subscription,
    currency: input.currency,
  });
  if (!candidates.primary) {
    return {
      kind: "declined",
      failureCode: "no_payment_method",
      failureMessage: "Customer has no saved payment method",
      payerMessage: "There is no saved payment method to charge.",
      pm: null,
    };
  }

  // Card limit (0482): above it no card is charged. With only cards on file the signup is
  // refused, as for any first charge that cannot be taken; nothing is created.
  let order = chargeOrder(candidates);
  if (order.some(isCardInstrument)) {
    const [biz] = await withTenant(organizationId, (tx) =>
      tx
        .select({ cardPaymentLimits: businesses.cardPaymentLimits })
        .from(businesses)
        .where(eq(businesses.id, businessId))
        .limit(1),
    );
    if (overCardLimit(biz, input.currency, input.amountMinor)) {
      const refusedCard = order.find(isCardInstrument)!;
      order = order.filter((pm) => !isCardInstrument(pm));
      if (order.length === 0)
        return {
          kind: "declined",
          failureCode: CARD_LIMIT_CODE,
          failureMessage:
            "The first payment is more than this business's card limit for this currency. " +
            "Create the subscription with automatic collection off to invoice the customer, " +
            "or add another payment method.",
          payerMessage: CARD_LIMIT_MESSAGE,
          pm: refusedCard,
        };
    }
  }
  const primary = order[0]!;

  // A notice rail cannot debit at once (decided 2026-10-24): the invoice is committed and
  // `preDebitGate` defers it like a renewal, buyer present or not. A hosted payment that
  // captures before the subscription exists is refunded as unmatched (measured on PayU,
  // 2026-10-30), so the buyer is not sent to pay it on-session.
  if (
    await primaryNeedsNotice({
      organizationId,
      businessId,
      currency: input.currency,
      pm: primary,
    })
  )
    return { kind: "deferred", pm: primary };

  let last: { pm: Pm; a: ChargeAttempt } | null = null;
  for (let i = 0; i < order.length; i++) {
    const pm = order[i]!;
    let a: ChargeAttempt;
    try {
      a = await chargeWithMethod({
        organizationId,
        businessId,
        currency: input.currency,
        pm,
        amountMinor: input.amountMinor,
        // No invoice exists yet, so the attempt is keyed on the subscription: a
        // crash-retry of the same signup dedupes at the gateway.
        idempotencyKey: input.idempotencyScope
          ? `sub_${subscription.publicId}_${input.idempotencyScope}_${pm.publicId}`
          : `sub_${subscription.publicId}_first_charge_${pm.publicId}`,
        // …and tagged with the subscription for the same reason (#31): it is the only
        // row of ours in existence at this instant. The invoice is committed only after
        // this charge returns, so an invoice ref here would name nothing — and if the
        // signup is refused, nothing is ever written, which is exactly the case where
        // the tag is the only thing connecting a gateway object back to us.
        ownershipRef: subscription.publicId,
        // The first debit of the subscription's series; the buyer is present on-session.
        initiator: {
          by: input.session === "on_session" ? "customer" : "merchant",
          recurring: true,
        },
        description: await subscriptionChargeDescription({
          // `chargeBeforeSubscriptionInvoice`: taken before the invoice is committed — a
          // signup, or a reactivation that must not start unless it is paid.
          flow: input.flow ?? "new_subscription",
          organizationId: input.organizationId,
          subscriptionId: subscription.id,
          subscriptionPublicId: subscription.publicId,
          customerId: input.customerId,
        }),
        contact,
      });
    } catch (e) {
      if (e instanceof GatewayRouterError) {
        return {
          kind: "declined",
          failureCode: "gateway_account_unavailable",
          failureMessage: e.message,
          payerMessage: PAYER_SAFE_INTERNAL_FAILURE,
          pm,
        };
      }
      throw e;
    }
    const outcome = tmtestOutcome(a.result);
    if (a.result.status === "succeeded") {
      return {
        kind: "charged",
        charge: {
          pm,
          account: a.account,
          gatewayKey: a.gatewayKey,
          result: a.result,
          amountMinor: input.amountMinor,
          outcome: "succeeded",
        },
      };
    }
    // Unknown-outcome paths are NOT a decline: the money may well have moved, so
    // the signup stands and the inbound reconciler settles it.
    if (a.result.status === "pending" || outcome === "timeout" || outcome === "needs_attention") {
      return {
        kind: "charged",
        charge: {
          pm,
          account: a.account,
          gatewayKey: a.gatewayKey,
          result: a.result,
          amountMinor: input.amountMinor,
          // Same distinction as collectInvoice: a gateway `pending` is a live attempt
          // (settles by webhook) → in_progress; `timeout` means the outcome is unknown.
          outcome: "pending",
          // Explicit outcomes win over a bare `pending` — tmtest's timeout instrument
          // also reports status 'pending' (see collectInvoice).
          pendingStatus:
            outcome === "needs_attention"
              ? "needs_attention"
              : outcome === "timeout"
                ? "timeout"
                : a.result.status === "pending"
                  ? "in_progress"
                  : "timeout",
        },
      };
    }
    // ON-SESSION 3DS (and only on-session): the buyer is in a browser right now, so
    // the challenge is completable. Mint the intent that carries it and hand it
    // back — deliberately BEFORE `recordDeclinedSignupAttempt`, because nothing has
    // failed. Off-session keeps falling through to the decline below, unchanged.
    if (input.session === "on_session" && a.result.status === "requires_action") {
      const challenge = await intentForOnSessionChallenge({
        organizationId,
        businessId,
        pm,
        amountMinor: input.amountMinor,
        currency: input.currency,
        // Deliberately NOT linked to `subscription`: it is provisional and about to
        // be deleted, and an intent pointing at a deleted row is worse than one
        // pointing at nothing. The buyer re-creates the subscription with this
        // intent, and THAT invoice is what it gets consumed into.
        ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        ...(input.cancelUrl ? { cancelUrl: input.cancelUrl } : {}),
      });
      if (challenge)
        return {
          kind: "action_required",
          intent: challenge.intent,
          attempt: challenge.attempt,
          pm,
        };
    }
    last = { pm, a };
    if (isDeadMandateDecline(a.result, pm))
      await markPaymentMethodInvalid(organizationId, pm.id, "mandate");
    const nextMethod = isHardDecline(a.result) || a.result.failure?.code === MANDATE_CURRENCY_CODE;
    if (nextMethod && i < order.length - 1) {
      // Another method still to try: one transaction per attempt.
      if (isHardDecline(a.result)) await markPaymentMethodInvalid(organizationId, pm.id);
      await recordDeclinedSignupAttempt({
        organizationId,
        businessId,
        customerId,
        subscriptionId: subscription.id,
        currency: input.currency,
        amountMinor: input.amountMinor,
        pm,
        attempt: a,
      });
      continue;
    }
    if (isHardDecline(a.result)) await markPaymentMethodInvalid(organizationId, pm.id);
    break;
  }

  const { a } = last!;
  await recordDeclinedSignupAttempt({
    organizationId,
    businessId,
    customerId,
    subscriptionId: subscription.id,
    currency: input.currency,
    amountMinor: input.amountMinor,
    pm: last!.pm,
    attempt: a,
  });
  // requires_action (off-session) has no failure object — still a refusal here:
  // there is no invoice to keep alive for the customer to authenticate against.
  const failureCode =
    a.result.failure?.code ??
    (a.result.status === "requires_action" ? "requires_action" : "charge_failed");
  const failureMessage =
    a.result.failure?.message ??
    (a.result.status === "requires_action"
      ? "The payment needs additional authentication."
      : "Charge failed");
  return {
    kind: "declined",
    pm: last!.pm,
    failureCode,
    failureMessage,
    payerMessage: payerDeclineMessage(
      {
        code: failureCode,
        message: failureMessage,
        exposedToPayer: a.result.failure?.exposedToPayer,
      },
      failureMessage,
    ),
  };
}

/**
 * Undo a pre-invoice charge whose invoice could not be committed (the
 * amount-mismatch guard). Best-effort at the gateway; the caller decides what to
 * tell the client. Nothing is booked — there is no invoice and no payment row for
 * this money, which is exactly why it must go straight back.
 */
export async function refundPreInvoiceCharge(input: {
  organizationId: string;
  businessId: string;
  charge: CompletedCharge;
  currency: string;
  reason: string;
}): Promise<{ refunded: boolean; error?: string }> {
  const { charge } = input;
  if (!charge.result.providerChargeId) return { refunded: false, error: "no provider charge id" };
  try {
    const { adapter } = await resolveChargeAdapter({
      organizationId: input.organizationId,
      businessId: input.businessId,
      currency: input.currency,
      pm: charge.pm,
    });
    const res = await adapter.refund({
      providerChargeId: charge.result.providerChargeId,
      amountMinor: charge.amountMinor,
      currency: input.currency,
      idempotencyKey: `precharge_refund_${charge.result.providerChargeId}`,
      /**
       * #31, and the one path where the convention cannot be "the row this settles":
       * by design NOTHING is booked for this money — no invoice, no payment, no refund
       * row (see this function's docstring) — and the provisional subscription the
       * original charge was tagged with is about to be deleted, so its id would resolve
       * to nothing. The instrument survives and its public id resolves, so it is what a
       * reconciler gets: `pm_…` lands on the payment method, which names the customer
       * whose money went back. `charge.result.providerChargeId` would be the gateway's
       * own id, not ours, and tells our search nothing.
       */
      ownershipRef: charge.pm.publicId,
      reason: input.reason,
    });
    return { refunded: res.status !== "failed" };
  } catch (e) {
    // Money taken from a buyer that we then failed to give back. It is returned as
    // data so the caller can decide, but it must never pass unlogged.
    log.error(e, {
      event: "precharge_refund_failed",
      providerChargeId: charge.result.providerChargeId,
      amountMinor: charge.amountMinor?.toString(),
      currency: input.currency,
    });
    return { refunded: false, error: e instanceof Error ? e.message : String(e) };
  }
}
