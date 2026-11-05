/**
 * Does the engine understand everything its own adapters can SAY?
 *
 * Every gateway answer arrives as one of three vocabularies, and each has a consumer that
 * must recognise every word:
 *
 *   1. a normalized EVENT TYPE          → routed by `handleProviderEvent`
 *   2. a synchronous CHARGE STATUS      → branched on by `collectClaimedInvoice`
 *   3. a normalized DECLINE CODE        → classified by `classifyDecline`, named by the taxonomy
 *
 * A word in any of those that no consumer knows does not raise an error. It takes the
 * silent default — `result` stays `ignored`, or `classifyDecline` falls to `retry` — and the
 * only symptom is a payment behaving wrongly in production weeks later.
 *
 * ── WHY THIS GATE EXISTS (2026-09-09, INV-100001) ────────────────────────────────────────
 * `requires_action` was stored as a decline code by the collection failure path. It is a
 * STATUS, and it appeared in none of `STRIPE_CODE_TABLE`, `ALL_DECLINE_RULES`, `TERMINATE`
 * or `PARK` — so `classifyDecline` fell to its liberal default and armed a dunning ladder of
 * unauthenticated retries against a live 3D Secure challenge, on a ₹885 debit. Nothing was
 * red. Every existing test passed. `audit:decline-coverage` could not see it either: it
 * only reports on tokens already written down somewhere, so a token nobody lists is
 * invisible to it, and it is deliberately a report that never exits non-zero.
 *
 * This gate asks the complementary question — not "is the table complete?" but "does
 * every word we can emit reach a consumer that knows it?" — and it FAILS the build.
 *
 * Axis (6) asks the same question in the other direction: does every word we can READ reach
 * the rules that are supposed to interpret it? See its header — that hole cost INV-100004.
 *
 * ── EXHAUSTIVENESS IS THE COMPILER'S JOB, NOT A SCAN'S ───────────────────────────────────
 * The two unions below are declared as `Record<Union, …>`, so adding a member to
 * `NormalizedProviderEvent["type"]` or `ChargeStatus` BREAKS THE BUILD until someone
 * classifies it here. A script that scraped the union with a regex would silently miss the
 * next one, which is the failure mode this whole file is about.
 *
 *   pnpm verify:gateway-vocabulary
 */
import { readFileSync } from "node:fs";
import type { ChargeStatus, NormalizedProviderEvent } from "@/providers/types";
import { PRE_DEBIT_NOT_DUE_CODE } from "@/providers/types";
import {
  ADYEN_CODE_TABLE,
  ADYEN_RULES,
  ALL_DECLINE_RULES,
  AUTHORIZENET_CODE_TABLE,
  AUTHORIZENET_RULES,
  MOLLIE_CODE_TABLE,
  MOLLIE_RULES,
  PAYU_CODE_TABLE,
  PAYU_RULES,
  CYBERSOURCE_CODE_TABLE,
  CYBERSOURCE_RULES,
  SQUARE_CODE_TABLE,
  SQUARE_RULES,
  BRAINTREE_CODE_TABLE,
  BRAINTREE_RULES,
  CASHFREE_CODE_TABLE,
  CASHFREE_RULES,
  CHECKOUTCOM_CODE_TABLE,
  CHECKOUTCOM_RULES,
  type DeclineRule,
  PAYPAL_CODE_TABLE,
  PAYPAL_RULES,
  GOCARDLESS_RULES,
  RAZORPAY_CODE_TABLE,
  RAZORPAY_RULES,
  STRIPE_CODE_TABLE,
  STRIPE_RULES,
  isTerminalDeclineCode,
} from "@/providers/decline-codes";
import {
  HOLD_FOR_NEW_CARD,
  PARK,
  RETRY_THEN_PARK,
  TERMINATE,
  classifyDecline,
} from "@/modules/subscriptions/decline-policy";
import { resolveErrorId } from "@/platform/error-taxonomy";

let failures = 0;
const fail = (what: string, detail: string) => {
  failures++;
  console.log(`  ✗ ${what}\n      ${detail}`);
};
const ok = (what: string) => console.log(`  ✓ ${what}`);

// ── (1) EVENT TYPES ──────────────────────────────────────────────────────────────────────
/**
 * What the engine does with each normalized event.
 *
 * `routed` — `handleProviderEvent` has a branch for it, asserted against the SOURCE below
 *   so a branch deleted in a refactor is caught rather than assumed.
 * `unhandled` — deliberately not consumed, WITH A REASON. This is not an escape hatch: the
 *   reason is the deliverable. An adapter that mints an event nothing reads is either a
 *   missing feature or a pointless normalisation, and writing down which forces the choice.
 */
