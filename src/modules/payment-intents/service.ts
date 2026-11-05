/**
 * Payment intents (C7 / GW-7) — a CONTAINER of attempts, for two purposes.
 *
 * An intent is not "a charge that needs a challenge first": it is the record of a
 * buyer authorization at a gateway, and it can be tried more than once. We surface
 * that as "Payment Attempts: N" on the list and one "Attempt N" card per try on
 * the detail page; our old model was a single flat row, so a buyer who failed
 * 3DS twice before succeeding overwrote the row twice and we kept only the last
 * outcome. `payment_attempts` (0170) is where the other tries live, and every
 * gateway-touching operation here mints/uses exactly one of them.
 *
 * `purpose` (0171) widens the object to what real gateways actually do:
 *  - `payment` — a priced authorization captured INTO an invoice (payments +
 *    double-entry ledger + transaction + invoice settlement). Unchanged.
 *  - `setup`   — a ZERO-amount authorization whose product is a VAULTED
 *    INSTRUMENT, not money (Stripe `seti_…`). No invoice, no ledger, no payment
 *    row; consuming it hands the provider ref to the payment-methods module,
 *    which is the only place that persists a vaulted instrument.
 *
 * Trace correlation: every gateway-touching call of an attempt runs in the caller's
 * trace under the attempt's span (`attemptSpan`), and both are stored on the
 * attempt row. `gateway_request_logs` records the same pair, and it is the ONLY
 * correlation key — that table is platform-global with no RLS, so an FK would put
 * referential integrity across the tenant boundary. The per-attempt "View
 * Request/Response Logs" link filters on the span.
 */
import { activatePaidCreditGrants } from "@/modules/credits/packs";
import type { AchAuthorizationEvidence } from "@/modules/payment-methods/ach-authorization";
import { methodTypeFor } from "@/modules/payments/method-type";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { systemDb, withTenant, type Tx } from "@/platform/db";
import { businessWallClock, stampNow } from "@/platform/clock";
import { publicId } from "@/platform/ids";
import { newTraceId, spanContext, type TraceContext, withTraceContext } from "@/platform/trace";
import {
  clampLimit,
  keysetCondition,
  pageOrder,
  parseCursor,
  toPage,
  type ListFilter,
  type ListPage,
} from "@/platform/list-query";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData } from "@/modules/events/registry";
import { resolveAdapter } from "@/providers/registry";
import { gatewayDefinition, methodLabel } from "@/providers/gateway-catalog";
import { liveProofPending, methodOffered, type PendingMethods } from "@/providers/conformance";
import { selectGatewayAccount } from "@/modules/gateway/router";
import { TmtestProvider } from "@/providers/tmtest";
import { postEntries } from "@/modules/ledger/service";
import { recordTransaction } from "@/modules/transactions/service";
import {
  invoiceChargeDescription,
  subscriptionChargeDescription,
  setupChargeDescription,
  chargeFlowLabel,
  type ChargeFlow,
} from "@/modules/invoicing/charge-description";
import { isOpenInvoiceStatus, dunningFieldsOnSettle } from "@/modules/invoicing/status";
import {
  AchAuthorizationRequiredError,
  ensureProviderCustomer,
  persistVaultedPaymentMethod,
  providerContact,
} from "@/modules/payment-methods/service";
// The customer's excess-payment bucket, for a capture the invoice can no longer swallow
// whole (see `finishPaymentConsume`). From `balances-read`, which is the leaf half of the
// balances module — `balances` itself would pull in writers this module has no use for.
import { EXCESS_PAYMENT } from "@/modules/customers/balances-read";
import { accountHolderName } from "@/modules/customers/names";
import type {
  ChargeResult,
  FetchedIntent,
  IntentPurpose,
  IntentRef,
  PaymentProvider,
  ProviderCustomerRef,
  ProviderPaymentMethodRef,
} from "@/providers/types";
import { ProviderIndeterminateError, strandedObjectId } from "@/providers/types";
import { allowsIntentPurpose } from "@/providers/types";
import { gatewayReturnUrl } from "@/providers/buyer-return";
import { CARD_LIMIT_CODE, CARD_LIMIT_MESSAGE, overCardLimit } from "@/modules/invoicing/card-limit";
import { providerPaymentMethodRef } from "@/modules/payment-methods/provider-ref";
import {
  MANDATE_CURRENCY_CODE,
  mandateCurrencyRefusal,
} from "@/modules/payment-methods/mandate-currency";
import {
  paymentIntents,
  paymentAttempts,
  paymentMethods,
  gatewayAccounts,
  invoices,
  payments,
  businesses,
  customers,
  subscriptions,
  transactions,
} from "@db/schema";
import { scanBusinessFilter } from "@/platform/clock";
import { createLogger } from "@/platform/logger";
// The rail-aware TTL. Lives in its own leaf module because the reasoning is long and
// because `stale-pending.ts` answers the same question at the other end of the flow —
// see `ttl.ts` for why the two tables are copies and what pins them together.
import { intentExpiresAt, intentTtlMs } from "./ttl";

const log = createLogger("payment-intents");

export type PaymentIntent = typeof paymentIntents.$inferSelect;
export type PaymentAttempt = typeof paymentAttempts.$inferSelect;
export type PaymentMethodRow = typeof paymentMethods.$inferSelect;
export type GatewayAccountRow = typeof gatewayAccounts.$inferSelect;

/**
 * `authorized_at`, written exactly as migration 0217 documents the contract:
 * `coalesce(authorized_at, app_now())` at EVERY transition INTO `authorized`, so the FIRST
 * hold wins and no later transition — nor a redelivered webhook — can move it.
 *
 * ⚠️ It has to be a coalesce rather than an assignment because four of the writers below
 * re-enter `authorized` by RELEASING a consume claim (a refused capture, an unreachable
 * gateway, a vault we could not persist, a refused setup). A plain `new Date()` there
 * would rewrite the moment the buyer's money was first held to the moment a capture was
 * refused — and `intent_hold_not_abandoned` (ops/invariants.ts) reads this column to
 * decide whether an expired intent ever held anything at all.
 *
 * ⚠️ Until now NOTHING wrote it. Measured today with `scripts/probe-late-authorization.ts`:
 * the column is NULL platform-wide — NULL even on the scenario-D intent that provably
 * held money at the gateway — so the invariant's `authorized_at IS NOT NULL` predicate
 * made it permanently green (0 violations by construction, not by health).
 *
 * On a row that reached `authorized` BEFORE this shipped, the coalesce stamps the moment
 * of a later transition rather than the true first hold. Accepted, and why the column is
 * documented as the first hold we RECORDED: a late honest timestamp beats a NULL that
 * silently excludes the row from the only check watching abandoned holds.
 */
const FIRST_AUTHORIZED_AT = sql`coalesce(${paymentIntents.authorizedAt}, app_now())`;

/** Attempt statuses that are still "in flight" — an expiry/void closes these. */
const OPEN_ATTEMPT_STATUSES = ["inited", "requires_action", "authorized"] as const;

/**
 * Trace-id prefix for everything an intent does at a gateway. The prefix names the
 * originating surface (`api-`, `job-`, `hook-`, `mig-`), so a log line from an
 * intent attempt reads as `pi-…` at a glance.
 */
const TRACE_PREFIX = "pi";

/**
 * The caller's trace with this attempt's span. A new attempt mints its span; a later call
 * on an existing one (fetch, void, consume) joins it. Older attempts carry no span: their
 * per-attempt trace id stands in.
 */
function attemptSpan(attempt?: { spanId: string | null; traceId: string | null } | null) {
  return spanContext(attempt?.spanId ?? attempt?.traceId ?? newTraceId(TRACE_PREFIX));
}

export class PaymentIntentError extends Error {
  /**
   * A stable identity for the refusal, independent of its wording.
   *
   * Added for #23. `message` on the consume path is now written FOR THE PAYER — the
   * portal maps a `PaymentIntentError` straight to `badRequest(reply, e.message)`, so
   * every sentence here is read by a buyer — and buyer copy is the thing most likely
   * to be rewritten next. A gate that asserts on prose either breaks on a comma or,
   * worse, quietly stops being able to fail: `verify:gateway`'s
   * `reviveConsumeError !== "Intent expired"` was one string edit away from passing
   * for no reason. Assert on the code; show the message to the person.
   *
   * Optional on purpose — the dozens of existing throws that no gate keys on are left
   * alone rather than churned.
   */
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "PaymentIntentError";
    if (code) this.code = code;
  }
}

/** Refuse, before the gateway, a saved mandate that cannot be debited in `currency`. */
function assertMandateCurrency(pm: typeof paymentMethods.$inferSelect, currency: string): void {
  const refused = mandateCurrencyRefusal(pm, currency);
  if (refused) throw new PaymentIntentError(refused.failure!.message, MANDATE_CURRENCY_CODE);
}

export class PaymentIntentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentIntentConflictError";
  }
}

/** The gateway refused the capture. `pending` is money in flight, never a refusal. */
export function captureRefused<C extends { status: string }>(
  charge: C | null | undefined,
): charge is C {
  return !!charge && charge.status !== "succeeded" && charge.status !== "pending";
}

/**
 * The gateway cannot release an authorization without moving money (RazorPay).
 * Named separately so the caller can say WHICH gateway — and so nobody is tempted
 * to substitute a refund, which would post real money movement for a payment that
 * never settled (see `ProviderCapabilities.intentVoid`).
 */
export class PaymentIntentVoidUnsupportedError extends PaymentIntentError {
  constructor(gatewayKey: string) {
    super(
      `Gateway ${gatewayKey} cannot void an authorized payment intent. ` +
        `Its authorizations are either captured or left to lapse. A refund instead would move real money for a payment that never settled.`,
    );
    this.name = "PaymentIntentVoidUnsupportedError";
  }
}

// ── gateway account resolution ───────────────────────────────────────────────

/**
 * The gateway account to run this payment method through.
 *
 * The payment method's OWN vaulting account is the answer whenever it can be —
 * the vaulted token exists only at that gateway, so routing elsewhere would charge
 * a token that is not there. But "is the answer" is not "is exempt from the
 * router's contract". This used to `return acc` on sight of `status === 'active'`,
 * which walked straight past `selectGatewayAccount`'s stated contract of NO SILENT
 * FALLBACK: a card vaulted on an INR-only RazorPay account took a USD "Pay now"
 * to RazorPay without anyone checking, and the refusal came back in RazorPay's
 * words (its domestic rails reject non-INR) instead of our own
 * `no_gateway_for_currency` naming the account and the currency.
 *
 * So the pin is kept and re-entered through the router as an `override`, which is
 * precisely the case that branch exists for: it honours the caller's account and
 * makes it prove it handles the currency AND the instrument type before returning
 * it. The S6 fallthrough is unchanged — a DISABLED vaulting account still drops to
 * ordinary routing.
 */
async function resolveAccountForPm(
  tx: Tx,
  businessId: string,
  pm: PaymentMethodRow,
  currency: string,
) {
  if (pm.gatewayAccountId) {
    const [acc] = await tx
      .select()
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.id, pm.gatewayAccountId))
      .limit(1);
    // A disabled vaulting account must NOT be used (S6): fall through to the
    // router, which only considers active mode-matched accounts.
    if (acc && acc.status === "active")
      return selectGatewayAccount(tx, {
        businessId,
        currency,
        methodType: pm.type,
        override: acc.publicId,
        // This account HOLDS the token — no other one can charge it, so its declared
        // `currencies` has nothing left to decide and does not get to refuse the charge.
        // The gateway answers that question, with a decline code we can act on.
        tokenBound: true,
      });
  }
  // Enforce the account's method-type restrictions on this off-session/renewal
  // charge path too (the PM carries its instrument type).
  return selectGatewayAccount(tx, { businessId, currency, methodType: pm.type });
}

/**
 * The gateway must support intents at all, and must support THIS purpose. A
 * gateway may do zero-amount `setup` intents without priced `payment` ones (or
 * vice-versa); an empty/absent `intentPurposes` with `intents: true` means both.
 */
function assertSupportsPurpose(
  adapter: PaymentProvider,
  acc: GatewayAccountRow,
  purpose: IntentPurpose,
): void {
  if (!adapter.createIntent)
    throw new PaymentIntentError(`Gateway ${acc.gatewayKey} does not support intents`);
  if (!allowsIntentPurpose(adapter.capabilities.intentPurposes, purpose))
    throw new PaymentIntentError(`Gateway ${acc.gatewayKey} does not support ${purpose} intents`);
}

// ── attempts ────────────────────────────────────────────────────────────────

/** Map a gateway `IntentRef.status` onto our attempt vocabulary. */
function attemptStatusOf(gatewayStatus: "inited" | "requires_action" | "authorized"): string {
  return gatewayStatus;
}

/** Map a gateway `IntentRef.status` onto the INTENT vocabulary (which has no `requires_action`). */
function intentStatusOf(gatewayStatus: "inited" | "requires_action" | "authorized"): string {
  return gatewayStatus === "requires_action" ? "in_progress" : gatewayStatus;
}

/**
 * Resolve what to persist from a gateway `IntentRef`, honouring a REFUSAL.
 *
 * A gateway that declines an authorization returns `failure` alongside whatever
 * status it reports — Stripe answers a card error with `requires_payment_method`,
 * which maps to `inited`. Reading the status alone (as this did before) persists
 * a decline as a live attempt and drops the reason on the floor: the attempt
 * looks retriable forever, `retryPaymentIntent` refuses it because the latest
 * attempt is not `failed`, and the decline never reaches dunning. Adapters were
 * deliberately changed to RETURN declines rather than throw, so this is the only
 * place that can record them.
 *
 * The INTENT stays open (`inited`) while the ATTEMPT is marked `failed` — that
 * pairing is exactly what `retryPaymentIntent` requires, and `payment_intents`
 * has no `failed` status of its own.
 */
function attemptOutcomeOf(intent: IntentRef): {
  attemptStatus: string;
  intentStatus: string;
  errorCode: string | null;
  errorText: string | null;
} {
  if (intent.failure) {
    return {
      attemptStatus: "failed",
      intentStatus: "inited",
      errorCode: intent.failure.code,
      errorText: intent.failure.message,
    };
  }
  return {
    attemptStatus: attemptStatusOf(intent.status),
    intentStatus: intentStatusOf(intent.status),
    errorCode: null,
    errorText: null,
  };
}

/** The highest-numbered attempt of an intent — the one every operation acts on. */
async function currentAttempt(tx: Tx, paymentIntentId: string): Promise<PaymentAttempt | null> {
  const [row] = await tx
    .select()
    .from(paymentAttempts)
    .where(eq(paymentAttempts.paymentIntentId, paymentIntentId))
    .orderBy(sql`${paymentAttempts.attemptNumber} desc`)
    .limit(1);
  return row ?? null;
}

export async function getCurrentAttempt(
  organizationId: string,
  paymentIntentId: string,
): Promise<PaymentAttempt | null> {
  return withTenant(organizationId, (tx) => currentAttempt(tx, paymentIntentId));
}

/**
 * Address the attempt at the gateway by `to` from now on, when it is still addressed by
 * `from` (`NormalizedProviderEvent.gatewayIntentId`). Compare-and-set, so a redelivery or
 * a browser result that got there first changes nothing.
 */
export async function repointAttemptAtGateway(
  organizationId: string,
  attemptId: string,
  from: string,
  to: string,
): Promise<boolean> {
  const rows = await withTenant(organizationId, (tx) =>
    tx
      .update(paymentAttempts)
      .set({ idAtGateway: to })
      .where(and(eq(paymentAttempts.id, attemptId), eq(paymentAttempts.idAtGateway, from)))
      .returning({ id: paymentAttempts.id }),
  );
  return rows.length > 0;
}

/**
 * Insert attempt N for an intent and bump the denormalised `attempt_count` in the
 * SAME transaction (the count is the "Payment Attempts" column and must stay
 * verifiable against the child table). Never mutates an earlier attempt — the
 * unique index on (payment_intent_id, attempt_number) makes a double-submit
 * collide instead of writing two rows claiming the same number.
 */
async function insertAttempt(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    paymentIntentId: string;
    /** The intent's PUBLIC id — event payloads never leak internal UUIDs. */
    intentPublicId: string;
    attemptNumber: number;
    status: string;
    paymentMethodId?: string | null;
    idAtGateway?: string | null;
    errorCode?: string | null;
    errorText?: string | null;
    trace: TraceContext;
    methodUsed?: string;
  },
): Promise<PaymentAttempt> {
  const [row] = await tx
    .insert(paymentAttempts)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentIntentId: input.paymentIntentId,
      publicId: publicId("pia"),
      attemptNumber: input.attemptNumber,
      status: input.status,
      paymentMethodId: input.paymentMethodId ?? null,
      idAtGateway: input.idAtGateway ?? null,
      errorCode: input.errorCode ?? null,
      errorText: input.errorText ?? null,
      traceId: input.trace.traceId,
      spanId: input.trace.spanId ?? null,
      ...(input.methodUsed ? { methodUsed: input.methodUsed } : {}),
    })
    .returning();
  await tx
    .update(paymentIntents)
    // A new attempt is by definition the newest one, so its status goes straight on.
    .set({ attemptCount: input.attemptNumber, lastAttemptStatus: input.status })
    .where(eq(paymentIntents.id, input.paymentIntentId));
  await emitEvent(tx, {
    organizationId: input.organizationId,
    businessId: input.businessId,
    type: "payment_attempt_created",
    data: buildEventData(
      "payment_attempt_created",
      {
        id: row!.publicId,
        payment_intent: input.intentPublicId,
        attempt_number: row!.attemptNumber,
        status: row!.status,
        id_at_gateway: row!.idAtGateway,
        trace_id: row!.traceId,
      },
      row!.resourceVersion,
    ),
  });
  return row!;
}

/**
 * Book a refused authorization as a TRANSACTION.
 *
 * The invoice lists transactions, the customer's Transactions tab lists transactions, and
 * the gateway's own id lives on one — so an intent and an attempt, which is all a refusal
 * used to leave behind here, are records nobody reads. The CONSUME path has always
 * recorded its capture failures this way, and `collectInvoice` has since #63; the create
 * and retry paths simply never did.
 *
 * ⚠️ NOT the cause of the 2026-09-06 orphans, which came through `charge()` and DID book
 * their transactions (verified on the invoices: `txn_XXXXXXXXXXXXXXXXXXXXXX01`,
 * `txn_XXXXXXXXXXXXXXXXXXXXXX02`). Those were missing only the gateway id. This closes the
 * same class of hole on the path that had no transaction at all.
 *
 * Gateway-agnostic on purpose: whether an id survives a refusal is the adapter's problem
 * (Stripe returns the PaymentIntent it kept, RazorPay the stranded order, PayPal nothing
 * because nothing is left), and this books whatever came back, including nothing.
 */
async function bookRefusedTransaction(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string | null;
    amountMinor: bigint;
    currency: string;
    gatewayAccountId: string;
    gatewayKey: string;
    idAtGateway: string | null;
    paymentMethodId: string | null;
    invoiceId: string | null;
    errorCode: string;
    errorText: string | null;
    retriable: boolean | null;
    paymentIntentId: string;
    paymentAttemptId: string | null;
  },
): Promise<void> {
  await recordTransaction(
    {
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      type: "payment",
      status: "failed",
      amountMinor: input.amountMinor,
      currency: input.currency,
      gatewayAccountId: input.gatewayAccountId,
      gatewayKey: input.gatewayKey,
      idAtGateway: input.idAtGateway,
      paymentMethodId: input.paymentMethodId,
      invoiceId: input.invoiceId,
      errorCode: input.errorCode,
      errorText: input.errorText,
      retriable: input.retriable,
      paymentIntentId: input.paymentIntentId,
      paymentAttemptId: input.paymentAttemptId,
    },
    tx,
  );
}

/**
 * The ONLY place an attempt's status changes — because the intent mirrors it.
 *
 * `payment_intents.last_attempt_status` is what a LIST row reads to tell a refused intent
 * from a live one (the intent's own status cannot say: it has no `failed`). Nine call
 * sites used to write `paymentAttempts.status` directly, and nine sites each remembering
 * to mirror is how a denormalised column silently goes stale — so they all funnel here.
 *
 * The mirror is GUARDED on `attempt_count <= attemptNumber`: `attempt_count` is the newest
 * attempt's number, so an update to an OLDER attempt (only `failAttempt` can be handed
 * one) leaves the intent alone rather than rewinding it to stale history.
 */
async function writeAttemptStatus(
  tx: Tx,
  attempt: PaymentAttempt,
  patch: Partial<typeof paymentAttempts.$inferInsert> & { status: string },
): Promise<PaymentAttempt> {
  const [row] = await tx
    .update(paymentAttempts)
    .set(patch)
    .where(eq(paymentAttempts.id, attempt.id))
    .returning();
  await tx
    .update(paymentIntents)
    .set({ lastAttemptStatus: patch.status })
    .where(
      and(
        eq(paymentIntents.id, attempt.paymentIntentId),
        lte(paymentIntents.attemptCount, attempt.attemptNumber),
      ),
    );
  return row ?? attempt;
}

