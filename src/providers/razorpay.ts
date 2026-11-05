import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "@/platform/logger";
import type {
  PaymentProvider,
  ProviderCapabilities,
  EnsureCustomerInput,
  ProviderCustomerRef,
  VaultPaymentMethodInput,
  ProviderPaymentMethodRef,
  ProviderMandate,
  InitiateVaultSetupInput,
  VaultSetupRef,
  BuyerAuthorization,
  ChargeInput,
  ChargeResult,
  RefundInput,
  RefundResult,
  NormalizeWebhookInput,
  ProvisionedWebhook,
  WebhookRemoval,
  NormalizedProviderEvent,
  CreateIntentInput,
  IntentRef,
  ConsumeIntentInput,
  ConsumeIntentResult,
  FetchedIntent,
  IntentPurpose,
} from "./types";
import { markStrandedObject } from "./types";
import { ProviderIndeterminateError, ProviderRefusalError } from "./types";
import { providerFetch, boundedProviderKey } from "./http";
import { classifyGatewayHttp } from "./gateway-http-class";
import { normalizeRazorpayDecline } from "./decline-codes";
import { bodyId, headerValue, webhookEventId } from "./webhook-event-id";
import { RAZORPAY_WEBHOOK_EVENTS } from "./gateway-catalog";

interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  apiBase: string;
  webhookSecret?: string;
}

/** RazorPay 400s on an order `receipt` longer than 40 chars. See `boundedProviderKey`. */
const log = createLogger("razorpay");
const RAZORPAY_RECEIPT_MAX = 40;

/**
 * ── The ownership tag (#31) ──────────────────────────────────────────────────
 *
 * The note key that says a RazorPay object was created by THIS engine. It is stamped
 * on every object we create (see the create paths below; the exemptions are named on
 * each of the two payment-create calls) and read back in `normalizeWebhook` /
 * `fetchOrderOwnership`.
 *
 * Why it has to exist: this merchant account is SHARED with another product, so
 * the engine receives capture webhooks for payments it never created — 124
 * `charge.succeeded` events had already arrived for charges with no payment row of
 * ours when this shipped. None was booked (booking needs a match on our own intent or
 * transaction, and `reconcileUnmatchedCapture` refuses to guess a customer), so money
 * was never at risk. What was broken is that "a sibling product's charge" (normal,
 * should be silent) and "our capture we failed to attribute" (a money incident)
 * produced the SAME warning, so the second could never be alerted on.
 *
 * Why `notes` and not `receipt`: measured 2026-09-04, of **875 orders this engine has
 * created at RazorPay, ZERO carried a readable ref**. The receipt was the only trace
 * and it is capped at 40 chars, so `boundedProviderKey` HASHES the recurring path's key
 * to `tm_<hash>` — irreversible, and that is precisely the money path. A `notes` value
 * takes 256 characters (15 pairs), so the full key goes in whole. The pattern already existed
 * twice in this file (`createEmandateAuthLink`, and the receipt prefix
 * `assertAuthLinkBelongsTo` falls back to) and had never reached a money object.
 *
 * ⚠️ Tagging must stay UNCONDITIONAL. The classifier's rule is "created after tagging
 * shipped and carries no tag ⇒ provably not ours", and one create path that forgets to
 * stamp makes that rule unsound for every object. `test/unit/razorpay-ownership.test.ts`
 * asserts each path separately and fails on a new untagged `POST` endpoint.
 */
const TMBILLING_REF_NOTE = "tmbilling_ref";
/**
 * The finer ref on the e-mandate auth link, which cannot use the key above.
 *
 * `assertAuthLinkBelongsTo` compares `notes.tmbilling_ref` to an expected PROVIDER
 * CUSTOMER id on the raw-token vault path — the value is load-bearing there, not just
 * its presence. Overwriting it with an intent ref would silently disable that ownership
 * proof, so the link carries both: the customer binding under the key that is checked,
 * and the intent ref under this one.
 */
const TMBILLING_INTENT_REF_NOTE = "tmbilling_intent_ref";
/**
 * Marks a mandate-registration order. A UPI order's fetch omits its `token` block (measured
 * 2026-10-29; a card order keeps it), so this note is how `setupAuthChargeFor` knows the order.
 */
const TMBILLING_SETUP_ORDER_NOTE = "tmbilling_setup";
/** The ref the connectivity probe's throwaway order carries — it is ours, not a stranger's. */
export const RAZORPAY_HEALTHCHECK_REF = "tmbilling_healthcheck";

/** The note bag every create path stamps. One helper so no path can spell the key its own way. */
function ownershipNotes(ref: string): Record<string, string> {
  return { [TMBILLING_REF_NOTE]: ref };
}

/**
 * What a RazorPay note bag says about ownership — separating "we looked and ours is
 * absent" from "there was nothing to look at".
 *
 * `read` is the distinction the whole three-way answer rests on. RazorPay echoes an
 * empty bag back as `[]` (measured on the customer endpoint, see `updateCustomer`), so
 * an array counts as READ; a missing/`null` `notes` property means the entity does not
 * carry one at all (token, settlement) and we learned nothing.
 */
export function readRazorpayNotes(notes: unknown): { read: boolean; ref?: string } {
  if (notes == null || typeof notes !== "object") return { read: false };
  const ref = (notes as Record<string, unknown>)[TMBILLING_REF_NOTE];
  return typeof ref === "string" && ref.length > 0 ? { read: true, ref } : { read: true };
}

/**
 * RazorPay's `created_at` is **SECONDS** since the epoch, on every entity that has one.
 * Reading it as milliseconds would date every object to January 1970 and therefore
 * "before tagging shipped" — which is exactly the half of the classifier's rule that
 * decides whether an untagged object is judged foreign. Absent stays absent: an
 * invented date is worse than no date.
 */
export function razorpayEpochToDate(seconds: unknown): Date | undefined {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  return new Date(seconds * 1000);
}

/** The ownership half of what a readback (webhook or order fetch) can tell us. */
export interface RazorpayOwnershipReadback {
  ownership: NonNullable<NormalizedProviderEvent["ownership"]>;
  ownershipRef?: string;
  providerObjectCreatedAt?: Date;
}

interface RazorpayTaggableEntity {
  notes?: unknown;
  created_at?: unknown;
}

/**
 * Decide ownership from the entities an event (or an order fetch) actually carries.
 *
 * ── Which entity may say "foreign", and which may not ────────────────────────
 * Only the ORDER. We stamp every order we create, so an order whose notes were read
 * without our ref is provably not ours. The PAYMENT is different and the difference is
 * load-bearing: a buyer's Checkout payment against our order is minted by RazorPay with
 * a note bag we never touch, and the two s2s payment-create calls deliberately send no
 * notes (their acceptance of the field is unmeasured on this account, and a rejected
 * field there would fail every off-session collection). So an untagged payment is not
 * evidence of anything — calling it `foreign` would report our own money as a
 * stranger's, the same error as reading a missing poll answer as "nothing held".
 * `payment.captured` carries the PAYMENT's notes, not the order's, which is why the
 * common case answers `unknown` and is resolved through `fetchOrderOwnership`.
 *
 * A positive tag on EITHER entity wins, because a tag can only have got there from us.
 *
 * ── The date must describe the object whose tags were read ───────────────────
 * "Created after tagging shipped and carries no tag ⇒ not ours" has to be asked of one
 * object. A payment minted today against an order created before the rollout would be
 * judged on the wrong object's age if the two were mixed, so the date is taken from
 * whichever entity produced the verdict.
 */
export function razorpayProvenance(
  order: RazorpayTaggableEntity | undefined,
  primary: RazorpayTaggableEntity | undefined,
): RazorpayOwnershipReadback {
  const fromOrder = readRazorpayNotes(order?.notes);
  const fromPrimary = readRazorpayNotes(primary?.notes);
  const orderAt = razorpayEpochToDate(order?.created_at);
  const primaryAt = razorpayEpochToDate(primary?.created_at);
  const at = (d: Date | undefined) => (d ? { providerObjectCreatedAt: d } : {});
  if (fromOrder.ref) {
    return { ownership: "ours", ownershipRef: fromOrder.ref, ...at(orderAt ?? primaryAt) };
  }
  if (fromPrimary.ref) {
    return { ownership: "ours", ownershipRef: fromPrimary.ref, ...at(primaryAt ?? orderAt) };
  }
  if (fromOrder.read) return { ownership: "foreign", ...at(orderAt ?? primaryAt) };
  return { ownership: "unknown", ...at(primaryAt ?? orderAt) };
}

/**
 * A rail an authorization can ride at RazorPay, in RazorPay's own vocabulary — NOT
 * ours. `emandate` is the netbanking MANDATE rail (recurring); a one-off netbanking
 * payment is `netbanking`, and Checkout rejects an order that says `emandate` without
 * a mandate token block. `wallet` exists for one-off payments only — RazorPay has no
 * recurring wallet rail at all (see the guard in `selectRail`).
 */
type RazorpayRail = "upi" | "card" | "emandate" | "wallet";

/**
 * A RazorPay payment entity, as returned by `GET /payments/:id`,
 * `GET /orders/:id/payments` and `POST /payments/:id/capture`.
 */
interface RazorpayPaymentEntity {
  id: string;
  status?: string;
  amount?: number;
  currency?: string;
  captured?: boolean;
  token_id?: string | null;
  /**
   * The customer the payment (and therefore the token it mints) is scoped to. The
   * ORDER does not carry this — see `consumeIntent` — so the payment is the only
   * place a mandate's customer can be read back from.
   */
  customer_id?: string | null;
  order_id?: string | null;
  /** `card`, `upi`, `netbanking`, `wallet`, `emandate`, `nach`, `emi`, … */
  method?: string | null;
  error_code?: string | null;
  error_reason?: string | null;
  error_description?: string | null;
  /** Seconds since the epoch. */
  created_at?: number;
}

/**
 * The payment entity's `method` → our method type (`ChargeResult.methodUsed`).
 * https://razorpay.com/docs/api/payments/ ("method"). EMI, pay-later and others stay unknown.
 */
const RAZORPAY_METHOD_USED: Readonly<Record<string, string>> = {
  card: "card",
  upi: "upi",
  wallet: "wallet",
  netbanking: "bank_transfer",
  emandate: "bank_transfer",
  nach: "bank_transfer",
};

export function razorpayMethodUsed(method: string | null | undefined): { methodUsed?: string } {
  const m = method ? RAZORPAY_METHOD_USED[method] : undefined;
  return m ? { methodUsed: m } : {};
}

/**
 * A payment RazorPay returned to the payer without capturing it (`refunded` with
 * `captured: false`). No money was ever ours; the payer can be debited again.
 */
const UNCAPTURED_RETURNED_FAILURE = {
  code: "charge_failed",
  message: "The payment was not captured. Razorpay returned the money to the payer.",
  retriable: true,
} as const;

/** RazorPay's documented `notes` limits: 15 pairs, 256 characters each. */
const RAZORPAY_NOTES_MAX_PAIRS = 15;
const RAZORPAY_NOTE_MAX_CHARS = 256;

/**
 * Caller notes cut to fit beside `reserved` pairs of our own, so a long description or a
 * large metadata bag cannot make RazorPay refuse the order. Values are truncated; pairs past
 * the limit are dropped, first come first kept.
 */
function boundedCallerNotes(
  notes: Record<string, string>,
  reserved: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  const room = RAZORPAY_NOTES_MAX_PAIRS - reserved;
  const entries = Object.entries(notes).filter(([k]) => k.length <= RAZORPAY_NOTE_MAX_CHARS);
  for (const [k, v] of entries.slice(0, room)) {
    out[k] = String(v).slice(0, RAZORPAY_NOTE_MAX_CHARS);
  }
  if (entries.length > room) {
    log.warn("razorpay notes over the limit were dropped", {
      event: "razorpay_notes_truncated",
      kept: room,
      dropped: entries.length - room,
    });
  }
  return out;
}

/** RazorPay's refund lifecycle is `pending → processed | failed`; only `processed` is settled. */
function refundStatusOf(status: string | undefined): RefundResult["status"] {
  if (status === "processed") return "succeeded";
  if (status === "failed") return "failed";
  return "pending";
}

/** A RazorPay token entity, as returned by `GET /customers/:id/tokens/:token`. */
export interface RazorpayToken {
  id: string;
  method?: string;
  recurring?: boolean;
  recurring_details?: { status?: string };
  bank?: string | null;
  wallet?: string | null;
  vpa?: { username?: string; handle?: string; name?: string } | null;
  /**
   * Verified against RazorPay's Tokens API field table (2026-09-12), not inferred:
   * https://razorpay.com/docs/api/payments/recurring-payments/cards/tokens
   */
  card?: {
    last4?: string;
    network?: string;
    /** 4-character issuing-bank code ("FDRL"). Documented as UNSET for a foreign bank. */
    issuer?: string;
    /** `credit` | `debit` | `prepaid` | `unknown`. */
    type?: string;
    /**
     * ⚠️ "Card usage restriction — supports international transactions". A CAPABILITY,
     * not where the card was issued. Reading it as origin is the mistake this comment
     * exists to stop.
     */
    international?: boolean;
    /** `consumer` | `business` — their docs say `customer`, their samples say `consumer`. */
    sub_type?: string;
    /** `flows.recurring` is whether this card can do recurring at all. */
    flows?: { otp?: boolean; recurring?: boolean } | null;
    expiry_month?: number;
    expiry_year?: number;
  } | null;
  /**
   * Mandate fields — present on a RECURRING token, absent on a plain saved card.
   * `max_amount` is the per-debit ceiling RazorPay enforces (paise); `expired_at`
   * is a UNIX seconds timestamp.
   */
  max_amount?: number | null;
  expired_at?: number | null;
}

/**
 * The mandate a RazorPay token was actually registered under.
 *
 * Read from the token entity rather than echoed from `createMandateOrder`'s input,
 * because the two can legitimately differ: `createMandateOrder` clamps the
 * requested ceiling to `MAX_UPI_MANDATE_MAX_AMOUNT` / `MAX_MANDATE_MAX_AMOUNT`
 * before sending it, and the buyer's bank can register a lower one still. The
 * number the engine must respect at debit time is RazorPay's, not ours.
 *
 * Returns undefined for a non-recurring token — a mandate that does not exist must
 * not be represented as one with unknown fields.
 */
/**
 * The event names RazorPay refused, pulled out of its own error text.
 *
 * Measured shape: `Invalid event name/names: token.resumed, token.updated`. Parsed rather than
 * guessed, and deliberately narrow — it only matches that phrasing, so an unrelated 400 falls
 * through to a real error instead of being quietly retried with a shorter list.
 */
export function parseInvalidEventNames(description: string | undefined): string[] {
  if (!description) return [];
  // `name`, `names`, and the measured `name/names` — RazorPay is not consistent about it.
  const m = /invalid event names?(?:\/names)?\s*:\s*(.+)$/i.exec(description.trim());
  if (!m?.[1]) return [];
  return m[1]
    .split(",")
    .map((n) => n.trim().replace(/[.\s]+$/, ""))
    .filter((n) => /^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(n));
}

/**
 * Refuse an e-mandate auth link that was not created for THIS customer.
 *
 * ── The hole this closes ─────────────────────────────────────────────────────
 * `vaultPaymentMethod` accepts three token shapes, and TWO of them were already
 * guarded: `token_…` and `pay_…` are read through `GET /customers/{ours}/tokens/{id}`,
 * so another customer's token 404s. The `inv_…` shape was not. It takes the customer
 * FROM THE LINK (`authLinkOutcome`) and then adopts it as `scopedCustomerId`, so the
 * customer-scoped token read that guards the other two shapes was, on this path,
 * scoped to whatever the attacker's link said. Possessing another buyer's `inv_…` id
 * was enough to vault their netbanking mandate into your own account.
 *
 * That id is not public, but it is not a secret either: it is the auth link, it is
 * handed to a browser, and `POST /portal/v1/payment_methods { token }` will take it
 * from anyone.
 *
 * ── The binding, and why there are two of them ───────────────────────────────
 * `createEmandateAuthLink` stamps the invoice with `notes.tmbilling_ref` (authoritative,
 * up to 256 characters) and a `receipt` that starts with `emandate_<ourCustomerId>_` (a fallback,
 * and the one that existed before this guard). Either proves the link is ours.
 *
 * ⚠️ The receipt fallback is only usable when it was NOT hashed: `boundedProviderKey`
 * compresses anything over 40 characters to `tm_<sha256-prefix>`, which is
 * unrecoverable. `emandate_` + a 19-char `cust_…` + `_` + a 10-digit epoch is 39, so
 * today it survives — but that is one character of headroom, which is exactly why the
 * `notes` copy exists and is checked first.
 *
 * Fails CLOSED: a link carrying NEITHER binding is refused. A guard that admits
 * unbound links is not a guard, since an attacker's link would simply be one we did
 * not mint. Nothing is live, so there are no pre-existing unbound links to strand.
 *
 * MEASURED against RazorPay test mode 2026-08-30: a `subscription_registration/auth_links`
 * created with `notes: { tmbilling_ref: … }` and the receipt above came back 200, and
 * `GET /invoices/{id}` echoed BOTH fields verbatim. The same read returned
 * a `customer_id` — a customer RazorPay minted, not the one we
 * named — which is the whole reason this guard cannot lean on `customer_id`.
 */
export function assertAuthLinkBelongsTo(
  invoiceId: string,
  invoice: { receipt?: string | null; notes?: Record<string, string> | null },
  expectedCustomerId: string,
): void {
  if (invoice.notes?.tmbilling_ref === expectedCustomerId) return;
  if (invoice.receipt?.startsWith(`emandate_${expectedCustomerId}_`)) return;
  throw new Error(
    `RazorPay e-mandate auth link ${invoiceId} was not created for this customer` +
      ". We refuse to vault a mandate that someone else authorized.",
  );
}

/**
 * The `receipt` an e-mandate auth link is created with. Names the customer WE minted
 * it for, so the link carries an ownership trace even though RazorPay replaces the
 * customer on it. Built here rather than inline so `assertAuthLinkBelongsTo` checks
 * the same string this writes — the guard and the stamp cannot drift.
 */
export function emandateReceipt(providerCustomerId: string, epochSec: number): string {
  return `emandate_${providerCustomerId}_${epochSec}`;
}

/**
 * RazorPay's mandate words onto ours. `cancellation_initiated` (a cancel in progress) and
 * `expired` are both mandates that will take no further debit, so they read as `cancelled`
 * — left as-is they fell to `unknown`, which does not stop collection.
 */
export function normaliseRazorpayMandateStatus(status: string): string {
  const s = status.trim().toLowerCase();
  return s === "cancellation_initiated" || s === "expired" ? "cancelled" : s;
}

/**
 * Exported for `scripts/backfill-payment-method-mandates.ts`, which recovers the mandate
 * of an ALREADY-VAULTED token from the gateway. It must use this mapping and not its own:
 * two mappings are two chances for the ceiling a backfill writes and the ceiling a vault
 * writes to disagree about the same token, and that column decides whether the engine
 * will attempt a debit at all.
 */