type Disposition =
  | { state: "routed"; via: string }
  /**
   * Consumed by an ops ALERT derived from `provider_events`, not by the router.
   *
   * A third state rather than a flavour of `unhandled`, because the difference is the
   * whole point: `handleProviderEvent` inserts the delivery row BEFORE routing, so an
   * event the router ignores is still persisted with its normalized type — which makes
   * it readable without a table, a migration, or any change to the charging path.
   */
  | { state: "derived"; alert: string }
  | { state: "unhandled"; why: string };

const EVENTS: Record<NormalizedProviderEvent["type"], Disposition> = {
  "charge.succeeded": { state: "routed", via: 'ev.type === "charge.succeeded"' },
  "charge.failed": { state: "routed", via: 'ev.type === "charge.failed"' },
  "charge.refunded": { state: "routed", via: 'ev.type === "charge.refunded"' },
  "charge.reversed": { state: "routed", via: 'ev.type === "charge.reversed"' },
  "payment_method.updated": { state: "routed", via: 'ev.type === "payment_method.updated"' },
  "payment_method.mandate_updated": {
    state: "routed",
    via: 'ev.type === "payment_method.mandate_updated"',
  },
  "payment_method.detached": { state: "routed", via: 'ev.type === "payment_method.detached"' },
  "refund.failed": { state: "routed", via: 'ev.type === "refund.failed"' },
  "intent.created": { state: "routed", via: 'ev.type === "intent.created"' },
  "intent.requires_action": { state: "routed", via: 'ev.type === "intent.requires_action"' },
  "intent.authorized": { state: "routed", via: 'ev.type.startsWith("intent.")' },
  "intent.failed": { state: "routed", via: 'ev.type.startsWith("intent.")' },
  "intent.voided": { state: "routed", via: 'ev.type.startsWith("intent.")' },
  "intent.setup_succeeded": { state: "routed", via: 'ev.type.startsWith("intent.")' },
  "intent.setup_failed": { state: "routed", via: 'ev.type.startsWith("intent.")' },
  "dispute.created": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "dispute.updated": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "dispute.funds_withdrawn": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "dispute.funds_reinstated": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "dispute.won": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "dispute.lost": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "dispute.closed": { state: "routed", via: 'ev.type.startsWith("dispute.")' },
  "reserve.hold.updated": { state: "routed", via: 'ev.type === "reserve.hold.updated"' },
  "pre_debit_notice.updated": {
    state: "routed",
    via: 'ev.type === "pre_debit_notice.updated"',
  },

  // ── Minted by an adapter, consumed by nothing. Each is a real open question. ──────────
  "fraud_warning.created": { state: "derived", alert: "early_fraud_warning" },
  "settlement.failed": { state: "derived", alert: "gateway_settlement_failed" },
  "gateway.downtime_started": { state: "derived", alert: "gateway_downtime" },
  "gateway.downtime_resolved": { state: "derived", alert: "gateway_downtime" },

  "charge.pending": {
    state: "unhandled",
    why:
      "Stripe and PayPal both mint it, and the SYNCHRONOUS path already books a pending " +
      "charge itself (bookPending). Asynchronously it would be the signal that an attempt " +
      "we booked as failed is actually alive — the INV-100001 shape. Unclaimed today.",
  },
  "charge.updated": {
    state: "unhandled",
    why: "Stripe only. Carries no outcome of its own; every field we track arrives on a typed event.",
  },
  "refund.pending": {
    state: "unhandled",
    why:
      "All three adapters mint it. A refund in flight is already `in_progress` locally, and " +
      "`refund.failed` / `charge.refunded` carry the outcomes. Informational.",
  },
  "settlement.processed": {
    state: "unhandled",
    why:
      "Stripe + RazorPay. Payout-level, not payment-level: no invoice or transaction to " +
      "apply it to until there is a payouts module.",
  },
  "review.opened": {
    state: "unhandled",
    why: "Stripe Radar. A charge under manual review is still pending to us; the outcome arrives as charge.succeeded/failed.",
  },
  "review.closed": {
    state: "unhandled",
    why:
      "Stripe Radar. The review's verdict does not arrive here — an approved charge raises " +
      "charge.succeeded and a refused one charge.failed, both routed. Consuming this would " +
      "duplicate an outcome we already book.",
  },

  // ── Not gateway vocabulary. ───────────────────────────────────────────────────────────
  unknown: {
    state: "unhandled",
    why: "The deliberate catch-all for an event we do not model. Reaching the router and being ignored IS its behaviour.",
  },
};