/** Close an attempt as failed + emit `payment_attempt_failed` (never touches earlier attempts). */
async function failAttempt(
  tx: Tx,
  attempt: PaymentAttempt,
  errorCode: string,
  errorText: string,
  intentPublicId?: string,
): Promise<PaymentAttempt> {
  const row = await writeAttemptStatus(tx, attempt, { status: "failed", errorCode, errorText });
  await emitEvent(tx, {
    organizationId: attempt.organizationId,
    businessId: attempt.businessId,
    type: "payment_attempt_failed",
    data: buildEventData(
      "payment_attempt_failed",
      {
        id: attempt.publicId,
        payment_intent: intentPublicId ?? null,
        attempt_number: attempt.attemptNumber,
        status: "failed",
        error_code: errorCode,
        error_text: errorText,
        trace_id: attempt.traceId,
      },
      row.resourceVersion,
    ),
  });
  return row;
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreatePaymentIntentInput {
  /**
   * WHICH FLOW this intent belongs to, for the gateway's own `description`.
   *
   * Only the caller knows: the portal's Pay now, an operator's Collect now and a
   * merchant's API call all arrive here identically. Optional, and an omitted flow simply
   * leaves the label off rather than guessing — a wrong flow on a receipt is worse than
   * none. See `ChargeFlow` for why the labels are not our internal names.
   */
  flow?: ChargeFlow;
  organizationId: string;
  businessId: string;
  /** What the intent is FOR. Defaults to `payment` (the original, only meaning). */
  purpose?: IntentPurpose;
  /** Required for `payment`; MUST be absent for `setup` (nothing is vaulted yet). */
  paymentMethodPublicId?: string;
  /** Required for `setup` — the buyer whose instrument we're about to vault. */
  customerPublicId?: string;
  /** Minor units. Required (> 0) for `payment`; ignored for `setup`, which is always 0. */
  amountMinor?: number;
  currency: string;
  /** Optional context links (`payment_intents.invoice_id` / `.subscription_id`). */
  invoicePublicId?: string;
  subscriptionPublicId?: string;
  /** Redirect targets + instrument allow-list for the buyer's challenge. */
  returnUrl?: string;
  cancelUrl?: string;
  methodTypes?: string[];
  /**
   * Let the BUYER choose the method inside the gateway's own sheet, instead of pinning
   * the rail we happen to have on file.
   *
   * Both `paymentMethod` and `methodTypes` are then withheld from the adapter, and the
   * two gateways do the right thing without further help:
   *
   *  - **RazorPay** — `selectRail` returns undefined for a one-off payment with no rail
   *    requested, so the order pins no `method` and Checkout offers whatever the merchant
   *    has enabled. Its own comment calls that the correct outcome: no mandate is being
   *    registered, so nothing is bound to a rail. (A non-INR order still resolves to
   *    cards, which is the only international rail it has.)
   *  - **Stripe** — `confirm` is `Boolean(paymentMethod)`, so the intent is created
   *    UNCONFIRMED with a client_secret, which is how a buyer picks in Elements, and
   *    `payment_method_types` is omitted so the account's automatic methods apply.
   *
   * ⚠️ `methodTypes: []` is NOT a way to express this. RazorPay would read it as "no rail
   * requested" and behave, but Stripe's `input.methodTypes ? …` is truthy for an empty
   * array and would send `payment_method_types: []`, which it rejects. Hence a flag that
   * says what it means rather than an empty list that means it by accident.
   *
   * The payment METHOD is still resolved and recorded — it routes to a gateway account
   * and it is what the intent row points at. Only the CHECKOUT is unpinned.
   */
  letBuyerChooseMethod?: boolean;
  session?: "on_session" | "off_session";
  /**
   * PIN the intent to this gateway account (`gwa_…` public id) instead of routing.
   *
   * Checkout and the customer portal let the BUYER choose which gateway to add a card
   * through, and the completion step vaults on that same account. Without an override
   * a `setup` intent went through `selectGatewayAccount`, so a multi-gateway business
   * would send the buyer to the wrong gateway (or fail with `ambiguous_gateway`) — the
   * reason add-card could not be recorded as an intent at all.
   *
   * Validated exactly as the consume path validates the account it captures on:
   * belongs to this business, `active`, and livemode-matched to the business. It is
   * honoured for `payment` too, where it likewise replaces routing — a caller pinning
   * an account there is asserting the payment method lives at it.
   */
  gatewayAccountId?: string;
  /**
   * Per-debit ceiling for a mandate registered by a `setup` intent, in minor units of
   * `currency`. Positive integer; rejected for `purpose: 'payment'`, which registers no
   * mandate.
   *
   * NOT the same field as `amountMinor` and deliberately not derived from it: a setup
   * intent authorizes zero. Persisted on the row (0174) because `retryPaymentIntent`
   * registers a NEW mandate and would otherwise silently fall back to the adapter's
   * default cap, capping renewals below the plan price.
   */
  maxAmountMinor?: number;
  /**
   * `setup` only: the registration also collects this much as the first invoice's payment,
   * on a gateway whose `capabilities.setupCollectsFirstCharge` lists every requested method.
   * Ignored elsewhere. Stored as `first_charge_minor`.
   */
  firstChargeMinor?: number;
  /**
   * Pay on the gateway's hosted page with this wallet (`CreateIntentInput.hostedWallet`). Only
   * for a buyer-picks `payment`, on a gateway whose catalogue entry offers it.
   */
  hostedWallet?: "apple_pay";
  /**
   * Methods not proven live; `live-proof-pending.json` by default. Conformance passes `{}`: it
   * proves a pending method offline.
   */
  pendingMethods?: PendingMethods;
}

/**
 * Resolve a caller-PINNED gateway account, with the same three checks the consume path
 * makes before it captures on one: it must belong to this business, be `active`, and be
 * livemode-matched to the business. Anything less would let an intent be created against
 * a disabled account, or a live account under a test business.
 *
 * ⚠️ Those three were never enough, and this is fed by BUYER-CONTROLLED input — the
 * `gateway_account` field on `POST /checkout/v1/setup` and
 * `POST /portal/v1/payment_methods/setup` are public bodies. Ownership/active/livemode
 * say nothing about whether the account can take THIS currency or THIS instrument, so a
 * buyer could pin an INR-only account to a USD setup and the first refusal came from the
 * gateway. `selectGatewayAccount`'s `override` branch is the router's own expression of
 * "honour this pin, but validate it" — raising `no_gateway_for_currency` naming the
 * account — so the currency/method contract stays in ONE place instead of being restated
 * (and forgotten) here.
 */
async function resolvePinnedAccount(
  tx: Tx,
  businessId: string,
  gwaPublicId: string,
  currency: string,
  methodType?: string,
): Promise<GatewayAccountRow> {
  const [acc] = await tx
    .select()
    .from(gatewayAccounts)
    .where(
      and(eq(gatewayAccounts.businessId, businessId), eq(gatewayAccounts.publicId, gwaPublicId)),
    )
    .limit(1);
  if (!acc) throw new PaymentIntentError(`We could not find the gateway account ${gwaPublicId}.`);
  if (acc.status !== "active")
    throw new PaymentIntentError(`Gateway account ${acc.publicId} is not active`);
  const [biz] = await tx
    .select({ livemode: businesses.livemode })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1);
  if (biz && acc.livemode !== (biz.livemode === "live"))
    throw new PaymentIntentError(
      `Gateway account mode does not match business mode ${biz.livemode}`,
    );
  // The three checks above give the precise message for the three failures they name;
  // the router then decides the currency/method question it owns.
  return selectGatewayAccount(tx, { businessId, currency, methodType, override: acc.publicId });
}

/**
 * Create an intent and its FIRST attempt.
 *
 * Gateway routing differs by purpose, deliberately:
 *  - `payment` keeps the payment-method-then-router resolution (incl. the S6
 *    disabled-vaulting-account fallthrough in `resolveAccountForPm`);
 *  - `setup` has NO payment method and no amount, so `resolveAccountForPm` cannot
 *    be used at all — it routes straight through `selectGatewayAccount`.
 *
 * The gateway call happens OUTSIDE the transaction (network); the intent and
 * attempt #1 are then written together, with `attempt_count = 1`.
 */
/**
 * The gateway-side label for an intent: the flow, then whatever identifies it.
 *
 * An intent may name an invoice, a subscription, or neither (a bare `amount_minor` through
 * the API). Each case has a builder already; the last has nothing to say beyond the flow,
 * and says that rather than inventing detail.
 */
async function intentDescription(
  organizationId: string,
  flow: ChargeFlow | undefined,
  ctx: {
    invoiceId: string | null;
    subscriptionId: string | null;
    customer?: { id: string } | null;
  },
  purpose: IntentPurpose,
  /** The mandate terms, for a `setup` intent only — the ceiling it is registering. */
  setup?: { maxAmountMinor: bigint | null; currency: string | null },
): Promise<string | undefined> {
  /**
   * A `setup` intent gets its OWN label, not a flow one: it moves no money, so "Renewal"
   * and "Portal payment" would both be false about it. What it does get is the two things
   * the gateway row cannot say for itself — who is authorising, and the ceiling being
   * registered. Stripe showed a SetupIntent with no description whatsoever.
   */
  if (purpose === "setup") {
    return await setupChargeDescription({
      organizationId,
      customerId: ctx.customer?.id ?? null,
      maxAmountMinor: setup?.maxAmountMinor ?? null,
      currency: setup?.currency ?? null,
    });
  }
  try {
    if (ctx.invoiceId) {
      const [inv] = await withTenant(organizationId, (tx) =>
        tx
          .select({ number: invoices.number, publicId: invoices.publicId })
          .from(invoices)
          .where(eq(invoices.id, ctx.invoiceId!))
          .limit(1),
      );
      if (inv) {
        return await invoiceChargeDescription({
          organizationId,
          invoiceId: ctx.invoiceId,
          invoiceNumber: inv.number,
          invoicePublicId: inv.publicId,
          customerId: ctx.customer?.id ?? null,
          flow,
        });
      }
    }
    if (ctx.subscriptionId) {
      const [sub] = await withTenant(organizationId, (tx) =>
        tx
          .select({ publicId: subscriptions.publicId })
          .from(subscriptions)
          .where(eq(subscriptions.id, ctx.subscriptionId!))
          .limit(1),
      );
      if (sub) {
        return await subscriptionChargeDescription({
          organizationId,
          subscriptionId: ctx.subscriptionId,
          subscriptionPublicId: sub.publicId,
          customerId: ctx.customer?.id ?? null,
          flow,
        });
      }
    }
  } catch {
    // Fall through to the flow alone — a label is never worth failing a charge for.
  }
  return chargeFlowLabel(flow) ?? undefined;
}

/**
 * Refuse, for the public create route, a currency the business does not bill in: its
 * default, its currency list, or the currency of the invoice or subscription the intent
 * names. Internal callers (checkout, portal, collection) take the currency from a record
 * that already has one, so they do not call this. A business with no currencies set
 * refuses nothing.
 */
export async function assertIntentCurrency(input: {
  organizationId: string;
  business: { id: string; defaultCurrency: string | null; currencies: unknown };
  currency: string;
  invoicePublicId?: string;
  subscriptionPublicId?: string;
}): Promise<void> {
  const want = input.currency.toUpperCase();
  const list = Array.isArray(input.business.currencies) ? input.business.currencies : [];
  const allowed = new Set(
    [input.business.defaultCurrency, ...list]
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.toUpperCase()),
  );
  if (allowed.size === 0 || allowed.has(want)) return;
  const linked = await withTenant(input.organizationId, async (tx) => {
    const out: string[] = [];
    if (input.invoicePublicId) {
      const [inv] = await tx
        .select({ currency: invoices.currency })
        .from(invoices)
        .where(
          and(
            eq(invoices.businessId, input.business.id),
            eq(invoices.publicId, input.invoicePublicId),
          ),
        )
        .limit(1);
      if (inv?.currency) out.push(inv.currency.toUpperCase());
    }
    if (input.subscriptionPublicId) {
      const [sub] = await tx
        .select({ currency: subscriptions.currency })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.businessId, input.business.id),
            eq(subscriptions.publicId, input.subscriptionPublicId),
          ),
        )
        .limit(1);
      if (sub?.currency) out.push(sub.currency.toUpperCase());
    }
    return out;
  });
  if (linked.includes(want)) return;
  throw new PaymentIntentError(
    `We could not create the payment intent. This business does not bill in ${want}. ` +
      `Use ${[...allowed].join(", ")}, or add ${want} to the business currencies.`,
    "currency_not_enabled",
  );
}

export async function createPaymentIntent(
  input: CreatePaymentIntentInput,
): Promise<{ intent: PaymentIntent; attempt: PaymentAttempt }> {
  const purpose: IntentPurpose = input.purpose ?? "payment";
  const currency = input.currency.toUpperCase();

  if (purpose === "payment") {
    if (!input.paymentMethodPublicId) {
      // A BUYER-PRESENT intent collects the instrument in the gateway's own sheet, so
      // requiring a stored one is a rule with nothing behind it: `letBuyerChooseMethod`
      // already withholds the saved method from the adapter (see the call below), which
      // left it deciding only the gateway account — and blocking a buyer whose card
      // happens to sit on an account that does not handle their currency.
      // Off-session still requires one: there is nothing to charge without a token.
      if (!input.letBuyerChooseMethod)
        throw new PaymentIntentError("A payment intent requires a payment method");
      if (!input.customerPublicId)
        throw new PaymentIntentError(
          "A payment intent with no payment method requires a customer to charge",
        );
    }
    if (input.amountMinor == null || input.amountMinor <= 0)
      throw new PaymentIntentError("A payment intent requires a positive amount");
  } else if (!input.customerPublicId) {
    throw new PaymentIntentError("A setup intent requires a customer");
  }
  // The ceiling caps a MANDATE; a payment intent registers none, so accepting it there
  // would be a field that reaches nothing (and one a caller could mistake for a limit on
  // the charge itself).
  if (input.maxAmountMinor != null) {
    if (purpose !== "setup")
      throw new PaymentIntentError(
        "maxAmountMinor is the ceiling of a mandate and applies to setup intents only",
      );
    if (!Number.isInteger(input.maxAmountMinor) || input.maxAmountMinor <= 0)
      throw new PaymentIntentError("maxAmountMinor must be a positive integer in minor units");
  }
  if (input.hostedWallet && (purpose !== "payment" || !input.letBuyerChooseMethod))
    throw new PaymentIntentError("A hosted wallet payment is a pay-now payment intent");

  // 1) Resolve the customer/payment method + gateway account (RLS-scoped reads).
  const ctx = await withTenant(input.organizationId, async (tx) => {
    let pm: PaymentMethodRow | null = null;
    let customer: typeof customers.$inferSelect | null = null;
    let account: GatewayAccountRow;

    // A PINNED account short-circuits ROUTING — the buyer already chose the gateway
    // (portal/checkout), so a router opinion about WHICH account could only contradict
    // them. It does not short-circuit VALIDATION: `resolvePinnedAccount` still makes the
    // pin prove it handles the currency and the instrument. Resolved inside each branch
    // rather than above them because the instrument type it is validated against is what
    // differs between the two.
    if (purpose === "payment" && input.paymentMethodPublicId) {
      const [found] = await tx
        .select()
        .from(paymentMethods)
        .where(
          and(
            eq(paymentMethods.businessId, input.businessId),
            eq(paymentMethods.publicId, input.paymentMethodPublicId!),
          ),
        )
        .limit(1);
      if (!found) throw new PaymentIntentError("Payment method not found");
      pm = found;
      account = input.gatewayAccountId
        ? await resolvePinnedAccount(
            tx,
            input.businessId,
            input.gatewayAccountId,
            currency,
            found.type,
          )
        : await resolveAccountForPm(tx, input.businessId, found, currency);
      const [cus] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, found.customerId))
        .limit(1);
      customer = cus ?? null;
    } else {
      const [cus] = await tx
        .select()
        .from(customers)
        .where(
          and(
            eq(customers.businessId, input.businessId),
            eq(customers.publicId, input.customerPublicId!),
          ),
        )
        .limit(1);
      if (!cus) throw new PaymentIntentError("Customer not found");
      customer = cus;
      // No payment method to route FROM — a `setup` intent, or a buyer-present
      // `payment` one — so go straight to the router, unless the caller pinned an
      // account, which is the buyer's own choice.
      //
      // The rail is left OPEN when the buyer picks it in the gateway's sheet: guessing
      // `card` there would filter out a wallet-only account they could have used.
      const methodType = input.letBuyerChooseMethod
        ? undefined
        : (input.methodTypes?.[0] ?? "card");
      account = input.gatewayAccountId
        ? await resolvePinnedAccount(
            tx,
            input.businessId,
            input.gatewayAccountId,
            currency,
            methodType,
          )
        : await selectGatewayAccount(tx, {
            businessId: input.businessId,
            currency,
            methodType,
            purpose,
          });
    }

    const invoiceId = input.invoicePublicId
      ? ((
          await tx
            .select({ id: invoices.id })
            .from(invoices)
            .where(
              and(
                eq(invoices.businessId, input.businessId),
                eq(invoices.publicId, input.invoicePublicId),
              ),
            )
            .limit(1)
        )[0]?.id ?? null)
      : null;
    const subscriptionId = input.subscriptionPublicId
      ? ((
          await tx
            .select({ id: subscriptions.id })
            .from(subscriptions)
            .where(
              and(
                eq(subscriptions.businessId, input.businessId),
                eq(subscriptions.publicId, input.subscriptionPublicId),
              ),
            )
            .limit(1)
        )[0]?.id ?? null)
      : null;
    return { pm, customer, account, invoiceId, subscriptionId };
  });

  const adapter = resolveAdapter(ctx.account);
  assertSupportsPurpose(adapter, ctx.account, purpose);
  // A wallet not proven live on this gateway is not offered (`live-proof-pending.json`).
  const pending = input.pendingMethods ?? liveProofPending();
  const hostedWallet =
    input.hostedWallet && methodOffered(ctx.account.gatewayKey, input.hostedWallet, pending)
      ? gatewayDefinition(ctx.account.gatewayKey)?.applePayHosted
      : undefined;
  if (input.hostedWallet && !hostedWallet)
    throw new PaymentIntentError(
      "We cannot take Apple Pay through this payment provider. Pay with another method.",
      "wallet_not_offered",
    );
  // A setup saves a new instrument, never of a method not proven live. A `payment` charges a
  // saved one, which keeps working.
  const notOffered =
    purpose === "setup"
      ? (input.methodTypes ?? []).filter((m) => !methodOffered(ctx.account.gatewayKey, m, pending))
      : [];
  if (notOffered.length)
    throw new PaymentIntentError(
      `We could not set up ${notOffered.map((m) => methodLabel(ctx.account.gatewayKey, m)).join(", ")}. ` +
        "It is not available yet. Select a different payment method.",
      "method_not_offered",
    );
  // The saved method goes to the gateway only when the buyer is not choosing.
  if (ctx.pm && !input.letBuyerChooseMethod) assertMandateCurrency(ctx.pm, currency);

  // A `setup` intent authorizes a buyer who has no vaulted instrument yet, so the
  // provider-side customer must exist before the challenge (this is the same
  // mapping `initiateVaultSetup` uses — reused, never re-minted).
  // Keyed on whether an INSTRUMENT exists, not on the purpose: a buyer-present payment
  // intent has no stored method to read the provider customer off, and must mint/reuse
  // the mapping exactly as a setup intent does.
  // A gateway that refuses the customer refuses the intent: booked exactly like a
  // `createIntent` rejection below. An unknown outcome is rethrown, never booked.
  let rejectedBy: unknown = null;
  let providerCustomer: ProviderCustomerRef | null = null;
  try {
    providerCustomer = ctx.pm
      ? { providerKey: adapter.key, providerCustomerId: ctx.pm.providerCustomerId }
      : await ensureProviderCustomer({
          organizationId: input.organizationId,
          businessId: input.businessId,
          customer: ctx.customer!,
          provider: adapter,
          gatewayAccountId: ctx.account.id,
        });
  } catch (err) {
    if (err instanceof ProviderIndeterminateError) throw err;
    rejectedBy = err;
  }

  // 2) Create the intent at the gateway (network — outside the tx). The
  // idempotency key is the new intent's own public id + the attempt number —
  // distinct intents for the same PM+amount must NOT collide at the gateway, and
  // neither must a retry against the same intent (see retryPaymentIntent).
  const piPublicId = publicId("pi");
  const trace = attemptSpan();
  const maxAmountMinor =
    purpose === "setup" && input.maxAmountMinor != null ? BigInt(input.maxAmountMinor) : null;
  const firstOn = adapter.capabilities.setupCollectsFirstCharge ?? [];
  const firstChargeMinor =
    purpose === "setup" &&
    input.firstChargeMinor != null &&
    input.firstChargeMinor > 0 &&
    (input.methodTypes ?? []).length > 0 &&
    input.methodTypes!.every((m) => (firstOn as string[]).includes(m))
      ? BigInt(input.firstChargeMinor)
      : null;
  // Card limit (0482): an on-session charge above it may not be a card. A buyer-picks sheet
  // offers cards, so it is refused too; a non-card rail named here still goes ahead.
  const charged = purpose === "payment" ? BigInt(input.amountMinor ?? 0) : (firstChargeMinor ?? 0n);
  if (charged > 0n) {
    const asked = input.letBuyerChooseMethod
      ? null
      : ctx.pm
        ? [ctx.pm.type]
        : (input.methodTypes ?? ["card"]);
    if (asked === null || asked.includes("card")) {
      const [biz] = await withTenant(input.organizationId, (tx) =>
        tx
          .select({ cardPaymentLimits: businesses.cardPaymentLimits })
          .from(businesses)
          .where(eq(businesses.id, input.businessId))
          .limit(1),
      );
      if (overCardLimit(biz, input.currency, charged))
        throw new PaymentIntentError(CARD_LIMIT_MESSAGE, CARD_LIMIT_CODE);
    }
  }
  /**
   * A GATEWAY THAT REJECTS OUR REQUEST IS STILL AN OUTCOME — the caller-level half of #63.
   *
   * Adapters return genuine declines as DATA (`IntentRef.failure`), so anything that
   * THROWS out of `createIntent` is a rejection of the request itself. Stripe's
   * `payment_intent_payment_attempt_failed` is booked in the adapter now, but RazorPay and
   * PayPal have no try/catch in `createIntent` at all and there is no evidence base to
   * write per-code lists from — 1 stored `BAD_REQUEST_ERROR` between them. This catches
   * the class for EVERY gateway without guessing which codes are declines.
   *
   * Measured 2026-09-06: a Collect now that Stripe refused booked nothing — no intent, no
   * attempt, no transaction — and the failure survived only in `gateway_request_logs`,
   * invisible to the customer, the operator and the clock. RazorPay is now the INR rail
   * for every renewal, and the same silence there would be found the same way.
   *
   * ⚠️ RETHROWN after persisting, never swallowed. The row is a RECORD, not a verdict: an
   * engine bug must still reach the caller, or a decline-shaped result buries it — the
   * exact trap #63's narrowness exists to avoid.
   *
   * ⚠️ `ProviderIndeterminateError` is re-thrown UNTOUCHED. A timeout is not a rejection:
   * the gateway may well have processed the request, and booking a definite failure over
   * an unknown state is worse than booking nothing. That path keeps its existing handling.
   */
  // Built before the gateway call rather than inside its argument list: the call is
  // wrapped in a non-async callback, and the description needs two reads of its own.
  const gatewayDescription = await intentDescription(
    input.organizationId,
    input.flow,
    ctx,
    purpose,
    {
      maxAmountMinor,
      currency,
    },
  );
  // Counted on the clock `consumePaymentIntent` checks it against: a time-travelled
  // business would otherwise expire every intent at birth.
  const expiresAt = intentExpiresAt(await businessWallClock(input.businessId), {
    purpose,
    session: input.session ?? "on_session",
    rail: ctx.pm?.mandateRail ?? null,
    methodType: ctx.pm?.type ?? input.methodTypes?.[0] ?? null,
    currency,
    amountMinor: purpose === "setup" ? 0n : BigInt(input.amountMinor!),
    letBuyerChooseMethod: input.letBuyerChooseMethod ?? false,
  });
  let intent: IntentRef;
  try {
    // The vault step already refused: no gateway call, the same booking.
    if (rejectedBy) throw rejectedBy;
    const customerRef = providerCustomer!;
    intent = await withTraceContext(
      { ...trace, organizationId: input.organizationId, businessId: input.businessId },
      () =>
        adapter.createIntent!({
          purpose,
          amountMinor: purpose === "setup" ? 0n : BigInt(input.amountMinor!),
          currency,
          customer: customerRef,
          ...(ctx.customer ? { contact: providerContact(ctx.customer) } : {}),
          // Withheld when the buyer is choosing: on RazorPay `paymentMethod` is only a RAIL
          // HINT (its Checkout cannot be pointed at a vaulted token), and sending it would
          // re-pin the very rail this mode exists to leave open.
          ...(ctx.pm && !input.letBuyerChooseMethod
            ? {
                // The instrument's OWN rail, read off the row, with the mandate we hold.
                // Adapters fall back to `methodTypes ?? [paymentMethod.display.type]` when
                // no rail is requested, so a hardcoded `card` asked the gateway for a CARD
                // checkout on a UPI mandate or a bank debit.
                paymentMethod: providerPaymentMethodRef(ctx.pm, adapter.key),
              }
            : {}),
          // #31: the tag the gateway object carries, so a capture can be proved ours —
          // or proved NOT ours. The intent's OWN public id, bare: the gateway object IS
          // this intent, and an operator holding the tag pastes it into our search and
          // lands on this row. NOT the idempotency key below, which the adapters used as
          // a fallback witness (measured 2026-09-04: no engine call site passed a ref, so
          // every object fell through to it) — a key resolves to nothing, and this one
          // would read `pi_create_pi_…`, the same doubled prefix the live PayPal capture
          // showed on the invoice path.
          /**
           * THE DESCRIPTION THE INTENT PATH NEVER SENT.
           *
           * `collectInvoice` has always passed one, so renewals read well in Stripe while
           * every Pay now and Collect now taken through an INTENT fell back to the
           * adapter's own placeholder — literally "Card authorization" (see
           * `exportSafeDescription`), which names neither the customer, the invoice, nor
           * the plan.
           *
           * Best-effort by construction, exactly like the charge path: every lookup inside
           * degrades to a shorter label and a charge must never fail because its
           * description could not be built.
           */
          description: gatewayDescription,
          expiresAt,
          ownershipRef: piPublicId,
          // Only a buyer-picks pay-now with an invoice to book into (see the contract).
          ...(purpose === "payment" && input.letBuyerChooseMethod && ctx.invoiceId
            ? { captureOnConfirm: true }
            : {}),
          idempotencyKey: `pi_create_${piPublicId}_a1`,
          session: input.session ?? "on_session",
          // The mandate's per-debit ceiling. Only a `setup` intent registers a mandate, and
          // the adapter reads THIS field for it — never `amountMinor`, which is zero here.
          ...(maxAmountMinor != null ? { maxAmountMinor } : {}),
          ...(firstChargeMinor != null ? { firstChargeMinor } : {}),
          ...(input.returnUrl ? { returnUrl: gatewayReturnUrl(adapter, input.returnUrl) } : {}),
          ...(input.cancelUrl ? { cancelUrl: gatewayReturnUrl(adapter, input.cancelUrl) } : {}),
          ...(input.methodTypes && !input.letBuyerChooseMethod
            ? { methodTypes: input.methodTypes }
            : {}),
          ...(input.hostedWallet ? { hostedWallet: input.hostedWallet } : {}),
        }),
    );
  } catch (err) {
    // A timeout leaves the outcome UNKNOWN — never book a definite failure over it.
    if (err instanceof ProviderIndeterminateError) throw err;
    rejectedBy = err;
    // Shaped exactly like a returned refusal, so `attemptOutcomeOf` books it through the
    // one path that already exists: attempt `failed`, intent `inited`, code + text stored.
    //
    // `intentId` comes from the error's stranded-object stamp when it carries one. An
    // adapter that RECOGNISES a refusal returns it as data and never reaches here; this is
    // the other case — an error it did not anticipate, rethrown on purpose, which may
    // still have left a live object at the gateway. Before the stamp existed that id was
    // dropped here and the object became an unexplained `orphaned_gateway_intents` row.
    intent = {
      intentId: strandedObjectId(err) ?? "",
      status: "inited",
      failure: {
        code: "gateway_request_rejected",
        message:
          `The gateway rejected the request itself: ${(err as Error)?.message ?? String(err)} ` +
          "This is a configuration or request fault on our side, not a problem with the card of the customer. " +
          "A retry of the same request cannot succeed.",
        retriable: false,
      },
      raw: { error: (err as Error)?.message ?? String(err) },
    };
  }

  // 3) Persist the intent AND attempt #1 together. A gateway REFUSAL comes back
  // as data on the ref (adapters return declines rather than throwing), so the
  // outcome — not the bare status — decides what lands on the attempt.
  const outcome = attemptOutcomeOf(intent);
  const created = await withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .insert(paymentIntents)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: ctx.customer?.id ?? null,
        publicId: piPublicId,
        status: outcome.intentStatus,
        purpose,
        amountMinor: purpose === "setup" ? 0n : BigInt(input.amountMinor!),
        currency,
        // Persisted so a RETRY re-registers the mandate with the same ceiling (0174).
        maxAmountMinor,
        firstChargeMinor,
        gatewayAccountId: ctx.account.id,
        paymentMethodId: ctx.pm?.id ?? null,
        intentAtGateway: intent.intentId,
        nextAction: intent.authorization ?? null,
        attemptCount: 0,
        invoiceId: ctx.invoiceId,
        subscriptionId: ctx.subscriptionId,
        /**
         * The deadline, from the RAIL rather than a flat hour (see `ttl.ts`). The rail is
         * the instrument's `mandate_rail` falling back to its `type` — and for a `setup`
         * intent there is no instrument row yet, so the requested family
         * (`methodTypes[0]`) is the only hint there is; with neither, the intent takes the
         * 72h default, which `ttl.ts` documents as the deliberate choice for a buyer who
         * has not picked a rail.
         *
         * `letBuyerChooseMethod` overrides the rail for a `payment` intent: the same flag
         * that withholds the instrument from the adapter above withholds it from the
         * deadline, and a buyer-present sheet gets the hour.
         */
        expiresAt,
        // An intent can be BORN authorized — an adapter that authorizes inline returns
        // `authorized` from `createIntent`, and the probe measured exactly that
        // (scenario D held real money with `authorized_at` NULL). No coalesce on an
        // INSERT: there is no earlier value this could overwrite.
        authorizedAt: outcome.intentStatus === "authorized" ? stampNow() : null,
      })
      .returning();
    const attempt = await insertAttempt(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      paymentIntentId: row!.id,
      intentPublicId: piPublicId,
      attemptNumber: 1,
      status: outcome.attemptStatus,
      paymentMethodId: ctx.pm?.id ?? null,
      idAtGateway: intent.intentId,
      trace,
      errorCode: outcome.errorCode,
      errorText: outcome.errorText,
      // The page shows that wallet alone, so it paid; the capture names no method.
      ...(hostedWallet === "only" ? { methodUsed: input.hostedWallet } : {}),
    });
    await emitEvent(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      type: "payment_intent_created",
      data: buildEventData(
        "payment_intent_created",
        {
          id: row!.publicId,
          status: row!.status,
          purpose,
          amount_minor: Number(row!.amountMinor ?? 0n),
          currency: row!.currency,
        },
        row!.resourceVersion,
      ),
    });
    // The gateway refused this authorization outright. Emit the failure too, so a
    // decline at CREATE time is as observable to webhooks and dunning as one that
    // arrives later on an attempt.
    if (outcome.errorCode) {
      /**
       * AND BOOK IT AS A TRANSACTION — see `bookRefusedTransaction`.
       *
       * 13152c64 gave the refusal an intent and an attempt; neither is a row anyone
       * reads. `payment` only: a refused `setup` moved no money and a zero-amount payment
       * transaction would be noise in the one list that has to stay readable.
       *
       * It also carries `idAtGateway`, which is what makes the object at the gateway
       * findable from here — an intent Stripe DID create before refusing is otherwise
       * nameable only from the alert that calls it orphaned.
       */
      if (purpose === "payment") {
        await bookRefusedTransaction(tx, {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: ctx.customer?.id ?? null,
          amountMinor: row!.amountMinor ?? 0n,
          currency,
          gatewayAccountId: ctx.account.id,
          gatewayKey: ctx.account.gatewayKey,
          idAtGateway: intent.intentId || null,
          paymentMethodId: ctx.pm?.id ?? null,
          invoiceId: ctx.invoiceId,
          errorCode: outcome.errorCode,
          errorText: outcome.errorText,
          retriable: intent.failure?.retriable ?? null,
          paymentIntentId: row!.id,
          paymentAttemptId: attempt.id,
        });
      }
      await emitEvent(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        type: "payment_intent_failed",
        data: buildEventData("payment_intent_failed", {
          id: row!.publicId,
          status: row!.status,
          purpose,
          attempt_number: 1,
          error_code: outcome.errorCode,
          error_text: outcome.errorText,
        }),
      });
    }
    const [fresh] = await tx
      .select()
      .from(paymentIntents)
      .where(eq(paymentIntents.id, row!.id))
      .limit(1);
    return { intent: fresh ?? row!, attempt };
  });
  // The attempt is now on record; the caller still gets the error. Recording it does not
  // make it someone else's problem.
  if (rejectedBy) throw rejectedBy;
  return created;
}