export function describeRazorpayMandate(
  tok: RazorpayToken,
  /** The currency of the payment that registered the mandate, where the caller read it. */
  registeredIn?: string | null,
): ProviderMandate | undefined {
  if (!tok.recurring && !tok.max_amount && !tok.recurring_details?.status) return undefined;
  // The token does not denominate its ceiling. UPI Autopay and netbanking are NPCI domestic
  // rails, so INR. A card mandate registers in its order's currency (USD/EUR too, see
  // `createMandateOrder`), which only the registration payment says: unknown, it stays unset.
  const currency = tok.method === "card" ? registeredIn?.toUpperCase() : "INR";
  return {
    ...(tok.max_amount ? { maxAmountMinor: BigInt(tok.max_amount) } : {}),
    ...(tok.max_amount && currency ? { currency } : {}),
    ...(tok.method ? { rail: tok.method } : {}),
    ...(tok.recurring_details?.status
      ? { status: normaliseRazorpayMandateStatus(tok.recurring_details.status) }
      : {}),
    ...(tok.expired_at ? { expiresAt: new Date(tok.expired_at * 1000) } : {}),
    reference: tok.id,
  };
}

/**
 * Describe a RazorPay token in our display vocabulary.
 *
 * RazorPay vaults several instrument families behind one opaque `token_…` id, so
 * the token entity is the only thing that says what was actually mandated. The
 * previous behavior hardcoded `type: 'card'` with an empty display, which stored a
 * UPI Autopay mandate as a card with no last4 and then mis-routed it (Smart Routing
 * matches on `method_types`) — the same class of bug as the Stripe non-card vault.
 *
 * Non-card families have no last4/expiry, so their human identity goes in `brand`:
 * the VPA for UPI, the bank for e-mandate/NACH, the wallet name for wallets. This
 * mirrors `describeStripePaymentMethod`, which puts a bank name in `brand` too.
 */
function describeRazorpayToken(tok: RazorpayToken): ProviderPaymentMethodRef["display"] {
  switch (tok.method) {
    case "upi": {
      const vpa =
        tok.vpa?.username && tok.vpa?.handle ? `${tok.vpa.username}@${tok.vpa.handle}` : undefined;
      return { type: "upi", ...(vpa ? { brand: vpa } : {}) };
    }
    case "emandate":
    case "nach":
      return { type: "bank_transfer", ...(tok.bank ? { brand: tok.bank } : {}) };
    case "wallet":
      return { type: "wallet", ...(tok.wallet ? { brand: tok.wallet } : {}) };
    case "card":
      return {
        type: "card",
        ...(tok.card?.network ? { brand: tok.card.network } : {}),
        ...(tok.card?.last4 ? { last4: tok.card.last4 } : {}),
        ...(tok.card?.expiry_month ? { expMonth: tok.card.expiry_month } : {}),
        ...(tok.card?.expiry_year ? { expYear: tok.card.expiry_year } : {}),
        // The rest of what the token already carried and we dropped on the floor.
        // ⚠️ `international` is NOT mapped to `issuerCountry`: RazorPay documents it as a
        // usage restriction, not an origin, so it rides its own field. RazorPay never
        // names the issuing country, which is why `issuerCountry` stays Stripe-only and
        // why the AFA gate treats its absence as UNKNOWN rather than "foreign".
        ...(tok.card?.type ? { instrumentFunding: tok.card.type } : {}),
        ...(tok.card?.issuer ? { issuerName: tok.card.issuer } : {}),
        ...(tok.card?.sub_type ? { instrumentSubType: tok.card.sub_type } : {}),
        ...(typeof tok.card?.international === "boolean"
          ? { supportsInternational: tok.card.international }
          : {}),
        ...(typeof tok.card?.flows?.recurring === "boolean"
          ? { supportsRecurring: tok.card.flows.recurring }
          : {}),
      };
    default:
      // Some other RazorPay instrument. Don't lie "card" (that breaks routing) —
      // classify as a wallet and keep RazorPay's own method name visible.
      return { type: "wallet", ...(tok.method ? { brand: tok.method } : {}) };
  }
}