const ROUTER = readFileSync("src/modules/webhooks/inbound.ts", "utf8");

/**
 * Types no adapter mints, with the reason they are kept anyway.
 *
 * A routed branch for an event nothing produces is dead code that READS as coverage,
 * which is worse than an obvious gap — nobody audits a case that looks handled.
 */
// Empty since the Adyen adapter: a refused payment-intent AUTHORISATION is `intent.failed`.
// `intent.failed` left this list when Authorize.net began minting it (a declined or
// fraud-declined authorization, 2026-10-24).
const NO_PRODUCER: Record<string, string> = {};

console.log("\nevent types — every normalized event reaches a consumer or states why not");
for (const [type, d] of Object.entries(EVENTS) as [string, Disposition][]) {
  if (d.state === "routed" && !ROUTER.includes(d.via))
    fail(`${type} claims to be routed, but the branch is gone`, `expected in inbound.ts: ${d.via}`);
  // That the named alert exists is checked where the alerts live, outside this repo's engine.
  else if (d.state === "derived" && !/^[a-z_]+$/.test(d.alert))
    fail(`${type} claims to be reported by an alert but names none`, "name the alert key");
  else if (d.state === "unhandled" && d.why.trim().length < 40)
    fail(`${type} is unhandled with no real reason`, "a one-word excuse is not a decision");
}
const unhandled = Object.values(EVENTS).filter((d) => d.state === "unhandled").length;
const derived = Object.values(EVENTS).filter((d) => d.state === "derived").length;
if (!failures)
  ok(
    `${Object.keys(EVENTS).length} event types classified ` +
      `(${derived} reported by an alert, ${unhandled} deliberately unhandled)`,
  );

// ── (1b) PRODUCERS ───────────────────────────────────────────────────────────────────────
/**
 * Every type we CONSUME must be minted by some adapter. The reverse direction of the
 * check above, and it found `intent.failed`: a routed branch with no producer anywhere.
 */
console.log("\nproducers — nothing is consumed that no adapter can mint");
const ADAPTERS = [
  "stripe",
  "razorpay",
  "paypal",
  "gocardless",
  "braintree",
  "cashfree",
  "adyen",
  "mollie",
  "payu",
  "cybersource",
  "checkoutcom",
  "authorizenet",
  "square",
  "tmtest/index",
].map((f) => ({
  name: f.replace("/index", ""),
  src: readFileSync(`src/providers/${f}.ts`, "utf8"),
}));
for (const [type, d] of Object.entries(EVENTS) as [string, Disposition][]) {
  if (d.state === "unhandled") continue; // nothing consumes it; a producer is not required
  const minters = ADAPTERS.filter((a) => a.src.includes(`"${type}"`)).map((a) => a.name);
  if (minters.length === 0 && !(type in NO_PRODUCER))
    fail(
      `${type} is consumed but no adapter mints it`,
      "dead vocabulary — delete the branch, or add it to NO_PRODUCER with the reason it stays",
    );
}
for (const type of Object.keys(NO_PRODUCER)) {
  const minters = ADAPTERS.filter((a) => a.src.includes(`"${type}"`)).map((a) => a.name);
  if (minters.length > 0)
    fail(
      `${type} is listed as having no producer, but ${minters.join(", ")} mints it`,
      "stale entry — remove it from NO_PRODUCER",
    );
}
if (!failures)
  ok(
    `every consumed type has a producer ` +
      `(${Object.keys(NO_PRODUCER).length} known exception, documented)`,
  );

// ── (2) CHARGE STATUSES ──────────────────────────────────────────────────────────────────
/**
 * Every synchronous outcome the collection path must branch on. Compiler-exhaustive for the
 * same reason as the events: a fourth status added to `ChargeStatus` must not silently
 * inherit the failure path, which is precisely what `requires_action` did.
 */
const STATUS_HANDLING: Record<ChargeStatus, string> = {
  succeeded: 'a.result.status === "succeeded"',
  pending: 'a.result.status === "pending"',
  requires_action: 'a.result.status === "requires_action"',
  failed: "a.result.failure?.code",
};
const COLLECT = readFileSync("src/modules/invoicing/service.ts", "utf8");
console.log("\ncharge statuses — the collection path branches on each");
for (const [status, needle] of Object.entries(STATUS_HANDLING))
  if (!COLLECT.includes(needle))
    fail(`${status} is not branched on in collectClaimedInvoice`, `expected: ${needle}`);