// ── retry ───────────────────────────────────────────────────────────────────

/**
 * Try the intent AGAIN — mint attempt N+1 against the gateway.
 *
 * This is what "Payment Attempts: 2" means, and it is the whole point of
 * `payment_attempts`: the previous attempt is NEVER mutated, so the failed 3DS
 * that came before a success stays on the timeline. A fresh gateway intent is
 * created (a retry gets a new id at most gateways) and becomes the intent's
 * current `intent_at_gateway`.
 *
 * Legal only when the intent is still open (not consumed/expired/voided) AND the
 * latest attempt actually failed — retrying a live attempt would double-authorize
 * the buyer.
 */
export async function retryPaymentIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<{ intent: PaymentIntent; attempt: PaymentAttempt } | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status === "consumed") throw new PaymentIntentError("Intent already consumed");
  if (pi.status === "expired") throw new PaymentIntentError("Intent expired");
  if (pi.status === "voided" || pi.voidedAt) throw new PaymentIntentError("Intent was voided");

  const ctx = await withTenant(organizationId, async (tx) => {
    const last = await currentAttempt(tx, pi.id);
    if (!last) throw new PaymentIntentError("Intent has no attempt to retry");
    if (last.status !== "failed")
      throw new PaymentIntentError(
        `Attempt ${last.attemptNumber} is ${last.status}, not failed. There is nothing to retry.`,
      );
    const [acc] = await tx
      .select()
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.id, pi.gatewayAccountId!))
      .limit(1);
    if (!acc) throw new PaymentIntentError("Gateway account missing");
    if (acc.status !== "active")
      throw new PaymentIntentError(`Gateway account ${acc.publicId} is not active`);
    const pm = pi.paymentMethodId
      ? ((
          await tx
            .select()
            .from(paymentMethods)
            .where(eq(paymentMethods.id, pi.paymentMethodId))
            .limit(1)
        )[0] ?? null)
      : null;
    const customer = pi.customerId
      ? ((await tx.select().from(customers).where(eq(customers.id, pi.customerId)).limit(1))[0] ??
        null)
      : null;
    return { last, acc, pm, customer };
  });

  const purpose = (pi.purpose as IntentPurpose) ?? "payment";
  const adapter = resolveAdapter(ctx.acc);
  assertSupportsPurpose(adapter, ctx.acc, purpose);
  if (ctx.pm && pi.currency) assertMandateCurrency(ctx.pm, pi.currency);

  const providerCustomer = ctx.pm
    ? { providerKey: adapter.key, providerCustomerId: ctx.pm.providerCustomerId }
    : await ensureProviderCustomer({
        organizationId,
        businessId,
        customer: ctx.customer!,
        provider: adapter,
        gatewayAccountId: ctx.acc.id,
      });

  const attemptNumber = ctx.last.attemptNumber + 1;
  const retryDescription = await intentDescription(
    organizationId,
    purpose === "payment" && !ctx.pm ? "portal_payment" : undefined,
    { invoiceId: pi.invoiceId, subscriptionId: pi.subscriptionId, customer: ctx.customer },
    purpose,
  );
  const retryExpiresAt = intentExpiresAt(await businessWallClock(pi.businessId), {
    purpose,
    // A retry always asks the gateway for an on-session authorization (the
    // `session: 'on_session'` below), so the rail is what decides the deadline.
    session: "on_session",
    rail: ctx.pm?.mandateRail ?? null,
    methodType: ctx.pm?.type ?? null,
    currency: pi.currency,
    amountMinor: pi.amountMinor,
    /**
     * INFERRED, because the flag is not a column. A `payment` intent with no stored
     * instrument can only have been minted with `letBuyerChooseMethod` — the create
     * path refuses that combination otherwise ("A payment intent requires a payment
     * method" unless the buyer is choosing in the sheet). So the inference is exact,
     * not a guess, and without it a retried Pay now inherits the 72h unknown-rail
     * default that the create path was just fixed to avoid — the same fix landing on
     * one path and not its twin, which is how #63 came back a second time.
     */
    letBuyerChooseMethod: purpose === "payment" && !ctx.pm,
  });
  const trace = attemptSpan();
  let intent;
  try {
    intent = await withTraceContext({ ...trace, organizationId, businessId }, () =>
      adapter.createIntent!({
        purpose,
        amountMinor: pi.amountMinor ?? 0n,
        currency: pi.currency!,
        customer: providerCustomer,
        ...(ctx.customer ? { contact: providerContact(ctx.customer) } : {}),
        // The instrument's own rail and mandate — see the note at the create call site.
        ...(ctx.pm ? { paymentMethod: providerPaymentMethodRef(ctx.pm, adapter.key) } : {}),
        // #31: same tag as the create path, and deliberately NOT attempt-scoped. Every
        // attempt re-registers a gateway object for the SAME intent of ours, so all of
        // them must name that one row; per-attempt refs would scatter one intent's
        // objects across ids the console cannot group.
        // Rebuilt from the row, since the description is not stored either. The FLOW is
        // inferred exactly as `letBuyerChooseMethod` is a few lines down and for the same
        // reason: a `payment` intent with no stored instrument can only have been minted by
        // the portal, because the create path refuses that combination otherwise. Anything
        // holding an instrument came from Collect now or the API, and those do not claim a
        // flow rather than claim the wrong one on a payer's receipt.
        description: retryDescription,
        expiresAt: retryExpiresAt,
        ownershipRef: pi.publicId,
        // Same rule as the create path: a buyer-picks intent with an invoice behind it.
        ...(purpose === "payment" && !ctx.pm && pi.invoiceId ? { captureOnConfirm: true } : {}),
        // Attempt-scoped: reusing the create key would make the gateway hand back
        // the FAILED intent instead of opening a new authorization.
        idempotencyKey: `pi_create_${pi.publicId}_a${attemptNumber}`,
        session: "on_session",
        // Read back off the row, not off a request that is long gone: a retry creates a
        // NEW mandate registration at the gateway, so omitting the ceiling here would
        // silently re-cap the buyer at the adapter's default (₹10,000 on RazorPay) and
        // the mismatch would only surface as a declined renewal months later.
        ...(pi.maxAmountMinor != null ? { maxAmountMinor: pi.maxAmountMinor } : {}),
        ...(pi.firstChargeMinor != null ? { firstChargeMinor: pi.firstChargeMinor } : {}),
      }),
    );
  } catch (e) {
    // The retry never reached an authorization — record it as an attempt anyway,
    // otherwise the timeline silently loses a real gateway interaction.
    log.error(e, { event: "intent_retry_failed", intent: pi.publicId, attemptNumber });
    await withTenant(organizationId, async (tx) => {
      const failedAttempt = await insertAttempt(tx, {
        organizationId,
        businessId,
        paymentIntentId: pi.id,
        intentPublicId: pi.publicId,
        attemptNumber,
        status: "failed",
        paymentMethodId: pi.paymentMethodId,
        errorCode: "intent_create_failed",
        errorText: e instanceof Error ? e.message : String(e),
        trace,
      });
      // Retry is the create path's twin and had the identical blind spot: an attempt on
      // record, nothing on the invoice. No gateway id here by construction — the adapter
      // threw, so it handed back no object to name.
      if (purpose === "payment" && pi.currency) {
        await bookRefusedTransaction(tx, {
          organizationId,
          businessId,
          customerId: pi.customerId,
          amountMinor: pi.amountMinor ?? 0n,
          currency: pi.currency,
          gatewayAccountId: ctx.acc.id,
          gatewayKey: ctx.acc.gatewayKey,
          idAtGateway: null,
          paymentMethodId: pi.paymentMethodId,
          invoiceId: pi.invoiceId,
          errorCode: "intent_create_failed",
          errorText: e instanceof Error ? e.message : String(e),
          retriable: null,
          paymentIntentId: pi.id,
          paymentAttemptId: failedAttempt.id,
        });
      }
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_intent_failed",
        data: buildEventData("payment_intent_failed", {
          id: pi.publicId,
          status: pi.status,
          purpose,
          attempt_number: attemptNumber,
          error_code: "intent_create_failed",
          error_text: e instanceof Error ? e.message : String(e),
        }),
      });
    });
    throw e;
  }

  const outcome = attemptOutcomeOf(intent);
  return withTenant(organizationId, async (tx) => {
    const attempt = await insertAttempt(tx, {
      organizationId,
      businessId,
      paymentIntentId: pi.id,
      intentPublicId: pi.publicId,
      attemptNumber,
      status: outcome.attemptStatus,
      paymentMethodId: pi.paymentMethodId,
      idAtGateway: intent.intentId,
      trace,
      errorCode: outcome.errorCode,
      errorText: outcome.errorText,
    });
    const [row] = await tx
      .update(paymentIntents)
      .set({
        status: outcome.intentStatus,
        intentAtGateway: intent.intentId,
        nextAction: intent.authorization ?? null,
        // A new gateway intent carries its own TTL; the old deadline belonged to the
        // authorization that failed. Rail-aware like the create site — a retry of an
        // e-mandate registration is the same 2-working-day wait the first attempt was,
        // and the instrument (if any) is read off the row.
        expiresAt: retryExpiresAt,
        // Attempt N+1 can come back authorized straight away, exactly as attempt 1 can.
        // Coalesced, so a retry that re-authorizes never moves the first hold's stamp.
        ...(outcome.intentStatus === "authorized" ? { authorizedAt: FIRST_AUTHORIZED_AT } : {}),
      })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    // A retry the gateway refused straight away is still a real attempt, and it
    // must read as `failed` so the NEXT retry is legal.
    if (outcome.errorCode) {
      // …and a transaction, for the same reason the create path books one. Here the
      // adapter DID answer, so `intent.intentId` carries whatever object the gateway kept.
      if (purpose === "payment" && pi.currency) {
        await bookRefusedTransaction(tx, {
          organizationId,
          businessId,
          customerId: pi.customerId,
          amountMinor: pi.amountMinor ?? 0n,
          currency: pi.currency,
          gatewayAccountId: ctx.acc.id,
          gatewayKey: ctx.acc.gatewayKey,
          idAtGateway: intent.intentId || null,
          paymentMethodId: pi.paymentMethodId,
          invoiceId: pi.invoiceId,
          errorCode: outcome.errorCode,
          errorText: outcome.errorText,
          retriable: intent.failure?.retriable ?? null,
          paymentIntentId: pi.id,
          paymentAttemptId: attempt.id,
        });
      }
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_intent_failed",
        data: buildEventData("payment_intent_failed", {
          id: pi.publicId,
          status: row!.status,
          purpose,
          attempt_number: attemptNumber,
          error_code: outcome.errorCode,
          error_text: outcome.errorText,
        }),
      });
    }
    return { intent: row!, attempt };
  });
}

// ── read ────────────────────────────────────────────────────────────────────

export async function getPaymentIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<PaymentIntent | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(eq(paymentIntents.businessId, businessId), eq(paymentIntents.publicId, piPublicId)),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * The instrument one ATTEMPT was tried with, resolved from
 * `payment_attempts.payment_method_id`. "Payment Method" shows on every Attempt
 * card, and it is per-attempt for a real reason: a buyer who is declined
 * can retry on a different card, so reading the intent's method would mislabel
 * every attempt but the last.
 *
 * Every field is nullable and `method` itself can be null — a `setup` intent has
 * NO instrument until the buyer supplies one, and a vaulted method can be deleted
 * while the attempt that used it stays as history (there is deliberately no FK).
 */
export interface AttemptPaymentMethod {
  /** Public id (`pm_…`) — null when the row was deleted after the attempt. */
  publicId: string | null;
  /** `card` | `upi` | `wallet` | … */
  type: string | null;
  brand: string | null;
  last4: string | null;
}

/** An attempt plus its instrument. Intersection, so every `PaymentAttempt` field reads unchanged. */
export type PaymentAttemptWithMethod = PaymentAttempt & { method: AttemptPaymentMethod | null };

/**
 * Every attempt of one intent, OLDEST FIRST — the order the detail page renders
 * "Attempt 1 / Attempt 2 / …" in, and the order a timeline reads in. The
 * instrument is joined so the caller can render the per-attempt "Payment Method"
 * row without a second round trip per card.
 */
export async function listAttemptsForIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<PaymentAttemptWithMethod[]> {
  return withTenant(organizationId, async (tx) => {
    const [pi] = await tx
      .select({ id: paymentIntents.id })
      .from(paymentIntents)
      .where(
        and(eq(paymentIntents.businessId, businessId), eq(paymentIntents.publicId, piPublicId)),
      )
      .limit(1);
    if (!pi) return [];
    const rows = await tx
      .select({
        attempt: paymentAttempts,
        pmPid: paymentMethods.publicId,
        pmType: paymentMethods.type,
        pmBrand: paymentMethods.brand,
        pmLast4: paymentMethods.last4,
      })
      .from(paymentAttempts)
      .leftJoin(paymentMethods, eq(paymentAttempts.paymentMethodId, paymentMethods.id))
      .where(eq(paymentAttempts.paymentIntentId, pi.id))
      .orderBy(asc(paymentAttempts.attemptNumber));
    return rows.map((r) => ({
      ...r.attempt,
      // `method: null` means the ATTEMPT names no instrument. A non-null `method`
      // whose fields are all null means it named one we can no longer resolve —
      // two different facts, so they are not collapsed onto one shape.
      method: r.attempt.paymentMethodId
        ? {
            publicId: r.pmPid ?? null,
            type: r.pmType ?? null,
            brand: r.pmBrand ?? null,
            last4: r.pmLast4 ?? null,
          }
        : null,
    }));
  });
}

/**
 * The `payment_reversal` transaction `voidPaymentIntent` books, correlated by
 * `transactions.payment_intent_id` (0172).
 *
 * The timeline names this transaction's id under "Transaction Voided", and without
 * it the node states a void the operator cannot then go and look at. Newest
 * first and capped at one: an intent is voided once, but ordering makes the read
 * deterministic rather than relying on that.
 */
export async function getPaymentIntentReversal(
  organizationId: string,
  intentId: string,
): Promise<{ publicId: string; createdAt: Date } | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select({ publicId: transactions.publicId, createdAt: transactions.createdAt })
      .from(transactions)
      .where(
        and(eq(transactions.paymentIntentId, intentId), eq(transactions.type, "payment_reversal")),
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    return row ?? null;
  });
}

// ── authorize ───────────────────────────────────────────────────────────────

/**
 * Gateway callback: the buyer completed the challenge → authorize.
 *
 * Resolves the CURRENT (highest-numbered) attempt, not the intent alone: "the
 * buyer passed 3DS" is a fact about one try, and stamping it on the container
 * only is what erased attempt history in the first place.
 */
export async function authorizePaymentIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<PaymentIntent | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status === "consumed" || pi.status === "expired" || pi.status === "voided")
    throw new PaymentIntentError(`Intent is ${pi.status}`);

  const attempt = await withTenant(organizationId, (tx) => currentAttempt(tx, pi.id));
  // Resolve the gateway-side challenge (tmtest simulates the 3DS completion).
  if (pi.gatewayAccountId) {
    const [acc] = await withTenant(organizationId, (tx) =>
      tx
        .select()
        .from(gatewayAccounts)
        .where(eq(gatewayAccounts.id, pi.gatewayAccountId!))
        .limit(1),
    );
    const gatewayIntentId = attempt?.idAtGateway ?? pi.intentAtGateway;
    if (acc?.gatewayKey === "tmtest" && gatewayIntentId) {
      await withTraceContext({ ...attemptSpan(attempt), organizationId, businessId }, () =>
        TmtestProvider.resolveChallenge(gatewayIntentId, true),
      );
    }
  }
  return withTenant(organizationId, async (tx) => {
    if (attempt) {
      await writeAttemptStatus(tx, attempt, {
        status: "authorized",
        errorCode: null,
        errorText: null,
      });
    }
    const [row] = await tx
      .update(paymentIntents)
      // The moment the gateway actually held the buyer's money — the one transition this
      // column exists for. `FIRST_AUTHORIZED_AT`, so a redelivered `intent.authorized`
      // (gateways retry) re-runs this whole handler harmlessly without moving it.
      .set({ status: "authorized", nextAction: null, authorizedAt: FIRST_AUTHORIZED_AT })
      // Guarded: a consume that commits between the read above and this write (a buyer's
      // leg 2 racing the webhook) must not be walked back. Throwing rolls back the attempt.
      .where(
        and(
          eq(paymentIntents.id, pi.id),
          notInArray(paymentIntents.status, ["consumed", "expired", "voided"]),
        ),
      )
      .returning();
    if (!row) throw new PaymentIntentError("Intent is no longer open");
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_authorized",
      data: buildEventData(
        "payment_intent_authorized",
        {
          id: row!.publicId,
          status: row!.status,
          purpose: row!.purpose,
          attempt_number: attempt?.attemptNumber ?? null,
        },
        row!.resourceVersion,
      ),
    });
    return row!;
  });
}

// ── gateway callbacks (inbound webhooks) ────────────────────────────────────

/**
 * The gateway authorized AFTER we had already written the intent off — put it back so
 * the money can be reconciled.
 *
 * ── The hole this closes ──────────────────────────────────────────────────────
 * `applyIntentEvent` (webhooks/inbound.ts) computes
 * `terminal = consumed | expired | voided | voided_at != null` and opens both authorize
 * cases with `if (terminal) return 'ignored'`. That guard is right about three of those
 * four states and wrong about `expired`, because `expired` is OUR opinion about a clock,
 * not the gateway's about the money. Measured with `scripts/probe-late-authorization.ts`
 * (scenarios A and B): the approval is dropped in silence, leaving either a hold at the
 * gateway with the invoice unpaid — INV-5510 carries two RazorPay orders, the second
 * `authorized` with `pay_XXXXXXXXXXXX01` and zero engine rows — or a live mandate with no
 * `payment_methods` row. The rail-aware TTL (`ttl.ts`) makes this rare; it cannot make it
 * impossible, because no deadline can outlast a bank that is simply late.
 *
 * ── What it will and will not revive ──────────────────────────────────────────
 * ONLY `expired`, and the two exclusions are not symmetric:
 *  - **consumed** → null. It is genuinely finished; a redelivered authorization for a
 *    captured intent is a duplicate, not a discovery.
 *  - **voided / `voided_at`** → null, and this is the important one. A void means we
 *    deliberately RELEASED the hold at the gateway (`voidPaymentIntent`, or the release
 *    inside `expirePaymentIntents`). Reviving it would claim money we asked the gateway
 *    to give back — the caller records that money separately instead.
 *
 * ── Why it is a compare-and-set ───────────────────────────────────────────────
 * Same shape as `expirePaymentIntents`'s claim and `consumePaymentIntent`'s, for the same
 * reason: gateways redeliver. Two copies of one `intent.authorized` must not both revive
 * and both hand a capture to the caller. The UPDATE is guarded on `status = 'expired'`, so
 * exactly one wins and the loser gets `null`.
 *
 * Nothing is captured, released or voided here — the caller owns what the money is FOR.
 */
