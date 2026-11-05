/**
 * RBI/NPCI additional-factor authentication — the rule that decides whether an INR
 * mandate debit can be collected off-session, or has to stop and wait for the payer.
 *
 * ── Why this is a LEAF module ─────────────────────────────────────────────────
 * It imports nothing. That is deliberate and load-bearing: the predicate is needed
 * by `transactions/serialize.ts`, which was itself split out of `transactions/service`
 * precisely to avoid the cycle serialize → service → events/emit → events/content →
 * serialize. `payment-methods/service` imports `events/emit`, so importing the
 * predicate from THERE would close that same cycle by a different door.
 *
 * `payment-methods/service` re-exports everything here, so existing importers are
 * unaffected and there is still one obvious place to look.
 */

/**
 * ₹15,000 in paise — the per-debit amount above which an INR e-mandate stops being
 * off-session.
 *
 * RBI's e-mandate framework (and NPCI's for UPI) auto-debits without
 * re-authentication only up to this figure. Above it the debit needs additional-factor
 * authentication from the buyer.
 *
 * ⚠️ The ₹1,00,000 figure people reach for is a **category** exemption — mutual-fund
 * SIPs, insurance premiums and credit-card bill payments — and a SaaS subscription is
 * none of those. ₹15,000 is the figure that applies to us.
 *
 * ⚠️ This is a property of the RAIL, not of any one gateway — a Stripe India
 * e-mandate obeys the identical rule — which is why it lives in the payment-methods
 * module rather than in `providers/razorpay.ts`.
 */
export const INR_AFA_FREE_CEILING_MINOR = 1_500_000n;

/**
 * Whether a single debit of this size needs additional-factor authentication from
 * the buyer, i.e. cannot be collected off-session.
 *
 * Only INR is in scope: the threshold is an RBI/NPCI rule about Indian e-mandates,
 * not a general one. A non-INR amount always answers false.
 */
export function requiresAfaPerDebit(currency: string, amountMinor: bigint): boolean {
  return currency.toUpperCase() === "INR" && amountMinor > INR_AFA_FREE_CEILING_MINOR;
}

/**
 * Rails on which a debit above {@link INR_AFA_FREE_CEILING_MINOR} pauses for the
 * buyer, keyed by `payment_methods.mandate_rail` (falling back to the method type).
 *
 * The threshold is a rule about the DEBIT; whether a rail has to stop and ask is a
 * property of how that rail authenticates, and the two are not the same question:
 *
 *  - **card** — MEASURED 2026-08-13 on one mandate, with a control: ₹13,870 captured
 *    while ₹28,215 and ₹56,715 were accepted and then sat in `created` indefinitely,
 *    waiting on the issuer's AFA link.
 *  - **upi** — INFERRED, not measured. NPCI's per-debit approval applies above the
 *    same figure for our merchant category, but the only evidence we hold is a
 *    ₹66,025 sandbox debit that settled — and `success@razorpay` auto-approves, so it
 *    proves nothing about production. Listed here because the conservative error is
 *    to warn a buyer who did not need it; the other way round is a silent stall.
 *  - **emandate / nach / bank_transfer** — EXCLUDED, measured: the netbanking rail
 *    authenticates once at registration, and a ₹66,025 off-session debit against a
 *    real HDFC mandate captured and settled by webhook (`pay_XXXXXXXXXXXX23`). This
 *    is what makes netbanking the only rail that renews unattended above ₹15,000.
 *
 * An unknown rail is NOT assumed to need AFA: this drives a customer-facing notice,
 * and mailing "your bank will ask you to authenticate" to someone whose bank never
 * will is its own kind of wrong. Card and UPI are named explicitly.
 */
export const RAILS_NEEDING_PER_DEBIT_AFA: ReadonlySet<string> = new Set(["card", "upi"]);