ok(`${Object.keys(STATUS_HANDLING).length} statuses branched on`);

// ── (3) DECLINE CODES ────────────────────────────────────────────────────────────────────
/**
 * Every canonical token any adapter can produce, from the REAL rules and tables — not a
 * list maintained here, which would drift from the thing it checks.
 */
const emitted = new Set<string>([
  ...ALL_DECLINE_RULES.map((r) => r.code),
  ...Object.values(STRIPE_CODE_TABLE),
  ...Object.values(RAZORPAY_CODE_TABLE),
  ...Object.values(PAYPAL_CODE_TABLE),
  ...Object.values(BRAINTREE_CODE_TABLE),
  ...Object.values(MOLLIE_CODE_TABLE),
  ...Object.values(PAYU_CODE_TABLE),
  ...Object.values(CYBERSOURCE_CODE_TABLE),
  ...Object.values(ADYEN_CODE_TABLE),
  ...Object.values(CHECKOUTCOM_CODE_TABLE),
  ...Object.values(AUTHORIZENET_CODE_TABLE),
  ...Object.values(SQUARE_CODE_TABLE),
  ...Object.values(CASHFREE_CODE_TABLE),
  // An adapter's own code for a debit refused only as too early (Cashfree). Booked only
  // when the caller recorded the attempt before the gateway call.
  PRE_DEBIT_NOT_DUE_CODE,
  /**
   * Not from a rule or a table: the ENGINE mints these when the adapter handed back a
   * failure with no code of its own. They are stored on `transactions.error_code` and
   * reach `classifyDecline` exactly like a gateway token, so leaving them out would
   * exempt the code path that produced the INV-100001 bug in the first place.
   */
  "charge_failed",
  "authentication_required",
  /**
   * The safety net's token for a throw NOTHING recognised (`collectClaimedInvoice`'s
   * attempt catch). Listed here because no rule or table emits it, so without this line
   * the one code the engine mints on its least-understood path is the one the gate cannot
   * see — and an unclassified token there is how a stranded invoice happens.
   */
  "gateway_error",
]);

/**
 * Tokens whose CORRECT policy is the liberal retry default.
 *
 * Named explicitly, because "it retries" must be a decision somebody made rather than the
 * answer everything unrecognised gets. That is the whole distinction this gate enforces:
 * `insufficient_funds` retrying is right; `requires_action` retrying was a hole.
 */
const RETRY_BY_DESIGN = new Set([
  /**
   * The gateway call failed and nothing recognised the reason. RETRIED on purpose: a
   * catch-all cannot tell a malformed request from a timeout or an outage, and parking an
   * outage stops collection on money the next tick would have taken. Corrected 2026-09-10
   * after this branch first booked the parking `gateway_request_rejected` — which is an
   * over-claim, since that token asserts the request was ours to fix.
   */
  "gateway_error",
  // The money was not there TODAY. The account exists and can be funded.
  "insufficient_funds",
  // A transient fault at the gateway or the network, by the providers' own descriptions.
  "processing_error",
  // The adapter gave us a failure with no code. Unclassified is not the same as hard, and
  // marking a working instrument invalid on our own ignorance is the worse error.
  "charge_failed",
  /**
   * The NETWORK refused a re-present as too soon and named when to come back — RazorPay's
   * `already_declined`, "Retry after 24 hours" (captured in
   * `docs/references/RAZORPAY_EMANDATE_ERROR_CODES.md`). Retry is emphatically right: the
   * instrument is fine and the refusal is about timing alone. WHEN is handled separately
   * by `RETRY_NOT_BEFORE_MS`, which floors the next attempt at the window the bank named —
   * so this token retries on the merchant's own schedule, just never inside that window.
   */
  "retry_too_soon",
  // Too early under a still-valid pre-debit notice. The notice is kept and reused.
  PRE_DEBIT_NOT_DUE_CODE,
  // PayU UPI: another notice is still open for the mandate. The collection gate waits and
  // withdraws it; booked only if that keeps failing, and the next cycle clears it.
  "pre_debit_cycle_open",
]);

console.log("\ndecline codes — every token an adapter can emit has a deliberate policy");
/**
 * FIRST, check the allowlist itself. A stale `RETRY_BY_DESIGN` is how this gate would stop
 * testing anything while still printing a tick:
 *
 *  · an entry the policy actually PARKS or TERMINATES makes the bucket counts lie, and the
 *    reviewer reads a policy decision that is not the one in force. Measured on the first
 *    run: `card_declined` was listed here AND in `PARK`, which is what `classifyDecline`
 *    really does with it — the entry came from a docblock example, not from the code.
 *  · an entry nothing emits is dead weight that hides a genuine orphan behind a name that
 *    looks handled.
 */