export async function reviveIntentForLateAuthorization(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  opts: { occurredAt: Date },
): Promise<PaymentIntent | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status !== "expired") return null;
  // Belt and braces: `voided` is excluded by the status check, `voided_at` on a row that
  // reads `expired` is not — the sweep sets the status and the release records the void.
  if (pi.voidedAt) return null;

  /**
   * The new deadline, and the ONE subtlety in this function.
   *
   * It is the rail-aware TTL again, counted from when the authorization actually happened
   * — but floored at the BUSINESS wall clock, because that is the clock
   * `consumePaymentIntent` measures `expires_at` against (`businessWallClock`, so a
   * time-travelled test business expires intents in simulated time). Counting from
   * `occurredAt` alone would hand a time-travelled business a revived intent that is
   * already expired again, and the caller's capture would fail on the guard this revive
   * exists to clear. Long enough, either way, that the caller's immediate capture cannot
   * lose a race with the next hourly sweep.
   */
  const wall = await businessWallClock(pi.businessId);
  const base = opts.occurredAt.getTime() > wall.getTime() ? opts.occurredAt : wall;
  const pm = pi.paymentMethodId
    ? await withTenant(
        organizationId,
        async (tx) =>
          (
            await tx
              .select({ mandateRail: paymentMethods.mandateRail, type: paymentMethods.type })
              .from(paymentMethods)
              .where(eq(paymentMethods.id, pi.paymentMethodId!))
              .limit(1)
          )[0] ?? null,
      )
    : null;
  const expiresAt = new Date(
    base.getTime() +
      intentTtlMs({
        purpose: (pi.purpose as "payment" | "setup") ?? "payment",
        // The rail decides it, not the session: whoever was present at the challenge, this
        // authorization has already taken longer than the on-session hour.
        session: "off_session",
        rail: pm?.mandateRail ?? null,
        methodType: pm?.type ?? null,
        currency: pi.currency,
        amountMinor: pi.amountMinor,
      }),
  );

  const revived = await withTenant(organizationId, async (tx) => {
    const [claimed] = await tx
      .update(paymentIntents)
      .set({
        status: "authorized",
        nextAction: null,
        expiresAt,
        // `coalesce`, per migration 0217, and stamped with `occurredAt` rather than `now()`:
        // the hold was taken when the bank approved it, which is the fact the
        // abandoned-hold invariant reads. Bound as text + cast, never as a bare JS Date —
        // interpolating a Date into a `sql` template binds it as text and throws at call
        // time (the note on `liveIntentForInvoice` is about that trap).
        authorizedAt: sql`coalesce(${paymentIntents.authorizedAt}, ${opts.occurredAt.toISOString()}::timestamptz)`,
      })
      .where(and(eq(paymentIntents.id, pi.id), eq(paymentIntents.status, "expired")))
      .returning();
    if (!claimed) return null;

    /**
     * Reopen the attempt the sweep closed.
     *
     * `expirePaymentIntents` fails every open attempt with `intent_expired` / "The intent
     * expired before it was consumed". Left `failed` under an `authorized` intent it would
     * put the row at odds with both readers of that pairing: `retryPaymentIntent` treats
     * "open intent + failed latest attempt" as retriable and would mint a pointless attempt
     * N+1 against an authorization that already succeeded, and the attempt timeline would
     * show a decline where the bank in fact approved.
     *
     * ONLY that error code, and only the latest attempt. A genuine decline
     * (`insufficient_funds`, a refused 3DS) is real history and is never rewritten — the
     * whole point of `payment_attempts` is that earlier tries survive.
     */
    const attempt = await currentAttempt(tx, claimed.id);
    if (attempt?.status === "failed" && attempt.errorCode === "intent_expired") {
      await writeAttemptStatus(tx, attempt, {
        status: "authorized",
        errorCode: null,
        errorText: null,
      });
    }
    return claimed;
  });
  if (!revived) return null;

  // WARN, not info: every line here is an authorization we had already given up on, which
  // is a statement about the TTL and about webhook latency, not just about this intent.
  // `late_by_ms` is the number that says whether the rail's TTL is set right.
  log.warn("a payment intent was revived — the gateway authorized it after we expired it", {
    event: "intent_revived_late_authorization",
    intent: revived.publicId,
    purpose: revived.purpose,
    amountMinor: String(revived.amountMinor ?? 0n),
    currency: revived.currency,
    invoice: revived.invoiceId,
    customer: revived.customerId,
    expires_at: pi.expiresAt?.toISOString() ?? null,
    occurred_at: opts.occurredAt.toISOString(),
    late_by_ms: pi.expiresAt ? opts.occurredAt.getTime() - pi.expiresAt.getTime() : null,
    new_expires_at: expiresAt.toISOString(),
  });
  return revived;
}

/**
 * Resolve the intent a gateway INTENT id belongs to.
 *
 * Uses the admin connection deliberately: an inbound provider webhook arrives with
 * no org context, so the org is resolved FROM our own record and every subsequent
 * write happens inside `withTenant` — the same pattern the charge/refund handlers
 * in `webhooks/inbound.ts` use against `transactions`/`payments`.
 *
 * Correlates on `intent_at_gateway`, never on a charge id: an authorized-but-
 * unconsumed intent has no `transactions` row at all, which is precisely why the
 * intent callbacks were inert. Indexed by `payment_intents_gateway_intent_idx`
 * (0173).
 */
/**
 * A LIVE payment intent already working on this invoice, if any.
 *
 * The other half of the double-charge guard. `pendingPaymentForInvoice` sees an
 * outstanding `payments` row — but a buyer who is mid-checkout has no payment row yet,
 * only an intent, so collection could not see them at all. Measured 2026-08-14: with
 * `pi_XXXXXXXXXXXXXXXXXXXXXX01` open on INV-2143 a collect ran anyway and booked
 * `pay_XXXXXXXXXXXXXXXXXXXXXX02`. The buyer finishes their checkout, the mandate debit
 * settles, and they have paid twice.
 *
 * "Live" is deliberately narrow: not consumed, not voided, not expired, and still
 * inside its own expiry window. That bounds the block — an abandoned checkout stops
 * holding dunning off the moment the intent lapses, and `expirePaymentIntents` retires it
 * regardless. Waiting for a buyer who is actively paying is a far better trade than
 * charging them twice.
 *
 * ⚠️ How long that wait is, is now the RAIL's answer (`ttl.ts`), not a flat hour: an hour
 * for the on-session card this paragraph was written about, up to 7 days for an e-mandate.
 * That is deliberate and it is the same trade, read at the right scale — an INR e-mandate
 * debit can be authorized up to 2 working days after it is accepted, so collecting again
 * inside that window is not impatience, it is the double charge this guard exists to
 * prevent (measured: INV-5510, two RazorPay orders, the second `authorized` with
 * `pay_XXXXXXXXXXXX01`).
 */
export async function liveIntentForInvoice(
  organizationId: string,
  invoiceId: string,
  now: Date,
): Promise<PaymentIntent | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(paymentIntents)
      .where(
        and(
          eq(paymentIntents.invoiceId, invoiceId),
          isNull(paymentIntents.voidedAt),
          notInArray(paymentIntents.status, ["consumed", "expired", "voided"]),
          // `or(...)` + `gt(...)`, not a raw template: interpolating a JS Date into
          // sql`` binds it as text and throws TypeError at call time, which reads as the
          // guard "working" (no second charge) when in fact the whole collection crashed.
          or(isNull(paymentIntents.expiresAt), gt(paymentIntents.expiresAt, now)),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Resolve a gateway intent id back to OUR intent, within the business that delivered it.
 *
 * `intent_at_gateway` is not unique — a retry re-points it, and two intents can carry the
 * same id across gateway accounts. The previous version acknowledged exactly that and then
 * guessed anyway ("pick the most recent deterministically rather than letting the plan
 * decide"), unscoped across every tenant. That is not a tie-break, it is a coin toss with
 * someone's money: the caller reads `organizationId` and `businessId` OFF the row this
 * returns and then authorizes, harvests or fails the intent under that org — a real capture
 * at the gateway.
 *
 * Two ways it lands in the wrong tenant. Two of our organizations on one shared gateway
 * account make these ids collide for free. And webhook signatures are checked against the
 * merchant's OWN stored secret, so a tenant can post a validly-signed `intent.*` naming an
 * id they observed — the id reaches a buyer's browser during checkout.
 *
 * So: scope to the delivering business when the caller knows it, and DECLINE on ambiguity
 * rather than ordering by date. `null` reads as "not one of our intents" to every caller,
 * which is the safe direction — a missed reconciliation is a discrepancy an operator can
 * find; a capture booked against the wrong tenant is not.
 */
export async function findPaymentIntentByGatewayIntentId(
  gatewayIntentId: string,
  scope?: { businessId?: string | null },
): Promise<PaymentIntent | null> {
  const rows = await systemDb
    .select()
    .from(paymentIntents)
    .where(
      and(
        eq(paymentIntents.intentAtGateway, gatewayIntentId),
        ...(scope?.businessId ? [eq(paymentIntents.businessId, scope.businessId)] : []),
      ),
    )
    .limit(2);
  if (rows.length > 1) {
    log.error(new Error("ambiguous gateway intent id — refusing to guess which intent it is"), {
      event: "inbound_intent_ambiguous",
      intent_at_gateway: gatewayIntentId,
      businessId: scope?.businessId ?? null,
      detail:
        "two payment intents share this gateway intent id in scope; the callback is ignored rather than captured against the wrong tenant",
    });
    return null;
  }
  return rows[0] ?? null;
}

/**
 * The gateway refused an authorization (3DS failed, mandate rejected) — the
 * webhook counterpart of a failed `consumeIntent`.
 *
 * Fails the CURRENT attempt and leaves the INTENT status untouched. That is not an
 * oversight: `payment_intents` has no `failed` status (see migration 0172), and the
 * retriable state is exactly "open intent whose latest attempt failed" — what
 * `retryPaymentIntent` checks for. Marking the container failed would make a
 * recoverable 3DS decline look terminal.
 *
 * Returns null when there is nothing to fail (the intent is already consumed /
 * expired / voided, or its latest attempt is already closed), so a redelivered or
 * out-of-order callback is a no-op rather than a second failure event.
 */
export async function failPaymentIntentFromGateway(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  failure: { code: string; message: string },
): Promise<{ intent: PaymentIntent; attempt: PaymentAttempt } | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status === "consumed" || pi.status === "expired" || pi.status === "voided" || pi.voidedAt)
    return null;

  return withTenant(organizationId, async (tx) => {
    const attempt = await currentAttempt(tx, pi.id);
    if (
      !attempt ||
      !OPEN_ATTEMPT_STATUSES.includes(attempt.status as (typeof OPEN_ATTEMPT_STATUSES)[number])
    )
      return null;
    const failed = await failAttempt(tx, attempt, failure.code, failure.message, pi.publicId);
    const [row] = await tx
      .update(paymentIntents)
      .set({ nextAction: null })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_failed",
      data: buildEventData(
        "payment_intent_failed",
        {
          id: pi.publicId,
          status: row!.status,
          purpose: pi.purpose,
          attempt_number: failed.attemptNumber,
          error_code: failure.code,
          error_text: failure.message,
        },
        row!.resourceVersion,
      ),
    });
    return { intent: row!, attempt: failed };
  });
}

/**
 * The gateway told us the authorization was RELEASED (Stripe
 * `payment_intent.canceled`, PayPal `PAYMENT.AUTHORIZATION.VOIDED`).
 *
 * Deliberately NOT `voidPaymentIntent`: that one CALLS the gateway to release a
 * hold. Here the gateway is the one doing the telling, so calling back out would be
 * a pointless round-trip at best — and on RazorPay it would raise
 * `PaymentIntentVoidUnsupportedError` for an event we simply need to record. No
 * `transactions` row is written either: `voidPaymentIntent` books a
 * `payment_reversal` for the release IT performed, and duplicating that here would
 * double-count the same release when a merchant-initiated void is echoed back to us
 * as a webhook.
 *
 * Returns null when the intent is already voided/consumed/expired.
 */
export async function markPaymentIntentVoidedFromGateway(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  voidedAt?: Date,
): Promise<{ intent: PaymentIntent; attempt: PaymentAttempt | null } | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status === "consumed" || pi.status === "expired" || pi.status === "voided" || pi.voidedAt)
    return null;

  return withTenant(organizationId, async (tx) => {
    let attempt = await currentAttempt(tx, pi.id);
    if (
      attempt &&
      OPEN_ATTEMPT_STATUSES.includes(attempt.status as (typeof OPEN_ATTEMPT_STATUSES)[number])
    ) {
      attempt = await writeAttemptStatus(tx, attempt, { status: "voided" });
    }
    const [row] = await tx
      .update(paymentIntents)
      .set({ status: "voided", voidedAt: voidedAt ?? stampNow(), nextAction: null })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_voided",
      data: buildEventData(
        "payment_intent_voided",
        {
          id: pi.publicId,
          status: "voided",
          purpose: pi.purpose,
          amount_minor: Number(pi.amountMinor ?? 0n),
          currency: pi.currency,
          attempt_number: attempt?.attemptNumber ?? null,
        },
        row!.resourceVersion,
      ),
    });
    return { intent: row!, attempt };
  });
}

/** What `closeIntentForReturnedCharge` was told about the money, for the record it writes. */
export interface ReturnedChargeFacts {
  /** The gateway's charge id — the id every side of this carries. */
  providerChargeId: string;
  refundedMinor: bigint;
  fullyReturned: boolean;
  /** The gateway's own refund id: what the gateway's dashboard shows. */
  providerRefundId: string | null;
  refundPublicId: string | null;
  paymentPublicId: string | null;
}

/**
 * This intent's money ALREADY CAME BACK — close it, and say so.
 *
 * ── WHY (measured 2026-09-03, INV-7824 · docs/PROGRESS.md #17) ──────────────────
 * RazorPay delivered `payment.authorized` LAST, 21 minutes out of order: after their own
 * `payment.captured` and after OUR refund of that exact charge (`rfnd_XXXXXXXXXXXX01`).
 * `authorizePaymentIntent` then flipped the intent `in_progress → authorized` and stamped
 * `authorized_at` — for money that was already back with the buyer. Two things follow from
 * that lie: the harvest raised a `needs_attention` claiming the gateway held ₹22,184.00,
 * and the intent sat `authorized` until its expiry, where `releaseHoldBeforeExpiry` would
 * try to release a hold that no longer exists on a gateway that cannot void anyway.
 *
 * ── WHY `consumed` AND NOT `voided` ─────────────────────────────────────────────
 * `voided`/`voided_at` mean the hold was RELEASED without money moving — the schema says
 * so, and `payment_intent_voided` is read that way. Here money did move: the hold became a
 * charge, we booked it, and we gave it back. `consumed` is the honest terminal state ("this
 * intent's money arrived"), and it is also the one every other guard already understands —
 * `applyIntentEvent` ignores a redelivery on it, `liveIntentForInvoice` excludes it, and
 * `releaseHoldBeforeExpiry` reads `not_held`. The refund is named on the event instead of
 * being implied by a status that cannot carry it.
 *
 * No `transactions` row: the money's story is already told by the payment and the refund
 * transactions that exist for this charge. A third row asserting an authorization would
 * double-count in the money log — the same reasoning `markPaymentIntentVoidedFromGateway`
 * and `consumeSetup` give for not writing a `payment_reversal` they did not perform.
 *
 * Returns null when there was nothing to close (already `consumed`/`voided`, or a
 * concurrent delivery claimed it) — the caller treats that as "someone else did this".
 */
export async function closeIntentForReturnedCharge(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  facts: ReturnedChargeFacts,
): Promise<PaymentIntent | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status === "consumed" || pi.status === "voided" || pi.voidedAt) return null;

  return withTenant(organizationId, async (tx) => {
    // Compare-and-set, so two redeliveries of the same late event cannot both close it.
    const [row] = await tx
      .update(paymentIntents)
      .set({
        status: "consumed",
        nextAction: null,
        // The hold DID exist — the gateway held the money before capturing it. Coalesced
        // for the same reason `authorizePaymentIntent` coalesces: the column records that
        // a hold once existed, and a redelivery must not move it.
        authorizedAt: FIRST_AUTHORIZED_AT,
      })
      .where(
        and(
          eq(paymentIntents.id, pi.id),
          notInArray(paymentIntents.status, ["consumed", "voided"]),
        ),
      )
      .returning();
    if (!row) return null;
    let attempt = await currentAttempt(tx, pi.id);
    if (
      attempt &&
      OPEN_ATTEMPT_STATUSES.includes(attempt.status as (typeof OPEN_ATTEMPT_STATUSES)[number])
    ) {
      attempt = await writeAttemptStatus(tx, attempt, {
        status: "consumed",
        // The attempt learns the CHARGE id it produced. It only ever knew the gateway's
        // intent/order id, which is why nothing local could tie this intent to its payment
        // in the first place — the gap #17 documents.
        idAtGateway: attempt.idAtGateway ?? facts.providerChargeId,
      });
    }
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_consumed",
      data: buildEventData(
        "payment_intent_consumed",
        {
          id: pi.publicId,
          status: "consumed",
          purpose: pi.purpose,
          amount_minor: Number(pi.amountMinor ?? 0n),
          currency: pi.currency,
          attempt_number: attempt?.attemptNumber ?? null,
        },
        row.resourceVersion,
        // WHY it closed, on the event itself — a consumer that sees only `consumed` would
        // conclude we collected this money. We collected it and returned it.
        {
          charge_at_gateway: facts.providerChargeId,
          returned: {
            refund: facts.refundPublicId,
            provider_refund_id: facts.providerRefundId,
            payment: facts.paymentPublicId,
            refunded_minor: Number(facts.refundedMinor),
            fully_returned: facts.fullyReturned,
          },
        },
      ),
    });
    return row;
  });
}

// ── consume ─────────────────────────────────────────────────────────────────

export interface ConsumePaymentIntentResult {
  intent: PaymentIntent;
  attempt: PaymentAttempt | null;
  /** `purpose: 'payment'` — the gateway's capture outcome. */
  charge?: ChargeResult;
  /** `purpose: 'setup'` — the instrument the intent existed to vault. */
  paymentMethod?: PaymentMethodRow;
}

/**
 * ── WHAT A PAYER READS WHEN WE REFUSE THEIR PAYMENT (#23) ───────────────────
 *
 * `customer-portal-routes.ts` maps every `PaymentIntentError` out of this module to
 * `badRequest(reply, e.message)`. So these are not developer strings: they are the
 * sentence a person reads after handing over money. Measured 2026-09-03 17:47 (Pay now
 * → cancel the subscription mid-checkout → complete the payment at RazorPay), the one
 * they read after a SUCCESSFUL payment was:
 *
 *     "Intent is in_progress; complete the challenge first"
 *
 * — our vocabulary, and an instruction to redo the step they had just finished.
 *
 * Three rules, lifted from B2's zero-due copy in that same route rather than invented,
 * so the portal has one voice and not a fourth register:
 *  1. **No internal vocabulary.** No `Intent`, `in_progress`, `consumed`; no gateway,
 *     no account ids. `verify:customer-portal` asserts the absence, because a wording
 *     rule nothing checks is a wording suggestion.
 *  2. **Never tell someone to do a thing they have done.** Where we genuinely cannot
 *     know whether they finished — and on this branch we cannot, that is the defect —
 *     the sentence is CONDITIONAL ("if you have just completed it"), which is true in
 *     both worlds rather than guessing one and being wrong half the time.
 *  3. **Claim the MECHANISM, never the outcome.** "It will be returned to you
 *     automatically" is what `refundUnappliedExcess` actually does (on INV-7824 the
 *     refund was issued three seconds after the capture). "We have refunded you" would
 *     be false at the moment the sentence is written, and if the auto-refund itself
 *     fails the money becomes customer credit with an `unapplied_gateway_money` alert
 *     rather than money in their account. B2's note makes the same distinction.
 *
 * ⚠️ `Intent already consumed` is deliberately NOT reworded. Two routes convert it into
 * a SUCCESS by matching `/already consumed/i` — `customer-portal-routes.ts:1171` and
 * `invoice-routes.ts:568`, the latter not ours — precisely so the payer never reads it
 * when the webhook wins the race. It is the one message on this path that is
 * operator-only, and rewording it would show a red error for captured money, which is
 * the bug those two catches were written to fix.
 */
const RETURNED_ON_ITS_OWN =
  "If the payment that you started goes through, we will return it to you " +
  "automatically. You do not need to do anything. Do not pay again.";

/** The gateway account behind an intent, its business's mode, and the adapter. */
interface IntentGateway {
  acc: typeof gatewayAccounts.$inferSelect | null;
  /** The BUSINESS's mode, for the live/test cross-check. Null when the row is gone. */
  businessLivemode: string | null;
  /** Null when there is no account, or no adapter can be built for its key. */
  adapter: PaymentProvider | null;
  /** Whatever `resolveAdapter` threw, rethrown verbatim at the original refusal point. */
  adapterError: unknown;
}

/**
 * Read the gateway account + adapter for an intent, ONCE.
 *
 * #23 needed the adapter EARLIER than it existed. The poll that decides whether to
 * refuse the buyer has to run before the status check, and the account was selected
 * below it — inside the same `withTenant` block that CLAIMS the intent. The obvious
 * move, a second select up top, is the exact failure #15 and #17 are both about (two
 * readers/writers of one fact drifting apart), so there is one reader and both the poll
 * and the capture path use it.
 *
 * It never throws; `assertIntentGatewayUsable` does the refusing, in the order those
 * refusals were already in. That separation is the point: hoisting the READ must not
 * reorder any error a caller has seen before, so a broken gateway account on a zero-due
 * invoice still reports the invoice first, exactly as it did.
 */
async function loadIntentGateway(
  organizationId: string,
  businessId: string,
  pi: PaymentIntent,
): Promise<IntentGateway> {
  const { acc, businessLivemode } = await withTenant(organizationId, async (tx) => {
    const rows = pi.gatewayAccountId
      ? await tx
          .select()
          .from(gatewayAccounts)
          .where(eq(gatewayAccounts.id, pi.gatewayAccountId))
          .limit(1)
      : [];
    const [biz] = await tx
      .select({ livemode: businesses.livemode })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return { acc: rows[0] ?? null, businessLivemode: biz?.livemode ?? null };
  });
  let adapter: PaymentProvider | null = null;
  let adapterError: unknown = null;
  if (acc) {
    try {
      adapter = resolveAdapter(acc);
    } catch (e) {
      // Held, not thrown. An unresolvable adapter means the pre-flight poll cannot ask
      // the gateway anything — a reason to keep the old behaviour, not to fail a buyer
      // before the invoice has even been looked at. It is rethrown verbatim where
      // `resolveAdapter` used to be called, so nothing about that failure changes.
      adapterError = e;
    }
  }
  return { acc, businessLivemode, adapter, adapterError };
}

/**
 * The three refusals that used to live inline, in their original order, plus the
 * adapter failure rethrown at the point it used to happen.
 *
 * ── #28a · these are OPERATOR configuration problems, not the buyer's ──────────
 *
 * The three messages below used to name the gateway account and the mismatched mode
 * verbatim — words that name what an OPERATOR must fix, produced by a function whose
 * own docblock (see `PaymentIntentError`, above) says every consume-path message is
 * "written FOR THE PAYER". `consumePaymentIntent` is called from the customer portal's
 * `/portal/v1/invoices/:inv/collect` route, which maps a `PaymentIntentError` straight
 * to `badRequest(reply, e.message)` — so a buyer's screen showed `"Gateway account
 * gwacc_… is not active"`, naming an id they have never seen and cannot act on, and
 * implying nothing about who is at fault (them, by construction, since it is THEIR
 * screen showing an error).
 *
 * A buyer cannot activate a gateway account or fix a livemode mismatch — only an
 * operator can — so the copy below says only what is true and actionable for the
 * person reading it: something is wrong on our side, nothing was charged, try again
 * or contact the business. The operator does not lose the detail: it is logged here,
 * structured, before the throw — the same place `code` already lets an operator
 * search (`event: "intent_gateway_unusable"`), rather than inventing a new ops
 * surface for it.
 */