/**
 * RazorPay adapter. Only moves money + references vaulted tokens (BLUEPRINT
 * ADR-001) — the engine owns subscription state.
 *
 * Off-session (recurring) charging needs a token from a prior authenticated
 * mandate, so `vaultPaymentMethod` takes that token id. OAuth-less Basic auth +
 * orders/refund/webhook are server-side. Amounts are integer minor units (paise) —
 * RazorPay's native unit, no conversion.
 *
 * ## Mandate rails (which one you get, and what it costs)
 *  - **UPI Autopay** (`methodTypes: ['upi']`) — the buyer approves a collect request
 *    in their UPI app. Registration is scriptable end-to-end against the sandbox via
 *    `initiateUpiAutopayCollect` + the `success@razorpay` test VPA, which is what
 *    makes `verify:razorpay-live` headless. Debits are **asynchronous**: the charge
 *    returns `pending` and the terminal outcome arrives as a `payment.captured` /
 *    `payment.failed` webhook minutes-to-hours later, so this rail REQUIRES the
 *    inbound webhook path to be wired or payments sit pending forever.
 *  - **e-mandate** (`methodTypes: ['bank_transfer']`) — netbanking mandate. The ONLY
 *    rail that does not use Checkout: it registers through a hosted
 *    **subscription-registration auth link** (`createEmandateAuthLink`), because
 *    `checkout/embedded` offers no methods for e-mandate at all. Proven off-session
 *    2026-08-13, and the only rail with no ₹15,000 authentication ceiling — it took
 *    ₹28,215 and ₹56,715 in ~20s where the card rail leaves both uncaptured.
 *
 * There is **no default**: an INR mandate with no rail pinned is refused, because
 * the three differ in settlement lag and buyer authorization and the wrong guess
 * only surfaces at the first renewal. See `selectRail`.
 *  - **card recurring** (`methodTypes: ['card']`) — requires RazorPay to enable
 *    recurring-payments-on-cards per merchant. Without it a card token mints with
 *    `recurring: false` and the off-session charge is refused with "the seller does
 *    not support recurring payments". See the gateway README for the operator ask.
 *
 * **NPCI pre-debit notification.** For UPI Autopay, RazorPay sends the notice to the
 * payer itself and, by default, debits about 25 hours after the notice is delivered
 * (UPI recurring docs, "Create subsequent payments"). That is why a UPI debit stays
 * `pending` for a day; the engine sends no notice of its own.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly key = "razorpay" as const;
  readonly capabilities: ProviderCapabilities = {
    refunds: true,
    partialRefunds: true,
    // Not "card": a card mandate registers in the order's currency, which older rows hold as INR.
    mandateCurrencyAuthoritative: ["upi", "bank_transfer"],
    // Empty = "whatever the account is configured for", same as Stripe/PayPal.
    // This used to say ['INR'], which was wrong about RazorPay and misleading
    // about us: currency support is **per rail**, not per gateway.
    //   - UPI Autopay + Netbanking e-mandate → INR only, because they are NPCI
    //     domestic rails: the payer is an Indian bank customer and presentment and
    //     settlement are both INR.
    //     ⚠️ RazorPay used to enforce this for us ("Currency is not supported",
    //     verified live 2026-07-27) but **stopped**: measured 2026-08-01 it ACCEPTS a
    //     USD/EUR debit on a UPI mandate and returns `pending`. `charge()` therefore
    //     refuses it locally — see the guard at the top of that method.
    //   - Cards → international. With International Payments / an export account
    //     enabled, RazorPay accepts 100+ currencies incl. USD/EUR/GBP and
    //     settles in INR (or to an EEFC account in the original currency).
    // Nothing reads this field for routing — `selectGatewayAccount` filters on
    // the gateway_account row's own `currencies`/`method_types` columns — so the
    // operator declares per-account reality and this stays documentation.
    currencies: [],
    // `upi` here means UPI Autopay (an off-session mandate), not a one-tap
    // collect — and it settles asynchronously, like Stripe's bank debits.
    methods: ["card", "upi", "wallet", "bank_transfer"],
    intents: true,
    // Both halves are real here. `setup` is the mandate-registration order
    // `initiateVaultSetup` has always created (a RazorPay mandate IS a setup intent —
    // an authorization whose product is a vaulted token, not money); `payment` is an
    // order created with manual capture, authorized by the buyer in Checkout and
    // captured by `consumeIntent`.
    intentPurposes: ["payment", "setup"],
    // ⚠️ RazorPay has NO true void. An authorized payment is either captured or left
    // to lapse — the merchant API exposes no release/cancel call for it — and faking
    // one with a refund would post real money movement for a payment that never
    // settled (a refund row, a ledger entry and a statement line for cash that was
    // only ever held). So `voidIntent` is deliberately NOT implemented, and this flag
    // is what the UI reads to hide the control rather than offering a button that
    // cannot work.
    intentVoid: false,
    // ⚠️ …but it CAN be asked. The two flags are opposites here on purpose, and the
    // pairing is the whole point of defect #15: because there is no void, a hold we
    // lose track of cannot be undone, which makes *knowing about it* the only lever
    // left. `GET /orders/{id}/payments` answers it — see `fetchIntent`.
    intentStatus: true,
    // Every rail here registers under a ceiling and RazorPay reports it back as
    // `token.max_amount` (see `describeRazorpayMandate`), so a NULL ceiling on a
    // RazorPay instrument means UNKNOWN — worth investigating — and never "this
    // gateway does not do mandates". Contrast `paypal.ts`, which declares `false`.
    mandates: true,
  };

  /** RazorPay's test VPA that auto-approves a collect request (test mode only). */
  static readonly TEST_SUCCESS_VPA = "success@razorpay";

  /**
   * Auth amount for a UPI Autopay mandate, in paise. UPI Autopay registration must
   * carry a non-zero amount (unlike e-mandate, which registers at 0), and RazorPay
   * rejects anything under ₹1 with "Order amount less than minimum amount allowed" —
   * so this is the smallest mandate RazorPay will accept, not a token 1 paise.
   */
  private static readonly UPI_MANDATE_AUTH_AMOUNT = 100;

  /**
   * Auth amount for a CARD mandate, in paise. Same ₹1 floor and same reason as
   * UPI: a card mandate order is rejected at 0 with "Order amount less than
   * minimum amount allowed" (only e-mandate registers at 0).
   */
  private static readonly CARD_MANDATE_AUTH_AMOUNT = 100;

  /**
   * Both auth amounts are CAPTURED, so the engine refunds them once the instrument is
   * vaulted (`setupAuthCharge` → `refund_setup_auth` job).
   *
   * Captured because `payment_capture` on the order overrides the account's capture
   * setting (razorpay.com/docs/payments/payments/capture-settings/), and RazorPay's
   * recurring guides say the token "is generated after the authorisation transaction is
   * successfully captured" (razorpay.com/docs/payments/recurring-payments/cards/integrate/
   * and .../upi/integrate/, read 2026-10-29). An uncaptured auth would be auto-refunded
   * after 3 days (razorpay.com/docs/payments/payments/), but no recurring guide documents
   * that flow, so we keep the documented capture and give the money back ourselves.
   * Measured in test mode 2026-10-29: a UPI token stays debitable after its auth is refunded.
   */
  private static readonly SETUP_AUTH_AMOUNTS: ReadonlySet<number> = new Set([
    RazorpayProvider.UPI_MANDATE_AUTH_AMOUNT,
    RazorpayProvider.CARD_MANDATE_AUTH_AMOUNT,
  ]);

  /**
   * Fallback per-debit ceiling when the caller doesn't supply one, in minor units
   * (₹10,000 / $10,000 — the number is currency-blind, so its *meaning* differs by
   * rail; always pass `maxAmountMinor` derived from the real plan price).
   *
   * Note for INR: RBI's card e-mandate framework only allows auto-debit without
   * re-authentication up to ₹15,000; above that every debit needs AFA and is no
   * longer off-session. So an INR mandate ceiling above ₹15,000 buys nothing.
   */
  private static readonly DEFAULT_MANDATE_MAX_AMOUNT = 1_000_000n;

  /**
   * Upper ceiling limit allowed by RazorPay API for mandate max_amount (100,000,000 paise = ₹1,000,000).
   * Exceeding this value causes RazorPay order creation to fail with:
   * "400 The max amount may not be greater than 100000000."
   */
  private static readonly MAX_MANDATE_MAX_AMOUNT = 100_000_000n;

  /**
   * Upper ceiling limit allowed by NPCI & RazorPay for UPI Autopay mandate max_amount (10,000,000 paise = ₹100,000).
   * Exceeding this value causes RazorPay UPI order creation to fail with:
   * "400 Max amount for UPI recurring payment for this merchant category code cannot be greater than Rs. 100000.00"
   */
  private static readonly MAX_UPI_MANDATE_MAX_AMOUNT = 10_000_000n;

  private cfg: RazorpayConfig;

  constructor(cfg: RazorpayConfig) {
    this.cfg = cfg;
  }

  private authHeader(): string {
    return "Basic " + Buffer.from(`${this.cfg.keyId}:${this.cfg.keySecret}`).toString("base64");
  }

  private async api<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }> {
    const res = await providerFetch({
      gatewayKey: this.key,
      operation,
      method,
      url: `${this.cfg.apiBase}${path}`,
      headers: { Authorization: this.authHeader(), "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (res.text ? JSON.parse(res.text) : {}) as T };
  }

  /**
   * `api`, but a lost answer is data: a transport failure, a timeout or a body that is not
   * JSON comes back as `{ lost }` instead of a throw. Only the calls that move money need
   * to tell "refused" from "we do not know".
   */
  private async tryApi<T>(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T; lost?: undefined } | { lost: string }> {
    try {
      return await this.api<T>(operation, method, path, body);
    } catch (e) {
      return { lost: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Live connectivity check used by verification — proves the keys work.
   *  Returns the contract-v2 `{ ok, detail }` plus provider-specific extras. */
  async healthCheck(): Promise<{
    ok: boolean;
    detail?: string;
    authenticated: boolean;
    orderId?: string;
    orderStatus?: string;
  }> {
    const { status, json } = await this.api<{ id: string; status: string; error?: unknown }>(
      "health_check",
      "POST",
      "/orders",
      {
        amount: 50000,
        currency: "INR",
        receipt: RAZORPAY_HEALTHCHECK_REF,
        // Tagged like every other order we create: an operator (or the classifier)
        // must not have to guess whether a stray unpaid order is a probe of ours or
        // a sibling product's.
        notes: ownershipNotes(RAZORPAY_HEALTHCHECK_REF),
      },
    );
    if (status >= 300)
      throw new Error(`RazorPay auth/order failed: ${status} ${JSON.stringify(json)}`);
    return {
      ok: true,
      detail: `order ${json.id} ${json.status}`,
      authenticated: true,
      orderId: json.id,
      orderStatus: json.status,
    };
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<ProviderCustomerRef> {
    const res = await this.tryApi<{ id: string; error?: { description?: string } }>(
      "ensure_customer",
      "POST",
      "/customers",
      {
        name: input.name ?? input.customerRef,
        email: input.email,
        // RazorPay requires a contact (phone) for recurring/e-mandate customers.
        ...(input.phone ? { contact: input.phone } : {}),
        // "Return the existing customer instead of erroring" — and it MUST be the
        // STRING '0'. A numeric 0 is silently ignored and the call 400s with
        // "Customer already exists for the merchant" (verified live 2026-07-27),
        // which made this method non-idempotent: a customer RazorPay already knew
        // (re-seeded DB, second business, migration re-import, retry after a partial
        // failure) blew up the vault instead of reusing the mapping.
        //
        // ⚠️ It reuses LESS than that phrasing suggests. RazorPay's "already exists"
        // key is the **(email, contact) pair**, not the email — measured live in test
        // mode 2026-08-30, on POST and on PUT alike:
        //   - same email + same contact → the SAME cust_ id back (name is ignored for
        //     matching, and is NOT updated on the returned record);
        //   - same email + a DIFFERENT contact → a brand-new cust_ id, 200, no warning;
        //   - same email + NO contact → a brand-new cust_ id (absent ≠ any contact);
        //   - a different email + the same contact → a brand-new cust_ id.
        // So this is idempotent for a REPLAYED identical identity, which is the case
        // that matters here, and NOT a general "find the customer by email".
        //
        // We deliberately do not look one up first. There is nothing to look up with:
        // `GET /customers?email=…` and `?contact=…` are silently IGNORED (measured —
        // both return the same unfiltered reverse-chronological page), so a lookup
        // means paging the merchant's entire customer list on the hot path of every
        // first vault, and still racing. Minting a spare customer is the cheaper
        // failure than binding to the wrong one.
        //
        // The blast radius is small because `ensureProviderCustomer` only reaches this
        // method when there is NO `provider_customers` row for (customer × provider ×
        // gateway account); the mapping pins the id forever after. A spare is minted
        // only when that mapping is LOST (DB reseed, re-import) or a second gateway
        // account is added — and note that after a mapping loss a changed phone means a
        // NEW customer, orphaning any token vaulted against the old one.
        fail_existing: "0",
        /**
         * Ownership tag (#31), stamped at CREATE because it cannot be repaired later:
         * `PUT /customers/{id}` silently IGNORES `notes` (measured — see
         * `updateCustomer`), which also means the binding cannot be forged through the
         * edit endpoint. No webhook is ever about a customer, so nothing depends on
         * this; it is here so that no object we create at RazorPay is anonymous.
         */
        notes: ownershipNotes(input.customerRef),
      },
    );
    // A lost answer or a 408/409/429/5xx is unknown, never a refusal; any other 4xx
    // (bad keys, a field RazorPay refuses) is.
    if (res.lost !== undefined)
      throw new ProviderIndeterminateError(
        `We could not confirm the customer at RazorPay. ${res.lost}`,
      );
    const { status, json } = res;
    if (status >= 300) {
      const why = json.error?.description ?? `RazorPay answered HTTP ${status}`;
      const message = `We could not create the customer at RazorPay. ${why}`;
      if (classifyGatewayHttp({ status }).kind === "definite")
        throw new ProviderRefusalError(message);
      throw new ProviderIndeterminateError(message);
    }
    return { providerKey: this.key, providerCustomerId: json.id };
  }

  /**
   * Push our current identity onto an EXISTING RazorPay customer.
   *
   * ── Why this is not cosmetic on RazorPay ─────────────────────────────────────
   * `createEmandateAuthLink` reads `contact` off **RazorPay's** customer record, not
   * off our input, and refuses without one ("The contact field is required for
   * recurring links"). `charge()` falls back to the same record. So a customer whose
   * RazorPay mirror was minted BEFORE we had a phone was permanently unable to
   * register a mandate: adding the phone in our portal satisfied
   * `assertVaultPreconditions` locally and changed nothing at the gateway, and the
   * buyer stayed blocked by an error naming a fix they had already applied. Without
   * this method `ensureProviderCustomer`'s `updateCustomer?.()` optional-chained the
   * repair away on every single reuse.
   *
   * ── What RazorPay actually allows (measured live, test mode, 2026-08-30) ──────
   *  - The verb is **PUT**, not PATCH. Every `PATCH /customers/{id}` — valid id,
   *    bogus id, empty body alike — answers `404 {"message":"no Route matched with
   *    those values"}`. There is no PATCH route to fall back to.
   *  - `PUT` accepts `name`, `email`, `contact`, `gstin`. It **silently ignores**
   *    `notes` and `shipping_address` (both read back unchanged as `[]`) and any
   *    unknown key — no error, no effect. So nothing here may rely on `notes`, and
   *    in particular the ownership binding stamped at CREATE time cannot be repaired
   *    or forged through this endpoint.
   *  - An empty body is a `200` no-op; an unknown id is `400 "The id provided does
   *    not exist"`.
   *  - ⚠️ `contact: ""` is ACCEPTED and BLANKS the contact — which would re-break the
   *    exact mandate this method exists to unblock. Hence every field is sent only
   *    when non-empty; do not "simplify" the spread away.
   *
   * ── The refusal, and why it is retried ───────────────────────────────────────
   * The duplicate check is on the **resulting (email, contact) pair** — not on email
   * alone, and not on contact alone. Re-measured live in test mode 2026-08-30, which
   * corrects what this comment used to claim ("the check is on email"): that earlier
   * reading came from PUT-ing a full name+email+contact body, where the contact
   * matched too, so the PAIR was what actually collided.
   *   - PUT `{email, contact}` equal to another customer's pair → `400 "Customer
   *     already exists for the merchant"`.
   *   - PUT `{email}` alone to an email another customer holds → `200`, when the
   *     resulting pair (that new email + OUR unchanged contact) belongs to nobody.
   *   - PUT `{contact}` alone to a contact another customer holds → `200`, same reason.
   * `POST /customers` keys on the same pair; see `ensureCustomer`.
   *
   * That matters because a single PUT carries name+email+contact, so a contested pair
   * would take the CONTACT down with it — losing the one field the mandate actually
   * needs. So on any refusal we retry with the contact alone: that leaves the email
   * untouched, which drops the half of the pair most likely to have caused the
   * collision. It is a much smaller target, NOT a guaranteed-collision-free one — it
   * still 400s if some other customer happens to hold exactly (our email, that
   * contact) — and a failed retry is logged, never thrown, like every other outcome.
   *
   * ── Non-fatal, always ────────────────────────────────────────────────────────
   * `ensureProviderCustomer` runs on the hot path of every vault AND every charge.
   * A failed identity sync must never become a failed payment, so this returns void
   * on every outcome and only logs. The full request/response is already in
   * `gateway_request_logs` via `providerFetch` (Gateway Activity), so nothing is
   * lost by not throwing. If the contact genuinely never lands, the caller that
   * needs it — `createEmandateAuthLink` — refuses on its own fresh read, which is
   * the right place for that error and the only one that can tell.
   *
   * Note this RENAMES a customer in someone else's system when our billing contact
   * has changed, exactly as the Stripe adapter's `updateCustomer` does and for the
   * same reason: the gateway identity and the document the payment settles must not
   * disagree.
   */
  async updateCustomer(ref: ProviderCustomerRef, input: EnsureCustomerInput): Promise<void> {
    // Only non-empty values. `contact: ""` would blank a working contact (measured),
    // and `name: ""` / `email: ""` are no better.
    const body: Record<string, string> = {};
    if (input.name) body.name = input.name;
    if (input.email) body.email = input.email;
    if (input.phone) body.contact = input.phone;
    if (Object.keys(body).length === 0) return;

    const first = await this.api<{ id?: string; error?: { description?: string } }>(
      "update_customer",
      "PUT",
      `/customers/${ref.providerCustomerId}`,
      body,
    );
    if (first.status < 300) return;

    // The refusal is almost always a contested email. Salvage the contact — it is the
    // field a mandate cannot be registered without, and it does not collide.
    if (body.contact && (body.name || body.email)) {
      const retry = await this.api<{ id?: string; error?: { description?: string } }>(
        "update_customer",
        "PUT",
        `/customers/${ref.providerCustomerId}`,
        { contact: body.contact },
      );
      if (retry.status < 300) {
        log.warn("razorpay refused the full customer sync — contact-only retry succeeded", {
          customer: ref.providerCustomerId,
          status: first.status,
          reason: first.json?.error?.description ?? "",
        });
        return;
      }
      log.warn("razorpay refused the customer sync, contact-only retry included", {
        customer: ref.providerCustomerId,
        status: retry.status,
        reason: retry.json?.error?.description ?? JSON.stringify(retry.json),
      });
      return;
    }
    log.warn("razorpay refused the customer sync", {
      customer: ref.providerCustomerId,
      status: first.status,
      reason: first.json?.error?.description ?? JSON.stringify(first.json),
    });
  }

  /**
   * Create the mandate-registration ("auth") order. The buyer then authorizes it —
   * in a UPI app for Autopay, or in RazorPay's embedded Checkout for e-mandate —
   * which mints the reusable token that `/payments/create/recurring` charges.
   *
   * `amount` differs per rail: e-mandate registers at 0 (a pure mandate), while UPI
   * Autopay requires a non-zero auth amount — see UPI_MANDATE_AUTH_AMOUNT.
   * Mandate validity: ~10 years out (RazorPay caps emandate expiry at 40 years).
   */
  private async createMandateOrder(
    customerId: string,
    rail: "upi" | "emandate" | "card",
    opts: {
      currency?: string;
      maxAmountMinor?: bigint;
      /**
       * OUR id for the thing being registered (#31). Defaults to the provider customer
       * id — which is what `createEmandateAuthLink` has always stamped. Never left unset:
       * an untagged order is what makes the classifier unsound.
       *
       * `initiateVaultSetup` now forwards `InitiateVaultSetupInput.ownershipRef` (the
       * `cus_…` the attempt is for), so the customer-id default is reached only by a
       * caller that passes none.
       */
      ownershipRef?: string;
    } = {},
  ): Promise<{ id: string }> {
    const expireAt = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 3600;
    const currency = (opts.currency ?? "INR").toUpperCase();

    // Domestic rails are INR-only and RazorPay says so outright ("The currency
    // should be INR when method is upi"). Fail loudly rather than quietly
    // registering an INR mandate for, say, a USD subscription — that would look
    // fine until the first renewal tried to debit USD against an INR mandate.
    if (rail !== "card" && currency !== "INR") {
      throw new Error(
        `RazorPay ${rail} mandates are INR-only because they use a domestic rail. ${currency} needs the card rail. ` +
          'Set methodTypes: ["card"] for a non-INR subscription.',
      );
    }
    // Every mandate needs a per-debit ceiling. Defaulting it is what made this a
    // hidden cap: a plan priced above the default registers fine and then fails
    // every renewal, because the debit exceeds the mandate.
    const requestedMaxAmount = opts.maxAmountMinor ?? RazorpayProvider.DEFAULT_MANDATE_MAX_AMOUNT;
    const maxAmountCap =
      rail === "upi"
        ? RazorpayProvider.MAX_UPI_MANDATE_MAX_AMOUNT
        : RazorpayProvider.MAX_MANDATE_MAX_AMOUNT;
    // ⚠️ Clamping to the rail cap is CORRECT HERE — the refusal belongs upstream.
    //
    // Tempting to throw instead, because a clamp is what let a ₹5,61,180 UPI mandate
    // register at ₹1,00,000 and then fail its renewals (measured 2026-08-19). But
    // refusing here breaks the case that WORKS: `deriveMandateCeiling` asks for the next
    // renewal's tax-inclusive total plus `MANDATE_HEADROOM_BPS`, which can exceed this cap
    // while the debit it has to carry sits well under it. Clamping to ₹1,00,000 serves
    // that subscription perfectly; refusing would deny a UPI mandate to plans the rail can
    // actually collect for.
    //
    // The band where that happens narrowed sharply on 2026-08-27, when the headroom went
    // from ×3 on a PRE-tax price to 25% on the tax-inclusive total: a ₹56,118/month plan
    // used to ask for ₹1,68,354 (clamped, and the buyer saw the ₹1,00,000) and now asks for
    // ₹82,774 (₹66,219 with 18% GST, plus 25%) — registered as asked. On 18% GST the clamp
    // now starts biting around ₹67,800/month rather than ₹28,250.
    //
    // The cap is simply the best ceiling this rail can carry, so taking it is right. What
    // must not happen is a debit ABOVE the clamped ceiling reaching the gateway, and that
    // is already prevented downstream rather than here: `vaultPaymentMethod` persists the
    // ceiling read off the TOKEN (the clamped value RazorPay actually holds, not what we
    // asked for), and `mandateRefusal` in invoicing/collection.ts compares every debit to
    // it and parks with `mandate_ceiling_exceeded` — non-retriable, with a message naming
    // the ceiling — without calling the gateway at all.
    //
    // ⚠️ So the clamp fails SAFELY through the engine. `verify:razorpay-pro-amounts` sees
    // the raw `order_failed` from RazorPay only because it calls `adapter.charge()`
    // directly and bypasses that guard. What the clamp still costs is TIMING: a business
    // whose plan outgrows the rail cap finds out at the first renewal (a parked invoice)
    // instead of at registration. Telling them at signup needs the plan price, which this
    // function does not have — see PROGRESS.md 2026-08-19 for the open item.
    const maxAmount = Number(requestedMaxAmount > maxAmountCap ? maxAmountCap : requestedMaxAmount);

    const body =
      rail === "upi"
        ? {
            amount: RazorpayProvider.UPI_MANDATE_AUTH_AMOUNT,
            currency: "INR",
            method: "upi",
            customer_id: customerId,
            // Captured, then refunded by the engine — see SETUP_AUTH_AMOUNTS.
            payment_capture: true,
            token: { max_amount: maxAmount, expire_at: expireAt, frequency: "monthly" },
          }
        : rail === "card"
          ? {
              // A card mandate registers against a real auth amount — RazorPay rejects
              // 0 here with "Order amount less than minimum amount allowed" (unlike
              // e-mandate, which does register at 0), so this is the 100-minor-unit
              // floor (₹1 / $1 / €1). No `auth_type`: RazorPay answers "The selected
              // auth type is invalid" for `3ds`, it infers the authentication itself.
              amount: RazorpayProvider.CARD_MANDATE_AUTH_AMOUNT,
              // Cards are RazorPay's international rail — a card mandate order is
              // accepted in USD/EUR (verified live 2026-07-27), so the mandate is
              // registered in the currency the subscription will be charged in.
              currency,
              method: "card",
              customer_id: customerId,
              // Captured, then refunded by the engine — see SETUP_AUTH_AMOUNTS.
              payment_capture: true,
              token: { max_amount: maxAmount, expire_at: expireAt, frequency: "monthly" },
            }
          : {
              amount: 0,
              currency: "INR",
              method: "emandate",
              customer_id: customerId,
              payment_capture: true,
              token: { auth_type: "netbanking", max_amount: maxAmount, expire_at: expireAt },
            };
    const { status, json } = await this.api<{ id: string; error?: { description?: string } }>(
      "vault",
      "POST",
      "/orders",
      // The ownership tag rides alongside every rail's body shape rather than inside
      // each of the three, so a fourth rail cannot be added without it.
      {
        ...body,
        notes: {
          ...ownershipNotes(opts.ownershipRef ?? customerId),
          [TMBILLING_SETUP_ORDER_NOTE]: "1",
        },
      },
    );
    if (status >= 300) {
      throw new Error(
        `RazorPay ${rail} auth-order failed: ${status} ${json?.error?.description ?? JSON.stringify(json)}`,
      );
    }
    return json;
  }

  /**
   * Pick the rail an authorization should ride, and refuse the combinations RazorPay
   * cannot honour.
   *
   * Which rail the business asked for is load-bearing: each has its OWN order shape,
   * and picking the wrong one mandates the wrong instrument. This used to send
   * anything that wasn't `upi` down the netbanking e-mandate branch, so a business
   * asking for `card` got a bank mandate — the buyer was shown a netbanking screen and
   * the vaulted token was a bank token, not a card.
   *
   * ⚠️ **One copy on purpose.** `initiateVaultSetup` and `createIntent` both authorize
   * a buyer at RazorPay and both must obey the guards below; a second copy for the
   * newer intent path is exactly how the silent-wrong-instrument bug would come back,
   * on the path with less operational mileage. Every caller comes through here.
   *
   * `recurring` says whether the result has to be a MANDATE rail. It changes two
   * things and nothing else:
   *  - wallets are refused for a mandate (no recurring wallet rail exists) but are a
   *    perfectly ordinary one-off instrument, so refusing them for a payment intent
   *    would be its own lie about what RazorPay can do;
   *  - a mandate must be bound to exactly one rail up front, so an unpinned INR
   *    mandate is REFUSED (see the guard at the end); an unpinned INR *payment*
   *    returns undefined and lets Checkout offer the buyer everything the merchant
   *    has enabled.
   * The domestic-currency guard applies to both — UPI and netbanking are NPCI
   * domestic rails whether or not a mandate is involved.
   */
  private selectRail(opts: {
    methodTypes?: string[];
    currency?: string;
    recurring: true;
  }): Exclude<RazorpayRail, "wallet">;
  private selectRail(opts: {
    methodTypes?: string[];
    currency?: string;
    recurring: false;
  }): RazorpayRail | undefined;
  private selectRail(opts: {
    methodTypes?: string[];
    currency?: string;
    recurring: boolean;
  }): RazorpayRail | undefined {
    const methods = opts.methodTypes ?? [];
    const foreignCurrency = Boolean(opts.currency) && opts.currency!.toUpperCase() !== "INR";

    // An explicitly requested domestic rail + a non-INR currency is a
    // contradiction, and silently promoting it to cards would repeat the bug
    // described above in the other direction: the business asks for one
    // instrument and the buyer is shown another. Say so instead.
    const wantsDomestic = methods.includes("upi") || methods.includes("bank_transfer");
    if (wantsDomestic && foreignCurrency) {
      throw new ProviderRefusalError(
        `RazorPay cannot ${opts.recurring ? "register" : "collect"} a ${opts.currency} ` +
          `${opts.recurring ? "mandate" : "payment"} on a domestic rail ` +
          `(${methods.join("/")}). UPI Autopay and netbanking e-mandate are INR-only. ` +
          'Use methodTypes: ["card"] for a non-INR subscription.',
      );
    }
    // ⚠️ `wallet` has NO recurring rail at RazorPay. Before this guard it fell through
    // to the `emandate` else-branch, so a business that pinned `method_types: ['wallet']`
    // got a NETBANKING mandate — buyer shown a bank screen, bank token vaulted, and the
    // stored instrument's type disagreeing with what was actually mandated. That is the
    // same silent-wrong-instrument bug fixed for cards above; it survived for wallets
    // because they hit the fallback rather than a branch.
    // RazorPay's recurring rails are cards, UPI Autopay and netbanking e-mandate only.
    if (opts.recurring && methods.length > 0 && methods.every((m) => m === "wallet")) {
      throw new ProviderRefusalError(
        "RazorPay has no recurring rail for wallets. Mandates exist only for cards, UPI Autopay " +
          '(methodTypes: ["upi"]) and netbanking e-mandate (["bank_transfer"]). ' +
          'Pin one of those on the gateway account instead of "wallet".',
      );
    }
    // ── Precedence when SEVERAL rails are permitted ───────────────────────────
    // `method_types` on a gateway account is a permission LIST, not a pin — the
    // dev account enables all three — so this order is a real decision, not a
    // tie-break. It runs UPI → card → netbanking, cheapest-risk first:
    //
    //   • UPI Autopay leads because it is the only rail whose mandate registers
    //     without a browser (hence the only one `verify:razorpay-live` can prove
    //     unattended), and it is the default consumer rail in India.
    //   • cards next: proven off-session for domestic cards, and the only rail
    //     that can carry a non-INR mandate at all.
    //   • netbanking last: registration is browser-only and its off-session debit
    //     is still unproven (see the recurring matrix in the gateway README).
    //
    // An interactive add-card does not rely on any of this — the portal renders
    // the account's allowed methods and the BUYER picks, arriving here as an
    // explicit single-element `methodTypes`.
    if (methods.includes("upi")) return "upi";
    // With no explicit choice, a non-INR authorization can only ride cards.
    if (methods.includes("card") || foreignCurrency) return "card";
    if (methods.includes("bank_transfer")) return "emandate";
    if (!opts.recurring && methods.includes("wallet")) return "wallet";
    // ⚠️ An UNPINNED INR mandate is REFUSED, not defaulted.
    //
    // This used to fall through to `emandate`, which made the netbanking mandate
    // the silent default for every INR subscription — at a time when that rail
    // could not complete a registration at all (it was pointed at Checkout, which
    // offers no methods for it). A business that expressed no preference got an
    // instrument that never worked, and found out at its first renewal.
    //
    // The rail works now, and is in several ways the BEST of the three (no ₹15,000
    // authentication ceiling, ~20s settlement). It is still not a default: it needs
    // the buyer to leave for a hosted page and supply bank details, which is a very
    // different signup than a card field, and not a choice to make on their behalf.
    //
    // The three rails differ in ways no default can paper over — settlement lag
    // (a card debit is minutes, a netbanking debit up to 2 working days), how the
    // buyer authorizes, and which of them the merchant has actually enabled at
    // RazorPay. So the business pins one on the gateway account's `method_types`,
    // which the dashboard already collects (Cards / UPI Autopay / Netbanking).
    // Same shape as the `wallet` guard above: name the real options and refuse,
    // rather than choose on the merchant's behalf and be wrong quietly.
    //
    // A one-off PAYMENT still returns undefined — there the order pins nothing and
    // Checkout offers the buyer whatever the merchant has enabled, which is
    // correct: no mandate is being registered, so nothing is bound to a rail.
    if (opts.recurring) {
      throw new Error(
        "RazorPay must know which rail an INR mandate uses, and we cannot infer it. " +
          'Pin one on the gateway account\'s method_types: ["card"] for a card mandate, ' +
          '["upi"] for UPI Autopay, or ["bank_transfer"] for a netbanking e-mandate. ' +
          "They differ in settlement lag, in how the buyer authorizes, and in which the merchant " +
          "enabled at RazorPay, so there is no safe default.",
      );
    }
    return undefined;
  }

  /**
   * Register a NETBANKING e-mandate — the one rail that does not go through Checkout.
   *
   * ── Why this exists ──────────────────────────────────────────────────────────
   * `checkout/embedded` answers **"No payment methods available"** for e-mandate. Not
   * for want of a bank (the account has 297 e-mandate banks, 59 on the `netbanking`
   * auth type), not for want of naming one, and not because of the amount — measured
   * 2026-08-13, all three were tried and Checkout offers nothing for this rail either
   * way. It is the wrong surface. Registration goes through a
   * **subscription-registration auth link**, which returns a hosted page.
   *
   * Two constraints, both the OPPOSITE of the other two rails, both measured:
   *  - **`amount` must be 0.** UPI needs ≥ ₹1 and cards a ₹1 floor; here a ₹1 link
   *    renders and then FAILS at Authenticate ("Payment could not be completed", no
   *    payment created), because ₹1 is a real debit the bank refuses. Zero is a pure
   *    mandate registration and succeeds.
   *  - **RazorPay mints its OWN customer**, ignoring `customer_id` even when passed
   *    (verified: the link came back bound to a different `cust_…`). So the token is
   *    customer-scoped to the LINK's customer, and `vaultPaymentMethod` reads it off
   *    the payment rather than assuming ours. `ProviderPaymentMethodRef.providerCustomerId`
   *    carries it back, and `persistVaultedPaymentMethod` adopts it — the same
   *    mechanism the Stripe stale-SetupIntent path already uses.
   *
   * `bank_account` is deliberately NOT sent: the engine holds no bank details (we are
   * PCI SAQ-A and this is not a card), so the buyer supplies account number + IFSC on
   * RazorPay's page. Passing it would only help a caller that already has them.
   *
   * Contact details come from the provider customer rather than a widened input —
   * `charge()` already reads them the same way, and the link is rejected without a
   * contact ("The contact field is required for recurring links").
   */
  private async createEmandateAuthLink(
    providerCustomerId: string,
    opts: {
      currency?: string;
      maxAmountMinor?: bigint;
      description?: string;
      returnUrl?: string;
      /** #31 — the intent this link belongs to; see `TMBILLING_INTENT_REF_NOTE`. */
      ownershipRef?: string;
    },
  ): Promise<{ id: string; shortUrl: string }> {
    const currency = (opts.currency ?? "INR").toUpperCase();
    if (currency !== "INR") {
      throw new Error(
        `RazorPay netbanking e-mandate is INR-only because it uses the NPCI domestic rail. ${currency} needs the card rail.`,
      );
    }
    const cust = await this.api<{
      name?: string;
      email?: string;
      contact?: string;
      error?: { description?: string };
    }>("vault", "GET", `/customers/${providerCustomerId}`);
    if (!cust.json?.contact) {
      // Reaching this now means more than "no phone stored". `ensureProviderCustomer`
      // runs `updateCustomer` immediately before every path that gets here, so a phone
      // on OUR customer would already have been PUT onto this record — and
      // `assertVaultPreconditions` refuses up front when there is none. So either the
      // customer truly has no phone anywhere, or the sync was refused by RazorPay and
      // said so in Gateway Activity (operation `update_customer`). Name both, because
      // the old message named only the first and sent operators to re-do a fix they
      // had already applied.
      throw new Error(
        `RazorPay customer ${providerCustomerId} has no contact. RazorPay rejects a netbanking ` +
          'e-mandate link without one: "The contact field is required for recurring links". Add a ' +
          "phone number to the customer. If one is already stored, RazorPay refused the sync. Examine " +
          "the `update_customer` call for this customer in Gateway Activity.",
      );
    }
    const requested = opts.maxAmountMinor ?? RazorpayProvider.DEFAULT_MANDATE_MAX_AMOUNT;
    const maxAmount = Number(
      requested > RazorpayProvider.MAX_MANDATE_MAX_AMOUNT
        ? RazorpayProvider.MAX_MANDATE_MAX_AMOUNT
        : requested,
    );
    const nowSec = Math.floor(Date.now() / 1000);

    const { status, json } = await this.api<{
      id?: string;
      short_url?: string;
      error?: { description?: string };
    }>("vault", "POST", "/subscription_registration/auth_links", {
      customer: {
        ...(cust.json.name ? { name: cust.json.name } : {}),
        ...(cust.json.email ? { email: cust.json.email } : {}),
        contact: cust.json.contact,
      },
      type: "link",
      // MUST be 0 — see the note above. Not a placeholder.
      amount: 0,
      currency,
      description: opts.description ?? "Authorize recurring payments",
      subscription_registration: {
        method: "emandate",
        auth_type: "netbanking",
        max_amount: maxAmount,
        expire_at: nowSec + 10 * 365 * 24 * 3600,
      },
      receipt: boundedProviderKey(
        emandateReceipt(providerCustomerId, nowSec),
        RAZORPAY_RECEIPT_MAX,
      ),
      /**
       * The ownership binding this link is checked against at vault time — see
       * `assertAuthLinkBelongsTo`.
       *
       * `notes` rather than `receipt` alone, for two reasons. `receipt` is capped at
       * 40 chars and `boundedProviderKey` HASHES anything longer, so a customer id one
       * character longer than today's would silently destroy the binding; and RazorPay
       * mints its own customer for this link (see above), which means the receipt is
       * otherwise the only trace of who we made it for. `notes` is a first-class
       * key/value bag on the invoice entity with no such cap, so it carries the
       * authoritative copy and the receipt prefix remains a fallback.
       */
      notes: {
        ...ownershipNotes(providerCustomerId),
        /**
         * The FINER ref (#31), under its own key on purpose: the value of
         * `tmbilling_ref` is what `assertAuthLinkBelongsTo` compares against, so
         * replacing it with an intent ref would disable that proof. Both fit — RazorPay
         * does not cap `notes`.
         */
        ...(opts.ownershipRef ? { [TMBILLING_INTENT_REF_NOTE]: opts.ownershipRef } : {}),
      },
      // How long the buyer has to complete it. Distinct from the mandate's own
      // expiry above: this is the LINK's shelf life.
      expire_by: nowSec + 7 * 24 * 3600,
      /**
       * ⚠️ **RazorPay IGNORES these on this endpoint.** Measured 2026-08-14, three
       * times, with the fields verified present in `gateway_request_logs`: the buyer
       * still ends on RazorPay's own "MANDATE REGISTRATION COMPLETED" screen and is
       * never sent anywhere. `GET /invoices/:id` does not echo them back either.
       *
       * Kept only because they cost nothing and would improve the buyer's experience
       * if RazorPay ever honours them. **Nothing may depend on them.** The buyer does
       * not come back from a netbanking auth link, so the WEBHOOK is the only
       * completion path — `payment.authorized` correlates to this link by its
       * `invoice_id` (see `normalizeWebhook`) and `harvestSetupIntent` vaults the
       * instrument with no browser involved.
       */
      ...(opts.returnUrl ? { callback_url: opts.returnUrl, callback_method: "get" } : {}),
    });
    if (status >= 300 || !json?.id || !json?.short_url) {
      throw new Error(
        `RazorPay e-mandate auth link failed: ${status} ${json?.error?.description ?? JSON.stringify(json)}`,
      );
    }
    return { id: json.id, shortUrl: json.short_url };
  }

  /**
   * Resolve the recurring token an e-mandate AUTH LINK produced.
   *
   * The link is an invoice (`inv_…`); once the buyer authorizes, it carries the
   * `payment_id`, and that payment names both the token and the customer it is
   * scoped to. Returns null while the buyer has not finished — not an error, the
   * same way an unauthorized order is not one.
   */
  private async authLinkOutcome(
    invoiceId: string,
    /**
     * Our provider customer id, when the caller needs the link PROVED to be theirs.
     * Required on the raw-token vault path (a client assertion); omitted where the
     * engine already looked the intent up scoped to the customer.
     */
    expectedCustomerId?: string,
  ): Promise<{ tokenId: string; customerId: string } | null> {
    const inv = await this.api<{
      payment_id?: string | null;
      customer_id?: string | null;
      status?: string;
      receipt?: string | null;
      notes?: Record<string, string> | null;
      error?: { description?: string };
    }>("vault", "GET", `/invoices/${invoiceId}`);
    if (inv.status >= 300) {
      throw new Error(
        `RazorPay auth link ${invoiceId} could not be read: ${inv.status} ` +
          `${inv.json?.error?.description ?? JSON.stringify(inv.json)}`,
      );
    }
    if (expectedCustomerId) {
      assertAuthLinkBelongsTo(invoiceId, inv.json ?? {}, expectedCustomerId);
    }
    if (!inv.json?.payment_id) return null;
    const pay = await this.getPayment(inv.json.payment_id);
    if (!pay.tokenId) return null;
    // The payment's customer, not the invoice's and certainly not ours — the token
    // lookup is scoped to it.
    const detail = await this.api<{ customer_id?: string }>(
      "vault",
      "GET",
      `/payments/${inv.json.payment_id}`,
    );
    const customerId = detail.json?.customer_id ?? inv.json.customer_id;
    if (!customerId) return null;
    return { tokenId: pay.tokenId, customerId };
  }

  /**
   * The buyer challenge for a RazorPay order.
   *
   * RazorPay has no client secret: a card, UPI or wallet authorization — mandate
   * registration or payment alike — happens in the embedded Checkout against an order
   * id. So one descriptor covers vault setup and both intent purposes, which is the
   * whole point of `BuyerAuthorization` being shared.
   *
   * The netbanking e-mandate is the one rail that does NOT come here: it has no usable
   * Checkout surface, so it registers through a hosted auth link and answers
   * `mode: 'redirect'` (see `initiateVaultSetup` and `createEmandateAuthLink`).
   */
  private checkoutAuthorization(
    orderId: string,
    customerId: string,
    recurring: boolean,
    method?: string,
  ): BuyerAuthorization {
    return {
      mode: "checkout",
      checkout: {
        provider: this.key,
        keyId: this.cfg.keyId,
        orderId,
        customerId,
        recurring,
        // The order is already bound to this rail, so the client must not offer a
        // different one. Absent = the order pinned nothing and Checkout may offer
        // whatever the merchant has enabled.
        ...(method ? { method } : {}),
      },
    };
  }

  async initiateVaultSetup(input: InitiateVaultSetupInput): Promise<VaultSetupRef> {
    // Rail choice + its three guards live in `selectRail`, shared with `createIntent`.
    // Card and UPI mandates are authorized in RazorPay's embedded Checkout, so only the
    // order shape and the preselected method differ between them. Netbanking leaves by
    // the hosted-link branch below.
    const rail = this.selectRail({
      methodTypes: input.methodTypes,
      currency: input.currency,
      recurring: true,
    });
    // Netbanking is the exception: Checkout offers no methods for it, so it
    // registers through a hosted auth link instead of an order. See
    // `createEmandateAuthLink` for the evidence and the two inverted constraints.
    if (rail === "emandate") {
      const link = await this.createEmandateAuthLink(input.customer.providerCustomerId, {
        currency: input.currency,
        maxAmountMinor: input.maxAmountMinor,
        returnUrl: input.returnUrl,
        // The engine's own label, replacing the generic default below it. This text is on
        // the invoice RazorPay raises for the registration and travels to the buyer's BANK
        // page, so it is the one description here a customer certainly reads.
        ...(input.description ? { description: input.description } : {}),
        // #31: the engine passes the `cus_…` this vault attempt is for. The customer-id
        // fallback inside stays for callers that pass nothing.
        ownershipRef: input.ownershipRef,
      });
      return { setupTokenId: link.id, mode: "redirect", approvalUrl: link.shortUrl };
    }
    const order = await this.createMandateOrder(input.customer.providerCustomerId, rail, {
      currency: input.currency,
      maxAmountMinor: input.maxAmountMinor,
      // #31: as above — our id for the attempt, not RazorPay's customer id.
      ownershipRef: input.ownershipRef,
    });
    return {
      setupTokenId: order.id,
      ...this.checkoutAuthorization(order.id, input.customer.providerCustomerId, true, rail),
    };
  }

  /**
   * Server-side UPI Autopay mandate registration: fire a collect request straight at
   * a VPA, no browser. RazorPay approves `success@razorpay` automatically in test
   * mode, which is what lets `verify:razorpay-live` prove the whole off-session path
   * (mandate → token → charge → settlement) headlessly.
   *
   * The `recurring: '1'` flag belongs at the TOP LEVEL of the payment body — putting
   * it under `upi.type` instead is accepted, captures the auth amount, and silently
   * mints NO token, which reads as a mysteriously tokenless success.
   *
   * Returns the mandate payment id; poll `getPayment` for the token, since approval
   * is asynchronous even with the auto-approving test VPA.
   *
   * Not part of the `PaymentProvider` contract — a RazorPay-specific entry point for
   * verification harnesses and for a future server-driven UPI collect flow.
   */
  async initiateUpiAutopayCollect(input: {
    customerId: string;
    vpa: string;
    email: string;
    contact: string;
    /** Reuse an existing auth order; otherwise one is created. */
    orderId?: string;
  }): Promise<{ paymentId: string; orderId: string }> {
    const orderId = input.orderId ?? (await this.createMandateOrder(input.customerId, "upi")).id;
    const { status, json } = await this.api<{
      razorpay_payment_id?: string;
      error?: { description?: string };
    }>("vault", "POST", "/payments/create/upi", {
      // Must match the auth order exactly.
      amount: RazorpayProvider.UPI_MANDATE_AUTH_AMOUNT,
      currency: "INR",
      order_id: orderId,
      customer_id: input.customerId,
      email: input.email,
      contact: input.contact,
      method: "upi",
      recurring: "1",
      upi: { flow: "collect", vpa: input.vpa },
    });
    if (status >= 300 || !json.razorpay_payment_id) {
      throw new Error(
        `RazorPay UPI Autopay collect failed: ${status} ${json?.error?.description ?? JSON.stringify(json)}`,
      );
    }
    return { paymentId: json.razorpay_payment_id, orderId };
  }

  /**
   * Read a payment entity. Two uses, both needing the same call: polling a mandate
   * payment for the token it mints (approval is asynchronous even with the
   * auto-approving test VPA), and polling an off-session debit for settlement (UPI
   * Autopay captures minutes-to-hours after the charge is accepted).
   *
   * Not part of the `PaymentProvider` contract — in production settlement arrives by
   * webhook; this is for verification harnesses and operator reconcile tooling.
   */
  async getPayment(paymentId: string): Promise<{
    status: string;
    tokenId: string | null;
    captured: boolean;
    amountMinor: bigint | null;
    errorDescription: string | null;
    method: string | null;
    currency: string | null;
  }> {
    const { json } = await this.api<{
      status?: string;
      token_id?: string;
      captured?: boolean;
      amount?: number;
      currency?: string;
      error_description?: string | null;
      method?: string | null;
    }>("charge", "GET", `/payments/${paymentId}`);
    return {
      status: json.status ?? "unknown",
      tokenId: json.token_id ?? null,
      captured: json.captured === true,
      amountMinor: json.amount != null ? BigInt(json.amount) : null,
      errorDescription: json.error_description ?? null,
      method: json.method ?? null,
      currency: json.currency ? json.currency.toUpperCase() : null,
    };
  }

  /**
   * Contract: what became of a charge we already placed (see `fetchChargeStatus`
   * on `PaymentProvider`). The stale-pending sweep's only source of truth when a
   * settlement webhook never arrived.
   *
   * Maps exactly as `charge()` does, and deliberately so — the sweep must not be a
   * second opinion about what "settled" means. Only `captured` is money in hand;
   * `failed` is terminal; everything else (`created`, `authorized`, `pending`) is
   * still in flight and the sweep leaves the payment alone.
   *
   * An `order_…` id is a charge whose create answer was lost (`charge()` throws the
   * order as the stranded object); it resolves through the order's payments.
   */
  async fetchChargeStatus(input: { providerChargeId: string }): Promise<ChargeResult> {
    if (input.providerChargeId.startsWith("order_")) {
      const found = await this.chargeOutcomeForOrder(input.providerChargeId);
      if (!found) throw new Error(`could not read the payments of ${input.providerChargeId}`);
      return found.result ?? { status: "pending", providerChargeId: input.providerChargeId };
    }
    const p = await this.getPayment(input.providerChargeId);
    const used = razorpayMethodUsed(p.method);
    // `captured` is the money fact. A `refunded` payment that was never captured is an
    // authorization RazorPay returned on its own: no money was ever ours.
    if (p.captured || p.status === "captured") {
      return { status: "succeeded", providerChargeId: input.providerChargeId, ...used, raw: p };
    }
    if (p.status === "refunded") {
      return {
        status: "failed",
        providerChargeId: input.providerChargeId,
        failure: { ...UNCAPTURED_RETURNED_FAILURE },
        ...used,
        raw: p,
      };
    }
    if (p.status === "failed") {
      // `getPayment` surfaces only the human description, not the machine reason,
      // so normalize from that rather than claim a code we did not read. Unmapped
      // input yields the liberal `charge_failed`/retriable default — the same
      // answer the synchronous path gives for a decline it cannot classify.
      const norm = normalizeRazorpayDecline(undefined);
      return {
        status: "failed",
        providerChargeId: input.providerChargeId,
        failure: {
          code: norm.code,
          message: p.errorDescription ?? "RazorPay reports this payment as failed",
          retriable: norm.retriable,
        },
        ...used,
        raw: p,
      };
    }
    return { status: "pending", providerChargeId: input.providerChargeId, ...used, raw: p };
  }

  /**
   * What became of the payments made against one of OUR orders — the lost-answer read.
   *
   * null = we could not read them. `{ result: undefined }` = the order has no payment, so
   * no money can have moved on it. Otherwise the most advanced attempt wins: money taken,
   * then still in flight, then the newest refusal.
   */
  private async chargeOutcomeForOrder(orderId: string): Promise<{ result?: ChargeResult } | null> {
    const res = await this.tryApi<{ items?: RazorpayPaymentEntity[] }>(
      "charge",
      "GET",
      `/orders/${orderId}/payments`,
    );
    if (res.lost !== undefined || res.status >= 300) return null;
    const items = res.json?.items ?? [];
    if (items.length === 0) return {};
    const taken = items.find((p) => p.captured === true || p.status === "captured");
    const live = items.find((p) => ["created", "authorized", "pending"].includes(p.status ?? ""));
    const chosen =
      taken ?? live ?? [...items].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))[0]!;
    return { result: this.outcomeOfPayment(chosen) };
  }

  /** One payment entity as a `ChargeResult`, by the same rules as `fetchChargeStatus`. */
  private outcomeOfPayment(p: RazorpayPaymentEntity): ChargeResult {
    const used = razorpayMethodUsed(p.method);
    if (p.captured === true || p.status === "captured") {
      return { status: "succeeded", providerChargeId: p.id, ...used, raw: p };
    }
    if (p.status === "refunded") {
      return {
        status: "failed",
        providerChargeId: p.id,
        failure: { ...UNCAPTURED_RETURNED_FAILURE },
        ...used,
        raw: p,
      };
    }
    if (p.status === "failed") {
      const providerCode = p.error_reason ?? p.error_code ?? undefined;
      const norm = normalizeRazorpayDecline(providerCode);
      return {
        status: "failed",
        providerChargeId: p.id,
        failure: {
          code: norm.code,
          ...(providerCode ? { providerCode } : {}),
          message: p.error_description ?? "RazorPay reports this payment as failed",
          retriable: norm.retriable,
        },
        ...used,
        raw: p,
      };
    }
    return { status: "pending", providerChargeId: p.id, ...used, raw: p };
  }

  /**
   * Contract: what became of a refund we already placed (see `fetchRefundStatus` on
   * `PaymentProvider`). The stale-pending refund sweep's only source of truth when the
   * settlement webhook never arrived.
   *
   * RazorPay's refund lifecycle is `pending → processed | failed`, and **`processed` is the
   * settled state** — the one that corresponds to `refund.processed`, the webhook this
   * mirrors. Mapping it to anything else would make a swept refund disagree with a
   * webhook-settled one, which is the single thing this poll must not do.
   *
   * Anything else — `pending`, or a status this version has not seen — stays in flight.
   * The sweep never turns an unrecognised answer into a reversal.
   */
  async fetchRefundStatus(input: { providerRefundId: string }): Promise<RefundResult> {
    const { json } = await this.api<{ status?: string }>(
      "refund",
      "GET",
      `/refunds/${input.providerRefundId}`,
    );
    if (json.status === "processed") {
      return { status: "succeeded", providerRefundId: input.providerRefundId, raw: json };
    }
    if (json.status === "failed") {
      return { status: "failed", providerRefundId: input.providerRefundId, raw: json };
    }
    return { status: "pending", providerRefundId: input.providerRefundId, raw: json };
  }

  /**
   * Resolve the recurring token a mandate payment minted.
   *
   * RazorPay's embedded Checkout hands the browser a PAYMENT id (`pay_…`) — never
   * the `token_…` that vaulting needs — and the token is minted asynchronously, so
   * it is routinely absent for a moment after authorization. Poll here rather than
   * making every buyer surface re-implement it. Card mandates are near-instant; UPI
   * Autopay can lag, and a payment that stays tokenless is reported as such so the
   * caller can surface a retry instead of vaulting nothing.
   */
  /** The token a mandate payment minted, and the currency the mandate registered in. */
  private async tokenIdForMandatePayment(
    paymentId: string,
  ): Promise<{ tokenId: string; currency: string | null }> {
    let detail = "no token minted";
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      const p = await this.getPayment(paymentId);
      if (p.tokenId) return { tokenId: p.tokenId, currency: p.currency };
      detail = p.errorDescription ?? `payment is ${p.status}`;
      if (p.status === "failed") break;
    }
    throw new Error(`RazorPay mandate payment ${paymentId} minted no recurring token (${detail})`);
  }

  /**
   * The auth amount a mandate registration took, for the engine to refund. Only a payment of
   * the auth amount on a MANDATE order qualifies, so an invoice payment is never returned
   * this way. A mandate order is one we tagged, one whose fetch shows a `token` block, or —
   * `setupOrder` — one the caller already knows is a setup intent's. `authorized` counts too:
   * the order auto-captures, and the refund job retries until the capture lands.
   *
   * A failed read throws: the vault is retryable, a silently kept rupee is not.
   * Public for `scripts/refund-razorpay-setup-auths.ts`, which must judge a payment the same way.
   */
  async setupAuthChargeFor(
    paymentId: string,
    opts: { setupOrder?: string } = {},
  ): Promise<ProviderPaymentMethodRef["setupAuthCharge"]> {
    const pay = await this.api<RazorpayPaymentEntity & { amount_refunded?: number }>(
      "vault",
      "GET",
      `/payments/${paymentId}`,
    );
    if (pay.status >= 300) {
      throw new Error(`RazorPay could not read the mandate payment ${paymentId}: ${pay.status}`);
    }
    const p = pay.json;
    const amount = p.amount ?? 0;
    const remaining = amount - (p.amount_refunded ?? 0);
    if (!["authorized", "captured"].includes(p.status ?? "") || remaining <= 0) return undefined;
    if (!RazorpayProvider.SETUP_AUTH_AMOUNTS.has(amount) || !p.order_id) return undefined;
    const order = await this.api<{ amount?: number; token?: unknown; notes?: unknown }>(
      "vault",
      "GET",
      `/orders/${p.order_id}`,
    );
    if (order.status >= 300) {
      throw new Error(`RazorPay could not read the mandate order ${p.order_id}: ${order.status}`);
    }
    const notes = (order.json?.notes ?? {}) as Record<string, unknown>;
    const mandateOrder =
      opts.setupOrder === p.order_id ||
      Boolean(order.json?.token) ||
      notes[TMBILLING_SETUP_ORDER_NOTE] === "1";
    if (!mandateOrder || order.json.amount !== amount) return undefined;
    return {
      providerChargeId: paymentId,
      amountMinor: BigInt(remaining),
      currency: (p.currency ?? "INR").toUpperCase(),
    };
  }

  /**
   * Re-read a token's mandate state. The POLL half of the paused-mandate problem: RazorPay
   * refuses to subscribe `token.resumed`, so a mandate that pauses and resumes can only be
   * discovered by asking.
   *
   * Maps through `describeRazorpayMandate` and not its own reading, for the reason that
   * function's own docblock gives: two mappings are two chances for the ceiling a poll
   * writes and the ceiling a vault writes to disagree about the same token, and that column
   * decides whether the engine will attempt a debit at all.
   *
   * A 404 is null, never a throw: a token the gateway has forgotten is a real answer to
   * "what is this mandate now", and the caller decides what to do about it.
   */
  /**
   * Contract: re-read an instrument's display facts (see `fetchPaymentMethodDisplay`).
   *
   * Customer-scoped like every other token read here, and that scoping IS the ownership
   * guard — without the customer we would be reading an unscoped object, so a missing one
   * returns null rather than a wider read. Reuses `describeRazorpayToken`, so a backfilled
   * row and a freshly vaulted one describe the same card identically.
   */
  async fetchPaymentMethodDisplay(input: {
    providerPaymentMethodId: string;
    providerCustomerId?: string;
  }): Promise<ProviderPaymentMethodRef["display"] | null> {
    if (!input.providerCustomerId) return null;
    const { status, json } = await this.api<RazorpayToken>(
      "vault",
      "GET",
      `/customers/${input.providerCustomerId}/tokens/${input.providerPaymentMethodId}`,
    );
    // Gone, or not this customer's — a real answer, not a failure. The row stays
    // unfilled rather than acquiring invented values.
    if (status === 404) return null;
    if (status >= 300) {
      throw new Error(
        `RazorPay token ${input.providerPaymentMethodId} could not be read: HTTP ${status}`,
      );
    }
    return describeRazorpayToken(json);
  }

  /** Contract: see `fetchVaultedPaymentMethod`. The customer-scoped read is the ownership check. */
  async fetchVaultedPaymentMethod(input: {
    providerCustomerId: string;
    providerPaymentMethodId: string;
  }): Promise<ProviderPaymentMethodRef | null> {
    const { status, json } = await this.api<RazorpayToken & { error?: { description?: string } }>(
      "vault",
      "GET",
      `/customers/${input.providerCustomerId}/tokens/${input.providerPaymentMethodId}`,
    );
    if (status === 404 || status === 400) return null;
    if (status >= 300) {
      throw new Error(
        `RazorPay token ${input.providerPaymentMethodId} could not be read: HTTP ${status}`,
      );
    }
    const mandate = describeRazorpayMandate(json);
    return {
      providerKey: this.key,
      providerPaymentMethodId: input.providerPaymentMethodId,
      providerCustomerId: input.providerCustomerId,
      display: describeRazorpayToken(json),
      ...(mandate ? { mandate } : {}),
    };
  }

  async fetchMandate(input: {
    providerCustomerId: string;
    token: string;
  }): Promise<ProviderMandate | null> {
    const { status, json } = await this.api<RazorpayToken & { error?: { description?: string } }>(
      "vault",
      "GET",
      `/customers/${input.providerCustomerId}/tokens/${input.token}`,
    );
    if (status === 404) return null;
    if (status >= 300) {
      throw new Error(
        `RazorPay token ${input.token} could not be read for ` +
          `${input.providerCustomerId}: ${status} ` +
          `${json?.error?.description ?? JSON.stringify(json)}`,
      );
    }
    return json ? (describeRazorpayMandate(json) ?? null) : null;
  }

  async vaultPaymentMethod(
    input: VaultPaymentMethodInput,
    /** `consumeIntent`: the registration payment's currency, when it hands in a `token_…`. */
    opts: { registeredIn?: string | null } = {},
  ): Promise<ProviderPaymentMethodRef> {
    // Three shapes reach here:
    //   token_… — an authenticated mandate's token, handed straight in
    //   pay_…   — the payment id Checkout gives the browser (card / UPI rails)
    //   inv_…   — a netbanking e-mandate AUTH LINK, which is an invoice
    //
    // The auth link also decides WHICH customer the token is scoped to: RazorPay
    // mints its own for the link and ignores `customer_id`, so the lookup below must
    // use the link's customer, not the one the caller passed. The returned ref
    // carries it in `providerCustomerId` and the engine adopts it.
    let tokenId: string;
    let setupAuthCharge: ProviderPaymentMethodRef["setupAuthCharge"];
    let scopedCustomerId = input.customer.providerCustomerId;
    // The card mandate's currency: read off the payment on the `pay_…` shape.
    let registeredIn = opts.registeredIn ?? null;
    if (input.token.startsWith("inv_")) {
      // ⚠️ THE OWNERSHIP PROOF FOR THIS SHAPE. The other two are guarded implicitly —
      // their token read is scoped to `input.customer.providerCustomerId`, so another
      // customer's token 404s. This one is not: the link names its OWN customer and we
      // adopt it below, which means the scoped read is scoped to whatever the link
      // says. Without this the customer scope is attacker-controlled.
      const outcome = await this.authLinkOutcome(input.token, input.customer.providerCustomerId);
      if (!outcome) {
        throw new Error(
          `RazorPay e-mandate auth link ${input.token} is not authorized yet. The buyer did ` +
            "not complete it, so no recurring token exists to vault.",
        );
      }
      tokenId = outcome.tokenId;
      scopedCustomerId = outcome.customerId;
    } else if (input.token.startsWith("pay_")) {
      ({ tokenId, currency: registeredIn } = await this.tokenIdForMandatePayment(input.token));
      setupAuthCharge = await this.setupAuthChargeFor(input.token);
    } else {
      tokenId = input.token;
    }
    // Read the token entity to learn what was actually mandated: the id alone is
    // opaque, and assuming "card" stores a UPI Autopay mandate as a card with no
    // last4 and then mis-routes it (Smart Routing matches on method type).
    const { status, json } = await this.api<RazorpayToken & { error?: { description?: string } }>(
      "vault",
      "GET",
      `/customers/${scopedCustomerId}/tokens/${tokenId}`,
    );
    if (status >= 300) {
      // Deliberately fatal rather than defaulting to `card`: the method type is
      // load-bearing for routing and charging for the whole life of the instrument,
      // and a vault is an interactive, retryable operation. Guessing here is how the
      // Stripe adapter ended up storing every bank debit as an empty card.
      throw new Error(
        `RazorPay token ${tokenId} could not be read for customer ` +
          `${scopedCustomerId}: ${status} ${json?.error?.description ?? JSON.stringify(json)}`,
      );
    }
    const mandate = describeRazorpayMandate(json, registeredIn);
    return {
      providerKey: this.key,
      providerPaymentMethodId: tokenId,
      // Only when it DIFFERS from what the caller passed — an auth link binds the
      // token to a customer RazorPay minted, and charging the caller's would fail.
      ...(scopedCustomerId !== input.customer.providerCustomerId
        ? { providerCustomerId: scopedCustomerId }
        : {}),
      display: describeRazorpayToken(json),
      ...(mandate ? { mandate } : {}),
      ...(setupAuthCharge ? { setupAuthCharge } : {}),
    };
  }

  /**
   * Normalize a refused RazorPay payment response into our dunning vocabulary.
   *
   * Extracted so the off-session `charge()` and the intent capture in `consumeIntent`
   * read a decline identically — a card declined at capture is the same decline it
   * would have been on a renewal, and dunning must not branch on which call collected
   * the money.
   *
   * Normalizes RazorPay's decline vocabulary so smart dunning can park/terminate (raw
   * `error.reason` is more specific than `error.code`; prefer it), and keeps
   * RazorPay's OWN reason alongside our normalized code: normalizing is lossy (several
   * distinct refusals collapse to `processing_error`), and the raw reason is what an
   * operator matches against RazorPay's docs or quotes to their support.
   */
  private declineFailure(json: any, httpStatus: number): NonNullable<ChargeResult["failure"]> {
    const providerCode: string | undefined = json?.error?.reason ?? json?.error?.code;
    const norm = normalizeRazorpayDecline(providerCode);
    return {
      code: norm.code,
      ...(providerCode ? { providerCode } : {}),
      message: json?.error?.description ?? JSON.stringify(json),
      // Gateway 5xx is always retriable regardless of the normalized token.
      retriable: httpStatus >= 500 ? true : norm.retriable,
      ...(norm.retryAfterMs ? { retryAfterMs: norm.retryAfterMs } : {}),
    };
  }

  /**
   * Off-session charge on a mandated token.
   *
   * ⚠️ **No provider-side idempotency.** RazorPay exposes no idempotency key on
   * either call below — `receipt` is a merchant reference it does not dedupe on — so
   * a retry after a mid-flight timeout would create a second order and a second
   * debit. The engine is what makes this safe: `collectInvoice` refuses to re-charge
   * while a prior attempt is still `pending`, leaving the inbound reconciler or the
   * manual reconcile op to resolve the unknown outcome. Never call this in a blind
   * retry loop.
   */
  async charge(input: ChargeInput): Promise<ChargeResult> {
    // ── INR-only rails, enforced HERE rather than trusted to RazorPay ──────────
    // UPI Autopay and netbanking e-mandate are NPCI **domestic** rails: the payer is
    // an Indian bank customer and both presentment and settlement are INR. RazorPay
    // used to refuse a foreign-currency debit on them outright ("Currency is not
    // supported"); measured 2026-08-01 it now **accepts** one and returns `pending`.
    // That is strictly worse than a refusal — the debit enters async limbo on a rail
    // that cannot settle it, so instead of a clean decline the engine parks a payment
    // that may never resolve. `initiateVaultSetup` already refuses to *register* a
    // foreign-currency mandate on these rails; this closes the same hole at charge time,
    // where the instrument's real rail is known.
    const rail = input.paymentMethod.display.type;
    const currency = input.currency.toUpperCase();
    if ((rail === "upi" || rail === "bank_transfer") && currency !== "INR") {
      return {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: "currency_not_supported",
          message:
            `RazorPay ${rail === "upi" ? "UPI Autopay" : "netbanking e-mandate"} is an INR-only ` +
            `domestic rail. We cannot debit it in ${currency}. Charge a card mandate instead.`,
          // Terminal: retrying the same instrument in the same currency can never work.
          retriable: false,
        },
        raw: { rail, currency },
      };
    }

    // Recurring/off-session: create an order, then a recurring payment on the token.
    const order = await this.api<{ id: string; error?: unknown }>("charge", "POST", "/orders", {
      amount: Number(input.amountMinor),
      currency: input.currency.toUpperCase(),
      payment_capture: 1,
      customer_id: input.customer.providerCustomerId,
      receipt: boundedProviderKey(input.idempotencyKey, RAZORPAY_RECEIPT_MAX),
      /**
       * ── The blind spot #31 was actually about ─────────────────────────────────
       * This is the money path, and until now its only trace of us was the `receipt`
       * above — which `boundedProviderKey` HASHES to `tm_<hash>` whenever the
       * idempotency key exceeds 40 chars, i.e. always on the collect path. So a
       * capture we failed to attribute was indistinguishable from a sibling product's.
       * A `notes` value takes 256 characters, so the SAME key goes in whole and is reversible.
       *
       * ⚠️ The tag lands on the ORDER, not on the payment: the following
       * `/payments/create/recurring` call deliberately sends no `notes` (see there).
       * `payment.captured` therefore resolves through this order — the event carries
       * `order_id`, and `fetchOrderOwnership` reads the tag back off it.
       */
      notes: ownershipNotes(input.idempotencyKey),
    });
    if (order.status >= 300) {
      return {
        status: "failed",
        providerChargeId: "",
        failure: {
          code: "order_failed",
          message: JSON.stringify(order.json),
          // ALWAYS retriable, including on a 4xx. Order creation never references
          // the vaulted token, so its failure cannot mean "bad instrument" — and
          // `retriable: false` is exactly what `collectInvoice` reads as a hard
          // decline, which would mark the customer's payment method INVALID over
          // what is really our own request or a gateway config problem. Dunning
          // retrying a genuinely broken request is the far cheaper mistake.
          retriable: true,
        },
        raw: order.json,
      };
    }

    // Buyer contact is REQUIRED here, unlike on the order: without it RazorPay
    // rejects the charge with "The contact field is required." and every off-session
    // collection fails. `ensureCustomer` already stored both, but this endpoint reads
    // them off the request, not off the customer — so the engine threads them
    // through, and we fall back to the vaulted customer when a caller omits them.
    let email = input.email;
    let contact = input.phone;
    if (!email || !contact) {
      const cust = await this.api<{ email?: string; contact?: string }>(
        "charge",
        "GET",
        `/customers/${input.customer.providerCustomerId}`,
      );
      email = email ?? cust.json?.email;
      contact = contact ?? cust.json?.contact;
    }

    /**
     * ⚠️ **No `notes` here, deliberately (#31).** RazorPay's acceptance of `notes` on
     * the s2s payment-create endpoints is NOT measured on this account, and this is the
     * ONLY off-session collection call there is: a field the gateway rejects would fail
     * every renewal, which is a far worse outcome than an untagged payment entity. The
     * order above carries the tag and the capture webhook carries `order_id`, so
     * attribution is complete without it — see `razorpayProvenance` for why an untagged
     * payment must answer `unknown` rather than `foreign`. Send it only once a live
     * measurement says the endpoint echoes it.
     */
    const orderId: string = order.json.id;
    const pay = await this.tryApi<any>("charge", "POST", "/payments/create/recurring", {
      amount: Number(input.amountMinor),
      currency: input.currency.toUpperCase(),
      order_id: orderId,
      customer_id: input.customer.providerCustomerId,
      token: input.paymentMethod.providerPaymentMethodId,
      recurring: "1",
      ...(email ? { email } : {}),
      ...(contact ? { contact } : {}),
      description: input.description,
    });
    /**
     * A LOST ANSWER IS NOT A DECLINE. A timeout, a 408/409/429/5xx (`classifyGatewayHttp`)
     * or an unreadable body may follow a debit RazorPay did create, and RazorPay has no
     * idempotency key here and says not to create another payment until the first one's
     * status is known. So ask the order what happened instead of retrying; if that cannot
     * answer either, the outcome is indeterminate and the order is the handle the engine
     * resolves it by (webhook `order_id`, `locateCharge`).
     */
    if (
      pay.lost !== undefined ||
      classifyGatewayHttp({ status: pay.status }).kind === "retry_same_key"
    ) {
      const found = await this.chargeOutcomeForOrder(orderId);
      if (found?.result) return found.result;
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `We could not confirm whether RazorPay created the debit on order ${orderId}: ` +
            (pay.lost ?? `HTTP ${pay.status} ${JSON.stringify(pay.json)}`),
        ),
        orderId,
      );
    }
    if (pay.status >= 300) {
      return {
        status: "failed",
        providerChargeId: "",
        failure: this.declineFailure(pay.json, pay.status),
        raw: pay.json,
      };
    }
    // `/payments/create/recurring` answers with the SIGNED HANDSHAKE shape
    // (razorpay_payment_id / _order_id / _signature) rather than a payment entity, so
    // there is no `status` and no `id`. Reading `id` left providerChargeId undefined —
    // which meant an async debit was recorded with no idAtGateway and the settlement
    // webhook could never correlate it, stranding the payment as pending forever.
    const chargeId: string = pay.json.razorpay_payment_id ?? pay.json.id ?? "";
    if (!chargeId) {
      // Accepted with no id is a lost answer too: the debit may exist. Same resolution.
      const found = await this.chargeOutcomeForOrder(orderId);
      if (found?.result) return found.result;
      throw markStrandedObject(
        new ProviderIndeterminateError(
          `RazorPay accepted the debit on order ${orderId} but returned no payment id: ` +
            JSON.stringify(pay.json),
        ),
        orderId,
      );
    }
    return {
      // Only a CAPTURED payment is money in hand. `authorized` — and the
      // status-less recurring handshake — is `pending`: UPI Autopay debits settle
      // asynchronously and the terminal state arrives as payment.captured /
      // payment.failed. Treating `authorized` as succeeded booked cash the gateway
      // had not captured yet.
      status: pay.json.status === "captured" ? "succeeded" : "pending",
      providerChargeId: chargeId,
      // The handshake shape carries no `method`; an entity does.
      ...razorpayMethodUsed(pay.json.method),
      raw: pay.json,
    };
  }

  /**
   * Begin a buyer authorization at RazorPay (contract v2, C7).
   *
   * Both purposes end in the SAME place — an order id the client opens Checkout with —
   * because that is the only authorization handshake RazorPay has. What differs is
   * what the authorization produces:
   *
   *  - `setup` → a **mandate-registration order**. This is not a new flow: it is
   *    exactly what `initiateVaultSetup` has always created, and a RazorPay mandate is
   *    a setup intent by any other name (an authorization whose product is a vaulted
   *    token, not money). The only difference is that the engine now RECORDS it as an
   *    intent with attempts instead of leaving it untracked.
   *  - `payment` → a priced order with **manual capture**, authorized by the buyer now
   *    and captured by `consumeIntent` when the engine decides to.
   *
   * Rail selection and its guards are shared with `initiateVaultSetup` via
   * `selectRail` — this path must not be able to reach a rail that path refuses.
   */
  async createIntent(input: CreateIntentInput): Promise<IntentRef> {
    const customerId = input.customer.providerCustomerId;

    if (input.purpose === "setup") {
      const rail = this.selectRail({
        methodTypes: input.methodTypes,
        currency: input.currency,
        recurring: true,
      });
      // The per-debit CEILING the mandate carries comes from `maxAmountMinor` — the
      // field that means exactly this on both `CreateIntentInput` and
      // `InitiateVaultSetupInput`. It is deliberately NOT read off `amountMinor`
      // any more: a setup intent's amount is zero by definition, and treating a
      // stray positive amount as a ceiling made one field mean two things (a charge
      // on the payment arm, a limit on the setup arm) — so a caller who passed an
      // amount by mistake silently bound the mandate to it. Absent, the documented
      // default in `createMandateOrder` applies.
      // Netbanking registers through a hosted auth link, not Checkout — its
      // `intentAtGateway` is therefore an `inv_…`, which `consumeIntent` branches on.
      if (rail === "emandate") {
        const link = await this.createEmandateAuthLink(customerId, {
          currency: input.currency,
          maxAmountMinor: input.maxAmountMinor,
          ...(input.ownershipRef ? { ownershipRef: input.ownershipRef } : {}),
          ...(input.description ? { description: input.description } : {}),
          // Same reason as the vault-setup arm: without it the buyer ends on
          // RazorPay's completion page and never comes back to finish the vault.
          ...(input.returnUrl ? { returnUrl: input.returnUrl } : {}),
        });
        return {
          intentId: link.id,
          status: "requires_action",
          authorization: { mode: "redirect", approvalUrl: link.shortUrl },
          raw: link,
        };
      }
      const order = await this.createMandateOrder(customerId, rail, {
        currency: input.currency,
        maxAmountMinor: input.maxAmountMinor,
        // #31: the intent's own ref when the engine passed one, else the idempotency
        // key — also ours, also reversible, and unlike the receipt it is not hashed.
        // Never nothing: `initiateVaultSetup`, which has neither, falls back to the
        // customer id inside `createMandateOrder`.
        ownershipRef: input.ownershipRef ?? input.idempotencyKey,
      });
      return {
        intentId: order.id,
        // Always: a RazorPay mandate cannot be registered server-side. The buyer has
        // to approve it in Checkout (or, for UPI, in their UPI app).
        status: "requires_action",
        authorization: this.checkoutAuthorization(order.id, customerId, true, rail),
        raw: order,
      };
    }

    const amountMinor = input.amountMinor ?? 0n;
    if (amountMinor <= 0n) {
      throw new Error(
        "RazorPay payment intents need a positive amountMinor. RazorPay rejects a zero-amount " +
          'order with "Order amount less than minimum amount allowed". Use purpose: "setup" for a ' +
          "zero-amount vault authorization.",
      );
    }
    // No explicit `methodTypes`? Take the hint from the instrument the engine had in
    // mind. RazorPay's Checkout cannot be pointed at a VAULTED token (that is
    // `/payments/create/recurring`, which is off-session and is what `charge()` does),
    // so `paymentMethod` cannot be used to pay here — but its family still tells us
    // which rail the buyer is expected to re-authorize on, and feeding it through
    // `selectRail` means a non-INR debit on a domestic instrument is refused here too.
    const methodTypes =
      input.methodTypes ?? (input.paymentMethod ? [input.paymentMethod.display.type] : undefined);
    const rail = this.selectRail({ methodTypes, currency: input.currency, recurring: false });
    // Checkout's method names are not our mandate rail names for a ONE-OFF payment:
    // the netbanking MANDATE rail is `emandate`, but a plain netbanking payment is
    // `netbanking`, and an order that says `emandate` without a mandate token block is
    // rejected.
    const checkoutMethod = rail === "emandate" ? "netbanking" : rail;
    const notes: Record<string, string> = {
      ...boundedCallerNotes(
        {
          ...(input.metadata ?? {}),
          ...(input.description ? { description: input.description } : {}),
        },
        1,
      ),
      /**
       * #31, and last so no caller's metadata can shadow it. `ownershipRef` is what the
       * engine means to be recognised by; the idempotency key is the fallback because it
       * is equally ours and, unlike the `receipt` below, is not hashed. The fallback was
       * originally load-bearing because nothing passed `ownershipRef`; every engine call
       * site now does (2026-09-04), so it now only covers a future caller that forgets —
       * and it stays, because the classifier's "no tag ⇒ not ours" rule is sound only
       * while every object we create carries one.
       */
      ...ownershipNotes(input.ownershipRef ?? input.idempotencyKey),
    };

    const { status, json } = await this.api<{
      id: string;
      error?: {
        description?: string;
        /** RazorPay's SPECIFIC refusal — `declineFailure` prefers it over `code`. */
        reason?: string;
        /** Documented: "additional information about the request" — the objects it touched. */
        metadata?: { order_id?: string; payment_id?: string };
      };
    }>("intent", "POST", "/orders", {
      amount: Number(amountMinor),
      currency: input.currency.toUpperCase(),
      // ⚠️ **0, not 1.** Manual capture is the whole difference between an intent and
      // a charge: the buyer authorizes in Checkout now, and the engine redeems the
      // authorization with `consumeIntent` when it is ready to book the money. With
      // `payment_capture: 1` RazorPay captures the instant the buyer authorizes and
      // there is nothing left for the engine to decide — which is exactly right for
      // `charge()`'s off-session renewals (it still passes 1) and exactly wrong here.
      payment_capture: 0,
      customer_id: customerId,
      // RazorPay does not dedupe on `receipt` — see the idempotency warning on
      // `charge()`. It is a merchant reference, carried so an operator can trace an
      // order in RazorPay's dashboard back to the attempt that created it.
      receipt: boundedProviderKey(input.idempotencyKey, RAZORPAY_RECEIPT_MAX),
      ...(checkoutMethod ? { method: checkoutMethod } : {}),
      // Unconditional now — the bag always carries the ownership tag, so the old
      // "only if non-empty" guard could only ever hide it.
      notes,
    });
    if (status >= 300 || !json?.id) {
      /**
       * A REJECTION THAT LEFT AN ORDER BEHIND MUST NOT LOSE IT — RazorPay's half of #63.
       *
       * `createPaymentIntent` already books every throw out of here as
       * `gateway_request_rejected` (13152c64), so the failure is no longer invisible. The
       * one thing that backstop cannot recover is the ORDER: its synthesised ref carries
       * `intentId: ""`, and an order RazorPay kept — stamped with the `notes.tmbilling_ref`
       * above — then has our ownership tag and no local row, tripping
       * `orphaned_gateway_intents` on every retry. RazorPay names that object in its
       * documented error envelope (`error.metadata.order_id`), which is the same recovery
       * Stripe's `createIntent` makes from `err.payment_intent.id`.
       *
       * ⚠️ No `authorization` is handed back. `capabilities.intentVoid` is false here —
       * RazorPay has no true void — so an order we send a buyer into after the gateway
       * refused the request is one we could never unwind. `inited`, not a state we invented.
       *
       * `declineFailure` classifies this ONLY when RazorPay sent a `reason`: that is the
       * specific field it is built to read, and the documented envelope carries it beside
       * `metadata`. With no reason there is only the generic code, and
       * `RAZORPAY_CODE_TABLE` maps `BAD_REQUEST_ERROR` to `card_declined` — which would
       * report our own malformed request as the customer's card failing. That case takes
       * the caller's verdict instead of inventing one.
       *
       * Everything else still throws. With no order id there is nothing stranded and
       * nothing the backstop does not already record.
       */
      const strandedOrderId = json?.error?.metadata?.order_id;
      if (strandedOrderId) {
        return {
          intentId: strandedOrderId,
          status: "inited",
          failure: json.error?.reason
            ? this.declineFailure(json, status)
            : {
                code: "gateway_request_rejected",
                message:
                  `RazorPay rejected the payment-intent order itself: ${
                    json.error?.description ?? JSON.stringify(json)
                  } This is a configuration or request fault on our side, not the ` +
                  "customer's instrument. A retry of the same request cannot succeed.",
                retriable: false,
              },
          raw: json,
        };
      }
      // Still a throw — an error whose shape we do not recognise is our bug and the caller
      // must see it — but stamp the order RazorPay kept, if it named one. The narrow
      // recovery above only covers envelopes we understand, and the whole point of this
      // rethrow is the ones we do not.
      throw markStrandedObject(
        new Error(
          `RazorPay payment-intent order failed: ${status} ${json?.error?.description ?? JSON.stringify(json)}`,
        ),
        strandedOrderId,
      );
    }
    return {
      intentId: json.id,
      // A RazorPay order is inert until a buyer authorizes against it in Checkout, so
      // there is no state between "created" and "the buyer must act".
      status: "requires_action",
      authorization: this.checkoutAuthorization(json.id, customerId, false, checkoutMethod),
      raw: json,
    };
  }

  /**
   * Find the payment a buyer created against an order.
   *
   * ⚠️ **An intent is keyed by the ORDER id** (`order_…`) — that is what Checkout is
   * opened with, and what exists before the buyer has done anything. But capture,
   * token lookup and every other post-authorization call take a **PAYMENT id**
   * (`pay_…`), which only comes into existence once the buyer authorizes. Neither id
   * can be derived from the other, so resolve it here: RazorPay lists an order's
   * payment attempts, and the authorized (or already captured) one is the intent's.
   *
   * `captured` is preferred over `authorized` so consuming an already-captured intent
   * is idempotent — RazorPay refuses a second capture, and a replayed consume must
   * report the money that already moved rather than fail. Returns null when the buyer
   * has not authorized yet: that is a normal state (Checkout still open, UPI collect
   * still pending), not an error, and the caller parks the intent instead of throwing.
   */
  private async authorizedPaymentForOrder(orderId: string): Promise<RazorpayPaymentEntity | null> {
    const { status, json } = await this.api<{
      items?: RazorpayPaymentEntity[];
      error?: { description?: string };
    }>("intent", "GET", `/orders/${orderId}/payments`);
    if (status >= 300) {
      throw new Error(
        `RazorPay could not list payments for order ${orderId}: ` +
          `${status} ${json?.error?.description ?? JSON.stringify(json)}`,
      );
    }
    const items = json?.items ?? [];
    return (
      items.find((p) => p.status === "captured") ??
      items.find((p) => p.status === "authorized") ??
      null
    );
  }

  /**
   * Redeem an authorized intent (contract v2, C7).
   *
   *  - `payment` → capture the authorization into money. Returns a `ChargeResult`
   *    built by the same mappers `charge()` uses, so the engine cannot tell (and must
   *    not care) whether an invoice was collected on-session or off-session.
   *  - `setup` → harvest the mandate token the authorization minted. No money moves.
   */
  async consumeIntent(input: ConsumeIntentInput): Promise<ConsumeIntentResult> {
    if (input.purpose === "setup") {
      // A netbanking e-mandate's intent is an AUTH LINK (`inv_…`), not an order —
      // Checkout cannot register this rail at all. Resolve it through its own path;
      // the link also owns the customer the token is scoped to.
      if (input.intentId.startsWith("inv_")) {
        // No ownership proof here, deliberately, and for the reason `stripe.ts`
        // documents on its own setup harvest: the engine looked this intent up on the
        // `payment_intents` row, already scoped to the organization and the customer,
        // so the binding is OURS by construction. The proof belongs on
        // `vaultPaymentMethod`, where the link id is a client assertion instead.
        const outcome = await this.authLinkOutcome(input.intentId);
        if (!outcome) {
          throw new Error(
            `RazorPay e-mandate auth link ${input.intentId} is not authorized yet. The buyer ` +
              "did not complete it, so no recurring token exists to vault.",
          );
        }
        const customer: ProviderCustomerRef = {
          providerKey: this.key,
          providerCustomerId: outcome.customerId,
        };
        const ref = await this.vaultPaymentMethod({ customer, token: outcome.tokenId });
        return {
          purpose: "setup",
          paymentMethod: { ...ref, providerCustomerId: outcome.customerId },
        };
      }
      // `ConsumeIntentInput` carries no customer, and the token lookup is
      // customer-scoped (`GET /customers/:c/tokens/:t`), so the customer has to be
      // read back from the gateway.
      //
      // ⚠️ It comes off the PAYMENT, not the order. This used to read
      // `order.customer_id` and hard-fail without it — and RazorPay does not return
      // `customer_id` on a mandate order at all (verified against a live order: the
      // entity carries id/status/amount/currency/token and nothing else). So every
      // card and UPI setup intent threw "carries no customer_id" the moment the
      // portal's add-card tried to consume it. It survived because every other path
      // calls `vaultPaymentMethod` directly and never reaches here; the frontend
      // add-card flow is what finally exercised it.
      //
      // The payment is authoritative anyway: it is the object the token is minted
      // against, so its customer is by definition the one the token is scoped to.
      const payment = await this.authorizedPaymentForOrder(input.intentId);
      if (!payment) {
        throw new Error(
          `RazorPay mandate order ${input.intentId} has no authorized payment yet. The buyer has ` +
            "not completed Checkout, so no recurring token exists to vault.",
        );
      }
      // The order is still consulted as a fallback, in case RazorPay ever starts
      // echoing it — but its absence is no longer fatal.
      const order = await this.api<{ customer_id?: string }>(
        "intent",
        "GET",
        `/orders/${input.intentId}`,
      );
      const providerCustomerId = payment.customer_id ?? order.json?.customer_id;
      if (!providerCustomerId) {
        throw new Error(
          `RazorPay mandate order ${input.intentId}: neither its authorized payment ` +
            `(${payment.id}) nor the order names a customer, so the recurring token cannot be read.`,
        );
      }
      const customer: ProviderCustomerRef = {
        providerKey: this.key,
        providerCustomerId,
      };
      // Reuse the vault path verbatim rather than re-deriving the ref: it already
      // polls `getPayment` for the token a mandate payment mints (minting LAGS
      // authorization, routinely by seconds) and maps the token entity through
      // `describeRazorpayToken`, which is what stops a UPI Autopay mandate being
      // stored as an empty card and then mis-routed. Hand it the token id when the
      // payment already carries one, so the common case skips the poll entirely.
      const ref = await this.vaultPaymentMethod(
        { customer, token: payment.token_id ?? payment.id },
        { registeredIn: payment.currency ?? null },
      );
      // Handed a token id, the vault never saw the payment, so ask here.
      const setupAuthCharge =
        ref.setupAuthCharge ??
        (await this.setupAuthChargeFor(payment.id, { setupOrder: input.intentId }));
      return {
        purpose: "setup",
        // The mandate is bound to the order's customer, which the caller may not have
        // been holding — the contract says to stamp it so charges use the right one.
        paymentMethod: {
          ...ref,
          providerCustomerId: customer.providerCustomerId,
          ...(setupAuthCharge ? { setupAuthCharge } : {}),
        },
      };
    }

    const payment = await this.authorizedPaymentForOrder(input.intentId);
    if (!payment) {
      // NOT an error: the buyer simply has not finished the challenge. Park it the way
      // `charge()` parks an async rail, so the engine keeps waiting on the webhook
      // instead of failing an invoice over a buyer who is still typing their OTP.
      return {
        purpose: "payment",
        charge: {
          status: "pending",
          // No payment exists at the gateway yet, so there is no id to correlate on —
          // same as `charge()`'s pre-payment failures. The order id lives in `raw`.
          providerChargeId: "",
          raw: { orderId: input.intentId, reason: "no authorized payment on the order yet" },
        },
      };
    }
    if (payment.status === "captured") {
      // Already captured — a replayed consume, or an order RazorPay auto-captured.
      // Report the capture that happened instead of calling /capture again, which
      // RazorPay refuses ("This payment has already been captured").
      return {
        purpose: "payment",
        charge: {
          status: "succeeded",
          providerChargeId: payment.id,
          ...razorpayMethodUsed(payment.method),
          raw: payment,
        },
      };
    }

    // RazorPay's capture call requires BOTH `amount` and `currency` — it rejects the
    // call with either missing — and the amount may not exceed what was authorized.
    // Default to the authorization's own amount/currency so a caller that omits them
    // captures the full hold rather than sending 0.
    const cap = await this.api<RazorpayPaymentEntity & { error?: { description?: string } }>(
      "charge",
      "POST",
      `/payments/${payment.id}/capture`,
      {
        amount: Number(input.amountMinor ?? BigInt(payment.amount ?? 0)),
        currency: (input.currency ?? payment.currency ?? "INR").toUpperCase(),
      },
    );
    if (cap.status >= 300) {
      return {
        purpose: "payment",
        charge: {
          status: "failed",
          // Unlike `charge()`'s pre-payment failures, the payment DOES exist here, and
          // its id is the only handle a reconcile or a settlement webhook has. Losing
          // it is what strands a payment as pending forever.
          providerChargeId: payment.id,
          failure: this.declineFailure(cap.json, cap.status),
          ...razorpayMethodUsed(payment.method),
          raw: cap.json,
        },
      };
    }
    return {
      purpose: "payment",
      charge: {
        // Same rule as `charge()`: only a CAPTURED payment is money in hand. Anything
        // else (including a capture RazorPay accepted but has not settled on an async
        // rail) is pending until `payment.captured` says otherwise.
        status: cap.json?.status === "captured" ? "succeeded" : "pending",
        providerChargeId: cap.json?.id ?? payment.id,
        ...razorpayMethodUsed(cap.json?.method ?? payment.method),
        raw: cap.json,
      },
    };
  }

  /**
   * Contract: what the gateway says about an intent NOW (see `fetchIntent` on
   * `PaymentProvider` for why this exists at all — defect #15, a 21-minute-late
   * `payment.authorized`).
   *
   * ── It has to ask about the ORDER, because that is what we stored ─────────────
   * A RazorPay intent's `payment_intents.intent_at_gateway` is an ORDER id
   * (`order_…`); the money handle is a PAYMENT id
   * (`pay_…`), and measured 2026-09-03 the two appeared together on our
   * side in exactly one place — inside a `provider_events.normalized` blob. So a poll
   * keyed on what we store must query the order and read the payments hanging off it,
   * which is what `GET /orders/{id}/payments` returns. The payment id comes back in
   * `providerChargeId` so the caller does not have to go blob-diving for it.
   *
   * ── Which payment decides the answer ─────────────────────────────────────────
   * An order can carry several attempts. `authorized` WINS over everything else,
   * because it is the only state where money is held and the only one anyone needs to
   * act on; a captured payment is the charge path's business, and failures are noise
   * once a later attempt succeeded. Statuses are RazorPay's own: `created` (attempted,
   * unauthenticated), `authorized`, `captured`, `refunded`, `failed`.
   *
   * ── The one id shape it refuses to guess about ───────────────────────────────
   * The netbanking e-mandate rail stores an `inv_…` auth-link id instead of an order
   * (see `createEmandateAuthLink`), and `GET /orders/inv_…/payments` is a 400. That
   * rail is `purpose: 'setup'` — a mandate registration — and a setup intent holds no
   * money to release, so rather than a second API path for a case with nothing at
   * stake this answers `unknown`, which every caller must already treat as "I learned
   * nothing" (never as "nothing is held"). If a PAYMENT intent ever gets an `inv_…`
   * id, this needs the invoice endpoint, not a looser guess.
   */
  /**
   * ── `resolveOwnership` (#31) ─────────────────────────────────────────────────
   * OFF by default, and that is the design: a capture almost always matches a local
   * row, and buying an extra gateway round trip for every one of them would cost real
   * latency for information nobody needed. Ask for it on the path that has already
   * failed to attribute — the one where "a sibling product's charge" and "our money we
   * lost track of" have to be told apart.
   *
   * It is a SECOND call (`GET /orders/{id}`), not a widening of the one below, because
   * the poll reads `GET /orders/{id}/payments` — which returns payment entities only.
   * The order's own `notes` and `created_at` are not in that response, so there is no
   * free ride to be had here.
   *
   * The ownership fields ARE on the `FetchedIntent` contract now (`ownership`,
   * `ownershipRef`, `providerObjectCreatedAt`, plus `resolveOwnership?: boolean` on the
   * input), so an engine caller holding a `PaymentProvider` can read them; `#31`'s
   * capture classifier is the consumer.
   */
  async fetchIntent(input: {
    intentId: string;
    purpose?: IntentPurpose;
    resolveOwnership?: boolean;
  }): Promise<FetchedIntent & Partial<RazorpayOwnershipReadback>> {
    const intentId = input.intentId;
    if (!intentId.startsWith("order_")) {
      // Not queryable, so nothing was read — and `unknown` is the answer to BOTH
      // questions, never "nothing is held" and never "not ours".
      return {
        intentId,
        status: "unknown",
        ...(input.resolveOwnership ? { ownership: "unknown" as const } : {}),
      };
    }
    const { status, json } = await this.api<{
      items?: Array<{
        id?: string;
        status?: string;
        amount?: number;
        currency?: string;
        captured?: boolean;
      }>;
      error?: { description?: string };
    }>("fetch_intent", "GET", `/orders/${intentId}/payments`);
    // A non-2xx is not evidence about the buyer's money — a 500 or a revoked key says
    // nothing about whether a hold exists. `unknown`, never a verdict.
    if (status >= 300)
      return {
        intentId,
        status: "unknown",
        raw: json,
        ...(input.resolveOwnership ? { ownership: "unknown" as const } : {}),
      };
    const items = json.items ?? [];
    const pick = (...want: string[]) => items.find((p) => want.includes(p.status ?? ""));
    const held = pick("authorized");
    // `refunded` counts only when it was captured first. An uncaptured `refunded` payment
    // is an authorization RazorPay returned on its own: nothing moved, nothing is held.
    const moved = items.find(
      (p) => p.status === "captured" || (p.status === "refunded" && p.captured === true),
    );
    const trying = pick("created", "pending");
    const chosen = held ?? moved ?? trying ?? items[0];
    const state: FetchedIntent["status"] = held
      ? "authorized"
      : moved
        ? "consumed"
        : trying
          ? "requires_action"
          : items.length
            ? "failed"
            : // The order exists and nothing has been attempted against it. Not
              // `unknown`: RazorPay answered, and its answer is "nothing yet".
              "inited";
    return {
      intentId,
      status: state,
      ...(chosen?.id ? { providerChargeId: chosen.id } : {}),
      ...(chosen?.amount != null ? { amountMinor: BigInt(chosen.amount) } : {}),
      ...(chosen?.currency ? { currency: String(chosen.currency).toUpperCase() } : {}),
      ...(input.resolveOwnership ? await this.fetchOrderOwnership(intentId) : {}),
      raw: json,
    };
  }

  /**
   * Read the ownership tag back off an ORDER (#31).
   *
   * This is how a capture is attributed when the event itself cannot answer:
   * `payment.captured` carries the PAYMENT entity's notes, and we do not stamp payments
   * (see the note on `/payments/create/recurring`) — but it does carry `order_id`, and
   * every order this engine creates is stamped. So the order is where the answer lives.
   *
   * Not part of the `PaymentProvider` contract, like `getPayment` and
   * `initiateUpiAutopayCollect`: the contract has no ownership-resolution method yet.
   * Reached through `fetchIntent({ resolveOwnership: true })`, or directly by an
   * operator tool holding the RazorPay adapter.
   *
   * ⚠️ Never a verdict from a failed read. An unreachable gateway, a revoked key or an
   * id shape this cannot query (`inv_…`) all mean we learned nothing — `unknown`, so a
   * bad gateway day cannot be mistaken for someone else's money.
   */
  async fetchOrderOwnership(orderId: string): Promise<RazorpayOwnershipReadback> {
    if (!orderId.startsWith("order_")) return { ownership: "unknown" };
    const { status, json } = await this.api<{
      id?: string;
      notes?: unknown;
      created_at?: number;
      error?: { description?: string };
    }>("fetch_ownership", "GET", `/orders/${orderId}`);
    if (status >= 300) {
      log.warn("razorpay order could not be read for ownership", {
        order: orderId,
        status,
        reason: json?.error?.description ?? JSON.stringify(json),
      });
      return { ownership: "unknown" };
    }
    return razorpayProvenance(json, undefined);
  }

  // ── voidIntent: deliberately NOT implemented ────────────────────────────────
  // RazorPay has no true void. An authorized payment is either captured or left to
  // lapse; the merchant API exposes no release/cancel call for the hold, and faking one
  // with a refund would post REAL money movement for a payment that never settled — a
  // refund at the gateway, a refund row, ledger entries and a statement line for cash
  // that was only ever held. `capabilities.intentVoid: false` is what the UI reads to
  // hide the control, per the contract note on `PaymentProvider.voidIntent`. Do not
  // "helpfully" add a refund-shaped void here.

  async refund(input: RefundInput): Promise<RefundResult> {
    const res = await this.tryApi<{ id: string; status: string }>(
      "refund",
      "POST",
      `/payments/${input.providerChargeId}/refund`,
      {
        ...(input.amountMinor != null ? { amount: Number(input.amountMinor) } : {}),
        // Normal speed, explicit: the documented default, and free; instant refunds carry a fee
        // (razorpay.com/docs/api/refunds/create-normal/, .../payments/refunds/faqs/, 2026-10-29).
        speed: "normal",
        // #31: `notes` is a documented field on the refund-create endpoint (unlike the
        // two s2s payment-create calls, which stay untagged), so a `refund.processed`
        // for a sibling product's refund is now distinguishable from one of ours
        // instead of both arriving as the same anonymous event. It is also how a refund
        // whose answer was lost is found again (`locateRefund`).
        notes: ownershipNotes(input.idempotencyKey),
      },
    );
    // A lost answer or a 5xx is not a refusal: the refund may exist, and creating a
    // second one could pay the customer twice. Find it by our tag, or say we do not know.
    if (res.lost !== undefined || res.status >= 500) {
      const found = await this.locateRefund({
        providerChargeId: input.providerChargeId,
        ownershipRef: input.idempotencyKey,
      }).catch(() => undefined);
      if (found) return found;
      throw new ProviderIndeterminateError(
        `We could not confirm whether RazorPay created the refund on ${input.providerChargeId}: ` +
          (res.lost ?? `HTTP ${res.status} ${JSON.stringify(res.json)}`),
      );
    }
    const { status, json } = res;
    if (classifyGatewayHttp({ status }).kind === "definite") {
      const err = (json as { error?: { code?: string; description?: string } }).error;
      throw new ProviderRefusalError(
        `RazorPay refused the refund (${err?.code ?? `HTTP ${status}`}).` +
          (err?.description ? ` ${err.description.trim()}` : ""),
      );
    }
    return {
      status: status < 300 ? refundStatusOf(json.status) : "failed",
      providerRefundId: json.id ?? "",
      raw: json,
    };
  }

  /**
   * Find a debit whose answer was lost (see `PaymentProvider.locateCharge`). `charge()` makes
   * one order per attempt, with `receipt` and the `notes` tag both derived from the
   * idempotency key, so this lists our orders by receipt since `createdAfter`
   * (`GET /orders?receipt=`) and reads each one's payments (`GET /orders/{id}/payments`).
   *
   * `null` only when no matching order has a payment: RazorPay makes the payment inside the
   * create call, so an order without one 24 hours later was never debited. A throw = we
   * could not ask.
   */
  async locateCharge(input: {
    ownershipRef: string;
    idempotencyKey: string;
    amountMinor: bigint;
    currency: string;
    createdAfter: Date;
  }): Promise<ChargeResult | null> {
    const receipt = boundedProviderKey(input.idempotencyKey, RAZORPAY_RECEIPT_MAX);
    const from = Math.floor(input.createdAfter.getTime() / 1000);
    const orders: Array<{ id: string }> = [];
    for (let skip = 0; ; skip += 100) {
      const q = new URLSearchParams({
        receipt,
        from: String(from),
        count: "100",
        skip: String(skip),
      });
      const res = await this.api<{
        items?: Array<{ id?: string; amount?: number; currency?: string; notes?: unknown }>;
        error?: { description?: string };
      }>("locate_charge", "GET", `/orders?${q}`);
      if (res.status >= 300)
        throw new Error(
          `RazorPay could not list orders by receipt: ${res.status} ` +
            (res.json?.error?.description ?? JSON.stringify(res.json)),
        );
      const items = res.json.items ?? [];
      for (const o of items) {
        if (!o.id || readRazorpayNotes(o.notes).ref !== input.idempotencyKey) continue;
        if (o.amount !== Number(input.amountMinor)) continue;
        if ((o.currency ?? "").toUpperCase() !== input.currency.toUpperCase()) continue;
        orders.push({ id: o.id });
      }
      if (items.length < 100) break;
    }

    const found: ChargeResult[] = [];
    for (const o of orders) {
      const r = await this.chargeOutcomeForOrder(o.id);
      if (!r) throw new Error(`RazorPay could not list the payments of ${o.id}`);
      if (r.result) found.push(r.result);
    }
    if (found.length > 1)
      throw new Error(
        `RazorPay has ${found.length} orders with debits for one attempt; not guessing`,
      );
    return found[0] ?? null;
  }

  /**
   * Contract: find a refund of OURS by the tag `refund()` stamps on it (see `locateRefund` on
   * `PaymentProvider`). null = the payment has no such refund; a throw = we could not ask.
   */
  async locateRefund(input: {
    providerChargeId: string;
    ownershipRef: string;
  }): Promise<RefundResult | null> {
    const { status, json } = await this.api<{
      items?: Array<{ id?: string; status?: string; notes?: unknown }>;
      error?: { description?: string };
    }>("refund", "GET", `/payments/${input.providerChargeId}/refunds?count=100`);
    if (status >= 300) {
      throw new Error(
        `RazorPay could not list the refunds of ${input.providerChargeId}: ${status} ` +
          (json?.error?.description ?? JSON.stringify(json)),
      );
    }
    const mine = (json.items ?? []).find(
      (r) => r.id && readRazorpayNotes(r.notes).ref === input.ownershipRef,
    );
    return mine
      ? { status: refundStatusOf(mine.status), providerRefundId: mine.id!, raw: mine }
      : null;
  }

  /**
   * Register our notification URL with RazorPay, signed with a secret WE choose.
   *
   * RazorPay's merchant API does expose webhook management (contrary to the earlier
   * assumption that it had none), and its create call accepts the signing `secret` —
   * so unlike Stripe (which mints the secret) we hand ours over and keep it. That
   * removes the manual "paste this secret into the RazorPay dashboard" step and gives
   * all three gateways the same zero-config flow.
   *
   * Idempotent by construction, and it has to be: RazorPay HAPPILY accepts a second
   * webhook with an identical URL, which would double-deliver every event forever. So
   * we look the URL up first and UPDATE in place, which also keeps the secret we hold
   * authoritative and reactivates an endpoint someone had disabled.
   *
   * RazorPay API shapes verified live (2026-07-27) — each of these is a 404/400 trap:
   *  - update is **PUT** `/webhooks/:id`; PATCH and POST to that path are both 404.
   *  - PUT requires the full object (`url` at minimum) — a partial body is rejected
   *    with "url: cannot be blank".
   *  - there is **no DELETE** verb; deactivating (`active: false`) is the only removal.
   *  - the URL's host is **resolved** — a placeholder `WEBHOOK_BASE_URL` such as
   *    `…example.invalid` is rejected outright, which is why the caller keeps a
   *    paste-the-secret fallback.
   */
  /**
   * Delete the vaulted token at RazorPay.
   *
   * ⚠️ **An ACTIVE mandate cannot be deleted** (measured live 2026-07-31):
   * `400 "The token you're trying to delete is still active in our systems. Please
   * ensure the token is cancelled before proceeding to delete the same."`
   * RazorPay documents a cancel call for UPI tokens — `PUT /customers/:c/tokens/:t/cancel`
   * (initiated, confirmed or paused tokens; it answers `cancellation_initiated`). We do not
   * call it yet, so an active mandate is still cancelled out of band (payer's UPI app, or
   * the RazorPay dashboard) before the token can go. The earlier probes (2026-07-31) tried
   * POST on that path and 404'd; the documented verb is PUT.
   *
   * That case throws with an actionable message rather than resolving quietly: the
   * caller treats a gateway-delete failure as non-fatal and logs it, so the local
   * row still goes, but the operator needs to hear that a chargeable mandate survived.
   *
   * Idempotent per the contract: RazorPay answers an unknown/already-deleted token
   * with `400 BAD_REQUEST_ERROR "The id provided does not exist"` rather than 404,
   * so both are treated as success. A MALFORMED id ("… is not a valid id") is a
   * caller bug and still throws.
   */
  async deletePaymentMethod(input: {
    customer: ProviderCustomerRef;
    paymentMethod: ProviderPaymentMethodRef;
  }): Promise<void> {
    const custId = input.paymentMethod.providerCustomerId ?? input.customer.providerCustomerId;
    const tokenId = input.paymentMethod.providerPaymentMethodId;
    const { status, json } = await this.api<{
      deleted?: boolean;
      error?: { description?: string };
    }>("delete_payment_method", "DELETE", `/customers/${custId}/tokens/${tokenId}`);
    if (status < 300 || status === 404) return;
    const desc = json?.error?.description ?? "";
    if (/does not exist|not found/i.test(desc)) return;
    if (/still active/i.test(desc)) {
      throw new Error(
        `RazorPay mandate token ${tokenId} (customer ${custId}) is still ACTIVE and cannot be ` +
          `deleted. RazorPay requires a cancellation first, and we do not cancel recurring tokens ` +
          `yet. Cancel the mandate in the RazorPay dashboard, or ask the payer to revoke it in ` +
          `their UPI app. Until then, the instrument remains chargeable at RazorPay.`,
      );
    }
    throw new Error(
      `RazorPay token ${tokenId} could not be deleted for customer ${custId}: ` +
        `${status} ${desc || JSON.stringify(json)}`,
    );
  }

  /**
   * RazorPay has no DELETE for a webhook (measured: 404), so the registration for `url` is
   * switched off with the same full-object PUT that updates it. The operator deletes it in
   * the dashboard.
   */
  async removeWebhookEndpoint(input: { url: string }): Promise<WebhookRemoval> {
    const list = await this.api<{
      items?: Array<{ id: string; url: string; events?: Record<string, boolean> }>;
    }>("remove_webhook", "GET", "/webhooks");
    if (list.status >= 300) throw new Error(`RazorPay could not list webhooks: ${list.status}`);
    let removed = false;
    for (const w of list.json?.items ?? []) {
      if (w.url !== input.url) continue;
      const events = Object.fromEntries(
        Object.entries(w.events ?? {})
          .filter(([, on]) => on)
          .map(([name]) => [name, 1] as const),
      );
      const res = await this.api<{ error?: { description?: string } }>(
        "remove_webhook",
        "PUT",
        `/webhooks/${encodeURIComponent(w.id)}`,
        { url: w.url, events, active: false },
      );
      if (res.status >= 300)
        throw new Error(
          `RazorPay could not switch off webhook ${w.id}: ${res.status} ${res.json?.error?.description ?? ""}`,
        );
      removed = true;
    }
    return { removed, deactivatedOnly: true };
  }

  async provisionWebhookEndpoint(input: {
    url: string;
    secret?: string;
  }): Promise<ProvisionedWebhook> {
    // `events` must be a MAP of name → 1. Passing the documented-looking array makes
    // RazorPay read the array indices as event names ("Invalid event name: 1").
    // The list and why each name is (or is not) on it: `RAZORPAY_WEBHOOK_EVENTS`.
    const events: Record<string, 1> = Object.fromEntries(
      RAZORPAY_WEBHOOK_EVENTS.map((name) => [name, 1] as const),
    );

    const list = await this.api<{ items?: Array<{ id: string; url: string }> }>(
      "provision_webhook",
      "GET",
      "/webhooks",
    );
    const existing = list.json?.items?.find((w) => w.url === input.url);
    const body = {
      url: input.url,
      ...(input.secret ? { secret: input.secret } : {}),
      events,
      // Explicit so re-provisioning revives an endpoint that was deactivated
      // (deactivation is RazorPay's only "delete").
      active: true,
    };
    const res = existing
      ? await this.api<{ id?: string; error?: { description?: string } }>(
          "provision_webhook",
          "PUT",
          `/webhooks/${existing.id}`,
          body,
        )
      : await this.api<{ id?: string; error?: { description?: string } }>(
          "provision_webhook",
          "POST",
          "/webhooks",
          body,
        );
    /**
     * ONE UNKNOWN EVENT NAME MUST NOT COST US THE WHOLE ENDPOINT.
     *
     * RazorPay rejects an entire registration if any single event name is not valid on the
     * account — measured: `400 "Invalid event name/names: token.resumed, token.updated"`. The
     * caller treats a throw here as "auto-provisioning failed" and falls back to
     * `paste_required`, so one unrecognised name silently turns an auto-provisioned endpoint
     * into a manual one and every webhook stops arriving until a human notices.
     *
     * That is a bad trade: the names RazorPay rejects are, by definition, ones it will never
     * send, so dropping them costs nothing while keeping the other fifteen live. It also makes
     * the subscription list safe to extend as their catalog grows, which is exactly what this
     * codebase could not do before — `token.resumed` and `token.updated` are mapped but were
     * left unsubscribed precisely because adding them broke provisioning outright.
     *
     * Retried ONCE. If the second attempt still fails the error is real and propagates.
     */
    let final = res;
    const rejected = parseInvalidEventNames(res.json?.error?.description);
    if (final.status >= 300 && rejected.length > 0) {
      const kept = Object.fromEntries(
        Object.entries(events).filter(([name]) => !rejected.includes(name)),
      );
      if (Object.keys(kept).length > 0) {
        log.warn("razorpay rejected webhook event names — retrying without them", {
          rejected,
          keeping: Object.keys(kept).length,
        });
        const retryBody = { ...body, events: kept };
        final = existing
          ? await this.api<{ id?: string; error?: { description?: string } }>(
              "provision_webhook",
              "PUT",
              `/webhooks/${existing.id}`,
              retryBody,
            )
          : await this.api<{ id?: string; error?: { description?: string } }>(
              "provision_webhook",
              "POST",
              "/webhooks",
              retryBody,
            );
      }
    }
    if (final.status >= 300 || !final.json?.id) {
      throw new Error(
        `RazorPay webhook provisioning failed: ${final.status} ${final.json?.error?.description ?? JSON.stringify(final.json)}`,
      );
    }
    const res2 = final;
    return {
      // Echo our own secret back so the caller stores the key it just registered.
      ...(input.secret ? { webhookSecret: input.secret } : {}),
      providerEndpointId: res2.json!.id,
    };
  }

  /**
   * RazorPay puts the event id in the `x-razorpay-event-id` header, not the body, and sends
   * the same id to every webhook registered on the account.
   */
  webhookEventId(input: NormalizeWebhookInput): string {
    return webhookEventId(
      [headerValue(input.headers, "x-razorpay-event-id"), bodyId(input.payload)],
      input.payload,
    );
  }

  async normalizeWebhook(input: NormalizeWebhookInput): Promise<NormalizedProviderEvent[]> {
    if (!this.cfg.webhookSecret) {
      throw new Error("RAZORPAY_WEBHOOK_SECRET not configured — cannot verify webhook");
    }
    const raw = input.payload.toString();
    const sigHeader = input.headers["x-razorpay-signature"];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    const expected = createHmac("sha256", this.cfg.webhookSecret).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(sig ?? "");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("RazorPay webhook signature verification failed");
    }

    const event = JSON.parse(raw);
    const eventId = this.webhookEventId(input);
    const map: Record<string, NormalizedProviderEvent["type"]> = {
      // Money in hand. `payment.captured` is the terminal success for every rail we
      // charge — an off-session UPI Autopay debit settles here minutes-to-hours after
      // `charge()` returned pending, and an intent settles here after `consumeIntent`
      // captures. `order.paid` says the order is fully paid, which is the same news
      // arriving by a different name.
      "payment.captured": "charge.succeeded",
      "order.paid": "charge.succeeded",
      /**
       * Rail health, normalized so it is queryable as a TYPE rather than buried in
       * `payload`. `provider_events.type` stores the normalized name, so an unmapped
       * event lands as `unknown` and no alert can group on it.
       *
       * ⚠️ Mapping alone does NOT make these arrive: RazorPay only delivers what the
       * endpoint SUBSCRIBES to, and the subscription map above deliberately does not
       * list them yet. See the note there — one unavailable event name 400s the whole
       * registration and silently downgrades the endpoint to `paste_required`, so
       * adding these needs verification against a live account first. Until then this
       * mapping is inert and harmless, and the alert simply reports nothing.
       *
       * `payment.downtime.updated` is not mapped: the alert derives an OPEN outage from
       * a `.started` with no later `.resolved`, so an amendment to a window already
       * open tells it nothing new.
       */
      "payment.downtime.started": "gateway.downtime_started",
      "payment.downtime.resolved": "gateway.downtime_resolved",
      // ⚠️ NOT `charge.succeeded` — it used to be, and that was wrong in the one
      // direction that costs money. An AUTHORIZED payment is funds the gateway is
      // holding, not funds we have: payment intents are created with
      // `payment_capture: 0`, so an authorization is a promise the engine still has to
      // redeem with `consumeIntent`, and an intent nobody consumes simply lapses. Our
      // own `charge()` has always refused to call `authorized` a success for exactly
      // this reason ("Treating `authorized` as succeeded booked cash the gateway had
      // not captured yet") — so the webhook path was contradicting the charge path in
      // the same file, and `reconcileChargeSucceeded` would settle a pending payment
      // on the strength of a hold.
      //
      // It is an INTENT authorization, and it now says so: the buyer cleared the
      // challenge and the gateway is holding funds the engine still has to redeem with
      // `consumeIntent`. Correlation needs BOTH ids and they are not interchangeable —
      // an intent is keyed by the ORDER id (`payload.order.entity.id` →
      // `payment_intents.intent_at_gateway`) while the money handle is the PAYMENT id
      // (`payload.payment.entity.id`), which is why `providerIntentId` exists as its
      // own field. The client's Checkout callback is no longer the only thing that can
      // authorize an intent.
      "payment.authorized": "intent.authorized",
      // Terminal refusal, on both the off-session path and an intent capture.
      "payment.failed": "charge.failed",
      "refund.processed": "charge.refunded",
      // ⚠️ NOT `charge.failed` — it used to be, and that was the wrong term twice
      // over. The CHARGE succeeded and must stay succeeded; what failed is the money
      // going back. Routed at the charge path it correlated on the original
      // PAYMENT's id (`payload.payment.entity.id` → `transactions.id_at_gateway`),
      // so it aimed `reconcileChargeFailed` at a settled payment. Only a status
      // guard saved it — that handler ignores any transaction not in
      // `in_progress`/`timeout`/`needs_attention`, and a refunded payment's is
      // `success` — which meant a refund that never landed was silently dropped and
      // our ledger kept a refund the customer never received. A safety net, not a
      // design. `refund.failed` correlates on the REFUND id and reverses the booking.
      "refund.failed": "refund.failed",
      // A refund's BIRTH. The case this exists for is a refund a human raised in
      // RazorPay's own dashboard: until it processes we hear nothing, and on a slow
      // rail that is days of the customer believing they have been repaid while our
      // books say otherwise.
      //
      // ⚠️ NOT `charge.refunded` — `refund.processed` already books the money, so
      // that would double-book it AND book it before RazorPay had issued anything.
      //
      // ⚠️ MAPPED BUT NOT SUBSCRIBED, like `token.resumed` above and for the same
      // reason: RazorPay validates the event list AS A WHOLE, so an unverified name
      // added to the subscription rejects the entire registration (400 "Invalid event
      // name/names"), and a failed registration falls back to `paste_required` — one
      // bad name silently turns an auto-provisioned endpoint into a manual one. The
      // name goes into the list only once `scripts/probe-razorpay-event-names.ts` has
      // cleared it INDIVIDUALLY. Mapping an event the account does not deliver is
      // harmless; adding it to the list unverified is not.
      "refund.created": "refund.pending",
      // Dispute lifecycle. RazorPay reports the verdict via the dispute entity's
      // `status` on won/lost/closed; created carries the reason + evidence deadline.
      "payment.dispute.created": "dispute.created",
      "payment.dispute.won": "dispute.won",
      "payment.dispute.lost": "dispute.lost",
      "payment.dispute.closed": "dispute.closed",
      "payment.dispute.action_required": "dispute.created",
      // There is no normalized `under_review` type. `dispute.created` upserts the row and
      // refreshes reason + deadline; it does not change a stored status.
      "payment.dispute.under_review": "dispute.created",
      // Automatic card updater: RazorPay has NO first-class card-reissue webhook
      // (the Token API surfaces `token.confirmed`/`token.rejected`/`token.paused`,
      // none of which is a network account-updater refresh). We map a defensive
      // `token.updated` case so that IF RazorPay ships one, refreshed card fields
      // flow through unchanged; today this branch is effectively dormant.
      "token.updated": "payment_method.updated",
      // ── Mandate lifecycle ────────────────────────────────────────────────────
      // These four were already in the SUBSCRIPTION list above (so RazorPay has
      // been delivering them) but had no mapping, so every one landed `unknown`
      // and was dropped. Each is load-bearing on the INR rails:
      //   • `token.confirmed` — a netbanking e-mandate token is `initiated` when
      //     the buyer finishes at their bank and confirms only T+1 (HDFC/SBI).
      //     This is how the engine learns the mandate is chargeable at all.
      //   • `token.rejected` — the bank refused the registration.
      //   • `token.cancelled` — the buyer revoked it (UPI app / bank portal). Our
      //     only push notice; missing it leaves the engine charging a mandate that
      //     no longer exists until a token read (`fetchMandate`) says otherwise.
      //   • `token.paused` — temporarily suspended; debits refuse until resumed.
      "settlement.processed": "settlement.processed",
      "token.confirmed": "payment_method.mandate_updated",
      "token.rejected": "payment_method.mandate_updated",
      "token.cancelled": "payment_method.mandate_updated",
      "token.paused": "payment_method.mandate_updated",
      //   • `token.resumed` — kept MAPPED but NOT subscribed: RazorPay rejects the name
      //     on this account (see the subscription list). Harmless if they ship it later;
      //     until then the un-pause path is `token.confirmed` arriving over a stored
      //     `paused` status.
      "token.resumed": "payment_method.mandate_updated",
    };
    const type = map[event.event] ?? "unknown";
    const occurredAt = new Date((event.created_at ?? Date.now() / 1000) * 1000);

    /**
     * ── Whose object is this? (#31) ──────────────────────────────────────────
     * Answered once, for every branch below, because every branch had the same hole:
     * an event about a sibling product's object and an event about ours that we failed
     * to attribute were reported identically.
     *
     * `order` is preferred as the source of a NEGATIVE verdict and is the only entity
     * allowed to give one — see `razorpayProvenance`. RazorPay expands
     * `payload.order.entity` only when the webhook subscription includes `order.*`, so
     * on most deliveries there is no order here and the honest answer is `unknown`,
     * resolvable through `fetchOrderOwnership` off the `order_id` the payment carries.
     *
     * The primary entity is the one the event is ABOUT, and a refund event is about the
     * refund (a `refund.processed` payload carries the original payment too, and reading
     * that instead would answer for the wrong object).
     */
    const provenance = razorpayProvenance(
      event.payload?.order?.entity,
      event.payload?.refund?.entity ??
        event.payload?.payment?.entity ??
        event.payload?.token?.entity ??
        event.payload?.settlement?.entity ??
        event.payload?.dispute?.entity,
    );

    if (type === "payment_method.mandate_updated") {
      const tok: RazorpayToken | undefined = event.payload?.token?.entity;
      // Trust the token entity's OWN status when it carries one, and fall back to
      // the event name otherwise. RazorPay sends both and they can lag each other;
      // the entity is the authority, the event name is what the entity is
      // *becoming*. Neither is invented — an event we cannot classify is dropped
      // rather than guessed, because writing a wrong mandate status is worse than
      // writing none (it decides whether the engine will attempt a debit at all).
      const fromEvent = event.event?.startsWith("token.")
        ? event.event.slice("token.".length)
        : undefined;
      const rawStatus = tok?.recurring_details?.status ?? fromEvent;
      const status = rawStatus ? normaliseRazorpayMandateStatus(rawStatus) : undefined;
      const mandate = tok ? describeRazorpayMandate(tok) : undefined;
      return [
        {
          providerEventId: eventId,
          type,
          ...(tok?.id ? { providerPaymentMethodId: tok.id } : {}),
          mandate: { ...(mandate ?? {}), ...(status ? { status } : {}) },
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── a refund that did not land, or has not landed YET ─────────────────────
    // Correlated on the REFUND id, never the payment's: the engine has to reverse
    // the refund booking, and the payment it came from is untouched.
    //
    // `refund.pending` shares the branch because the extraction is identical — the
    // object is a refund entity either way — and because the branch is what makes the
    // refund id available at all: without it the generic charge return below would
    // emit the PAYMENT id as `providerChargeId` and no `providerRefundId`, and every
    // refund-keyed consumer returns early without one.
    if (type === "refund.failed" || type === "refund.pending") {
      const rf = event.payload?.refund?.entity as
        | {
            id?: string;
            payment_id?: string;
            amount?: number;
            status?: string;
            error_reason?: string;
            error_code?: string;
          }
        | undefined;
      return [
        {
          providerEventId: eventId,
          type,
          ...(rf?.id ? { providerRefundId: rf.id } : {}),
          // For the inspector's Transaction column only — the engine does not
          // correlate the reversal through it.
          ...(rf?.payment_id ? { providerChargeId: rf.payment_id } : {}),
          ...(rf?.amount != null ? { amountRefundedMinor: BigInt(rf.amount) } : {}),
          ...(rf?.error_reason || rf?.error_code
            ? { providerFailureCode: rf.error_reason ?? rf.error_code }
            : {}),
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── settlement (payout) ───────────────────────────────────────────────────
    // Not a charge term and never booked against an invoice: this is the gateway
    // remitting money it already collected. `settlement.amount` is NET, with `fees` and
    // `tax` (GST on those fees) the deductions that explain the gap from gross — which
    // is the only way collections can be reconciled against the bank.
    if (type === "settlement.processed") {
      const st = event.payload?.settlement?.entity as
        | {
            id?: string;
            amount?: number;
            fees?: number;
            tax?: number;
            status?: string;
            utr?: string;
            created_at?: number;
          }
        | undefined;
      return [
        {
          providerEventId: eventId,
          type,
          ...(st?.id ? { settlementId: st.id } : {}),
          // Signed on purpose: a settlement window whose refunds exceed its collections
          // settles negative, and clamping that at zero would silently lose the debit.
          ...(st?.amount != null ? { settlementAmountMinor: BigInt(st.amount) } : {}),
          ...(st?.fees != null ? { settlementFeesMinor: BigInt(st.fees) } : {}),
          ...(st?.tax != null ? { settlementTaxMinor: BigInt(st.tax) } : {}),
          // RazorPay domestic settlement is always INR; read it rather than assume, so a
          // future export-account payout is not silently mislabelled.
          settlementCurrency:
            (event.payload?.settlement?.entity as { currency?: string })?.currency ?? "INR",
          settlementStatus: st?.status ?? null,
          settlementUtr: st?.utr ?? null,
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    if (type === "payment_method.updated") {
      const tok = event.payload?.token?.entity;
      const card = tok?.card;
      return [
        {
          providerEventId: eventId,
          type,
          providerPaymentMethodId: tok?.id,
          card: {
            brand: card?.network ?? null,
            last4: card?.last4 ?? null,
            expMonth: card?.expiry_month ?? null,
            expYear: card?.expiry_year ?? null,
          },
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── intent lifecycle ──────────────────────────────────────────────────────
    // `payment.authorized`. The ORDER id is the intent's id at the gateway; the
    // PAYMENT id is the charge handle the later capture is keyed on. RazorPay only
    // expands `payload.order.entity` when the webhook subscription includes
    // `order.*`, so fall back to the order id the payment entity itself carries —
    // both name the same order, and dropping the correlation would make the callback
    // inert exactly like the `unknown` mapping it replaces.
    if (type.startsWith("intent.")) {
      const payment = event.payload?.payment?.entity;
      const orderId = event.payload?.order?.entity?.id ?? payment?.order_id;
      /**
       * The NETBANKING e-mandate rail's intent is an auth link, so its
       * `intentAtGateway` is an `inv_…` (see `createEmandateAuthLink`) — while RazorPay
       * mints its own order behind that link and every webhook names THAT order. So
       * correlating on the order id alone missed the intent completely and the whole
       * webhook path was dead for netbanking.
       *
       * Measured 2026-08-14: a buyer confirmed a netbanking mandate; `payment.authorized`
       * arrived carrying `invoice_id` — exactly our intent's id —
       * `order_id`, and `token_id`. It was logged `ignored`,
       * `harvestSetupIntent` never ran, and we held no payment method for a mandate that
       * was live and chargeable at the gateway. That is the precise orphan
       * `harvestSetupIntent` exists to close, reached through the one rail whose id it
       * could not match.
       *
       * `invoice_id` FIRST, because it is only present on the invoice/auth-link flow;
       * the card and UPI rails send it null and keep correlating on the order.
       */
      const intentId = payment?.invoice_id ?? orderId;
      return [
        {
          providerEventId: eventId,
          type,
          ...(intentId ? { providerIntentId: intentId } : {}),
          ...(payment?.id ? { providerChargeId: payment.id } : {}),
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    if (type.startsWith("dispute.")) {
      const d = event.payload?.dispute?.entity;
      return [
        {
          providerEventId: eventId,
          type,
          providerDisputeId: d?.id,
          providerChargeId: d?.payment_id ?? event.payload?.payment?.entity?.id,
          disputeReason: d?.reason_code ?? d?.reason ?? null,
          disputeStatus: d?.status ?? null,
          disputeAmountMinor: d?.amount != null ? BigInt(d.amount) : undefined,
          disputeCurrency: d?.currency ? String(d.currency).toUpperCase() : null,
          evidenceDueBy: d?.respond_by ? new Date(d.respond_by * 1000) : null,
          ...provenance,
          occurredAt,
          raw: event,
        },
      ];
    }

    // ── charge lifecycle ──────────────────────────────────────────────────────
    // On a FAILURE, normalize the decline here rather than leaving the settlement
    // path to invent one. RazorPay's async rails (UPI Autopay, netbanking
    // e-mandate) report every outcome this way — `charge()` returned `pending` and
    // this webhook is the first and only verdict — so without a normalized code
    // smart dunning fell back to fixed retries on exactly the rails that need it.
    // `error_reason` is more specific than `error_code`; prefer it, as
    // `declineFailure` does on the synchronous path, and keep RazorPay's own string
    // alongside ours because normalizing is lossy.
    const payment = event.payload?.payment?.entity;
    const providerFailureCode: string | undefined =
      type === "charge.failed"
        ? (payment?.error_reason ?? payment?.error_code ?? undefined)
        : undefined;
    const norm = providerFailureCode ? normalizeRazorpayDecline(providerFailureCode) : undefined;
    /**
     * CARRY THE ORDER ID ON A CHARGE EVENT TOO (2026-08-31).
     *
     * `providerIntentId` used to be set on `intent.*` only, so a `charge.succeeded` we
     * could not match to a `transactions` row was uncorrelatable and the inbound handler
     * dropped it — `if (!txn) return "ignored"`. Measured on production data, INV-5510:
     * a second "Pay now" minted a new order, the buyer paid it, and RazorPay
     * sent `charge.succeeded` for that payment TWICE. Both were ignored, and the
     * money existed nowhere in the engine — not refundable, not visible, not in the ledger.
     *
     * The payload always carries the order (`payment.entity.order_id`), so the correlation
     * was available all along; only the mapping dropped it. Same resolution as the intent
     * branch below — `invoice_id` first for the netbanking auth-link rail, then the order —
     * because both name the object our `payment_intents.intent_at_gateway` holds.
     *
     * Additive: every existing consumer keys on `providerChargeId`, which is unchanged.
     */
    const chargeIntentId = payment?.invoice_id ?? payment?.order_id;
    /**
     * THE GATEWAY'S OWN CUT, WHICH NOTHING HAS EVER READ (#18).
     *
     * RazorPay puts `fee` and `tax` on the payment entity of every event that carries
     * one, and it has been landing in `provider_events.payload` unread since the adapter
     * was written — no fee column, no fee field on any adapter, no fee account in the
     * ledger. Measured 2026-09-03 on a live payment: `fee: 43192`, `tax: 6588`
     * (₹431.92, of which ₹65.88 GST), identical on `payment.captured`, `order.paid` and
     * `refund.processed`. The fee is NOT returned when the charge is — so the
     * capture-and-refund round trip that engine did on its own cost ₹431.92 that the
     * books record as zero, and the auto-refund alert reported the amount returned while
     * nothing reported the amount lost.
     *
     * Read HERE, at the adapter boundary, so no caller has to know RazorPay's JSON
     * layout (CLAUDE.md: the engine never reaches past the adapter). One extraction
     * covers `charge.succeeded`, `charge.refunded` and `charge.failed`, because all
     * three arrive with a payment entity.
     *
     * ⚠️ Not set on the `intent.*` branch above, and that is honest rather than an
     * oversight: at `payment.authorized` nothing has been captured, so RazorPay reports
     * no fee yet. Absent means unknown, never zero.
     */
    const feeMinor = payment?.fee != null ? BigInt(payment.fee) : undefined;
    const feeTaxMinor = payment?.tax != null ? BigInt(payment.tax) : undefined;
    // RazorPay captures the whole payment, so a captured payment's `amount` is what moved.
    const capturedAmountMinor =
      type === "charge.succeeded" &&
      (payment?.captured === true || payment?.status === "captured") &&
      typeof payment?.amount === "number"
        ? BigInt(payment.amount)
        : undefined;
    /**
     * `refund.processed`: the REFUND id and the payment's running `amount_refunded`. Without
     * them the engine cannot match a refund it already booked and assumes a full refund, so
     * a partial refund booked the rest of the payment as a second, phantom refund.
     */
    const refund =
      type === "charge.refunded"
        ? (event.payload?.refund?.entity as { id?: string; payment_id?: string } | undefined)
        : undefined;
    return [
      {
        providerEventId: eventId,
        type,
        providerChargeId: payment?.id ?? refund?.payment_id,
        ...(capturedAmountMinor != null ? { capturedAmountMinor } : {}),
        ...(refund?.id ? { providerRefundId: refund.id } : {}),
        ...(refund && payment?.amount_refunded != null
          ? { amountRefundedMinor: BigInt(payment.amount_refunded) }
          : {}),
        ...(payment?.amount != null ? { amountMinor: BigInt(payment.amount) } : {}),
        ...(chargeIntentId ? { providerIntentId: chargeIntentId } : {}),
        ...(feeMinor != null ? { feeMinor } : {}),
        ...(feeTaxMinor != null ? { feeTaxMinor } : {}),
        ...(norm ? { failureCode: norm.code, failureRetriable: norm.retriable } : {}),
        ...(providerFailureCode ? { providerFailureCode } : {}),
        ...provenance,
        occurredAt,
        raw: event,
      },
    ];
  }
}