for (const code of RETRY_BY_DESIGN) {
  if (TERMINATE.has(code) || PARK.has(code) || HOLD_FOR_NEW_CARD.has(code))
    fail(
      `${code} is listed as retry-by-design but the policy ${classifyDecline(code)}s it`,
      "remove it here — the policy is the truth, this list only records the DEFAULT being deliberate",
    );
  else if (!emitted.has(code))
    fail(`${code} is listed as retry-by-design but nothing emits it`, "dead entry — remove it");
  else if (classifyDecline(code) !== "retry")
    fail(`${code} is listed as retry-by-design but classifies as ${classifyDecline(code)}`, "");
}
// `RETRY_THEN_PARK` is a policy of its own (retry, then park after N attempts), so it must
// sit in no other bucket and name only tokens something emits.
for (const code of RETRY_THEN_PARK) {
  if (
    TERMINATE.has(code) ||
    PARK.has(code) ||
    HOLD_FOR_NEW_CARD.has(code) ||
    RETRY_BY_DESIGN.has(code)
  )
    fail(`${code} is retry-then-park but also in another bucket`, "one policy per token");
  else if (!emitted.has(code))
    fail(`${code} is listed as retry-then-park but nothing emits it`, "dead entry — remove it");
}
const orphans: string[] = [];
for (const code of [...emitted].sort()) {
  const classified =
    TERMINATE.has(code) ||
    PARK.has(code) ||
    HOLD_FOR_NEW_CARD.has(code) ||
    RETRY_THEN_PARK.has(code) ||
    RETRY_BY_DESIGN.has(code);
  if (!classified) orphans.push(code);
  // A token the policy TERMINATES must agree with the provider layer's own terminal set,
  // or dunning and the payer-facing copy tell different stories about the same refusal.
  if (TERMINATE.has(code) && !isTerminalDeclineCode(code))
    fail(
      `${code} terminates dunning but is not terminal to the provider layer`,
      "the two disagree",
    );
  // A held card is dead: the provider layer must mark the method invalid.
  if (HOLD_FOR_NEW_CARD.has(code) && !isTerminalDeclineCode(code))
    fail(`${code} is held for a new card but the provider layer would retry it`, "");
}
if (orphans.length)
  fail(
    `${orphans.length} token(s) reach classifyDecline's default with nobody having chosen it`,
    orphans.join(", ") +
      "\n      → add to TERMINATE / PARK / HOLD_FOR_NEW_CARD / RETRY_THEN_PARK, or to RETRY_BY_DESIGN if retrying is genuinely right",
  );
else {
  // The breakdown is printed on SUCCESS too. A gate that says only "ok" cannot be audited,
  // and this one's whole claim is about which bucket each token landed in.
  const n = (s: Set<string>) => [...emitted].filter((c) => s.has(c)).length;
  ok(
    `${emitted.size} emitted tokens, all with a chosen policy ` +
      `(${n(TERMINATE)} terminate · ${n(PARK)} park · ${n(HOLD_FOR_NEW_CARD)} held for a new card · ` +
      `${n(RETRY_THEN_PARK)} retry-then-park · ` +
      `${n(RETRY_BY_DESIGN)} retry-by-design)`,
  );
}

// ── (4) TAXONOMY ─────────────────────────────────────────────────────────────────────────
console.log("\ntaxonomy — every emitted token is named, none falls into the unknown bucket");
const unnamed = [...emitted].filter((c) => !resolveErrorId(c).known).sort();
if (unnamed.length)
  fail(
    `${unnamed.length} token(s) resolve to no family`,
    unnamed.join(", ") + "\n      → add to GATEWAY_FAMILY / BILLING_FAMILY in error-taxonomy.ts",
  );
else ok(`${emitted.size} tokens all resolve to a named family`);

// A status string must never be usable as a decline code again — the INV-100001 bug in one line.
console.log("\nregression — a gateway STATUS is not a decline code");
for (const status of Object.keys(STATUS_HANDLING)) {
  if (status === "failed") continue;
  if (emitted.has(status))
    fail(`the status "${status}" is emitted as a decline token`, "a status is not a refusal");
}
if (classifyDecline("requires_action") === "retry" && !emitted.has("requires_action"))
  ok('"requires_action" is not a decline token (it would classify as retry if stored)');