const GATEWAY_UNUSABLE_MESSAGE =
  "We cannot complete this payment now because of a problem with the payment configuration " +
  "of this business. We did not charge you. Try again in a few " +
  "minutes. If the problem continues, contact the business.";

function assertIntentGatewayUsable(gw: IntentGateway): {
  acc: NonNullable<IntentGateway["acc"]>;
  adapter: PaymentProvider;
} {
  if (!gw.acc) {
    log.error(new Error("gateway account missing at consume"), {
      event: "intent_gateway_unusable",
      reason: "gateway_account_missing",
    });
    throw new PaymentIntentError(GATEWAY_UNUSABLE_MESSAGE, "gateway_account_missing");
  }
  if (gw.acc.status !== "active") {
    log.error(new Error("gateway account is not active at consume"), {
      event: "intent_gateway_unusable",
      reason: "gateway_account_inactive",
      gatewayAccount: gw.acc.publicId,
    });
    throw new PaymentIntentError(GATEWAY_UNUSABLE_MESSAGE, "gateway_account_inactive");
  }
  if (gw.businessLivemode && gw.acc.livemode !== (gw.businessLivemode === "live")) {
    log.error(new Error("gateway account mode does not match business mode at consume"), {
      event: "intent_gateway_unusable",
      reason: "gateway_mode_mismatch",
      gatewayAccount: gw.acc.publicId,
      gatewayAccountLivemode: gw.acc.livemode,
      businessLivemode: gw.businessLivemode,
    });
    throw new PaymentIntentError(GATEWAY_UNUSABLE_MESSAGE, "gateway_mode_mismatch");
  }
  if (!gw.adapter) throw gw.adapterError;
  return { acc: gw.acc, adapter: gw.adapter };
}

/**
 * ── #23 · ASK THE GATEWAY BEFORE REFUSING THE BUYER'S OWN CALLBACK ──────────
 *
 * The buyer's browser posts leg 2 the instant the gateway's sheet closes. The gateway's
 * `authorized` webhook is a SEPARATE, slower delivery. So the ordinary case — not the
 * exotic one — is that the browser arrives first and `payment_intents.status` still says
 * `in_progress`, because nothing has updated it yet. Refusing on that row told a person
 * who had just paid to go and pay again (17:47, ₹22,184.00, zero inbound webhooks in the
 * preceding 32 minutes).
 *
 * This is the same fix, in the same file, as B1's poll in `releaseHoldBeforeExpiry`, and
 * it follows the same three rules deliberately rather than inventing a second style:
 *
 *  1. **Only where the gateway can be asked.** `fetchIntent` and
 *     `capabilities.intentStatus === true` are checked together, so an adapter cannot
 *     advertise a probe it does not implement. Where the gateway cannot be asked we
 *     behave exactly as before — refuse on our own status — because "we cannot check"
 *     must not silently become "the money is there".
 *  2. **`authorized` is the ONLY answer that means proceed.** `unknown` is not an
 *     answer about money and must never be read as one. `consumed` means the money has
 *     already moved and belongs to the charge/harvest path, not here — authorizing on
 *     it would walk an already-captured intent back into a capture. The one exception is
 *     `consumed` with `capturedOnConfirm`: the gateway captured at the buyer's confirm,
 *     so there is no capture to repeat and consume books what it reads.
 *  3. **A gateway's bad day is not the buyer's 500.** Every failure returns null and
 *     the caller refuses in words, exactly as it would have without the poll.
 *
 * Scoped to `purpose: 'payment'`. A setup intent's consume (`vault-setup.ts`) has the
 * same theoretical staleness, but its India e-mandate registration debit is a ₹1–5
 * charge with its own refund lifecycle — A1 scoped #17's guard to payment intents for
 * that reason and the same reasoning holds here. Widening it needs its own measurement
 * and its own gate.
 *
 * The answer is a THREE-way verdict, not a boolean, and that is load-bearing: a gateway
 * that says `consumed` has already moved the money, so "we have not heard from your bank"
 * would be exactly the confident falsehood this defect is about, told to the one person
 * who can least afford it. The caller owes that case a different sentence.
 */
type AuthorizationProbe =
  /** The gateway is holding the funds; our row has been caught up. Proceed. */
  | { outcome: "authorized"; intent: PaymentIntent }
  /** Nothing is authorized, we could not ask, or we could not find out. Refuse. */
  | { outcome: "not_authorized" }
  /**
   * The money has ALREADY been captured at the gateway and we never booked it.
   *
   * `chargeAtGateway` rides along because "captured" and "captured and since refunded"
   * are the SAME `FetchedIntent.status` (`consumed` — its own docblock says so), and the
   * buyer must not be told the same thing about both. Without the charge id there is no
   * way to ask.
   */
  | { outcome: "captured_at_gateway"; chargeAtGateway?: string | null };

async function confirmAuthorizationWithGateway(
  organizationId: string,
  businessId: string,
  pi: PaymentIntent,
  gw: IntentGateway,
): Promise<AuthorizationProbe> {
  const adapter = gw.adapter;
  if (!adapter?.fetchIntent || adapter.capabilities.intentStatus !== true)
    return { outcome: "not_authorized" };
  const attempt = await withTenant(organizationId, (tx) => currentAttempt(tx, pi.id));
  // Same precedence the capture below uses: a retry mints a NEW id at the gateway and
  // the attempt is the only row that knows it. On RazorPay this is an ORDER id; the
  // poll hands back the PAYMENT id in `providerChargeId`.
  const intentIdAtGateway = attempt?.idAtGateway ?? pi.intentAtGateway;
  // Nothing ever reached a gateway under this row, so there is nothing to ask about.
  if (!intentIdAtGateway) return { outcome: "not_authorized" };
  const money = {
    intent: pi.publicId,
    gatewayKey: gw.acc?.gatewayKey,
    gatewayIntent: intentIdAtGateway,
    localStatus: pi.status,
    amountMinor: pi.amountMinor == null ? null : Number(pi.amountMinor),
    currency: pi.currency,
  };
  let fetched: FetchedIntent;
  try {
    fetched = await withTraceContext({ ...attemptSpan(attempt), organizationId, businessId }, () =>
      adapter.fetchIntent!({ intentId: intentIdAtGateway, purpose: "payment" }),
    );
  } catch (e) {
    // Rule 3. The buyer gets the refusal sentence, not a stack trace.
    log.error(e, {
      event: "intent_authorization_uncheckable",
      reason: "gateway_unreachable",
      ...money,
    });
    return { outcome: "not_authorized" };
  }
  /**
   * Captured at the buyer's confirm (a bank debit or a redirect method on a pay-now
   * intent): nothing is held and nothing has booked it yet. That is the normal outcome,
   * not the anomaly below, so it is authorized through the same writer and consume books
   * the captured result — the adapter reads it instead of capturing.
   */
  const capturedOnConfirm = fetched.status === "consumed" && fetched.capturedOnConfirm === true;
  if (fetched.status === "consumed" && !capturedOnConfirm) {
    /**
     * THE MONEY HAS ALREADY MOVED and we never booked it — the one answer that is
     * neither "proceed" nor "nothing is held". Authorizing here would walk an
     * already-captured intent back into a capture; refusing with "we have not heard
     * from your bank" would be the same species of confident falsehood as
     * `complete the challenge first`, told about money that has actually left.
     *
     * So it is reported UP as its own verdict and left to the charge/harvest path, and
     * logged at WARN because an unbooked capture is a reconciliation gap, not routine.
     */
    log.warn("the gateway has already captured a payment our own record never booked", {
      event: "intent_captured_at_gateway_unbooked",
      gatewayStatus: fetched.status,
      chargeAtGateway: fetched.providerChargeId ?? null,
      ...money,
    });
    return { outcome: "captured_at_gateway", chargeAtGateway: fetched.providerChargeId ?? null };
  }
  if (fetched.status !== "authorized" && !capturedOnConfirm) {
    // WARN only for `unknown`, which is a delivery/identity gap worth seeing. The other
    // answers (`requires_action`, `inited`, `failed`) are the gateway correctly telling
    // us the buyer has not finished — ordinary, and the refusal below is right.
    if (fetched.status === "unknown")
      log.warn("could not establish whether the gateway has authorized a buyer's payment", {
        event: "intent_authorization_uncheckable",
        reason: "gateway_does_not_know",
        ...money,
      });
    else
      log.info("the gateway confirms a buyer's payment is not authorized", {
        event: "intent_authorization_absent",
        gatewayStatus: fetched.status,
        ...money,
      });
    return { outcome: "not_authorized" };
  }
  if (capturedOnConfirm)
    log.info("the gateway captured a buyer's payment at confirm — booking it", {
      event: "intent_captured_on_confirm",
      chargeAtGateway: fetched.providerChargeId ?? null,
      ...money,
    });
  // A real authorization our record never learned about — the delivery failure itself is
  // worth seeing even though we recover from it, exactly as B1's poll logs its find.
  else
    log.warn("the gateway has authorized a payment our own record still calls unfinished", {
      event: "intent_authorization_found_by_poll",
      gatewayStatus: fetched.status,
      chargeAtGateway: fetched.providerChargeId ?? null,
      ...money,
    });
  try {
    // ── ONE WRITER OF THIS FACT ────────────────────────────────────────────────
    // `authorizePaymentIntent` is what the INBOUND WEBHOOK calls, and it is called here
    // rather than open-coding a second UPDATE. That is the whole lesson of #15/#17: two
    // writers of one fact drift apart. It also carries the parts an inline flip would
    // forget — the `authorized_at` stamp (coalesced, so a later webhook redelivery
    // cannot move the moment the hold was taken), reopening the attempt, and emitting
    // `payment_intent_authorized` so webhook subscribers see the same sequence they
    // would have seen had the callback arrived on time.
    const intent = await authorizePaymentIntent(organizationId, businessId, pi.publicId);
    return intent ? { outcome: "authorized", intent } : { outcome: "not_authorized" };
  } catch (e) {
    // The webhook harvest got here in the microseconds since our read. That race is
    // already handled — both collect routes convert `/already consumed/i` into a
    // SUCCESS report — so re-read and speak the message they match on rather than
    // inventing a refusal for money that has in fact been captured.
    const now = await getPaymentIntent(organizationId, businessId, pi.publicId);
    if (now?.status === "consumed") throw new PaymentIntentError("Intent already consumed");
    log.error(e, { event: "intent_authorization_write_failed", ...money });
    return { outcome: "not_authorized" };
  }
}

/**
 * Hand the gateway what the buyer's browser SDK returned (`mode: 'sdk'`), on gateways where
 * that result IS the authorization: a payment-method nonce authorizes nothing until our
 * server uses it.
 *
 * Writes nothing of its own. `authorized` goes through `authorizePaymentIntent` and a refusal
 * through `failPaymentIntentFromGateway` — the same writers the webhooks use. Callers must
 * stop on `failed`: the intent itself stays open (intents have no failed status), so
 * carrying on would self-authorize or tell a declined buyer to wait.
 */
export async function applyClientResult(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  clientResult: Record<string, string>,
): Promise<{
  outcome: "authorized" | "failed" | "pending" | "past_challenge";
  failure?: { code: string; message: string };
} | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status !== "in_progress" && pi.status !== "requires_action")
    return { outcome: "past_challenge" };
  const gw = await loadIntentGateway(organizationId, businessId, pi);
  const { acc, adapter } = assertIntentGatewayUsable(gw);
  if (!adapter.submitClientResult)
    throw new PaymentIntentError(
      "This payment method does not accept a confirmation from the browser.",
      "client_result_unsupported",
    );
  const attempt = await withTenant(organizationId, (tx) => currentAttempt(tx, pi.id));
  const intentId = attempt?.idAtGateway ?? pi.intentAtGateway;
  if (!intentId) throw new PaymentIntentError("This payment did not reach the gateway.");
  const fetched = await withTraceContext(
    { ...attemptSpan(attempt), organizationId, businessId },
    () =>
      adapter.submitClientResult!({
        intentId,
        purpose: (pi.purpose as IntentPurpose) ?? "payment",
        clientResult,
        idempotencyKey: `pi_client_${pi.publicId}_a${attempt?.attemptNumber ?? 1}`,
      }),
  );
  log.info("the gateway answered a browser confirmation", {
    event: "intent_client_result_submitted",
    intent: pi.publicId,
    gatewayKey: acc?.gatewayKey,
    gatewayStatus: fetched.status,
  });
  const newId =
    fetched.gatewayIntentId && fetched.gatewayIntentId !== attempt?.idAtGateway
      ? fetched.gatewayIntentId
      : undefined;
  if (attempt && (newId || fetched.methodUsed)) {
    await withTenant(organizationId, (tx) =>
      tx
        .update(paymentAttempts)
        .set({
          ...(newId ? { idAtGateway: newId } : {}),
          ...(fetched.methodUsed ? { methodUsed: fetched.methodUsed } : {}),
        })
        .where(eq(paymentAttempts.id, attempt.id)),
    );
  }
  if (fetched.status === "authorized") {
    await authorizePaymentIntent(organizationId, businessId, pi.publicId);
    return { outcome: "authorized" };
  }
  if (fetched.status === "failed") {
    const failure = {
      code: fetched.failure?.code ?? "authorization_failed",
      message: fetched.failure?.message ?? "The gateway refused this payment method.",
    };
    await failPaymentIntentFromGateway(organizationId, businessId, pi.publicId, failure);
    return { outcome: "failed", failure };
  }
  return { outcome: "pending" };
}

/**
 * Catch an unfinished payment intent up with the gateway before a caller refuses on it —
 * for flows that gate on `authorized` before they reach consume (hosted checkout leg 2).
 * The same read, rules and writer as consume's own poll: authorized, or captured at
 * confirm, flips our row through `authorizePaymentIntent`. Anything else — a capture we
 * did not ask for, a failed read, a gateway that cannot be asked — returns null.
 */
export async function authorizeFromGateway(
  organizationId: string,
  businessId: string,
  pi: PaymentIntent,
): Promise<PaymentIntent | null> {
  if (pi.status === "authorized") return pi;
  if (
    pi.purpose !== "payment" ||
    pi.status === "consumed" ||
    pi.status === "expired" ||
    pi.status === "voided" ||
    pi.voidedAt
  )
    return null;
  const gw = await loadIntentGateway(organizationId, businessId, pi);
  try {
    const probe = await confirmAuthorizationWithGateway(organizationId, businessId, pi, gw);
    return probe.outcome === "authorized" ? probe.intent : null;
  } catch (e) {
    // Consumed under us: not ours to book, and the caller's refusal is still true.
    if (e instanceof PaymentIntentError) return null;
    throw e;
  }
}

/**
 * What a buyer who reopens Pay now on an open intent should get, by the gateway's word:
 *  - `settle`: authorized or captured. Run consume; the form cannot load on it.
 *  - `closed`: cancelled at the gateway. Our row is voided here; start a new intent.
 *  - `open`: still needs the buyer, or we could not ask. Show the stored action.
 * Only adapters that declare `intentStatus` are asked; the rest always get `open`.
 */
export type ResumeVerdict = "settle" | "closed" | "open";

/**
 * The buyer asked for Apple Pay on the gateway's page but the open intent is its own form, or
 * the other way round. Only on a gateway with `applePayHosted`, where the page is the one
 * redirect pay-now there is.
 */
export async function hostedWalletMismatch(
  organizationId: string,
  businessId: string,
  pi: PaymentIntent,
  wantsWallet: boolean,
): Promise<boolean> {
  if (pi.purpose !== "payment") return false;
  const gw = await loadIntentGateway(organizationId, businessId, pi);
  if (!gatewayDefinition(gw.acc?.gatewayKey)?.applePayHosted) return false;
  const hosted = (pi.nextAction as { mode?: string } | null)?.mode === "redirect";
  return hosted !== wantsWallet;
}

export async function resumeVerdictFromGateway(
  organizationId: string,
  businessId: string,
  pi: PaymentIntent,
): Promise<ResumeVerdict> {
  if (pi.purpose !== "payment") return "open";
  const gw = await loadIntentGateway(organizationId, businessId, pi);
  const adapter = gw.adapter;
  if (!adapter?.fetchIntent || adapter.capabilities.intentStatus !== true) return "open";
  const attempt = await withTenant(organizationId, (tx) => currentAttempt(tx, pi.id));
  const intentIdAtGateway = attempt?.idAtGateway ?? pi.intentAtGateway;
  if (!intentIdAtGateway) return "open";
  let fetched: FetchedIntent;
  try {
    fetched = await withTraceContext({ ...attemptSpan(attempt), organizationId, businessId }, () =>
      adapter.fetchIntent!({ intentId: intentIdAtGateway, purpose: "payment" }),
    );
  } catch (e) {
    log.warn("could not read an open intent before resuming it", {
      event: "intent_resume_uncheckable",
      intent: pi.publicId,
      detail: e instanceof Error ? e.message : String(e),
    });
    return "open";
  }
  // Same rule as the authorization poll: a capture we did not ask for (only Stripe's
  // capture-at-confirm is ours) stays with the charge/harvest path.
  if (fetched.status === "authorized" || fetched.capturedOnConfirm) {
    log.info("a resumed intent is already paid at the gateway — booking it", {
      event: "intent_resume_settles",
      intent: pi.publicId,
      gatewayStatus: fetched.status,
      localStatus: pi.status,
    });
    return "settle";
  }
  if (fetched.status === "voided") {
    // The webhook's own writer, so a later `payment_intent.canceled` is a no-op.
    await markPaymentIntentVoidedFromGateway(organizationId, businessId, pi.publicId);
    return "closed";
  }
  return "open";
}

/**
 * Consume an authorized intent.
 *
 * `purpose: 'payment'` — capture INTO AN INVOICE (plan §C7: the engine consumes
 * intents instead of charging — money captured through an intent must land in
 * payments + transactions + the ledger and settle the invoice). Guards, all
 * preserved verbatim:
 *  - atomic claim (`authorized → consumed` conditional UPDATE) — a concurrent
 *    consume loses the claim and gets a 409, so no double capture;
 *  - the intent's amount/currency must match the invoice's amount due exactly;
 *  - the invoice must still be collectible;
 *  - the gateway account must still be active + mode-matched.
 * On a gateway-side capture failure the claim is released (back to `authorized`)
 * and a failure transaction is recorded — which also fails the current attempt,
 * making the intent retriable.
 *
 * `purpose: 'setup'` — NO money moves and there is NO invoice. The product is a
 * vaulted instrument: the provider ref goes to the payment-methods module (the
 * only place that persists one), and the authorization is then VOIDED when the
 * gateway can void, so the buyer's hold is dropped rather than left to lapse.
 */
