/**
 * Credits Flexibility — whether, and up to how much, REFUNDABLE credits and EXCESS
 * payments are auto-applied to an invoice.
 *
 * Configured on three axes, which is why this is a nested config and not two columns:
 *   · per CREDIT KIND — refundable credits and excess payments, separately;
 *   · per INVOICE CLASS — recurring invoices and one-time invoices, separately;
 *   · each of those four slots takes one of three modes — do not auto-apply ·
 *     auto-apply · auto-apply up to a limit.
 * Plus a per-SUBSCRIPTION maximum, stored on the subscription row rather than here.
 *
 * ⚠️ PROMOTIONAL CREDIT IS NOT PART OF THIS. These settings cover refundable + excess
 * only, and promotional is a different animal: it is applied PRE-tax against the
 * discounted subtotal and is non-refundable, so a merchant granting it has already
 * decided it should be spent. `planCreditApplication` therefore caps promotional exactly
 * as it always did, and nothing here can reach it.
 *
 * ── Why this exists ───────────────────────────────────────────────────────────
 * We auto-applied refundable and excess credit unconditionally and in full, through one
 * chokepoint (`planCreditApplication`). That is the mechanism behind the 2026-08
 * production incident: **₹69,521.79** of refundable credit drawn onto INV-4705, which
 * then 500'd. With "do not auto-apply" — or any cap — on that business the invoice would
 * never have become credit-funded and the bug would not have been reachable.
 *
 * ── Shape and style ──────────────────────────────────────────────────────────
 * Modelled on `resolveDunningConfig` / `DEFAULT_DUNNING_CONFIG`
 * (`modules/subscriptions/dunning-schedule.ts`): a jsonb column on `businesses`, a PURE
 * resolver with a docblock per field explaining its default, and the house rule that
 * **only an explicit value opts out**. Pure so that the preview path (`estimate.ts`) and
 * the booking path can be handed the same resolved numbers and cannot drift; the one
 * DB-reading helper is `loadCreditApplicationLimits` at the bottom, the same
 * pure-rule + id-only-loader pair as `netTermDaysFrom` / `resolveNetTermDays`.
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { businesses, subscriptions } from "@db/schema";

/**
 * What a slot does with the bucket it governs.
 *
 *  - `auto`  — apply as much as the invoice can absorb. The historical behaviour and the
 *              default for all four slots (see DEFAULT_CREDITS_FLEXIBILITY).
 *  - `none`  — never auto-apply.
 *  - `limit` — apply at most `limitMinor` per invoice.
 */
export type CreditAutoApplyMode = "auto" | "none" | "limit";

/** The two invoice classes configured separately. */
export type InvoiceClass = "recurring" | "one_time";

export interface CreditAutoApplySlot {
  mode: CreditAutoApplyMode;
  /**
   * The per-invoice ceiling in integer MINOR UNITS, only meaningful for `mode: 'limit'`.
   * Null for the other two modes — `auto` has no ceiling and `none` needs none.
   *
   * Minor units and not major: money in this engine is integer minor units everywhere
   * (locked decision #4), and a jsonb float ceiling would be the one place a rounding
   * question could enter the credit-application path.
   *
   * ⚠️ CURRENCY-LESS, and read in the INVOICE's own currency. The setting is a site-level
   * amount, but a tmbilling business can bill in several currencies and credit buckets
   * are per (customer, currency). Rather than invent a
   * conversion this engine has no live FX rate for — `exchange_rates` is explicitly
   * reporting-only and must never rate or settle — the ceiling is applied as the same
   * NUMBER of minor units in whichever currency the invoice is in. A multi-currency
   * business setting "up to 50000" therefore caps at ₹500 on an INR invoice and $500 on a
   * USD one. The settings screen says so; a per-currency grid is the follow-up if anyone
   * needs it.
   */
  limitMinor: bigint | null;
}

export interface CreditsFlexibilityConfig {
  /** Credit from refundable credit notes, downgrade prorations and credit memos. */
  refundable: Record<InvoiceClass, CreditAutoApplySlot>;
  /** Overpayments and offline excess money received. */
  excess: Record<InvoiceClass, CreditAutoApplySlot>;
}

/**
 * The resolved per-invoice ceilings handed to `planCreditApplication`, which is pure and
 * must never read config itself.
 *
 * `null` = unlimited (apply whatever the invoice can absorb). `0n` = do not auto-apply.
 * A positive value = apply at most that many minor units of that bucket to this invoice.
 * The distinction matters: `null` and `0n` are opposite answers and a `?? 0n` anywhere in
 * this chain would silently switch the feature on for every business.
 */
export interface CreditApplicationLimits {
  refundable: bigint | null;
  excess: bigint | null;
}