// ── (5) WIRE COVERAGE, PER GATEWAY ───────────────────────────────────────────────────────
/**
 * Everything above tests OUR vocabulary. This tests the gateways':
 * every event Stripe, RazorPay and PayPal DOCUMENT — within the payment surface we claim —
 * is either recognised by its adapter or dismissed with a reason.
 *
 * Read from the committed captures in `docs/references/*_WEBHOOK.md`, so the gate measures
 * us against the provider's own catalogue rather than against our memory of it. Refresh a
 * capture and this tells you what the gateway added.
 *
 * ⚠️ THE GATEWAYS ARE NOT SYMMETRICAL, and that asymmetry is what bit us. `intent.requires_action`
 * is minted by STRIPE ALONE — RazorPay parks an AFA debit as a plain `pending` and PayPal
 * has no such rail at all. The ₹15,000 gate removed on 2026-09-09 looked safe precisely
 * because it was reasoned about on RazorPay's shape, where the pending path already worked.
 * A per-gateway view is the only one in which that kind of hole is visible.
 *
 * `ignore` entries are matched as a PREFIX, deliberately: a new event under a dismissed
 * prefix (another `payout.*`) is covered automatically, while a new PREFIX fails — which is
 * the alert worth having.
 */
interface WireSpec {
  doc: string;
  /** Captures the event name from the provider's own formatting. */
  extract: RegExp;
  adapter: string;
  /** The part of the provider's surface we claim to consume. */
  scope: string[];
  ignore: { prefix: string; why: string }[];
}