/**
 * Will this specific debit stop and wait for the buyer?
 *
 * Combines the amount rule with the rail rule. Used at four moments that must all
 * agree: when the debit is booked pending (to tell the customer it needs them), when
 * the stale-pending sweep decides whether an unsettled attempt is a stalled
 * authentication or an ordinary slow settlement, and when the portal and the
 * transaction serializer describe that wait to a buyer or an operator.
 */
export function debitNeedsBuyerAuthentication(
  pm: { mandateRail?: string | null; type?: string | null; issuerCountry?: string | null },
  currency: string,
  amountMinor: bigint,
): boolean {
  if (!requiresAfaPerDebit(currency, amountMinor)) return false;
  /**
   * RBI's rules bind cards ISSUED IN INDIA, and until 2026-09-12 this function had no way
   * to know — it read the debit's CURRENCY, which is only a proxy for the issuer's
   * country. An international card billed in INR was told its bank would ask it to
   * authenticate, under a regulation that does not govern it.
   *
   * ⚠️ ONLY A KNOWN-FOREIGN ISSUER SUPPRESSES THE CLAIM. `undefined`/`null` is UNKNOWN,
   * not "not India": every row vaulted before the column existed is null, RazorPay and
   * PayPal report nothing here today, and reading silence as "foreign" would switch the
   * warning off for the entire Indian book at a stroke. So unknown keeps the previous
   * currency-based answer, and the column can only ever make this function quieter about
   * an instrument a gateway has positively said is foreign.
   */
  const issuer = pm.issuerCountry?.trim().toUpperCase();
  if (issuer && issuer !== "IN") return false;
  const rail = (pm.mandateRail ?? pm.type ?? "").toLowerCase();
  return RAILS_NEEDING_PER_DEBIT_AFA.has(rail);
}

/**
 * The largest per-debit ceiling each mandate RAIL can be registered with, in minor
 * units of INR.
 *
 * A rail property, not a gateway one — the same reason `INR_AFA_FREE_CEILING_MINOR`
 * lives here. NPCI caps a UPI Autopay mandate at ₹1,00,000 for our merchant category;
 * ask for more and the order is refused outright ("Max amount for UPI recurring payment
 * for this merchant category code cannot be greater than Rs. 100000.00"), which is why
 * `createMandateOrder` clamps instead. Cards and netbanking e-mandates carry ₹10,00,000.
 *
 * ⚠️ `providers/razorpay.ts` holds its own copies (`MAX_UPI_MANDATE_MAX_AMOUNT`,
 * `MAX_MANDATE_MAX_AMOUNT`) because providers are a lower layer than modules and must not
 * import from it. `test/unit/mandate.test.ts` pins the two together — the test IS the
 * link, so a cap corrected in one place cannot silently disagree with the other.
 *
 * Used to STEER, never to block: a required ceiling above a rail's cap means that rail
 * cannot collect this subscription unattended, so the buyer is pointed at one that can
 * (netbanking e-mandate, or a card). All three rails still work for smaller debits.
 */
export const MANDATE_RAIL_MAX_CEILING_MINOR: Record<string, bigint> = {
  upi: 10_000_000n,
  card: 100_000_000n,
  emandate: 100_000_000n,
  nach: 100_000_000n,
};

/**
 * The SMALLEST cap in the table above — NPCI's ₹1,00,000 for UPI Autopay.
 *
 * Derived rather than written down, so it cannot drift from the caps it summarises.
 *
 * ── What it is for: a ceiling nobody can register is not generosity ───────────
 * `withMandateHeadroom` (`payment-methods/service.ts`) clamps the requested ceiling
 * here. Asking for MORE than this buys nothing and costs something concrete:
 *
 *  - RazorPay clamps it anyway (`createMandateOrder`, `MAX_UPI_MANDATE_MAX_AMOUNT`),
 *    so the number we asked for is not the number the mandate carries; and
 *  - `railsOverCeilingCap` compares the REQUESTED ceiling to each cap, so an
 *    over-cap request withdraws UPI Autopay from the buyer's options at
 *    registration — for a debit UPI could have carried perfectly well.
 *
 * With the clamp in place, `railsOverCeilingCap` flags UPI only when the DEBIT
 * itself is above the cap, which is the question it was always trying to ask.
 *
 * ⚠️ It is read in minor units of whatever the mandate is denominated in, and the
 * caps are INR paise — the same denomination hazard `MANDATE_FALLBACK_CEILING`
 * documents ("100,000 minor units means ₹1,000 but also $1,000"). It is defensible
 * HERE, and only here, for two measured reasons: in INR it is exactly the rail cap,
 * and in any other currency 10,000,000 minor units is $100,000 / €100,000 PER DEBIT,
 * above every subscription this platform bills — so the clamp is unreachable rather
 * than wrong. `withMandateHeadroom` additionally refuses to clamp below the sized
 * amount, so even a debit larger than this keeps its full headroom.
 */
