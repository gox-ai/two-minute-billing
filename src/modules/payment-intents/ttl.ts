/**
 * How long a payment intent stays live, BY RAIL.
 *
 * ── Why this is not one hour any more ─────────────────────────────────────────
 * The whole module used a single `INTENT_TTL_MS = 60 * 60 * 1000`, applied at both
 * creation sites. One hour is the right number for exactly one shape of authorization:
 * a card, on-session, buyer sitting in front of the challenge, and `expirePaymentIntents`
 * still says do not shorten it.
 *
 * It is the wrong number for every asynchronous rail, and the cost is measured, not
 * theoretical. Past the deadline `expirePaymentIntents` marks the intent `expired`,
 * which makes it TERMINAL to the inbound webhook path — `applyIntentEvent` opens both
 * authorize cases with `if (terminal) return 'ignored'`. So a bank approval that lands
 * at minute 61 is dropped, and the two ways that shows up in production are:
 *
 *  - a `payment` intent whose hold is real: money held at the gateway with the invoice
 *    still unpaid. **INV-5510** carries two RazorPay orders, the second sitting
 *    `authorized` with a real payment (`pay_XXXXXXXXXXXX01`) and zero engine rows.
 *  - a `setup` intent: a LIVE MANDATE at the gateway with no `payment_methods` row, so
 *    the customer is registered for debits the engine cannot see, let alone collect.
 *
 * Neither is recoverable by retrying — the authorization already happened.
 *
 * ── Why these hours, and why they are the same hours as the sweep's ───────────
 * `payments/stale-pending.ts` already had to answer the identical question for the
 * other end of the same flow ("how long may this legitimately stay unsettled before we
 * stop assuming the callback is on its way"), rail by rail, from each rail's documented
 * worst case. Its `RAIL_GRACE_HOURS` is reproduced here verbatim, with its reasoning:
 *
 *  - **emandate / nach** — up to **2 working days** to authorize (RazorPay must receive
 *    the debit by 08:59 on a bank working day for same-day authorization), and the token
 *    itself confirms T+1 on HDFC/SBI. A weekend sits inside that, so 7 calendar days.
 *  - **card** — above ₹15,000 an INR debit waits on the issuer's AFA link, which is
 *    valid **72 hours**. 96h leaves a margin past its expiry.
 *  - **upi** — minutes to hours in practice; 48h is already far outside normal.
 *  - **bank_transfer** — a netbanking presentation, same clearing cycle as an e-mandate.
 *  - default — 72h for a rail we have not characterised.
 *
 * ⚠️ **The table is DUPLICATED, deliberately, and there is a test that says so.**
 * Sharing it would mean importing from `payments/stale-pending`, and that import closes
 * a cycle: payment-intents/service → payments/stale-pending → payments/settlement →
 * invoicing/service → payment-intents/service (`liveIntentForInvoice`). Splitting the
 * table into a new leaf under `payments/` is the clean answer and is a change to a file
 * this work does not own. So the two copies are pinned together by an assertion in
 * `scripts/verify-stale-pending.ts` that compares this table, rail by rail, against
 * `__graceHoursFor` — the ONLY thing that keeps them from drifting apart in silence.
 *
 * ── The one thing that is NOT a copy: the on-session card fast path ───────────
 * A grace period asks "may we ask the gateway yet". A TTL asks "is this authorization
 * still worth waiting for". They agree on every asynchronous rail, because on those the
 * answer is the same physical clearing window. They disagree on the on-session card,
 * where the thing being waited on is a PERSON in a checkout tab: an hour is generous,
 * four days is a stale `client_secret` and a double-charge guard
 * (`liveIntentForInvoice`) held open on an abandoned checkout.
 *
 * The same is true of the gateway's OWN sheet (`letBuyerChooseMethod`), and there the rail
 * cannot even be consulted: no instrument is passed, so there is nothing to read a rail
 * off. What is being waited on is the buyer typing a card and clearing 3DS inline.
 *
 * ⚠️ Which is the real cost of every extension below, stated plainly: an unconsumed
 * intent against an invoice BLOCKS collection for as long as it lives. On an async rail
 * that is correct and is half the fix — collecting again while the bank is still
 * deciding is how INV-5510 ended up with two orders. On an on-session card it would be
 * a customer waiting days to retry their own abandoned checkout, which is why that case
 * keeps its hour.
 */
import { debitNeedsBuyerAuthentication } from "@/modules/payment-methods/mandate-afa";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The on-session card TTL — 1 hour.
 *
 * ⚠️ Deliberate, and not to be shortened (the note on `expirePaymentIntents` is about
 * this number): the release of the hold at expiry is what changed in 0217, not the
 * deadline. Only applied where the buyer is present and the rail is synchronous — see
 * {@link intentTtlMs}.
 */