const WIRE: Record<"stripe" | "razorpay" | "paypal", WireSpec> = {
  stripe: {
    doc: "docs/references/STRIPE_WEBHOOK.md",
    extract: /^- `([a-z0-9_]+(?:\.[a-z0-9_]+)+)`/gm,
    adapter: "src/providers/stripe.ts",
    scope: [
      "charge.",
      "payment_intent.",
      "setup_intent.",
      "payment_method.",
      "refund.",
      "review.",
      "radar.",
      "mandate.",
    ],
    ignore: [
      {
        prefix: "payment_intent.partially_funded",
        why: "Customer-balance / Multibanco partial funding. Not a rail we sell on.",
      },
      {
        prefix: "payment_method.attached",
        why: "We attach instruments ourselves and hold the row already; `automatically_updated` is the one that tells us something new.",
      },
      {
        prefix: "radar.early_fraud_warning.updated",
        why: "We take `.created`; an update to a warning we have no surface for adds nothing.",
      },
      {
        prefix: "setup_intent.created",
        why: "We mint every setup intent, so its creation is never news from the gateway.",
      },
    ],
  },
  razorpay: {
    doc: "docs/references/RAZORPAY_WEBHOOK.md",
    extract: /\[([a-z0-9_]+(?:\.[a-z0-9_]+)+)\]\(\/docs/gm,
    adapter: "src/providers/razorpay.ts",
    scope: [
      "payment.",
      "refund.",
      "order.",
      "settlement.",
      "invoice.",
      "transaction.",
      "subscription.",
    ],
    ignore: [
      {
        prefix: "subscription.",
        why:
          "RazorPay-managed subscriptions. Locked decision #1: the billing engine owns " +
          "subscription state and providers only charge/refund/vault — consuming these would " +
          "put a second state machine in charge of our own lifecycle.",
      },
      {
        prefix: "invoice.",
        why: "RazorPay's own invoices. We issue ours; theirs describe documents we never created.",
      },
      {
        prefix: "payment.downtime.updated",
        why:
          "`.started` and `.resolved` are now mapped and reported by the `gateway_downtime` " +
          "alert, which derives an OPEN outage from a start with no matching resolve — so an " +
          "amendment to a window already open tells it nothing new.",
      },
      {
        prefix: "transaction.created",
        why: "Settlement-ledger level. Belongs with a payouts module, which does not exist.",
      },
    ],
  },
  paypal: {
    doc: "docs/references/PAYPAL_WEBHOOK.md",
    extract: /^\|\s*`([A-Z][A-Z0-9_.]+)`/gm,
    adapter: "src/providers/paypal.ts",
    scope: ["PAYMENT.", "CHECKOUT.ORDER", "CUSTOMER.DISPUTE", "VAULT."],
    ignore: [
      {
        prefix: "PAYMENT.PAYOUTSBATCH.",
        why: "Payouts. No payouts module, and nothing here moves a buyer's money to us.",
      },
      {
        prefix: "PAYMENT.ORDER.",
        why: "Legacy v1 orders. We are on Orders v2 (`CHECKOUT.ORDER.*`), which we do consume.",
      },
      {
        prefix: "CHECKOUT.ORDER.PROCESSED",
        why: "Superseded for us by APPROVED and COMPLETED, which bracket the same money and are both handled.",
      },
    ],
  },
};

console.log("\nwire coverage — every documented event in our scope is handled or dismissed");
for (const [key, spec] of Object.entries(WIRE)) {
  let doc: string;
  try {
    doc = readFileSync(spec.doc, "utf8");
  } catch {
    fail(`${key}: the webhook capture is missing`, spec.doc);
    continue;
  }
  const documented = [...doc.matchAll(spec.extract)].map((m) => m[1]!);
  if (documented.length === 0) {
    // A capture whose format changed reads as "nothing documented", which would make this
    // whole section pass while testing nothing.
    fail(
      `${key}: parsed 0 events from its capture`,
      `the doc format changed — fix ${spec.extract}`,
    );
    continue;
  }
  const adapter = readFileSync(spec.adapter, "utf8");
  const inScope = [...new Set(documented)].filter((e) => spec.scope.some((p) => e.startsWith(p)));
  const unhandled = inScope
    .filter((e) => !adapter.includes(`"${e}"`))
    .filter((e) => !spec.ignore.some((i) => e.startsWith(i.prefix)));
  const dismissed = inScope.filter((e) => spec.ignore.some((i) => e.startsWith(i.prefix)));
  if (unhandled.length)
    fail(
      `${key}: ${unhandled.length} documented event(s) in scope reach no consumer and no decision`,
      unhandled.join(", ") +
        `\n      → handle in ${spec.adapter}, or add a prefix + reason to WIRE.${key}.ignore`,
    );
  else
    ok(
      `${key}: ${inScope.length - dismissed.length}/${inScope.length} in-scope events handled` +
        ` (${dismissed.length} dismissed with a reason, of ${new Set(documented).size} documented)`,
    );
  // A dismissal whose prefix no longer matches anything is a decision about an event that
  // no longer exists — it should be deleted, not left looking like coverage.
  for (const i of spec.ignore)
    if (!inScope.some((e) => e.startsWith(i.prefix)))
      fail(
        `${key}: the dismissal for "${i.prefix}" matches no documented in-scope event`,
        "stale — remove it",
      );
}

// ── (6) RULE REACHABILITY ────────────────────────────────────────────────────────────────
/**
 * The INPUT side. Every axis above tests words we can SAY; this one tests whether the words
 * we can HEAR ever reach the table that is supposed to interpret them.
 *
 * ── WHY THIS AXIS EXISTS (2026-09-10, INV-100004) ────────────────────────────────────────
 * `decline-codes.ts` § 5 held a rule for `payment_intent_mandate_inactive`. It never fired.
 * The Stripe adapter consulted the rules on the card-decline and `last_payment_error` paths
 * only, while an HTTP 400 arrives as a THROWN `StripeInvalidRequestError` that met a
 * hardcoded `err.code ===` against one code and was otherwise rethrown — so nine of the ten
 * rules in that section were dead, and the tenth was dead code's alibi. THIS GATE PASSED
 * THE WHOLE TIME: a dead rule still contributes its OUTPUT token, and that token is
 * classified, so axes (3) and (4) counted it as covered.
 *
 * The assertion, in one line: NO ADAPTER MAY HARDCODE A DECISION THE RULES ARE MEANT TO
 * MAKE. If an adapter compares a value that its own gateway's rules also name, that rule's
 * fate is settled by an `if` rather than by the table — which is exactly how a rule dies
 * with nothing turning red. Derived from the REAL rule arrays: a list of codes maintained
 * here would rot in precisely the way it is meant to catch.
 */
const RULES_BY_GATEWAY: Record<string, readonly DeclineRule[]> = {
  stripe: STRIPE_RULES,
  razorpay: RAZORPAY_RULES,
  paypal: PAYPAL_RULES,
  gocardless: GOCARDLESS_RULES,
  braintree: BRAINTREE_RULES,
  mollie: MOLLIE_RULES,
  payu: PAYU_RULES,
  cybersource: CYBERSOURCE_RULES,
  cashfree: CASHFREE_RULES,
  adyen: ADYEN_RULES,
  checkoutcom: CHECKOUTCOM_RULES,
  authorizenet: AUTHORIZENET_RULES,
  square: SQUARE_RULES,
};

/**
 * Literals an adapter may legitimately compare against even though a rule names the same
 * value, WITH THE REASON — same contract as `NO_PRODUCER`, and the reason is the deliverable.
 *
 * Seeded only when a real case turns up; an entry added to quiet a failure, rather than
 * to record a decision, is how this axis stops testing anything.
 */
const HARDCODED_BY_DESIGN: Record<string, string> = {
  payment_intent_unexpected_state:
    "stripe consumeIntent reads the intent when a capture is refused for this state: a pay-now " +
    "Stripe captured at the buyer's confirm is booked, anything else rethrows the same error. " +
    "It decides whether a capture is still owed, not how to treat a decline.",
};

/**
 * Source with comments removed — string-, template- and regex-aware.
 *
 * Not cosmetic. Every adapter DOCUMENTS the codes it used to branch on: stripe.ts names
 * `payment_intent_mandate_inactive` inside the docblock explaining this very fix, and
 * razorpay.ts and paypal.ts do the same for theirs. Scanning raw text would fail the build
 * on the comment describing the bug, and a gate that cries wolf gets deleted rather than
 * fixed. The comparison shape below is the second, independent guard against the same thing.
 *
 * Regex literals are skipped WHOLE rather than scanned: a quote inside a character class
 * would otherwise desync the string tracking for the rest of the file.
 */
function stripComments(src: string): string {
  const REGEX_POS = /[(,=:[!&|?{};+\-*%<>~^]/;
  let out = "";
  let prev = ""; // last significant char — tells a regex literal from a division
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          out += src[i]!;
          i++;
        }
        out += src[i]!;
        i++;
      }
      out += c;
      i++;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || REGEX_POS.test(prev))) {
      i++;
      let inClass = false;
      while (i < src.length) {
        const r = src[i]!;
        if (r === "\\") {
          i += 2;
          continue;
        }
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "\n") break;
        else if (r === "/" && !inClass) {
          i++;
          break;
        }
        i++;
      }
      out += " ";
      prev = "x";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const RE_ESC = /[.*+?^${}()|[\]\\]/g;