export const SMALLEST_RAIL_CEILING_CAP_MINOR: bigint = Object.values(
  MANDATE_RAIL_MAX_CEILING_MINOR,
).reduce((a, b) => (b < a ? b : a));

/**
 * The currency {@link MANDATE_RAIL_MAX_CEILING_MINOR} is denominated in.
 *
 * Named rather than left in prose because the figures are NPCI's and RBI's, i.e. rupees,
 * and a bigint carries no denomination of its own — the only thing standing between
 * ₹1,00,000 and "$100,000" is the caller knowing which one it holds.
 */
export const MANDATE_RAIL_CEILING_CURRENCY = "INR";

/**
 * Rails that cannot be registered with this ceiling, out of the ones on offer.
 *
 * An unknown rail is treated as capable: the caps above are the ones we have measured,
 * and inventing a limit for a rail we know nothing about would hide an option that works.
 *
 * ⚠️ `currency` — the denomination `ceilingMinor` is expressed in. The caps are INR
 * figures, so any other currency cannot be compared to them and the answer is "no rail is
 * over cap", not a comparison across denominations. `mandateRefusal`
 * (`modules/invoicing/collection.ts`) sets the precedent one file over: a ceiling in a
 * different currency is SKIPPED rather than guessed at, because an FX rate invented at
 * the comparison site is worse than not checking.
 *
 * What it costs when the currency is dropped, and why this parameter exists (F-24): a
 * checkout session in USD with a required ceiling above 10,000,000 minor (~$100k) reported
 * `upi` over cap for a business that has no Indian rail at all, and the buyer was shown
 * "UPI Autopay cannot be approved for $X per charge — your bank caps it lower". No bank
 * involved in that session caps anything, and there was no UPI on offer to be capped.
 *
 * OPTIONAL, and omitting it keeps the exact previous behaviour (the figures are read as
 * INR). That is deliberate: the one call site today —
 * `resolveSessionMandateRequirement` in `modules/checkout/service.ts` — is correct for
 * INR sessions and must not change meaning underneath itself. It should pass the
 * session's currency; until it does, a non-INR session keeps the old wrong answer rather
 * than acquiring a new one.
 */
export function railsOverCeilingCap(
  ceilingMinor: bigint,
  rails: string[],
  currency?: string | null,
): string[] {
  if (currency && currency.toUpperCase() !== MANDATE_RAIL_CEILING_CURRENCY) return [];
  return rails.filter((r) => {
    const cap = MANDATE_RAIL_MAX_CEILING_MINOR[r.toLowerCase()];
    return cap != null && ceilingMinor > cap;
  });
}