/** Both buckets unlimited — what an unconfigured business gets, and what every caller that has no config in hand must pass. */
export const UNLIMITED_CREDIT_LIMITS: CreditApplicationLimits = { refundable: null, excess: null };

/**
 * The default when a business configures nothing: **auto-apply, unlimited, in all four
 * slots**, with no subscription cap.
 *
 * This is deliberately the pre-feature behaviour, byte for byte. `businesses.credits_flexibility`
 * is jsonb with no column default, so the businesses this resolves for are exactly the ones
 * that have never saved the Credits Flexibility form — i.e. all of them on the day this
 * ships, including the one that lost ₹69,521.79. A default that CAPPED would silently stop
 * applying credit that customers have already been told is theirs, turning paid invoices
 * into due ones across every existing tenant; the incident is an argument for making the
 * control exist, not for changing the answer nobody has been asked yet. Merchants opt in.
 *
 * The same reasoning is why `verify:credit-notes`, `verify:invoices-v2`,
 * `verify:concurrent-credit-apply`, `verify:customers` and every parity probe pass
 * unchanged: with this default `creditApplicationLimits` returns `UNLIMITED_CREDIT_LIMITS`
 * and `planCreditApplication` takes exactly the branch it took before.
 */
export const DEFAULT_CREDITS_FLEXIBILITY: CreditsFlexibilityConfig = {
  refundable: {
    recurring: { mode: "auto", limitMinor: null },
    one_time: { mode: "auto", limitMinor: null },
  },
  excess: {
    recurring: { mode: "auto", limitMinor: null },
    one_time: { mode: "auto", limitMinor: null },
  },
};

/** The stored jsonb shape (snake_case, like `dunning_config`). Every member optional. */
interface StoredSlot {
  mode?: unknown;
  limit_minor?: unknown;
}
interface StoredCreditsFlexibility {
  refundable?: { recurring?: StoredSlot; one_time?: StoredSlot };
  excess?: { recurring?: StoredSlot; one_time?: StoredSlot };
}

/**
 * A stored limit is a JSON number of minor units. Integer and non-negative, else null.
 *
 * `Number.isSafeInteger` rather than `Number.isInteger`: a jsonb number beyond 2^53 has
 * already lost precision by the time the driver hands it over, and a money ceiling that
 * is off by an unknown amount is worse than no ceiling. 2^53 minor units is ~₹90 trillion,
 * so nothing real is being refused. Strings are also accepted because a hand-written row
 * or an importer may carry one, and rejecting `"50000"` would resolve the slot to
 * unlimited — the wrong direction to fail in for a value that plainly parses.
 */
function parseLimitMinor(raw: unknown): bigint | null {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw) : null;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return BigInt(raw.trim());
  return null;
}

/**
 * One slot. Only an explicit `'none'` or a `'limit'` WITH a parseable ceiling opts out of
 * auto-apply; everything else — absent, misspelt, `'limit'` with no amount — resolves to
 * `auto`, which is today's behaviour.
 *
 * The `'limit'`-without-an-amount case is unreachable through the API (the route's zod
 * schema requires `limit_minor` when `mode` is `'limit'`, and the dashboard action
 * refuses to save without one), so this branch only ever sees a hand-edited row. It
 * resolves to `auto` and not to `none` on the house rule that a malformed config must not
 * change behaviour: "apply nothing" is a decision, and a row that failed to express a
 * ceiling has not made it.
 */
function resolveSlot(raw: StoredSlot | undefined): CreditAutoApplySlot {
  if (raw?.mode === "none") return { mode: "none", limitMinor: null };
  if (raw?.mode === "limit") {
    const limitMinor = parseLimitMinor(raw.limit_minor);
    if (limitMinor !== null) return { mode: "limit", limitMinor };
  }
  return { mode: "auto", limitMinor: null };
}

/**
 * Resolve a business's effective Credits Flexibility config. Pure; a null / absent /
 * malformed stored value resolves to DEFAULT_CREDITS_FLEXIBILITY (auto, unlimited),
 * which is exactly what the engine did before this feature existed.
 */
export function resolveCreditsFlexibility(
  biz: { creditsFlexibility?: unknown } | null | undefined,
): CreditsFlexibilityConfig {
  const raw = (biz?.creditsFlexibility ?? null) as StoredCreditsFlexibility | null;
  return {
    refundable: {
      recurring: resolveSlot(raw?.refundable?.recurring),
      one_time: resolveSlot(raw?.refundable?.one_time),
    },
    excess: {
      recurring: resolveSlot(raw?.excess?.recurring),
      one_time: resolveSlot(raw?.excess?.one_time),
    },
  };
}