export const ON_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * TTL per rail, keyed by `payment_methods.mandate_rail` falling back to the method
 * `type` — the SAME resolution `stale-pending.ts` uses, because it is the same fact
 * about the same instrument.
 *
 * A COPY of `RAIL_GRACE_HOURS` (see the file docblock for why it is a copy and what
 * stops it drifting).
 */
export const RAIL_TTL_HOURS: Record<string, number> = {
  /**
   * ── The Stripe direct-debit rails, added 2026-09-05 with ACH and SEPA ─────────
   *
   * `us_bank_account` fell to the 72-hour default and that was TOO SHORT for the rail's
   * own verification. An ACH bank account that cannot be verified instantly falls back to
   * MICRODEPOSITS: Stripe takes 2–3 BUSINESS days to land them and gives the customer 10
   * days to enter the amounts. A setup started on a Thursday has its deposits arrive the
   * following week — while a 72-hour clock voided the intent on Sunday, before there was
   * anything for the customer to verify. They would have done everything right and found a
   * dead intent, with no event to tell anyone: Stripe sends NOTHING when microdeposits
   * land, by design.
   *
   * 10 days matches the window Stripe itself gives the customer. Ours must not be the
   * shorter clock — an authorization the gateway still considers live is not ours to
   * expire.
   *
   * `sepa_debit` keeps a shorter life on purpose: its mandate is accepted inline in the
   * payment sheet, so there is no out-of-band verification to wait for. 7 days is the same
   * value the other bank-debit rails carry.
   */
  us_bank_account: 24 * 10,
  sepa_debit: 24 * 7,
  emandate: 24 * 7,
  nach: 24 * 7,
  card: 96,
  upi: 48,
  bank_transfer: 24 * 7,
};

/** For a rail we have not characterised. Matches `DEFAULT_GRACE_HOURS`. */
export const DEFAULT_RAIL_TTL_HOURS = 72;

/**
 * The rails on which a PRESENT buyer actually finishes the authorization — the only ones
 * the one-hour deadline can apply to.
 *
 * Just `card`. Being on-session means the buyer is in front of the challenge; it does not
 * make their BANK synchronous. An e-mandate registration submitted while the buyer watches
 * still confirms T+1 on HDFC/SBI, and a netbanking debit still waits for a clearing cycle
 * — so "the buyer is present" answers nothing about how long the authorization takes on
 * every rail but this one. Measured the hard way: the first cut of this function gated the
 * hour on the session alone, and `verify:gateway` C7-TTL caught an on-session e-mandate
 * still being given 1 hour — the exact bug this file exists to remove.
 *
 * An unknown/absent rail is NOT in here: it takes {@link DEFAULT_RAIL_TTL_HOURS}, because
 * expiring an authorization early destroys money while expiring one late costs a held
 * double-charge guard.
 */
export const BUYER_PRESENT_SYNCHRONOUS_RAILS: ReadonlySet<string> = new Set(["card"]);

/** The rail this instrument settles on: its mandate rail, else its method type. */
export function railOf(rail: string | null | undefined, methodType: string | null | undefined) {
  return (rail ?? methodType ?? "").toLowerCase();
}

/** Hours for one rail. Unknown rails take the default rather than the shortest. */
export function railTtlHours(rail: string | null | undefined, methodType?: string | null): number {
  return RAIL_TTL_HOURS[railOf(rail, methodType)] ?? DEFAULT_RAIL_TTL_HOURS;
}

export interface IntentTtlInput {
  /** `payment` captures money; `setup` registers a mandate + vaults an instrument. */
  purpose: "payment" | "setup";
  /** `on_session` = the buyer is present at the challenge. Defaults to on-session. */
  session?: "on_session" | "off_session" | null;
  /** `payment_methods.mandate_rail`, when an instrument row exists. */
  rail?: string | null;
  /**
   * `payment_methods.type` when there is a row, otherwise the requested instrument
   * family (`methodTypes[0]`) — a `setup` intent has no row yet, by definition.
   */
  methodType?: string | null;
  /** Of the debit being authorized. Needed only for the INR AFA threshold. */
  currency?: string | null;
  amountMinor?: bigint | null;
  /**
   * The buyer picks and completes inside the GATEWAY's own sheet — the portal's "Pay now",
   * checkout. `CreatePaymentIntentInput.letBuyerChooseMethod`, unchanged in meaning: the
   * stored instrument is withheld from the adapter, so it gets no say in the deadline
   * either. 3DS finishes inline; no out-of-band issuer link exists to wait on.
   */
  letBuyerChooseMethod?: boolean;
}