/**
 * ── The mandate STATUS vocabulary, canonical ──────────────────────────────────
 *
 * `payment_methods.mandate_status` holds a PROVIDER-vocabulary string, normalised by
 * the adapters to one shared set rather than left raw per gateway: RazorPay reports
 * `recurring_details.status` (`initiated` | `confirmed` | `rejected` | `cancelled` |
 * `paused`) and `describeStripeMandate` maps Stripe's three (`active` | `pending` |
 * `inactive`) onto the SAME words, so a mandate read from a webhook and the same mandate
 * read from an API call can never disagree.
 *
 * These four sets live here — the leaf module that imports nothing — because they are a
 * property of the vocabulary, not of any one consumer, and they had already been copied
 * twice: `DEAD_MANDATE_STATUSES` was private to `modules/webhooks/inbound.ts` (which now
 * imports it from here) and `MANDATE_LIVE_STATUSES` is declared again in the buyer portal
 * (`dashboard/app/(storefront)/portal/(session)/portal-chrome.tsx`). The dashboard is a
 * separate package whose `@/*` resolves inside `dashboard/`, so it CANNOT import this
 * file; that copy stays, and stays deliberately — if you change a set here, change it
 * there too or the portal will describe an instrument the engine disagrees with.
 *
 * ── Partition, but only over the vocabulary the adapters actually emit (F-43) ──────
 * The sets are a PARTITION of {@link MANDATE_NORMALISED_STATUSES} — every status either
 * adapter normalises to lands in exactly one of them, and `test/unit/mandate.test.ts`
 * asserts both halves (pairwise disjoint, and the union is exactly that list). They are
 * still OPEN at the edge: `mandateChargeability` answers `unknown` for anything outside,
 * because a status we have no rule for must be treated as a claim we cannot make rather
 * than folded into the nearest neighbour.
 *
 * `spent` used to be the counter-example — a real status in none of the sets, so
 * `mandateChargeability` called it `unknown`, the pending guard did not refuse it and
 * collection went on debiting a single-use authorization that had already been used
 * (F-43). It now has its own set rather than being pushed into the dead one; see
 * {@link MANDATE_SPENT_STATUSES} for why the distinction is worth a fourth answer.
 */

/** Authorised and debitable off-session. The only statuses that can be charged. */
export const MANDATE_LIVE_STATUSES: ReadonlySet<string> = new Set(["confirmed", "active"]);

/**
 * Over: revoked at the bank, refused, or suspended. `applyMandateUpdate` flips
 * `payment_methods.status` to `invalid` on these; a resume from `paused` is the one
 * revival that puts it back.
 *
 * ⚠️ That flip is widely described in this codebase as "what takes the instrument out of
 * collection". It is not, quite: `resolveChargeCandidates` does not filter on
 * `payment_methods.status`, so an `invalid` instrument is still SELECTED and still
 * debited — the gateway is what refuses it. `invalid` is what stops a new auto-collect
 * subscription (`assertChargeableForAutoCollect`) and what the operator and the payer are
 * shown. Anything that must not reach the gateway needs a charge pre-flight in
 * `modules/invoicing/collection.ts`, which is why F-11 and F-43 both added one.
 */
export const DEAD_MANDATE_STATUSES: ReadonlySet<string> = new Set([
  "rejected",
  "cancelled",
  "paused",
]);

/**
 * Registered, and waiting on the bank to confirm it. NOT debitable yet, through nobody's
 * fault — a netbanking e-mandate is `initiated` from the moment the buyer finishes at
 * their bank until the bank confirms, and HDFC and SBI take until T+1.
 *
 * One value, not a guess at more: both adapters normalise to `initiated`, and a wider set
 * would be inventing pending-ness for statuses we have never seen.
 */
export const MANDATE_PENDING_STATUSES: ReadonlySet<string> = new Set(["initiated"]);