/** A slot's own ceiling: null = unlimited, 0n = never, positive = at most this much. */
function slotCeiling(slot: CreditAutoApplySlot): bigint | null {
  if (slot.mode === "none") return 0n;
  if (slot.mode === "limit") return slot.limitMinor ?? null;
  return null;
}

/**
 * The TIGHTER of two ceilings, where `null` means unlimited (∞).
 *
 * ── Why the tighter one wins ──────────────────────────────────────────────────
 * The subscription-level field is a MAXIMUM — the limit up to which refundable credits /
 * excess payments can be auto-applied on invoices generated for that subscription — not
 * an override. Two maxima both apply, so the effective
 * ceiling is their minimum, and a subscription cap can never RE-ENABLE a bucket the site
 * has set to "do not auto-apply" (0n stays 0n against any cap). That is also the only
 * reading that is safe in both directions: the alternative — subscription overrides site
 * — would let a per-subscription value quietly undo a site-wide "do not auto-apply",
 * which is the control the incident is about.
 */
function tighter(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** A stored subscription cap: null stays unlimited; a negative can only mean "none". */
function subscriptionCap(raw: bigint | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  return raw < 0n ? 0n : raw;
}

/**
 * The PURE rule: business config + invoice class + the subscription's own maxima → the
 * two per-invoice ceilings `planCreditApplication` needs.
 *
 * ── PER INVOICE, not per lifetime ─────────────────────────────────────────────
 * The subscription maximum applies "on the invoices generated for the subscription",
 * which leaves open whether it is a per-invoice ceiling or a running total across the
 * subscription's life. Implemented as PER INVOICE, because (a) the site-level
 * "apply up to a limit" is unambiguously per invoice and one screen should not mean two
 * different things, and (b) a lifetime reading needs a durable counter of credit applied
 * per subscription, which is state we do not have and which the ledger cannot answer
 * cheaply (credit applications are keyed to invoices, not to subscriptions). Recorded here
 * rather than left to be rediscovered; the lifetime reading, should it ever be wanted, is
 * a new derived counter, not a reshape of this config.
 */
export function creditApplicationLimits(input: {
  config: CreditsFlexibilityConfig;
  invoiceClass: InvoiceClass;
  /**
   * The subscription this invoice belongs to, when there is one. A one-time invoice has
   * no subscription and therefore no subscription cap — only the site-level `one_time`
   * slots apply to it.
   */
  subscription?: {
    maxRefundableCreditsUsageMinor?: bigint | null;
    maxExcessPaymentUsageMinor?: bigint | null;
  } | null;
}): CreditApplicationLimits {
  const cls = input.invoiceClass;
  return {
    refundable: tighter(
      slotCeiling(input.config.refundable[cls]),
      subscriptionCap(input.subscription?.maxRefundableCreditsUsageMinor),
    ),
    excess: tighter(
      slotCeiling(input.config.excess[cls]),
      subscriptionCap(input.subscription?.maxExcessPaymentUsageMinor),
    ),
  };
}

/**
 * {@link creditApplicationLimits} for a caller holding only ids — the invoicing and
 * collection paths, which reach credit application without the business row in hand.
 *
 * Two narrow selects rather than a join: both rows are usually already cached by the
 * planner's own reads, and this must be safe to call on a path that has no subscription
 * at all (a manual invoice), where the join would have to be an outer one.
 *
 * `subscriptionId` also DECIDES THE INVOICE CLASS by default: an invoice raised for a
 * subscription — a renewal, a proration, a mid-term item add — is a recurring invoice,
 * and one with no subscription behind it is a one-time invoice. Pass
 * `invoiceClass` explicitly only where the caller knows better.
 */
export async function loadCreditApplicationLimits(input: {
  organizationId: string;
  businessId: string;
  subscriptionId?: string | null;
  invoiceClass?: InvoiceClass;
}): Promise<CreditApplicationLimits> {
  return withTenant(input.organizationId, async (tx) => {
    const [biz] = await tx
      .select({ creditsFlexibility: businesses.creditsFlexibility })
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    const [sub] = input.subscriptionId
      ? await tx
          .select({
            maxRefundableCreditsUsageMinor: subscriptions.maxRefundableCreditsUsageMinor,
            maxExcessPaymentUsageMinor: subscriptions.maxExcessPaymentUsageMinor,
          })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.id, input.subscriptionId),
              eq(subscriptions.businessId, input.businessId),
            ),
          )
          .limit(1)
      : [undefined];
    return creditApplicationLimits({
      config: resolveCreditsFlexibility(biz),
      invoiceClass: input.invoiceClass ?? (input.subscriptionId ? "recurring" : "one_time"),
      subscription: sub ?? null,
    });
  });
}