export async function consumePaymentIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
  invoicePublicId?: string,
  opts?: {
    /** What the buyer's browser SDK returned for a `mode: 'sdk'` challenge. */
    clientResult?: Record<string, string>;
    /** A `setup`'s ACH authorization, stored with the payment method it saves. */
    achAuthorization?: AchAuthorizationEvidence;
  },
): Promise<ConsumePaymentIntentResult | null> {
  if (opts?.clientResult) {
    const applied = await applyClientResult(
      organizationId,
      businessId,
      piPublicId,
      opts.clientResult,
    );
    if (applied?.outcome === "failed")
      throw new PaymentIntentError(
        `We could not complete the payment. ${applied.failure!.message}`,
        applied.failure!.code,
      );
  }
  const loaded = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!loaded) return null;
  // Reassignable, and typed non-nullable so the closures below keep their narrowing:
  // #23's poll REPLACES this row mid-function (our `in_progress` cache is stale and the
  // gateway's answer is the truth), and everything downstream must read the fresh one.
  let pi: PaymentIntent = loaded;
  const purpose = (pi.purpose as IntentPurpose) ?? "payment";
  // Operator-only by contract — see the wording docblock above: both collect routes
  // match this string and turn it into a SUCCESS, so a payer never reads it.
  if (pi.status === "consumed") throw new PaymentIntentError("Intent already consumed");
  if (pi.status === "voided" || pi.voidedAt)
    throw new PaymentIntentError(
      "The payment that you started was cancelled before it completed. If any money " +
        "left your account, we will return it to you automatically. You can start a " +
        "new payment at any time.",
      "intent_voided",
    );
  // Expiry against BUSINESS time (finale review): a time-travelled test business
  // must expire intents in simulated time, not wall-clock.
  if (
    pi.status === "expired" ||
    (pi.expiresAt && pi.expiresAt < (await businessWallClock(pi.businessId)))
  )
    // "If any money did leave" rather than "nothing was taken": an expired intent may
    // still have a live hold at the gateway — that is defect #15, and
    // `releaseHoldBeforeExpiry` is what returns it. Claiming nothing was taken would be
    // the same species of confident falsehood this defect is about.
    throw new PaymentIntentError(
      // ⚠️ TWO sentences, chosen by purpose, and not for tidiness: a `setup` intent has
      // no invoice and no purchase, so the payment wording told someone who was SAVING A
      // CARD that a payment of theirs had closed. Same fault as #28 — a message that is
      // false for the case it is shown in. The money clause stays on BOTH: a setup
      // intent can still have taken a real verification debit (RazorPay's e-mandate
      // registration is a ₹1–5 charge with its own refund lifecycle), and an expired
      // intent may hold live funds at the gateway — that is #15, and
      // `releaseHoldBeforeExpiry` is what returns them. Claiming nothing was taken would
      // be the same species of confident falsehood this defect is about.
      purpose === "setup"
        ? "The confirmation of this payment method took too long, so we closed the request. " +
            "If any money left your account for the verification, we will " +
            "return it to you automatically. You can add your payment method again at " +
            "any time."
        : "The payment that you started took too long to complete, so we closed it. If any " +
            "money left your account, we will return it to you automatically. You " +
            "can start a new payment at any time.",
      "intent_expired",
    );
  if (purpose === "payment" && !invoicePublicId)
    throw new PaymentIntentError("A payment intent is consumed into an invoice. Pass an invoice.");

  // Read the gateway account + adapter ONCE, here, because the poll below needs the
  // adapter and the capture further down needs the account. Neither refuses yet.
  const gw = await loadIntentGateway(organizationId, businessId, pi);

  if (pi.status !== "authorized") {
    // #23: our row is not the gateway's opinion, it is a cache of the gateway's opinion
    // that a late callback leaves stale. Ask, and take the answer through the webhook's
    // own writer. Only when the gateway agrees nothing is authorized do we refuse — and
    // then in words that are true for a person who may have finished paying.
    const probe: AuthorizationProbe =
      purpose === "payment"
        ? await confirmAuthorizationWithGateway(organizationId, businessId, pi, gw)
        : { outcome: "not_authorized" };
    if (probe.outcome === "captured_at_gateway") {
      // The gateway has the money and we have not booked it. Telling this person we
      // have not heard from their bank would be false about money that has actually
      // left their account — the same fault as `complete the challenge first`, which is
      // what this whole defect is.
      //
      // But "is being applied to this invoice" is not always true either, and the
      // gateway cannot tell us which: `FetchedIntent.status` uses ONE value, `consumed`,
      // for "captured" and for "captured and since refunded" — its own docblock says so.
      // The live shape that proves it (2026-09-03): a buyer paid ₹22,184.00, the invoice
      // was cancelled under them 10 seconds later, the capture landed at 18:10:35 and was
      // auto-refunded at 18:10:38. Three seconds later this route would have told them
      // their payment was being applied to an invoice that had been credited to zero and
      // whose money was already back on their card. So the refund is checked, through the
      // same `chargeAlreadyReturned` the #17 guards use, and the two states get the two
      // different true sentences.
      // Dynamic, like this file's other cross-module reads: `refunds/service` pulls in
      // the transactions module, and a static edge from here would close a cycle.
      const returned = probe.chargeAtGateway
        ? await import("@/modules/refunds/service").then((m) =>
            m.chargeAlreadyReturned(organizationId, probe.chargeAtGateway!),
          )
        : null;
      if (returned?.fullyReturned)
        throw new PaymentIntentError(
          "Your payment reached us, but this invoice was already settled. We returned the " +
            "money to you automatically. You do not need to do anything, and you do not " +
            "need to pay again.",
          "captured_and_returned",
        );
      throw new PaymentIntentError(
        "Your payment reached us, and we are applying it to this invoice. You do not " +
          "need to do anything. Do not pay again.",
        "captured_at_gateway",
      );
    }
    if (probe.outcome !== "authorized")
      throw new PaymentIntentError(
        // ⚠️ The `setup` wording is the one that was WRONG, and this branch is exactly
        // where it fired: `confirmAuthorizationWithGateway` is hardcoded to
        // `not_authorized` for a setup intent (see its docblock — widening the poll waits
        // on the e-mandate verification-debit semantics), so a stale setup row lands here
        // without the gateway ever being asked. It then promised "it will be applied to
        // this invoice", and a setup intent HAS no invoice — its product is a vaulted
        // instrument. Reachable from the OPERATOR consume route, which has no
        // self-authorize wrapper the way `completeVaultFromIntent` does.
        //
        // The code is unchanged (`intent_not_authorized`) because the code was already
        // right; only the sentence shown to a person was false.
        purpose === "setup"
          ? "Your bank did not tell us yet that this payment method is confirmed. If you " +
              "completed it a short time ago, the confirmation can take a few minutes to " +
              "reach us. You do not need to do anything. We will save the payment method " +
              "automatically when the confirmation arrives. Do not add it again."
          : // The portal matches "did not tell us yet that this payment is complete" to retry.
            "Your bank did not tell us yet that this payment is complete. If you completed " +
              "it a short time ago, the confirmation can take a few minutes to reach us. " +
              "You do not need to do anything. We will apply the payment to this invoice " +
              "automatically when the confirmation arrives. Do not pay again.",
        "intent_not_authorized",
      );
    pi = probe.intent;
  }

  // Validate the target (invoice for `payment`) + gateway account, then CLAIM.
  const ctx = await withTenant(organizationId, async (tx) => {
    const attempt = await currentAttempt(tx, pi.id);
    let inv: typeof invoices.$inferSelect | null = null;
    let dueMinor = 0n;
    if (purpose === "payment") {
      const [found] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, invoicePublicId!)))
        .limit(1);
      if (!found) throw new PaymentIntentError(`We could not find the invoice ${invoicePublicId}.`);
      // Buyer-facing, and it must not read as a dead end. This is the branch #23's own
      // 17:47 scenario lands on one step further along: the gateway DOES hold their
      // money and the invoice has since been settled or credited out from under them.
      // Same promise B2's zero-due copy makes in the portal route, because it is the
      // same mechanism — a capture with no invoice left to pay is detached and handed to
      // `refundUnappliedExcess`.
      if (!isOpenInvoiceStatus(found.status))
        throw new PaymentIntentError(
          `This invoice is no longer open for payment. ${RETURNED_ON_ITS_OWN}`,
          "invoice_not_collectible",
        );
      // What is still COLLECTIBLE, not what was billed. `amount_due_minor` is the
      // issue-time collectible net of CREDITS only — cash is never subtracted from it —
      // so reading it raw demands the full original amount from a part-paid invoice.
      // That made card/3DS payment of a part-paid invoice not merely wrong but
      // UNREACHABLE: the API correctly reports 2000 outstanding, this demanded 5000, and
      // no amount satisfied both. Dynamic import because invoicing/service imports this
      // module (`liveIntentForInvoice`), so a static edge here closes a cycle.
      const { invoiceOutstanding } = await import("@/modules/invoicing/service");
      dueMinor = (await invoiceOutstanding(tx, found)).remainingMinor;
      // An open invoice with nothing left to collect must not mint a zero-amount charge;
      // it also cannot satisfy the equality below, so say why rather than failing on it.
      if (dueMinor <= 0n)
        throw new PaymentIntentError(
          `This invoice is already settled, so there is nothing left to pay. ${RETURNED_ON_ITS_OWN}`,
          "invoice_nothing_due",
        );
      if (found.currency !== pi.currency)
        throw new PaymentIntentError(
          `This payment uses a different currency from this invoice, so we cannot ` +
            `apply it to the invoice. ${RETURNED_ON_ITS_OWN}`,
          "currency_mismatch",
        );
      if (pi.amountMinor == null || pi.amountMinor !== dueMinor)
        // #22's dead end, in words a payer can act on. The amount they started paying is
        // no longer the amount owed (a cancellation or a downgrade moved it mid-checkout)
        // and there is no way to reconcile the two here — but the money is not lost, and
        // the sentence has to say so or it is the same trap with better grammar.
        throw new PaymentIntentError(
          `The amount due on this invoice changed after you started the payment, so we ` +
            `did not apply this payment. ${RETURNED_ON_ITS_OWN}`,
          "amount_mismatch",
        );
      inv = found;
    }
    // Resolved above, once — the poll needed it before this block existed. Refusals stay
    // in their original order relative to the invoice checks, so nothing reorders.
    const { acc } = assertIntentGatewayUsable(gw);
    const customer = pi.customerId
      ? ((await tx.select().from(customers).where(eq(customers.id, pi.customerId)).limit(1))[0] ??
        null)
      : null;
    // Atomic claim — the ONLY path from authorized to consumed.
    const [claimed] = await tx
      .update(paymentIntents)
      .set({ status: "consumed" })
      .where(and(eq(paymentIntents.id, pi.id), eq(paymentIntents.status, "authorized")))
      .returning();
    if (!claimed)
      throw new PaymentIntentConflictError("Another request consumed the intent at the same time");
    return { inv, acc, dueMinor, claimed, attempt, customer };
  });

  // The SAME adapter the poll above used — `loadIntentGateway` resolved it once and
  // `assertIntentGatewayUsable` already vouched for it, so this is no longer a second
  // resolution of the same account.
  const adapter = gw.adapter!;
  if (!adapter.consumeIntent)
    throw new PaymentIntentError("Gateway does not support intent capture");
  const attemptNumber = ctx.attempt?.attemptNumber ?? 1;
  const trace = attemptSpan(ctx.attempt);
  let outcome;
  try {
    outcome = await withTraceContext({ ...trace, organizationId, businessId }, () =>
      adapter.consumeIntent!({
        intentId: ctx.attempt?.idAtGateway ?? pi.intentAtGateway!,
        idempotencyKey: `pi_consume_${pi.publicId}_a${attemptNumber}`,
        purpose,
        ...(purpose === "payment"
          ? { amountMinor: ctx.dueMinor, currency: ctx.inv!.currency }
          : {}),
      }),
    );
  } catch (e) {
    // Gateway unreachable → release the claim so the intent can be retried.
    log.error(e, {
      event: "intent_consume_unreachable",
      intent: pi.publicId,
      attemptNumber,
      purpose,
    });
    await withTenant(organizationId, (tx) =>
      tx
        .update(paymentIntents)
        // A transition INTO `authorized`, so it stamps — coalesced, so releasing a claim
        // cannot rewrite the moment the hold was taken (migration 0217's write semantics).
        .set({ status: "authorized", authorizedAt: FIRST_AUTHORIZED_AT })
        .where(eq(paymentIntents.id, pi.id)),
    );
    throw e;
  }

  if (outcome.purpose === "setup") {
    // A refused setup (3DS declined on the vault, mandate rejected) is DATA, not an
    // exception: release the claim, fail the attempt, and leave the intent retriable
    // — exactly what a refused payment does through `ChargeResult.failure`.
    if (!outcome.paymentMethod) {
      if (outcome.setupAuthCharge) {
        const { queueRefusedRegistrationRefund } =
          await import("@/modules/payment-methods/setup-auth-refund");
        await queueRefusedRegistrationRefund({
          organizationId,
          businessId,
          gatewayAccountId: ctx.acc.id,
          providerKey: ctx.acc.gatewayKey,
          providerCustomerId: ctx.customer?.publicId ?? "",
          charge: outcome.setupAuthCharge,
          intent: pi.publicId,
        });
      }
      return failSetupConsume({ organizationId, businessId, pi, ctx, failure: outcome.failure });
    }
    return finishSetupConsume({
      organizationId,
      businessId,
      pi,
      ctx,
      adapter,
      paymentMethodRef: outcome.paymentMethod,
      trace,
      ...(opts?.achAuthorization ? { achAuthorization: opts.achAuthorization } : {}),
    });
  }
  return finishPaymentConsume({ organizationId, businessId, pi, ctx, result: outcome.charge });
}

type ConsumeContext = {
  inv: typeof invoices.$inferSelect | null;
  acc: GatewayAccountRow;
  dueMinor: bigint;
  attempt: PaymentAttempt | null;
  customer: typeof customers.$inferSelect | null;
};

/** `purpose: 'payment'` — the booking path, unchanged apart from the attempt links. */
async function finishPaymentConsume(args: {
  organizationId: string;
  businessId: string;
  pi: PaymentIntent;
  ctx: ConsumeContext;
  result: ChargeResult;
}): Promise<ConsumePaymentIntentResult> {
  const { organizationId, businessId, pi, ctx } = args;
  // Adyen and Checkout.com captures name no method; the browser's result did.
  const result: ChargeResult =
    args.result.methodUsed || !ctx.attempt?.methodUsed
      ? args.result
      : { ...args.result, methodUsed: ctx.attempt.methodUsed };
  const inv = ctx.inv!;
  return withTenant(organizationId, async (tx) => {
    if (result.status === "succeeded") {
      /**
       * ── WHAT THE INVOICE STILL OWES, RE-RESOLVED UNDER A LOCK ────────────────
       *
       * `ctx.dueMinor` is what the invoice owed in the CLAIM transaction, which
       * committed before the gateway capture left. Three transactions, and the
       * middle one is a network round-trip: an adjustment credit note or another
       * settler landing in that window moves the invoice while the capture is out.
       * Booking `ctx.dueMinor` regardless — as this did — marks the invoice `paid`
       * for a figure it no longer owes and over-credits `accounts_receivable` by
       * the difference, which shows up nowhere on the customer.
       *
       * `commitSubscriptionPeriodInvoice` guards the same window by re-resolving
       * under a lock and REFUSING (`ChargeAmountMismatchError`) so its caller can
       * refund. That shape does not transfer here: the money is already captured,
       * so refusing would roll back the only record of it. What transfers is
       * `settlePaymentSucceeded`'s (payments/settlement.ts) — read the invoice
       * FOR UPDATE, apply what it can absorb, and hold the rest as the customer's
       * excess payment. That path exists because this exact overshoot was MEASURED
       * on the async twin (an in-flight attempt plus a mid-dunning adjustment note,
       * customer 4606.00 over, silently); this is its synchronous twin and had no
       * guard at all.
       *
       * Read BEFORE the payment row is inserted, for the reason that file spells
       * out: `invoiceOutstanding` derives what is due from succeeded invoice-linked
       * payments, so a row written first would count itself and every invoice would
       * read `remaining = 0`.
       */
      const [locked] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, inv.id))
        .for("update")
        .limit(1);
      const live = locked ?? inv;
      // Dynamic import: invoicing/service imports this module (`liveIntentForInvoice`),
      // so a static edge here would close a cycle — same reason the consume path does it.
      const { invoiceOutstanding, postCreditApplications } =
        await import("@/modules/invoicing/service");
      const stillOpen = isOpenInvoiceStatus(live.status);
      const owed = stillOpen ? (await invoiceOutstanding(tx, live)).remainingMinor : 0n;
      const captured = ctx.dueMinor;
      const absorb = owed < captured ? owed : captured;
      const surplus = captured - absorb;
      // Fully covered ⇒ the invoice settles. Under-covered (the invoice GREW, e.g. a
      // refund landed against it) ⇒ book the cash and leave it open for the remainder,
      // rather than stamping `paid` on an invoice that is not.
      const settles = stillOpen && owed > 0n && captured >= owed;
      if (owed !== captured) {
        log.warn("the invoice moved while an intent capture was in flight", {
          event: "intent_capture_amount_drifted",
          intent: pi.publicId,
          invoice: inv.publicId,
          capturedMinor: String(captured),
          invoiceOwedMinor: String(owed),
          heldAsExcessMinor: String(surplus),
          invoiceStatus: live.status,
          currency: inv.currency,
        });
      }
      // Book the capture like any successful charge: payment + ledger + txn + events.
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId,
          businessId,
          customerId: inv.customerId,
          // DETACH when the invoice cannot swallow it whole. `paidTotals` sums
          // invoice-linked succeeded payments into the invoice's `amount_paid`, so
          // leaving the link credits the invoice with money that was not applied to it —
          // the over-collection `invoice_not_overpaid` exists to catch.
          invoiceId: surplus > 0n ? null : inv.id,
          paymentMethodId: pi.paymentMethodId,
          publicId: publicId("pay"),
          status: "succeeded",
          amountMinor: captured,
          currency: inv.currency,
          providerKey: ctx.acc.gatewayKey,
          providerChargeId: result.providerChargeId,
          methodType: await methodTypeFor(tx, result, pi.paymentMethodId),
          ...(result.methodUsed ? { metadata: { payment_method_used: result.methodUsed } } : {}),
        })
        .returning();
      await postEntries(
        {
          organizationId,
          businessId,
          ...(surplus > 0n ? { customerId: inv.customerId } : {}),
          sourceType: surplus > 0n ? "excess_payment" : "payment",
          sourceId: pay!.publicId,
          lines: [
            { account: "cash", direction: "debit", amountMinor: captured, currency: inv.currency },
            {
              account: surplus > 0n ? EXCESS_PAYMENT : "accounts_receivable",
              direction: "credit",
              amountMinor: captured,
              currency: inv.currency,
              ...(surplus > 0n ? { memo: "Captured for more than the invoice owed" } : {}),
            },
          ],
        },
        tx,
      );
      // …then pay the invoice out of that credit. Holding the money and leaving the
      // invoice open is not enough on its own — `collectInvoice` does not draw customer
      // credit, so the next dunning retry would charge the instrument a SECOND time.
      if (surplus > 0n && absorb > 0n) {
        await postCreditApplications(tx, {
          organizationId,
          businessId,
          customerId: inv.customerId,
          invoicePublicId: inv.publicId,
          currency: inv.currency,
          promotional: 0n,
          refundable: 0n,
          excess: absorb,
        });
      }
      if (settles) {
        await tx
          .update(invoices)
          .set({
            status: "paid",
            paidAt: stampNow(),
            attemptCount: live.attemptCount + 1,
            nextAttemptAt: null,
            ...dunningFieldsOnSettle(live),
          })
          .where(eq(invoices.id, inv.id));
      }
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: inv.customerId,
          type: "payment",
          status: "succeeded",
          amountMinor: ctx.dueMinor,
          currency: inv.currency,
          gatewayAccountId: ctx.acc.id,
          gatewayKey: ctx.acc.gatewayKey,
          idAtGateway: result.providerChargeId,
          paymentMethodId: pi.paymentMethodId,
          invoiceId: inv.id,
          paymentId: pay!.id,
          // Intent-level analytics stop being a guess: the failure tiles counted
          // TRANSACTIONS for want of these two columns (see db/schema/transactions.ts).
          paymentIntentId: pi.id,
          paymentAttemptId: ctx.attempt?.id ?? null,
        },
        tx,
      );
      let attempt = ctx.attempt;
      if (attempt) {
        attempt = await writeAttemptStatus(tx, attempt, {
          status: "consumed",
          idAtGateway: result.providerChargeId ?? attempt.idAtGateway,
        });
      }
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_succeeded",
        data: buildEventData(
          "payment_succeeded",
          {
            id: pay!.publicId,
            status: "succeeded",
            amount_minor: Number(ctx.dueMinor),
            currency: inv.currency,
            invoice: inv.publicId,
          },
          null,
          { via: "payment_intent" },
        ),
      });
      // Only when it actually settled. An invoice left partly open must not announce
      // itself paid — a webhook consumer acting on that provisions for money we did
      // not collect.
      if (settles) {
        await emitEvent(tx, {
          organizationId,
          businessId,
          type: "invoice_paid",
          data: buildEventData("invoice_paid", {
            id: inv.publicId,
            amount_minor: Number(inv.totalMinor),
            currency: inv.currency,
          }),
        });
        await activatePaidCreditGrants(tx, { organizationId, invoiceId: inv.id });
      }
      const [row] = await tx
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, pi.id))
        .limit(1);
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_intent_consumed",
        data: buildEventData(
          "payment_intent_consumed",
          {
            id: pi.publicId,
            status: "consumed",
            purpose: "payment",
            amount_minor: Number(ctx.dueMinor),
            currency: inv.currency,
            invoice: inv.publicId,
            attempt_number: attempt?.attemptNumber ?? null,
          },
          row?.resourceVersion ?? null,
        ),
      });
      return { intent: row!, attempt, charge: result };
    }

    /**
     * The gateway TOOK the capture but has not released the money (PayPal `PENDING_REVIEW`,
     * an eCheck hold). Not a failure: the authorization is spent, so the intent stays
     * consumed, and the money is booked the way `bookPending` books a pending charge — a
     * pending payment plus an `in_progress` transaction — so `charge.succeeded` /
     * `charge.failed` settle it. Booking it failed left the later webhook nothing to
     * settle: the buyer charged, the invoice open, no ledger entry.
     */
    if (result.status === "pending") {
      const [pay] = await tx
        .insert(payments)
        .values({
          organizationId,
          businessId,
          customerId: inv.customerId,
          invoiceId: inv.id,
          paymentMethodId: pi.paymentMethodId,
          publicId: publicId("pay"),
          status: "pending",
          amountMinor: ctx.dueMinor,
          currency: inv.currency,
          providerKey: ctx.acc.gatewayKey,
          providerChargeId: result.providerChargeId,
          methodType: await methodTypeFor(tx, result, pi.paymentMethodId),
          ...(result.methodUsed ? { metadata: { payment_method_used: result.methodUsed } } : {}),
        })
        .returning();
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: inv.customerId,
          type: "payment",
          status: "in_progress",
          amountMinor: ctx.dueMinor,
          currency: inv.currency,
          gatewayAccountId: ctx.acc.id,
          gatewayKey: ctx.acc.gatewayKey,
          idAtGateway: result.providerChargeId,
          paymentMethodId: pi.paymentMethodId,
          invoiceId: inv.id,
          paymentId: pay!.id,
          paymentIntentId: pi.id,
          paymentAttemptId: ctx.attempt?.id ?? null,
        },
        tx,
      );
      // Park the invoice like `bookPending`: dunning must not collect money already in flight.
      await tx
        .update(invoices)
        .set({ attemptCount: inv.attemptCount + 1, nextAttemptAt: null })
        .where(eq(invoices.id, inv.id));
      let attempt = ctx.attempt;
      if (attempt) {
        attempt = await writeAttemptStatus(tx, attempt, {
          status: "consumed",
          idAtGateway: result.providerChargeId ?? attempt.idAtGateway,
        });
      }
      const [row] = await tx
        .select()
        .from(paymentIntents)
        .where(eq(paymentIntents.id, pi.id))
        .limit(1);
      await emitEvent(tx, {
        organizationId,
        businessId,
        type: "payment_intent_consumed",
        data: buildEventData(
          "payment_intent_consumed",
          {
            id: pi.publicId,
            status: "consumed",
            purpose: "payment",
            amount_minor: Number(ctx.dueMinor),
            currency: inv.currency,
            invoice: inv.publicId,
            attempt_number: attempt?.attemptNumber ?? null,
          },
          row?.resourceVersion ?? null,
        ),
      });
      return { intent: row!, attempt, charge: result };
    }

    // Capture failed at the gateway → release the claim, record the failure.
    const [row] = await tx
      .update(paymentIntents)
      // Coalesced: this is the exact case migration 0217 names — the hold was taken when
      // the buyer authorized, NOT now when a capture against it was refused.
      .set({ status: "authorized", authorizedAt: FIRST_AUTHORIZED_AT })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    const errorCode = result.failure?.code ?? "capture_failed";
    const errorText = result.failure?.message ?? "We could not capture the payment.";
    await recordTransaction(
      {
        organizationId,
        businessId,
        customerId: inv.customerId,
        type: "payment",
        status: "failed",
        amountMinor: ctx.dueMinor,
        currency: inv.currency,
        gatewayAccountId: ctx.acc.id,
        gatewayKey: ctx.acc.gatewayKey,
        idAtGateway: result.providerChargeId ?? null,
        paymentMethodId: pi.paymentMethodId,
        invoiceId: inv.id,
        errorCode,
        errorText,
        retriable: result.failure?.retriable ?? null,
        paymentIntentId: pi.id,
        paymentAttemptId: ctx.attempt?.id ?? null,
      },
      tx,
    );
    const attempt = ctx.attempt
      ? await failAttempt(tx, ctx.attempt, errorCode, errorText, pi.publicId)
      : null;
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_failed",
      data: buildEventData(
        "payment_intent_failed",
        {
          id: pi.publicId,
          status: row!.status,
          purpose: "payment",
          amount_minor: Number(ctx.dueMinor),
          currency: inv.currency,
          invoice: inv.publicId,
          attempt_number: attempt?.attemptNumber ?? null,
          error_code: errorCode,
          error_text: errorText,
        },
        row!.resourceVersion,
      ),
    });
    return { intent: row!, attempt, charge: result };
  });
}

/**
 * `purpose: 'setup'` — the product is an instrument, not money.
 *
 * Vaulting is NOT reimplemented here: `persistVaultedPaymentMethod` in the
 * payment-methods module is the single writer of a `payment_methods` row (it also
 * re-points a stale provider-customer mapping and emits `payment_source_added` +
 * the audit entry). We only hand it the ref the gateway gave back.
 */
async function finishSetupConsume(args: {
  organizationId: string;
  businessId: string;
  pi: PaymentIntent;
  ctx: ConsumeContext;
  adapter: PaymentProvider;
  paymentMethodRef: ProviderPaymentMethodRef;
  trace: TraceContext;
  achAuthorization?: AchAuthorizationEvidence;
}): Promise<ConsumePaymentIntentResult> {
  const { organizationId, businessId, pi, ctx, adapter, paymentMethodRef } = args;
  if (!ctx.customer) throw new PaymentIntentError("Setup intent has no customer to vault against");

  // `payment_methods.provider_customer_id` is NOT NULL, and only SOME adapters
  // stamp it on the consume ref (RazorPay does; tmtest and PayPal return a bare
  // ref). Omitting it here failed the insert AFTER the gateway had already vaulted
  // the card — an orphaned vault on two of three gateways. Resolve the mapping the
  // same way `vaultPaymentMethod` does; `ensureProviderCustomer` is idempotent and
  // returns the mapping `createPaymentIntent` already established for this intent.
  const providerCustomerId =
    paymentMethodRef.providerCustomerId ??
    (
      await ensureProviderCustomer({
        organizationId,
        businessId,
        customer: ctx.customer,
        provider: adapter,
        gatewayAccountId: ctx.acc.id,
      })
    ).providerCustomerId;

  let pm: PaymentMethodRow;
  try {
    pm = await persistVaultedPaymentMethod({
      organizationId,
      businessId,
      customer: ctx.customer,
      vaulted: paymentMethodRef,
      gatewayAccountId: ctx.acc.id,
      providerCustomerId,
      ...(args.achAuthorization ? { achAuthorization: args.achAuthorization } : {}),
    });
  } catch (e) {
    // Saved at the gateway with no authorization: remove it there, so it cannot be charged.
    if (e instanceof AchAuthorizationRequiredError && adapter.deletePaymentMethod)
      await adapter
        .deletePaymentMethod({
          customer: { providerKey: adapter.key, providerCustomerId },
          paymentMethod: paymentMethodRef,
        })
        .catch((err: unknown) =>
          log.warn("could not remove an unauthorized bank account at the gateway", {
            event: "ach_unauthorized_vault_not_removed",
            intent: pi.publicId,
            detail: (err as Error).message,
          }),
        );
    // The instrument is real at the gateway but we failed to record it. Release the
    // claim: `consumeIntent` is idempotency-keyed per attempt, so consuming again
    // returns the SAME ref and re-persists — whereas leaving the intent `consumed`
    // would strand a vaulted card with no local row and no way back to it.
    await withTenant(organizationId, (tx) =>
      tx
        .update(paymentIntents)
        // Coalesced — see `FIRST_AUTHORIZED_AT`. A `setup` intent holds nothing, so this
        // records only that the buyer's authorization existed, which is what the
        // abandoned-hold invariant needs to tell it apart from an abandoned checkout.
        .set({ status: "authorized", authorizedAt: FIRST_AUTHORIZED_AT })
        .where(eq(paymentIntents.id, pi.id)),
    );
    throw e;
  }

  // NOTHING IS RELEASED HERE, deliberately. A `setup` intent is created with
  // `amountMinor: 0n` on every adapter, so there is no hold to give back: Stripe's
  // is a SetupIntent (`seti_`), PayPal's is a /v3/vault/setup-tokens approval with no
  // authorization behind it, and RazorPay reports `intentVoid: false`. This used to
  // call `adapter.voidIntent` unconditionally, which meant EVERY Stripe add-card
  // logged `POST /v1/setup_intents/{id}/cancel -> 400 setup_intent_unexpected_state`
  // (Stripe refuses to cancel a succeeded SetupIntent) and PayPal would have voided
  // against an order id it never had. Caught and warned, so no buyer ever saw it —
  // it just wasted a round-trip and made Gateway Activity read as if add-cards were
  // failing. `voidPaymentIntent` still releases a real `payment` hold; that is the
  // path with something to release.

  return withTenant(organizationId, async (tx) => {
    let attempt = ctx.attempt;
    if (attempt) {
      attempt = await writeAttemptStatus(tx, attempt, {
        status: "consumed",
        paymentMethodId: pm.id,
      });
    }
    const [row] = await tx
      .update(paymentIntents)
      .set({ paymentMethodId: pm.id })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    // No `payment_reversal` row either. One was recorded here for "timeline
    // visibility", but with no release actually attempted it asserted a gateway
    // interaction that never happened — worse than a missing row. The
    // `payment_intent_consumed` event below is what marks the consume.
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_consumed",
      data: buildEventData(
        "payment_intent_consumed",
        {
          id: pi.publicId,
          status: "consumed",
          purpose: "setup",
          payment_source: pm.publicId,
          attempt_number: attempt?.attemptNumber ?? null,
        },
        row!.resourceVersion,
      ),
    });
    return { intent: row!, attempt, paymentMethod: pm };
  });
}