/**
 * USED UP, and nothing is wrong. A `single_use` Stripe mandate that has gone `inactive`
 * is one that already carried its one debit — `describeStripeMandate` reports it as
 * `spent` precisely because Stripe's `inactive` means REVOKED on a `multi_use` mandate
 * and merely "previously used" on a single-use one, and those are not the same news.
 *
 * ── Why this is NOT in DEAD_MANDATE_STATUSES (F-43) ───────────────────────────────
 * Membership of that set is not a label, it is an INSTRUCTION: `applyMandateUpdate`
 * writes `payment_methods.status = 'invalid'` for every status in it. `invalid` is the
 * status a hard decline writes and the one an operator reads as "the bank refused this
 * instrument" — and nothing here was refused. The mandate did exactly what the buyer
 * authorised it to do, once.
 *
 * More decisively, joining the dead set would not have FIXED anything. Flipping the
 * instrument to `invalid` is widely described as "what takes it out of collection", but
 * `resolveChargeCandidates` (`modules/invoicing/collection.ts`) does not filter on
 * `payment_methods.status` at all — the known soft-decline hole — so a spent mandate
 * would still be selected, still be debited, and still be refused at the gateway. What
 * actually stops the debit is the charge pre-flight, `mandateSpentRefusal`, which is
 * therefore where the fix lives.
 *
 * Reversible on purpose: if operators later want a spent mandate to invalidate the
 * instrument, adding `"spent"` to `DEAD_MANDATE_STATUSES` is a one-line change and the
 * refusal stays correct either way.
 */
export const MANDATE_SPENT_STATUSES: ReadonlySet<string> = new Set(["spent"]);

/**
 * The instrument NEEDS a mandate on this gateway and has none — learned from the gateway,
 * never guessed.
 *
 * Not a status any provider reports. It is written by the collection path when a debit
 * comes back `mandate_missing` (Stripe: "The parameter `mandate` is not provided or
 * invalid"), so the SECOND attempt is refused before the gateway is asked and the first is
 * the only one that ever costs a round trip.
 *
 * WHY LEARNED RATHER THAN DERIVED. The obvious shortcut is to refuse every INR debit whose
 * instrument has no reference. Measured against production: all 13 migrated Stripe methods
 * are bare — rail, status and ceiling NULL — because the imported `payment_source` carries
 * no mandate data, so a bare row is indistinguishable from a plain card-on-file, and the
 * currency is only a proxy for the issuer's country (an international card billed in INR
 * needs no RBI e-mandate). Guessing would have declined renewals that collect fine. The
 * gateway already knows the answer and gives it once; this is where we keep it.
 */
export const MANDATE_MISSING_STATUS = "missing";

/**
 * Every status either adapter normalises a mandate to. The four sets above partition
 * exactly this list — pinned rather than derived so that adding a fifth normalised word
 * without classifying it turns a test red instead of silently becoming `unknown`.
 *
 * RazorPay reports `recurring_details.status` (`initiated` | `confirmed` | `rejected` |
 * `cancelled` | `paused`); `describeStripeMandate` maps `active` → `confirmed`,
 * `pending` → `initiated`, and `inactive` → `cancelled` (multi-use) or `spent`
 * (single-use).
 */
export const MANDATE_NORMALISED_STATUSES: readonly string[] = [
  "confirmed",
  "active",
  "initiated",
  "rejected",
  "cancelled",
  "paused",
  "spent",
  // ⚠️ MANDATE_MISSING_STATUS is deliberately NOT here. This list is the vocabulary the
  // ADAPTERS emit, and the four sets below are a partition of it (asserted). `missing` is
  // ours — written by the collection path from a refusal, never reported by a provider —
  // so adding it would either break that partition or force it into a set it does not
  // belong to. `mandateChargeability` gives it its own answer instead.
];

/**
 * What the mandate behind an instrument is doing right now, as far as we can honestly
 * tell. The engine-side twin of the portal's `mandateState`.
 *
 * `none` (no status reported at all) and `unknown` (a status in none of the four sets)
 * are kept apart on purpose even though every caller today treats them the same: they are
 * different facts — "this instrument has no mandate" versus "this mandate is in a state
 * we have no rule for" — and only the second one is worth a log line when it shows up.
 *
 * `spent` is likewise kept apart from `dead`: both mean "this cannot be debited again",
 * but only one of them means something went wrong, and the difference is what the payer
 * is told and whether the instrument gets branded.
 */
export type MandateChargeability =
  | "live"
  | "pending"
  | "dead"
  | "spent"
  | "missing"
  | "unknown"
  | "none";