/**
 * How long this intent should stay live, in ms.
 *
 * ── The decision, in the order it is made ────────────────────────────────────
 *  1. **A `setup` intent never takes the one-hour path.** Its product is a REGISTERED
 *     MANDATE, and mandate confirmation is asynchronous on every INR rail (T+1 on
 *     HDFC/SBI for netbanking). It is the case the hour hurt most: expire the intent
 *     and the mandate still goes live at the gateway, unattached to any
 *     `payment_methods` row. So a setup intent gets its rail's hours — and when the
 *     rail is not yet known, which is the NORMAL state for a vault setup created before
 *     any instrument exists, it gets {@link DEFAULT_RAIL_TTL_HOURS} (72h). That is the
 *     honest choice, not a fallback: the buyer has not chosen a rail yet, so the intent
 *     must survive the slowest thing they might choose. It is shorter than e-mandate's
 *     7 days on purpose — a `setup` intent holds no money and blocks no collection
 *     (no `invoice_id`, so `liveIntentForInvoice` cannot see it), and if the rail turns
 *     out to be netbanking the mandate registration webhook is what recovers it.
 *  2. **An off-session authorization has no buyer to be present.** Nobody is watching a
 *     tab; the only clock that matters is the rail's. Rail hours.
 *  3. **The buyer completes in the GATEWAY's own sheet** (`letBuyerChooseMethod` — the
 *     portal's "Pay now", checkout). They type a fresh card and clear 3DS INLINE: no
 *     issuer link is sent, and the instrument on file is withheld from the adapter, so it
 *     gets no say here either. One hour — an abandoned sheet must not sit on its invoice
 *     for days.
 *     ⚠️ Tested BEFORE rule 4, not after. This mode passes neither a stored instrument nor
 *     `methodTypes`, so the rail arrives unknown and rule 4 would divert it to the 72h
 *     default — which is how the hour became unreachable for the one flow it describes.
 *     Overtaking rule 4 costs nothing: the asynchronous case rule 4 protects is a MANDATE
 *     registration, and rule 1 has already taken every `setup` intent.
 *     Keyed on the flag alone, never on the gateway: the sheet is Stripe Elements,
 *     RazorPay's overlay or a PayPal approval, and the buyer is present at all three.
 *  4. **A present buyer does not make their BANK synchronous.** Only the rails in
 *     {@link BUYER_PRESENT_SYNCHRONOUS_RAILS} — cards — finish while the buyer is there.
 *     An on-session e-mandate registration still confirms T+1. Rail hours.
 *  5. **An on-session debit that needs the bank's AFA link.** `debitNeedsBuyerAuthentication`
 *     — INR, above ₹15,000, on card/UPI — means the buyer does not finish inline: the
 *     issuer sends a link, and that link is valid 72 hours. Measured 2026-08-13 on one
 *     mandate with a control: ₹13,870 captured while ₹28,215 and ₹56,715 were accepted
 *     and then sat in `created`, waiting on it. An hour is a fifth of a working day
 *     there. Rail hours (card 96h ⇒ past the link's own expiry).
 *     What reaches here is a debit on a STORED mandate, which is what that run measured —
 *     a gateway sheet has already taken rule 3.
 *  6. **Otherwise — on-session, synchronous, buyer present: one hour.** Unchanged, for
 *     the case it was chosen for.
 */
export function intentTtlMs(input: IntentTtlInput): number {
  const rail = railOf(input.rail, input.methodType);
  if (input.purpose === "setup") return railTtlHours(rail) * HOUR_MS;
  if ((input.session ?? "on_session") === "off_session") return railTtlHours(rail) * HOUR_MS;
  // Ahead of the rail test on purpose: this mode withholds the instrument, so `rail` is
  // unknown here and the line below would give an inline 3DS checkout the 72h default.
  // Safe, because setup and off-session have already returned: what is left is a
  // buyer-present PAYMENT, and those finish in the sheet on every gateway.
  if (input.letBuyerChooseMethod) return ON_SESSION_TTL_MS;
  // A present buyer only shortens the wait on a rail that finishes while they are there.
  if (!BUYER_PRESENT_SYNCHRONOUS_RAILS.has(rail)) return railTtlHours(rail) * HOUR_MS;
  const needsAfaLink =
    input.currency != null &&
    input.amountMinor != null &&
    debitNeedsBuyerAuthentication(
      { mandateRail: input.rail ?? null, type: input.methodType ?? null },
      input.currency,
      input.amountMinor,
    );
  if (needsAfaLink) return railTtlHours(rail) * HOUR_MS;
  return ON_SESSION_TTL_MS;
}

/** The deadline to persist on `payment_intents.expires_at`. */
export function intentExpiresAt(now: Date, input: IntentTtlInput): Date {
  return new Date(now.getTime() + intentTtlMs(input));
}