/**
 * `purpose: 'setup'` refused at the gateway. No instrument, no money — the same
 * shape as a failed capture: release the claim (back to `authorized`), fail the
 * current attempt, and record the refusal as a transaction so the timeline shows
 * the gateway interaction that happened. `retryPaymentIntent` can then mint
 * attempt N+1.
 */
async function failSetupConsume(args: {
  organizationId: string;
  businessId: string;
  pi: PaymentIntent;
  ctx: ConsumeContext;
  failure: ChargeResult["failure"];
}): Promise<ConsumePaymentIntentResult> {
  const { organizationId, businessId, pi, ctx, failure } = args;
  const errorCode = failure?.code ?? "setup_failed";
  const errorText = failure?.message ?? "The gateway refused to vault the payment method";
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .update(paymentIntents)
      // Coalesced — see `FIRST_AUTHORIZED_AT`. The refusal was of the VAULT, not of the
      // authorization that got us here.
      .set({ status: "authorized", authorizedAt: FIRST_AUTHORIZED_AT })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    if (pi.currency) {
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: pi.customerId,
          type: "authorization",
          status: "failed",
          amountMinor: 0n,
          currency: pi.currency,
          gatewayAccountId: ctx.acc.id,
          gatewayKey: ctx.acc.gatewayKey,
          idAtGateway: ctx.attempt?.idAtGateway ?? null,
          errorCode,
          errorText,
          retriable: failure?.retriable ?? null,
          paymentIntentId: pi.id,
          paymentAttemptId: ctx.attempt?.id ?? null,
        },
        tx,
      );
    }
    const attempt = ctx.attempt
      ? await failAttempt(tx, ctx.attempt, errorCode, errorText, pi.publicId)
      : null;
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_failed",
      data: buildEventData(
        "payment_intent_failed",
        {
          id: pi.publicId,
          status: row!.status,
          purpose: "setup",
          attempt_number: attempt?.attemptNumber ?? null,
          error_code: errorCode,
          error_text: errorText,
        },
        row!.resourceVersion,
      ),
    });
    return { intent: row!, attempt };
  });
}

// ── void ────────────────────────────────────────────────────────────────────

/**
 * Was there ever a hold to reverse? — the question `voidPaymentIntent` has to answer
 * before it writes a `payment_reversal`.
 *
 * ── WHY (defect #21, found by agent B1 on 2026-09-03) ───────────────────────────
 * `voidPaymentIntent` refuses `consumed`, `voided` and `expired`-with-a-reversal, and
 * reaches the gateway on everything else — including an `in_progress` checkout whose
 * buyer never completed their bank's step. The void SUCCEEDS there (Stripe cancels a
 * `requires_action` intent; so does tmtest, whose `voidIntentCharge` accepts
 * `inited`/`requires_action`/`authorized`), and the reversal that followed asserted in
 * the money log that we had released a hold on money nobody ever took. #16's
 * `releaseZeroDueIntents` (`payments/stale-pending.ts`) is what makes that the ORDINARY
 * case rather than an exotic one: it voids live checkouts on invoices that owe nothing,
 * and a live checkout is usually mid-challenge.
 *
 * A `payment_reversal` is not bookkeeping colour — three separate readers treat its
 * existence as proof a release happened. `voidPaymentIntent`'s own `expired` branch
 * refuses a second void on it; `ops/invariants.ts` (`intent_hold_abandoned`) reads its
 * ABSENCE as buyer money stranded at a gateway; and the operator's timeline names it
 * under "Transaction Voided" (`payment-intent-routes.ts`). Inventing one is three false
 * statements, not one.
 *
 * Writing no transaction is an established shape here, not a new one:
 * `markPaymentIntentVoidedFromGateway` and `consumeSetup` both close an intent without
 * one, for this exact stated reason — never record a release you did not perform.
 *
 * ── The rules, which are B1's from `releaseHoldBeforeExpiry`, deliberately ─────
 *  1. **Our own record of a hold still counts.** `authorized_at` is written from the
 *     gateway's own `intent.authorized`, and the column exists to record that a hold
 *     once existed (`FIRST_AUTHORIZED_AT`) — so a row carrying one is reversed without
 *     asking anybody, and every void the engine has ever performed keeps its behaviour.
 *     #21 is about a hold that NEVER existed, not one that has since lapsed.
 *  2. **Only where the gateway can be ASKED.** `fetchIntent` and
 *     `capabilities.intentStatus` are checked together, so an adapter cannot advertise a
 *     probe it does not implement. Where it cannot be asked, today's behaviour stands:
 *     Stripe and PayPal leave `intentStatus` undefined, and "we cannot check" must not
 *     quietly become a new answer on three other providers.
 *  3. **`authorized` is the ONLY answer that means money is held.** `unknown` is not an
 *     answer about money and is never read as one — and in practice it is moot, because
 *     a gateway that does not know the id refuses the void first. `consumed` means the
 *     money MOVED: a capture is not a hold, the gateway refuses to void it, and no
 *     reversal belongs to it either.
 *  4. **A gateway's bad day is not a verdict.** Every failure falls back to rule 2's
 *     answer, so an unreachable gateway cannot turn a void into a silent change.
 *
 * A `setup` intent sits outside all of it: it is created with `amountMinor: 0n` on every
 * adapter, so its reversal asserts no amount and there is no phantom money to invent —
 * the same reason `releaseHoldBeforeExpiry` answers `not_held` for one without spending
 * a round trip on it.
 */
async function heldBeforeVoid(
  pi: PaymentIntent,
  ctx: { attempt: PaymentAttempt | null; acc: typeof gatewayAccounts.$inferSelect },
  adapter: PaymentProvider,
  trace: TraceContext,
): Promise<{ book: boolean; reason: string }> {
  const money = {
    intent: pi.publicId,
    purpose: pi.purpose,
    customer: pi.customerId,
    invoice: pi.invoiceId,
    amountMinor: String(pi.amountMinor ?? 0n),
    currency: pi.currency,
    gatewayKey: ctx.acc.gatewayKey,
    localStatus: pi.status,
  };
  if (pi.purpose !== "payment") return { book: true, reason: "not_a_payment_intent" };
  if (pi.authorizedAt) return { book: true, reason: "local_authorization" };
  if (!adapter.fetchIntent || adapter.capabilities.intentStatus !== true)
    return { book: true, reason: "gateway_cannot_be_asked" };
  const intentIdAtGateway = ctx.attempt?.idAtGateway ?? pi.intentAtGateway;
  // Nothing ever reached a gateway under this row, so there is nothing to ask about —
  // and the void below is about to fail on the same missing id.
  if (!intentIdAtGateway) return { book: true, reason: "gateway_cannot_be_asked" };
  let fetched: FetchedIntent;
  try {
    fetched = await withTraceContext(
      { ...trace, organizationId: pi.organizationId, businessId: pi.businessId },
      // Always 'payment': the setup guard above returned, and the row's own `purpose`
      // column is typed as plain text.
      () => adapter.fetchIntent!({ intentId: intentIdAtGateway, purpose: "payment" }),
    );
  } catch (e) {
    // Rule 4.
    log.error(e, {
      event: "intent_hold_uncheckable_before_void",
      reason: "gateway_unreachable",
      gatewayIntent: intentIdAtGateway,
      ...money,
    });
    return { book: true, reason: "gateway_cannot_be_asked" };
  }
  if (fetched.status === "authorized") {
    // A real hold our record never learned about. WARN even though the void that follows
    // handles it correctly: an authorization the engine did not know it had is a delivery
    // failure worth seeing, exactly as B1's poll logs its find.
    log.warn("the gateway is holding funds for an intent our own record calls unfinished", {
      event: "intent_hold_found_before_void",
      gatewayIntent: intentIdAtGateway,
      gatewayStatus: fetched.status,
      chargeAtGateway: fetched.providerChargeId ?? null,
      ...money,
    });
    return { book: true, reason: "gateway_reports_a_hold" };
  }
  /**
   * WARN rather than info, and the reason is not the money. Nothing is wrong here — the
   * buyer's funds were never touched and the checkout is being closed correctly. What
   * deserves a line is that until 2026-09-04 this path wrote a FULL-AMOUNT reversal, so
   * this is also the count of how much of the money log was fiction, and on which
   * gateways.
   */
  log.warn("a payment intent was voided with no hold to release", {
    event: "intent_void_without_hold",
    reason: fetched.status === "unknown" ? "gateway_does_not_know" : "gateway_reports_no_hold",
    gatewayIntent: intentIdAtGateway,
    gatewayStatus: fetched.status,
    ...money,
  });
  return { book: false, reason: "gateway_reports_no_hold" };
}

/**
 * Release an authorized, unconsumed intent — the state `expires_at` could not
 * express (a cancellation is not a timeout).
 *
 * ⚠️ A gateway that cannot void (RazorPay: an authorized payment is either
 * captured or left to lapse) FAILS here by name. Substituting a refund would post
 * real money movement for a payment that never settled.
 *
 * Also the RECOVERY path for an intent the expiry sweep could not release — see the
 * `expired` branch below.
 */
export async function voidPaymentIntent(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<{ intent: PaymentIntent; attempt: PaymentAttempt | null } | null> {
  const pi = await getPaymentIntent(organizationId, businessId, piPublicId);
  if (!pi) return null;
  if (pi.status === "consumed") throw new PaymentIntentError("Intent already consumed");
  if (pi.status === "voided" || pi.voidedAt) throw new PaymentIntentError("Intent already voided");
  // An EXPIRED intent is refused ONLY when its hold is already accounted for.
  //
  // The flat refusal that used to sit here was written when expiry did nothing at the
  // gateway, and it was the second half of that bug: the sweep abandoned the hold and
  // this closed the one API that could have released it. Now `expirePaymentIntents`
  // releases first, so the refusal is right for every intent it succeeded on — a second
  // void would be a round-trip that can only fail, and re-closing a terminal row would
  // rewrite WHY it closed. But the release can fail (a gateway that was unreachable at
  // sweep time), and then the buyer's money is still held with no other way out. The
  // `payment_reversal` transaction is the record of a release actually happening, so its
  // ABSENCE is precisely the case that must stay reachable.
  if (pi.status === "expired" && (await getPaymentIntentReversal(organizationId, pi.id)))
    throw new PaymentIntentError(
      "Intent expired. Its authorization is already released at the gateway.",
    );

  const ctx = await withTenant(organizationId, async (tx) => {
    const attempt = await currentAttempt(tx, pi.id);
    const [acc] = await tx
      .select()
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.id, pi.gatewayAccountId!))
      .limit(1);
    if (!acc) throw new PaymentIntentError("Gateway account missing");
    return { attempt, acc };
  });

  const adapter = resolveAdapter(ctx.acc);
  if (!adapter.voidIntent || adapter.capabilities.intentVoid === false)
    throw new PaymentIntentVoidUnsupportedError(ctx.acc.gatewayKey);

  const trace = attemptSpan(ctx.attempt);
  /**
   * #21 — asked BEFORE the release, and the order is load-bearing: the void moves the
   * gateway's own row to `voided`, so a poll afterwards would be reading the answer to
   * our own call rather than what the buyer's bank had done.
   */
  const held = await heldBeforeVoid(pi, ctx, adapter, trace);
  const res = await withTraceContext({ ...trace, organizationId, businessId }, () =>
    adapter.voidIntent!({
      intentId: ctx.attempt?.idAtGateway ?? pi.intentAtGateway!,
      idempotencyKey: `pi_void_${pi.publicId}_a${ctx.attempt?.attemptNumber ?? 1}`,
    }),
  );
  if (!res.voided)
    throw new PaymentIntentError(`Gateway ${ctx.acc.gatewayKey} did not void the intent`);
  /**
   * The PRE-void poll wins whenever it actually asked. Where it could not ask, the
   * adapter's own answer on the void is the next-best evidence — and it is EVIDENCE,
   * unlike the `gateway_cannot_be_asked` fallback, which books a reversal on the
   * assumption that a hold existed.
   *
   * That fallback is right for RazorPay (whose poll answers, so this never fires) and
   * wrong for the two providers that cannot be polled at all but DO report what they
   * released: Stripe's cancel response carries `status` / `amount_capturable`, and
   * PayPal's void takes an authorization id, which only exists once funds were held
   * (see `VoidIntentResult.held`). `undefined` still means "cannot say", so it changes
   * nothing — reading it as `false` would stop booking reversals that are real, which is
   * the same class of error as #21 with the sign flipped.
   */
  const bookReversal =
    held.reason === "gateway_cannot_be_asked" && res.held !== undefined ? res.held : held.book;
  if (bookReversal !== held.book)
    log.info("the gateway's own void answer overruled the local assumption about a hold", {
      event: "void_hold_evidence_from_adapter",
      intent: pi.publicId,
      gatewayKey: ctx.acc.gatewayKey,
      assumed: held.book,
      reported: res.held,
    });

  return withTenant(organizationId, async (tx) => {
    let attempt = ctx.attempt;
    if (attempt) {
      attempt = await writeAttemptStatus(tx, attempt, { status: "voided" });
    }
    const [row] = await tx
      .update(paymentIntents)
      .set({ status: "voided", voidedAt: stampNow(), nextAction: null })
      .where(eq(paymentIntents.id, pi.id))
      .returning();
    /**
     * `transactions.currency` is NOT NULL; an intent we created always has one, but the
     * column is nullable so guard rather than assert.
     *
     * `held.book` is #21: this row is the RECORD OF A HOLD BEING RELEASED, so it is
     * written only where a hold existed — see `heldBeforeVoid` for how that is decided
     * and for the three readers who take its existence as proof. Everything else here
     * is unconditional: the checkout really did end, so the intent, the attempt and
     * `payment_intent_voided` are the same whatever the gateway was holding.
     */
    if (pi.currency && bookReversal) {
      await recordTransaction(
        {
          organizationId,
          businessId,
          customerId: pi.customerId,
          type: "payment_reversal",
          status: "succeeded",
          amountMinor: pi.amountMinor ?? 0n,
          currency: pi.currency,
          gatewayAccountId: ctx.acc.id,
          gatewayKey: ctx.acc.gatewayKey,
          idAtGateway: res.providerTransactionId ?? ctx.attempt?.idAtGateway ?? null,
          paymentMethodId: pi.paymentMethodId,
          paymentIntentId: pi.id,
          paymentAttemptId: attempt?.id ?? null,
        },
        tx,
      );
    }
    await emitEvent(tx, {
      organizationId,
      businessId,
      type: "payment_intent_voided",
      data: buildEventData(
        "payment_intent_voided",
        {
          id: pi.publicId,
          status: "voided",
          purpose: pi.purpose,
          amount_minor: Number(pi.amountMinor ?? 0n),
          currency: pi.currency,
          attempt_number: attempt?.attemptNumber ?? null,
        },
        row!.resourceVersion,
      ),
    });
    return { intent: row!, attempt };
  });
}

// ── expiry sweep ────────────────────────────────────────────────────────────

/**
 * What the sweep managed to do with the buyer's held money before the intent went
 * terminal. Reported on the `payment_intent_expired` event so an abandoned hold is
 * visible to a webhook consumer, not just in the logs.
 */
type HoldRelease =
  /**
   * Nothing was held. Either the intent never reached an authorization, or — since
   * 2026-09-03 — the GATEWAY was asked and did not report one. It also covers "we could
   * not find out": a gateway that cannot be asked, or would not answer, leaves the
   * behaviour exactly as it was before we asked, because neither guess is safe (see
   * `releaseHoldBeforeExpiry` rule 1). Those cases are logged `intent_hold_uncheckable`
   * rather than being silently indistinguishable from a genuine "nothing there".
   */
  | { outcome: "not_held" }
  /** The gateway released it; a `payment_reversal` transaction records it. */
  | {
      outcome: "released";
      gatewayKey: string;
      providerTransactionId: string | null;
      attemptId: string | null;
    }
  /** The gateway has no release call (RazorPay). The hold lapses on its timetable. */
  | { outcome: "unsupported" }
  /** We tried and could not — unreachable, refused, or misconfigured. */
  | { outcome: "failed" };

/**
 * Release the buyer's authorization hold BEFORE the intent is written off as expired.
 *
 * ⚠️ This is the money half of expiry, and until now it did not exist. The sweep set
 * `status = 'expired'`, failed the open attempts and emitted the event — and never told
 * the gateway. A hold is real buyer money: whenever `harvestInvoiceIntent`
 * (webhooks/inbound.ts) answers `ignored` — the gateway has not posted the authorization
 * yet, or the invoice's outstanding drifted so the consume's exact-amount check refuses —
 * the intent sits `authorized` with funds held, and an hour later we abandoned them in
 * silence. `voidPaymentIntent` had done the right thing since 2026-08-10 and nothing ever
 * wired it in.
 *
 * Four rules, in order of what they cost to get wrong:
 *
 *  0. **⚠️ OUR STATUS IS NOT EVIDENCE — ASK THE GATEWAY (2026-09-03, defect #15).** Rule 1
 *     below used to be applied to `payment_intents.status` alone, which is the exact
 *     field a lost or late callback leaves stale. Measured on INV-7824: RazorPay
 *     authorized ₹22,184.00 and `payment.authorized` arrived 21 MINUTES later, after the
 *     capture and after our own refund. Through that window this function would have
 *     concluded `not_held` without making a single gateway call, while the money was
 *     held, the invoice read unpaid and the buyer was blocked from paying it — and
 *     nothing anywhere reported any of it. So a row that is not locally `authorized` is
 *     now POLLED (`adapter.fetchIntent`, capability-gated) before it is written off.
 *     Where the gateway cannot be asked the old behaviour stands unchanged: a gateway
 *     that cannot be asked must not be assumed either way.
 *  1. **Only an `authorized` PAYMENT intent holds anything.** Two halves, and the second
 *     was missing until 2026-09-01. `inited` / `in_progress` never reached an
 *     authorization *as far as our own record knows* (rule 0 is what checks the other
 *     record), so a release there is a round-trip that can only fail — and neither
 *     does a `setup` intent at ANY status, because it is created with `amountMinor: 0n`
 *     on every adapter (see `finishSetupConsume`, which stopped voiding for exactly this
 *     reason). Status alone was the wrong test: `finishSetupConsume`'s catch path writes
 *     `status: 'authorized'` on a SETUP intent deliberately, to record that the buyer's
 *     authorization existed, so a setup whose local record failed and was then never
 *     retried arrived here an hour later and got `POST /v1/setup_intents/{id}/cancel ->
 *     400 setup_intent_unexpected_state` — the same failing call the consume path had
 *     just been cleaned of, surviving in the sweep. Measured 2026-09-01 across the whole
 *     dev database: **no setup intent has ever reached `expired` with `authorized_at`
 *     set** (512 expired setups, all `authorized_at IS NULL`, i.e. expired out of
 *     `in_progress` where rule 1's first half already skipped them), so this is a latent
 *     path rather than an observed one — which is why it is a guard plus a gate and not
 *     a data fix. `scripts/probe-zero-due-debits.ts` § B is that measurement.
 *  2. **One row must never stop the sweep.** Every gateway outcome is caught and turned
 *     into a verdict, never a throw. This runs platform-wide over many tenants; a gateway
 *     that is down must not strand everyone else's rows behind it, and the row still
 *     expires either way (the TTL is about OUR record, not about the gateway's).
 *  3. **RazorPay cannot be released, and that must be LOUD.** `intentVoid: false` is
 *     honest — there is no cancel call, and faking one with a refund would move real money
 *     for a payment that never settled (razorpay.ts, "voidIntent: deliberately NOT
 *     implemented"). The hold lapses on RazorPay's own timetable and nothing here can
 *     change that. What we can refuse to do is lose track of it, so the abandoned case is
 *     logged at WARN with the amount, the currency and every id needed to reconcile it —
 *     and reported on the event.
 */