export function mandateChargeability(pm: { mandateStatus?: string | null }): MandateChargeability {
  const status = pm.mandateStatus?.trim().toLowerCase();
  if (!status) return "none";
  if (MANDATE_LIVE_STATUSES.has(status)) return "live";
  if (MANDATE_PENDING_STATUSES.has(status)) return "pending";
  if (DEAD_MANDATE_STATUSES.has(status)) return "dead";
  if (MANDATE_SPENT_STATUSES.has(status)) return "spent";
  // Ours, not a provider's — see MANDATE_MISSING_STATUS. Kept apart from `none` (nothing
  // reported) and from `dead` (a mandate that existed and ended): this one means we ASKED
  // and the gateway said an authorization is required and absent.
  if (status === MANDATE_MISSING_STATUS) return "missing";
  return "unknown";
}

/**
 * Has this instrument's mandate passed its END DATE?
 *
 * A SEPARATE AXIS from {@link mandateChargeability}, deliberately, and not folded into
 * it: expiry is a fact about the clock, chargeability is a fact about the status the
 * gateway last reported, and the two disagree in the case that matters — a mandate
 * RazorPay still calls `confirmed` whose own `expired_at` has gone by. Folding expiry
 * into the status vocabulary would also break that vocabulary's partition invariant
 * (`MANDATE_NORMALISED_STATUSES`), which exists so that an unclassified status turns a
 * test red rather than becoming `unknown`.
 *
 * ── NULL means UNKNOWN, never "no expiry" ─────────────────────────────────────
 * The same rule `mandate_max_amount_minor` follows, and for the same reason: the column
 * is null for a plain card-on-file, for a provider that reports no end date, and for
 * every row vaulted before 0179. Reading null as "never expires" would turn missing data
 * into a permission. Reading it as expired would refuse every card on file.
 *
 * ── What we send vs what we store, measured 2026-09-01 ────────────────────────
 * `providers/razorpay.ts` sends `expire_at = now + 10 years` on every rail
 * (`createMandateOrder`, and the auth-link path at :921 — its `expire_by = now + 7d` is
 * the LINK's shelf life and reaches no mandate field). We then store what the gateway
 * RETURNS (`describeRazorpayMandate` reads `tok.expired_at`), because the number the
 * engine must respect at debit time is RazorPay's, not ours.
 *
 * The two differ, and only on cards. 137 RazorPay card mandates in the dev database hold
 * just THREE distinct expiry instants, all end-of-day IST and none of them our +10y:
 * 115 at `2026-08-31T18:29:59Z`, 2 at `2026-09-30T18:29:59Z` (created four minutes after
 * IST midnight rolled into September), 20 at `2030-12-31T18:29:59Z`. All 137 carry a
 * printed card expiry of 01/2099, so the value is NOT the card's own expiry. The 4 `upi`
 * and 2 `emandate` rows came back at +10y almost to the second, matching what we sent.
 *
 * So a card mandate can be handed back an end date inside the CURRENT MONTH — and on the
 * measurement above, **115 rows were already past it while still reporting
 * `mandate_status: confirmed`**, i.e. the engine held the fact that they were dead and
 * debited them anyway. That is the gap {@link mandateHasExpired} closes.
 *
 * ⚠️ All of those rows are TEST mode. Whether live-mode RazorPay shortens a card
 * mandate the same way is UNVERIFIED and needs a live token read; do not report this as
 * live mandates lapsing. The engine-side gap is worth closing either way — it is a
 * missing pre-flight over a fact we already store, not a guess about RazorPay.
 *
 * No grace period. A grace would be us overriding the gateway's own end date with an
 * invented one, and the debit it let through would be refused by RazorPay anyway — which
 * is the generic decline this pre-flight exists to avoid.
 */
export function mandateHasExpired(
  pm: { mandateExpiresAt?: Date | null },
  now: Date = new Date(),
): boolean {
  const at = pm.mandateExpiresAt;
  if (at == null) return false;
  return at.getTime() <= now.getTime();
}