/**
 * The shape that means "an adapter decided this": `x === "v"`, `"v" === x`, and
 * `case "v":` — a switch arm settles the answer exactly as hard as an `if` does, and the
 * switch is what stripe.ts used before the rules existed. A bare mention is not a match.
 */
const comparison = (value: string): RegExp => {
  const lit = "[\"']" + value.replace(RE_ESC, "\\$&") + "[\"']";
  return new RegExp(
    "(?:[=!]==?\\s*" + lit + ")|(?:" + lit + "\\s*[=!]==?)|(?:\\bcase\\s+" + lit + "\\s*:)",
  );
};

console.log("\nrule reachability — no adapter hardcodes a decision the rules are meant to make");
const STRIPPED = new Map(
  Object.keys(RULES_BY_GATEWAY).map((g) => [
    g,
    stripComments(ADAPTERS.find((a) => a.name === g)!.src),
  ]),
);
const hardcoded: string[] = [];
const exempted: string[] = [];
let ruleCount = 0;
for (const [gateway, rules] of Object.entries(RULES_BY_GATEWAY)) {
  ruleCount += rules.length;
  const src = STRIPPED.get(gateway)!;
  for (const value of new Set(rules.map((r) => r.value))) {
    if (!comparison(value).test(src)) continue;
    const why = HARDCODED_BY_DESIGN[value];
    if (why === undefined) {
      hardcoded.push(`${gateway}: ${value}`);
      continue;
    }
    exempted.push(value);
    if (why.trim().length < 40)
      fail(
        `${gateway} hardcodes "${value}" with no real reason`,
        "a one-word excuse is not a decision",
      );
  }
}
if (hardcoded.length)
  fail(
    `${hardcoded.length} rule value(s) are decided by an adapter branch, not by the rules`,
    hardcoded.join(", ") +
      "\n      → send the path through the normaliser, or add the value to HARDCODED_BY_DESIGN with the reason it stays",
  );
else
  ok(
    `${ruleCount} rules across ${Object.keys(RULES_BY_GATEWAY).length} adapters, none hardcoded` +
      (exempted.length ? ` (${exempted.length} exempted, documented)` : ""),
  );
// An exemption that matches nothing is a decision about code that no longer exists.
for (const value of Object.keys(HARDCODED_BY_DESIGN))
  if (!exempted.includes(value))
    fail(
      `the hardcode exemption for "${value}" matches no adapter comparison`,
      "stale — remove it",
    );

console.log(
  failures === 0 ? "\ngateway vocabulary: ok\n" : `\ngateway vocabulary: ${failures} failure(s)\n`,
);
process.exit(failures === 0 ? 0 : 1);