async function releaseHoldBeforeExpiry(pi: PaymentIntent): Promise<HoldRelease> {
  /**
   * Rule 1's second half now comes FIRST, and the order is load-bearing.
   *
   * A `setup` intent holds no money at ANY status — it is created with
   * `amountMinor: 0n` on every adapter — so it is the one case that can be answered
   * without asking anybody, and answering it early is what keeps the gateway poll below
   * off a population it has no business in. On the India e-mandate rails a setup
   * intent's registration debit is a ₹1–5 charge that is routinely refunded while the
   * mandate goes live (measured 2026-09-03: `pay_XXXXXXXXXXXX03`, amount 100, fee 3), so
   * polling one would spend a gateway call to discover a rupee that is not stranded and
   * report it as abandoned buyer funds.
   *
   * `not_held` and not `unsupported`: nothing was held, so there is nothing for an
   * operator to reconcile and no WARN to raise.
   */
  if (pi.purpose === "setup") return { outcome: "not_held" };
  // Mutable on purpose: the gateway poll below can DISCOVER the charge id behind the
  // order, and that id is the one thing an operator needs to reconcile a hold RazorPay
  // will not release. It is stamped in here so every log line after the poll carries it.
  const money: Record<string, unknown> = {
    intent: pi.publicId,
    purpose: pi.purpose,
    customer: pi.customerId,
    amountMinor: String(pi.amountMinor ?? 0n),
    currency: pi.currency,
    invoice: pi.invoiceId,
    gatewayAccount: pi.gatewayAccountId,
  };
  const ctx = await withTenant(pi.organizationId, async (tx) => {
    const attempt = await currentAttempt(tx, pi.id);
    const acc = pi.gatewayAccountId
      ? ((
          await tx
            .select()
            .from(gatewayAccounts)
            .where(eq(gatewayAccounts.id, pi.gatewayAccountId))
            .limit(1)
        )[0] ?? null)
      : null;
    return { attempt, acc };
  });
  if (!ctx.acc) {
    // Only a row WE believe is authorized can be reported as abandoned funds here. On a
    // row that is not, we have no evidence of a hold and no way to look for one, so the
    // honest answer is silence — a WARN would report buyer money that may not exist.
    if (pi.status !== "authorized") return { outcome: "not_held" };
    log.warn(
      "an expiring payment intent holds buyer funds and has no gateway account to release them through",
      {
        event: "intent_hold_abandoned",
        reason: "gateway_account_missing",
        ...money,
      },
    );
    return { outcome: "failed" };
  }

  let adapter: PaymentProvider;
  try {
    adapter = resolveAdapter(ctx.acc);
  } catch (e) {
    if (pi.status !== "authorized") return { outcome: "not_held" };
    log.error(e, {
      event: "intent_hold_abandoned",
      reason: "adapter_unresolvable",
      gatewayKey: ctx.acc.gatewayKey,
      ...money,
    });
    return { outcome: "failed" };
  }

  const intentIdAtGateway = ctx.attempt?.idAtGateway ?? pi.intentAtGateway;
  const trace = attemptSpan(ctx.attempt);

  /**
   * ── #15 · ASK THE GATEWAY, DO NOT TRUST OUR OWN STATUS ──────────────────────
   *
   * This function used to open with `if (pi.status !== 'authorized') return not_held`,
   * which trusts the ONE field a lost or late callback leaves stale. Measured 2026-09-03
   * on INV-7824: RazorPay authorized ₹22,184.00 and delivered `payment.authorized` 21
   * minutes late — after the capture and after our own refund. Through that window our
   * row said `in_progress`, so at expiry this made no gateway call at all and concluded
   * nothing was held, while the buyer's money sat at the gateway, the invoice read unpaid
   * and the buyer was blocked from paying it.
   *
   * So on a row we do NOT already believe is authorized, ask. Three rules:
   *
   *  1. **Only where the gateway can answer.** `fetchIntent` + `capabilities.intentStatus`
   *     are checked together, exactly as `voidIntent` + `intentVoid` are below. An adapter
   *     that cannot be asked keeps the old behaviour — `not_held`, no round trip — because
   *     "we cannot check" must not become either "nothing is held" (the defect) or
   *     "something is held" (a false alarm on every abandoned checkout in the database).
   *  2. **`unknown` is not an answer about money.** A gateway that has not heard of the id
   *     has told us nothing; it is logged so the gap is visible and the row is left alone.
   *  3. **The poll never decides the row's fate.** The intent is already claimed
   *     `expired` by the caller and stays that way whatever this returns; all that is at
   *     stake is whether the hold is released, logged, and counted as abandoned.
   */
  if (pi.status !== "authorized") {
    if (!adapter.fetchIntent || adapter.capabilities.intentStatus !== true) {
      return { outcome: "not_held" };
    }
    if (!intentIdAtGateway) {
      // Nothing ever reached a gateway under this row, so there is nothing to ask about.
      // The 7 seed rows in the dev database have exactly this shape.
      return { outcome: "not_held" };
    }
    let fetched: FetchedIntent;
    try {
      fetched = await withTraceContext(
        { ...trace, organizationId: pi.organizationId, businessId: pi.businessId },
        () =>
          // Always 'payment' here: rule 1's setup guard returned above, and the row's own
          // `purpose` column is typed as plain text.
          adapter.fetchIntent!({ intentId: intentIdAtGateway, purpose: "payment" }),
      );
    } catch (e) {
      // Rule 2 of this function: one row must never stop the sweep, and one gateway's bad
      // day must not strand every other tenant's expiry behind it.
      log.error(e, {
        event: "intent_hold_uncheckable",
        reason: "gateway_unreachable",
        gatewayKey: ctx.acc.gatewayKey,
        localStatus: pi.status,
        ...money,
      });
      return { outcome: "not_held" };
    }
    if (fetched.status === "unknown") {
      log.warn("could not establish whether an expiring payment intent holds buyer funds", {
        event: "intent_hold_uncheckable",
        reason: "gateway_does_not_know",
        gatewayKey: ctx.acc.gatewayKey,
        gatewayIntent: intentIdAtGateway,
        localStatus: pi.status,
        ...money,
      });
      return { outcome: "not_held" };
    }
    if (fetched.status === "consumed" && fetched.capturedOnConfirm) {
      // Captured at the buyer's confirm, so there is nothing to release. The payment
      // webhook books it (it revives an expired intent); this line is the trail if not.
      log.warn("an expiring payment intent was captured at confirm and is not booked yet", {
        event: "intent_captured_unbooked_at_expiry",
        gatewayKey: ctx.acc.gatewayKey,
        gatewayIntent: intentIdAtGateway,
        localStatus: pi.status,
        ...money,
      });
      return { outcome: "not_held" };
    }
    if (fetched.status !== "authorized") return { outcome: "not_held" };
    // A real hold our record never learned about. WARN even if the release below
    // succeeds: an authorization the engine did not know it had is a delivery failure
    // worth seeing, and on RazorPay it is also the last notice anyone gets.
    if (fetched.providerChargeId) money.chargeAtGateway = fetched.providerChargeId;
    log.warn("the gateway is holding funds for a payment intent our own record calls unfinished", {
      event: "intent_hold_found_by_poll",
      gatewayKey: ctx.acc.gatewayKey,
      gatewayIntent: intentIdAtGateway,
      localStatus: pi.status,
      gatewayStatus: fetched.status,
      ...money,
    });
  }

  if (!adapter.voidIntent || adapter.capabilities.intentVoid === false) {
    log.warn("an expiring payment intent holds buyer funds this gateway cannot release", {
      event: "intent_hold_abandoned",
      reason: "gateway_cannot_void",
      gatewayKey: ctx.acc.gatewayKey,
      note: "the hold will lapse on the gateway’s own timetable; nothing further will happen here",
      ...money,
    });
    return { outcome: "unsupported" };
  }
  if (!intentIdAtGateway) {
    log.warn("an expiring payment intent is authorized with no gateway id to release", {
      event: "intent_hold_abandoned",
      reason: "no_gateway_id",
      gatewayKey: ctx.acc.gatewayKey,
      ...money,
    });
    return { outcome: "failed" };
  }

  try {
    const res = await withTraceContext(
      { ...trace, organizationId: pi.organizationId, businessId: pi.businessId },
      () =>
        adapter.voidIntent!({
          intentId: intentIdAtGateway,
          // Attempt-scoped, like every other key here, and stable across sweeps: a
          // redelivered expiry must not open a second release at the gateway.
          idempotencyKey: `pi_void_${pi.publicId}_a${ctx.attempt?.attemptNumber ?? 1}`,
        }),
    );
    if (!res.voided) {
      log.warn("the gateway refused to release an expiring payment intent’s hold", {
        event: "intent_hold_abandoned",
        reason: "gateway_refused",
        gatewayKey: ctx.acc.gatewayKey,
        ...money,
      });
      return { outcome: "failed" };
    }
    return {
      outcome: "released",
      gatewayKey: ctx.acc.gatewayKey,
      providerTransactionId: res.providerTransactionId ?? ctx.attempt?.idAtGateway ?? null,
      attemptId: ctx.attempt?.id ?? null,
    };
  } catch (e) {
    // Caught, never rethrown — see rule 2. `voidPaymentIntent` stays open for this
    // intent (no `payment_reversal` was booked), so an operator has a way back.
    log.error(e, {
      event: "intent_hold_abandoned",
      reason: "gateway_unreachable",
      gatewayKey: ctx.acc.gatewayKey,
      ...money,
    });
    return { outcome: "failed" };
  }
}

/**
 * Hourly sweep: expire intents that were never consumed (incl. authorized, 1h
 * TTL), and close their still-open attempts. An attempt left `authorized`
 * under an `expired` intent would make the intent look retriable when it isn't.
 *
 * An `authorized` intent is RELEASED at the gateway first — see
 * `releaseHoldBeforeExpiry` for why, and for what happens on the gateways that cannot.
 * The release runs outside the tenant transaction because it is a network call; the row
 * is expired afterwards whatever it answered.
 *
 * ⚠️ The deadline is `expires_at`, set per RAIL at creation (`ttl.ts`). The **one-hour**
 * figure is deliberate and still applies to the case it was chosen for — an
 * on-session card, buyer present. Do not shorten it to make the release
 * land sooner: the release is what changed in 0217, not the deadline.
 *
 * ⚠️ Nor lengthen the on-session hour, and nor shorten the rails. The asynchronous rails
 * get days (e-mandate 7d, card 96h, UPI 48h) because expiring one EARLY is not a tidy-up,
 * it destroys money: `expired` is terminal to the inbound webhook path, so the bank's
 * later approval is dropped and the hold is left at the gateway with the invoice unpaid
 * (measured — INV-5510 carries two RazorPay orders, the second `authorized` with
 * `pay_XXXXXXXXXXXX01` and no engine rows), or a live mandate is left with no
 * `payment_methods` row.
 */
export async function expirePaymentIntents(
  now: Date,
): Promise<{ expired: number; released: number; abandoned: number }> {
  const due = await systemDb
    .select()
    .from(paymentIntents)
    .where(
      and(
        inArray(paymentIntents.status, ["inited", "in_progress", "authorized"]),
        lt(paymentIntents.expiresAt, now),
        scanBusinessFilter(paymentIntents.businessId),
      ),
    );
  let expired = 0;
  let released = 0;
  let abandoned = 0;
  for (const pi of due) {
    /**
     * CLAIM the row before touching the gateway.
     *
     * `due` was read outside any transaction, so between the scan and here a buyer's
     * callback could have consumed this intent or a retry could have re-armed it — and
     * voiding an intent that has just been CAPTURED would try to release money the
     * gateway already took. The conditional update is the same atomic-claim shape
     * `consumePaymentIntent` uses in the other direction: it wins or it does not, and
     * losing it means the row was never ours to expire. Guarded on the deadline too,
     * because a retry mints a new `expires_at` without necessarily changing the status.
     */
    const [claimed] = await withTenant(pi.organizationId, (tx) =>
      tx
        .update(paymentIntents)
        // The buyer can no longer finish it, so drop what the browser needed to (a gateway
        // session token, a client secret).
        .set({ status: "expired", nextAction: null })
        .where(
          and(
            eq(paymentIntents.id, pi.id),
            eq(paymentIntents.status, pi.status),
            lt(paymentIntents.expiresAt, now),
          ),
        )
        .returning(),
    );
    if (!claimed) continue;
    // The intent is terminal now, so no consume can take it while the gateway call is
    // out; `pi.status` is the status it held when we claimed it, which is what decides
    // whether anything is held.
    const release = await releaseHoldBeforeExpiry(pi);
    if (release.outcome === "released") released++;
    else if (release.outcome !== "not_held") abandoned++;
    await withTenant(pi.organizationId, async (tx) => {
      const open = await tx
        .select()
        .from(paymentAttempts)
        .where(
          and(
            eq(paymentAttempts.paymentIntentId, pi.id),
            inArray(paymentAttempts.status, [...OPEN_ATTEMPT_STATUSES]),
          ),
        );
      for (const attempt of open) {
        await failAttempt(
          tx,
          attempt,
          "intent_expired",
          "The intent expired before it was consumed",
          pi.publicId,
        );
      }
      // The gateway action, recorded the way `voidPaymentIntent` records the same one —
      // same row type, so Gateway Activity reads identically however the hold came to be
      // released. Only on a real release: a `payment_reversal` for a call that did not
      // happen would assert a gateway interaction that never took place (the 2026-08-22
      // lesson), and its absence is what keeps `voidPaymentIntent` open as the recovery
      // path for a release that failed.
      if (release.outcome === "released" && pi.currency) {
        await recordTransaction(
          {
            organizationId: pi.organizationId,
            businessId: pi.businessId,
            customerId: pi.customerId,
            type: "payment_reversal",
            status: "succeeded",
            amountMinor: pi.amountMinor ?? 0n,
            currency: pi.currency,
            gatewayAccountId: pi.gatewayAccountId,
            gatewayKey: release.gatewayKey,
            idAtGateway: release.providerTransactionId,
            paymentMethodId: pi.paymentMethodId,
            paymentIntentId: pi.id,
            paymentAttemptId: release.attemptId,
          },
          tx,
        );
      }
      await emitEvent(tx, {
        organizationId: pi.organizationId,
        businessId: pi.businessId,
        type: "payment_intent_expired",
        data: buildEventData(
          "payment_intent_expired",
          { id: pi.publicId, purpose: pi.purpose },
          null,
          // `unsupported` is the one an operator has to act on: the buyer's money is
          // still held and only the gateway's own clock will give it back.
          { hold_release: release.outcome },
        ),
      });
    });
    expired++;
  }
  return { expired, released, abandoned };
}

// ── list ────────────────────────────────────────────────────────────────────

/**
 * One page of a business's payment intents, newest-first. There was NO list route
 * at all (create / get-by-id / authorize / consume only), so the dashboard could
 * only ever be a create-and-inspect form.
 *
 * Keyset on `(created_at DESC, public_id DESC)` via
 * `payment_intents_business_created_idx`, the same contract as every other list
 * (GUIDE §3.4). The customer, gateway ACCOUNT and card are joined for the list's
 * columns — the account's label matters because the list shows "Stripe / Stripe-1"
 * and a business can hold several accounts on one gateway, so the key alone is
 * ambiguous.
 */
export interface PaymentIntentListRow {
  intent: PaymentIntent;
  customerPublicId: string | null;
  /** RESOLVED account-holder name (`customers/names.ts`), not a single column. */
  customerName: string | null;
  /** The Customer Information card is First/Last name + Email + Phone, not a display name. */
  customerFirstName: string | null;
  customerLastName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  gatewayKey: string | null;
  gatewayAccountPublicId: string | null;
  gatewayAccountLabel: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
}

/**
 * The joined projection behind BOTH the list and the single-intent read.
 *
 * It is one constant on purpose: the detail route used to serialize the bare
 * intent, so the detail page had no customer, no gateway and no card while the
 * list row had all three — and the page omitted three of its blocks because of
 * it. Two shapes drifting apart is what caused that, so there is now
 * exactly one.
 */
const INTENT_ROW_SELECTION = {
  intent: paymentIntents,
  cusPid: customers.publicId,
  cusFirstName: customers.firstName,
  cusLastName: customers.lastName,
  // The company completes the display-name chain (`accountHolderName`): first/last →
  // company → the legacy `name`. Without it a company-only customer — a business
  // buyer with no named contact — rendered nameless on both the list and the card.
  cusCompany: customers.company,
  cusEmail: customers.email,
  cusPhone: customers.phone,
  gatewayKey: gatewayAccounts.gatewayKey,
  gatewayAccountPid: gatewayAccounts.publicId,
  gatewayAccountLabel: gatewayAccounts.label,
  cardBrand: paymentMethods.brand,
  cardLast4: paymentMethods.last4,
} as const;

type IntentRowSelect = {
  [K in keyof typeof INTENT_ROW_SELECTION]: K extends "intent" ? PaymentIntent : string | null;
};

const toIntentRow = (r: IntentRowSelect): PaymentIntentListRow => ({
  intent: r.intent,
  customerPublicId: r.cusPid ?? null,
  customerName: accountHolderName({
    firstName: r.cusFirstName,
    lastName: r.cusLastName,
    company: r.cusCompany,
    email: r.cusEmail,
  }),
  customerFirstName: r.cusFirstName ?? null,
  customerLastName: r.cusLastName ?? null,
  customerEmail: r.cusEmail ?? null,
  customerPhone: r.cusPhone ?? null,
  gatewayKey: r.gatewayKey ?? null,
  gatewayAccountPublicId: r.gatewayAccountPid ?? null,
  gatewayAccountLabel: r.gatewayAccountLabel ?? null,
  cardBrand: r.cardBrand ?? null,
  cardLast4: r.cardLast4 ?? null,
});

/**
 * One intent WITH the same joined context as a list row — what
 * `GET /payment_intents/:pi` serializes.
 *
 * `getPaymentIntent` (the bare row) is still the right read for every engine path
 * that acts on an intent; this is the READ-FOR-DISPLAY, and the only difference is
 * the joins.
 */
export async function getPaymentIntentRow(
  organizationId: string,
  businessId: string,
  piPublicId: string,
): Promise<PaymentIntentListRow | null> {
  return withTenant(organizationId, async (tx) => {
    const [row] = await tx
      .select(INTENT_ROW_SELECTION)
      .from(paymentIntents)
      .leftJoin(customers, eq(paymentIntents.customerId, customers.id))
      .leftJoin(gatewayAccounts, eq(paymentIntents.gatewayAccountId, gatewayAccounts.id))
      .leftJoin(paymentMethods, eq(paymentIntents.paymentMethodId, paymentMethods.id))
      .where(
        and(eq(paymentIntents.businessId, businessId), eq(paymentIntents.publicId, piPublicId)),
      )
      .limit(1);
    return row ? toIntentRow(row) : null;
  });
}

export async function listPaymentIntentsPage(
  organizationId: string,
  businessId: string,
  f: {
    status?: string;
    purpose?: string;
    /**
     * The invoice these intents are collecting for — the invoice PAGE's filter.
     *
     * An open intent writes no `payments` row and no transaction, so an invoice's own
     * money list could not see one: a buyer mid-way through Pay now, or one who walked
     * away from it, was invisible to the operator looking at that invoice.
     *
     * A PUBLIC id, resolved here rather than by the route, the same way
     * `createPaymentIntent` resolves its own. An id that matches nothing on this business
     * returns an EMPTY page rather than every intent — silently dropping an
     * unrecognised filter is how a list ends up answering a question nobody asked.
     */
    invoicePublicId?: string;
    search?: string;
    filters?: ListFilter[];
    sortField?: string;
    sortDesc?: boolean;
    startingAfter?: string;
    limit?: number;
  } = {},
): Promise<ListPage<PaymentIntentListRow>> {
  const limit = clampLimit(f.limit);
  const descending = f.sortDesc ?? true;

  return withTenant(organizationId, async (tx) => {
    const conds: SQL[] = [eq(paymentIntents.businessId, businessId)];
    if (f.status) conds.push(eq(paymentIntents.status, f.status));
    if (f.purpose) conds.push(eq(paymentIntents.purpose, f.purpose));
    if (f.invoicePublicId) {
      const [inv] = await tx
        .select({ id: invoices.id })
        .from(invoices)
        .where(and(eq(invoices.businessId, businessId), eq(invoices.publicId, f.invoicePublicId)))
        .limit(1);
      // A never-true clause on a miss, never a DROPPED clause — see the field note.
      conds.push(inv ? eq(paymentIntents.invoiceId, inv.id) : sql`false`);
    }

    const { keysetId, offset } = parseCursor(f.startingAfter);
    /**
     * FIRST PAGE ONLY, per the contract. This used to run unconditionally, so intents
     * answered with `total` on every page — the same undeclared deviation `listRetriesPage`
     * had, and found the same way: by being added to `verify:list-pagination`, which failed
     * on "total is first-page only" the first time it ran. Nothing consumes a later page's
     * total — `ListPage`'s `loadMore` never calls `setTotal` — so it was a `count(*)` per
     * scroll with no reader.
     */
    const total =
      keysetId || offset
        ? null
        : ((
            await tx
              .select({ n: sql<number>`count(*)::int` })
              .from(paymentIntents)
              .where(and(...conds))
          )[0]?.n ?? 0);

    const pageConds = [...conds];
    if (keysetId) {
      const [cursor] = await tx
        .select({
          createdAt: sql<string>`${paymentIntents.createdAt}::text`,
          publicId: paymentIntents.publicId,
        })
        .from(paymentIntents)
        .where(
          and(eq(paymentIntents.businessId, businessId), eq(paymentIntents.publicId, keysetId)),
        )
        .limit(1);
      const seek = keysetCondition(
        paymentIntents.createdAt,
        paymentIntents.publicId,
        cursor ? { sortValue: cursor.createdAt, tiebreak: cursor.publicId } : undefined,
        descending,
      );
      if (seek) pageConds.push(seek);
    }

    const rows = await tx
      .select(INTENT_ROW_SELECTION)
      .from(paymentIntents)
      .leftJoin(customers, eq(paymentIntents.customerId, customers.id))
      .leftJoin(gatewayAccounts, eq(paymentIntents.gatewayAccountId, gatewayAccounts.id))
      .leftJoin(paymentMethods, eq(paymentIntents.paymentMethodId, paymentMethods.id))
      .where(and(...pageConds))
      .orderBy(...pageOrder(paymentIntents.createdAt, paymentIntents.publicId, descending, true))
      .limit(limit + 1);

    const page = toPage(rows, limit, {
      keyset: true,
      offset,
      keyOf: (r) => r.intent.publicId,
      total,
    });
    return { ...page, data: page.data.map(toIntentRow) };
  });
}

// ── serialization ───────────────────────────────────────────────────────────

/**
 * Row serializer: the single-intent shape plus the joined context. Used by BOTH
 * the list and `GET /payment_intents/:pi` — the detail route serialized the bare
 * intent until now, which is why the detail page could not render the Customer
 * Information card or the summary's Gateway row.
 */
export function serializePaymentIntentRow(r: PaymentIntentListRow) {
  return {
    ...serializePaymentIntent(r.intent),
    customer: r.customerPublicId,
    customer_name: r.customerName,
    // First/last/phone are what the "Customer Information" card renders; a display
    // name cannot be split back into them (many customers have only `name` set).
    customer_first_name: r.customerFirstName,
    customer_last_name: r.customerLastName,
    customer_email: r.customerEmail,
    customer_phone: r.customerPhone,
    gateway_key: r.gatewayKey,
    // The UI shows "Stripe / Stripe-1": the gateway AND which account of it. A business
    // can hold several accounts on one gateway, so the key alone names nothing.
    gateway_account: r.gatewayAccountPublicId,
    gateway_account_label: r.gatewayAccountLabel,
    payment_method_brand: r.cardBrand,
    payment_method_last4: r.cardLast4,
  };
}

export function serializePaymentIntent(pi: PaymentIntent) {
  return {
    object: "payment_intent",
    id: pi.publicId,
    status: pi.status,
    purpose: pi.purpose,
    amount_minor: pi.amountMinor != null ? Number(pi.amountMinor) : null,
    // The mandate ceiling a `setup` intent registered with (0174) — null for `payment`
    // intents, which register no mandate. Readable because it is
    // writable: a caller who sets a ceiling must be able to confirm the one that stuck,
    // and it is what a retry will re-register with.
    max_amount_minor: pi.maxAmountMinor != null ? Number(pi.maxAmountMinor) : null,
    currency: pi.currency,
    // The "Payment Attempts" column, denormalised (GUIDE §3.4 forbids the
    // per-row correlated COUNT a keyset list would otherwise need).
    attempt_count: pi.attemptCount,
    // The NEWEST attempt's status. Readable because the intent's own status cannot express
    // a refusal — it has no `failed` — so a caller listing intents (ours included: this is
    // what the dashboard list and the invoice's open-intents block read) cannot otherwise
    // tell a declined authorization from one a buyer is still working through. `null` =
    // no attempt yet.
    last_attempt_status: pi.lastAttemptStatus,
    next_action: pi.nextAction ?? null,
    expires_at: pi.expiresAt,
    voided_at: pi.voidedAt,
    created_at: pi.createdAt,
    resource_version: pi.resourceVersion,
  };
}

/**
 * Attempt serializer. `method` is the instrument the attempt was tried with
 * (`listAttemptsForIntent` joins it) — the per-attempt "Payment Method".
 *
 * ⚠️ The `payment_method*` keys are emitted **only when the argument is passed**,
 * not as nulls when it isn't. The action responses (create / retry / void /
 * consume) hand over a bare attempt they never joined an instrument for, and
 * `payment_method: null` there would assert "this attempt used no card" about an
 * attempt that used one. Saying nothing is the honest shape; the retrieve routes,
 * which do join, say it for real.
 */
export function serializePaymentAttempt(a: PaymentAttempt, method?: AttemptPaymentMethod | null) {
  return {
    object: "payment_attempt",
    id: a.publicId,
    attempt_number: a.attemptNumber,
    status: a.status,
    id_at_gateway: a.idAtGateway,
    ...(method !== undefined
      ? {
          payment_method: method?.publicId ?? null,
          payment_method_type: method?.type ?? null,
          payment_method_brand: method?.brand ?? null,
          payment_method_last4: method?.last4 ?? null,
        }
      : {}),
    error_code: a.errorCode,
    error_text: a.errorText,
    // Correlate this attempt with `gateway_request_logs` (platform-global, no RLS,
    // so no FK). `span_id` is the attempt; `trace_id` the request or job that made it.
    trace_id: a.traceId,
    span_id: a.spanId,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
    resource_version: a.resourceVersion,
  };
}