/**
 * Did this instrument's mandate just BECOME chargeable — i.e. is `after` a live status
 * that `before` was not?
 *
 * The trigger for post-confirmation recovery collection (F-42). `applyMandateUpdate` is
 * the moment the engine learns a netbanking e-mandate the bank sat on until T+1 is
 * finally debitable, and until F-42 it was wired to nothing: the add-card routes collect
 * the customer's open invoices against a freshly usable instrument, the webhook that
 * makes an instrument usable did not. With F-11's pre-flight now refusing debits while a
 * mandate is `initiated`, the confirmation is the ONLY prompt event a buyer whose bank
 * confirms at T+1 gets — otherwise they wait for the next 12h deferral tick.
 *
 * A TRANSITION, deliberately, not a state test. A gateway that redelivers `confirmed`
 * (and both do — an errored delivery is redelivered by design, and Stripe re-emits
 * `mandate.updated` for changes that leave `active` untouched) must not re-run recovery
 * collection. Provider-event dedup does not cover that: it is keyed on
 * `provider_event_id`, so two DIFFERENT events both asserting `confirmed` both pass it,
 * and a delivery whose prior outcome was `error` is deliberately let through to run
 * again. Comparing against the stored status is the guard that actually holds, and the
 * caller reads that status under `SELECT … FOR UPDATE` so two concurrent deliveries
 * cannot both see the pre-transition value.
 *
 * A resume from `paused` reaches a live status and so triggers too — an un-paused mandate
 * IS an instrument becoming collectable again, which is the same situation as an add-card.
 * A resume that lands on `initiated` does not, and must not: that instrument is not
 * chargeable yet, and collecting against it would trip the pending pre-flight and spend a
 * deferral for nothing.
 */
export function mandateBecameLive(
  before: string | null | undefined,
  after: string | null | undefined,
): boolean {
  return (
    mandateChargeability({ mandateStatus: after }) === "live" &&
    mandateChargeability({ mandateStatus: before }) !== "live"
  );
}

/**
 * The code an in-flight attempt carries when the GATEWAY said it needs the buyer.
 *
 * Written on the `in_progress` transaction (never on a `payments` row, which has no
 * field that means this) and read back by everything that later has to judge what
 * that attempt is waiting for.
 */
export const AWAITING_AUTHENTICATION_CODE = "authentication_required";

/**
 * The code an in-flight attempt carries when the GATEWAY said the buyer need do nothing.
 *
 * The mirror of {@link AWAITING_AUTHENTICATION_CODE}, and it exists because suppressing
 * the positive code is NOT enough to stay quiet: `debitAwaitsBuyerAuthentication` falls
 * back to the rail+amount prediction whenever no statement is recorded, and ABOVE the
 * AFA-free ceiling that prediction says "yes" on its own. Without somewhere to write the
 * negative, a debit Stripe told us needs no one would light the portal's approval CTA
 * anyway — the prediction beating the statement, which is the whole failure this
 * vocabulary exists to prevent. (Below the ceiling the prediction is already quiet, so
 * there the fix is simply not stamping the positive code — both halves are needed.)
 *
 * MEASURED 2026-09-10 (`verify:stripe-india-afa-live`): an India e-mandate debit of ₹100
 * came back `requires_action` with `next_action.card_await_notification =
 * { charge_attempt_at, customer_approval_required: false }`, sat five minutes in the
 * pre-debit notification window, and SUCCEEDED with no buyer involvement at all.
 *
 * Like its twin this is a STATEMENT on an in-flight row, not a verdict: nothing reads a
 * non-null `errorCode` as "failed", and the status stays `in_progress`.
 */
export const AUTHENTICATION_NOT_REQUIRED_CODE = "authentication_not_required";

/**
 * May a GATEWAY STATEMENT that the buyer must authenticate overwrite what this row
 * already says?
 *
 * ⚠️ THIS EXISTS BECAUSE THE NEGATIVE WAS MADE PERMANENT, AND IT COST A REAL INVOICE.
 * Production 2026-09-12, INV-100006 / `txn_XXXXXXXXXXXXXXXXXXXXXX07`: Stripe answered the
 * charge with `card_await_notification.customer_approval_required: false` — true at that
 * moment, the pre-debit notification needs no approval — so `bookPending` wrote
 * `authentication_not_required`. Stripe then asked for 3D Secure, the cardholder began it
 * and stopped, and `applyActionRequired` had no way to correct the row. Every consumer
 * kept reading "nobody needs to act": no portal CTA, `awaiting_authentication` false, the
 * invoice parked on "waiting for the current attempt to settle".
 *
 * The rule the original design missed is that STATEMENTS ARE ORDERED IN TIME. A gateway
 * saying "not now" does not bind its later "yes, now" — so the positive always wins, and
 * the negative is only ever the best answer *so far*.
 *
 * Narrow on purpose: a row carrying a REAL decline code is left alone. Those are terminal
 * verdicts about the attempt, not statements about who is waiting, and an out-of-order
 * `requires_action` delivery must not overwrite one.
 */
export function authenticationWaitMayBeRecorded(
  currentErrorCode: string | null | undefined,
): boolean {
  return currentErrorCode == null || currentErrorCode === AUTHENTICATION_NOT_REQUIRED_CODE;
}

/**
 * Is this attempt waiting on the buyer's bank? The STATEMENT first, the prediction
 * only as a fallback.
 *
 * ── Why the amount rule cannot be the arbiter ────────────────────────────────
 * `INR_AFA_FREE_CEILING_MINOR` is the figure above which additional-factor
 * authentication is COMPULSORY. It was never a floor — an issuer may challenge any
 * debit it likes — and production settled it (`txn_XXXXXXXXXXXXXXXXXXXXXX03`,
 * INV-100001, 2026-09-09): ₹885 came back `requires_action` against a mandate that
 * was `rail=card`, `status=confirmed`, ceiling ₹15,000. Nothing was wrong with the
 * authorisation. The debit was 1/17th of its own ceiling, our pre-flight was right to
 * let it through, and the issuer asked for the cardholder regardless.
 *
 * Note which instrument that was: `withMandateHeadroom` registers at the AFA-free
 * ceiling precisely so debits renew unattended. The card built to avoid this got
 * challenged anyway — so no amount is a safe assumption, and the ceiling cannot be
 * the thing that decides whether a challenge is real.
 *
 * Gating on the amount recorded it as an ordinary card failure, then armed a dunning
 * ladder of identical unauthenticated debits — attempt 1 of a ladder where every rung
 * re-asks a question only the buyer can answer, and none can succeed.
 *
 * So when the gateway has answered, its answer wins. `debitNeedsBuyerAuthentication`
 * stays as the fallback for the shape that arrives with NO statement — RazorPay parks
 * an AFA debit as a plain `pending`, indistinguishable from a netbanking presentation
 * — which is the only case a guess is still better than nothing.
 *
 * ⚠️ Only the statement is ever persisted. The prediction stays derived at every
 * call site, deliberately: its UPI half is "INFERRED, not measured", and writing a
 * guess down would make it permanent and unfalsifiable.
 */
export function debitAwaitsBuyerAuthentication(
  attempt: { errorCode?: string | null },
  pm: { mandateRail?: string | null; type?: string | null },
  currency: string,
  amountMinor: bigint,
): boolean {
  if (attempt.errorCode === AWAITING_AUTHENTICATION_CODE) return true;
  // The negative statement outranks the prediction for the same reason the positive one
  // does — see AUTHENTICATION_NOT_REQUIRED_CODE. Stripe states this on every India
  // e-mandate debit; the prediction would say "yes" to all of them.
  if (attempt.errorCode === AUTHENTICATION_NOT_REQUIRED_CODE) return false;
  return debitNeedsBuyerAuthentication(pm, currency, amountMinor);
}
