import { eq, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { businesses, organizations } from "@db/schema";
import { createLogger } from "@/platform/logger";
import { writeAuditLog } from "@/modules/audit/service";
import { ecbFxProvider } from "@/platform/fx/ecb";
import { recordExchangeRateObservations } from "@/platform/fx/history";
import { FxProviderError, type FxProvider } from "@/platform/fx/types";

const log = createLogger("fx.refresh");

/** How a currency's rate is maintained — the two radios on the screen. */
export type RateSource = "manual" | "auto";

/** One currency's rate plus its provenance, as the API and the screen need it. */
export interface CurrencyRateState {
  currency: string;
  /** Decimal string; null = no rate configured for this currency. */
  rate: string | null;
  source: RateSource;
  /**
   * The DAY THE RATE WE HOLD WAS PUBLISHED (the provider's own date), not when we last
   * checked — "Last updated on 1 Sept 2026". Null on a rate that predates 0229 or an
   * auto currency that has never successfully refreshed.
   *
   * Reporting the fetch time here would be the more flattering number and the wrong one:
   * the ECB publishes on weekdays, so a Sunday refresh legitimately holds Friday's rate,
   * and a screen claiming "updated today" would be describing our request, not the rate.
   */
  updatedAt: string | null;
  /** Which provider produced it (`ecb`), or null for a hand-entered rate. */
  provider: string | null;
  /**
   * Why the last refresh of THIS currency failed, or null. A failed fetch leaves the last
   * good rate standing — stale is a reporting inaccuracy, absent breaks the roll-up — so
   * without this the failure is invisible: a rate frozen a week ago looks like a rate that
   * simply has not moved.
   */
  lastError: string | null;
}

type StoredSource = {
  source?: string;
  updated_at?: string | null;
  provider?: string | null;
  last_error?: string | null;
};
type RatesMap = Record<string, number | string>;
type SourcesMap = Record<string, StoredSource>;

/** The two business columns this module reads. */
export type RateColumns = Pick<
  typeof businesses.$inferSelect,
  "defaultCurrency" | "currencies" | "exchangeRates" | "exchangeRateSources"
>;

const asRates = (b: RateColumns): RatesMap => (b.exchangeRates ?? {}) as RatesMap;
const asSources = (b: RateColumns): SourcesMap => (b.exchangeRateSources ?? {}) as SourcesMap;

/**
 * Every currency this business has a rate or a source for, plus its provenance.
 *
 * A currency present in `exchange_rates` but ABSENT from `exchange_rate_sources` reads as
 * `manual` — which is what every rate written before 0229 is. Defaulting the unknown to
 * `manual` is the safe direction: it claims nobody promised to keep the rate fresh, which
 * is true of a hand-entered one, where defaulting to `auto` would advertise a refresh that
 * is not happening.
 */
export function currencyRateStates(biz: RateColumns): CurrencyRateState[] {
  const rates = asRates(biz);
  const sources = asSources(biz);
  const base = biz.defaultCurrency?.toUpperCase() ?? null;
  const codes = new Set<string>([
    ...Object.keys(rates).map((c) => c.toUpperCase()),
    ...Object.keys(sources).map((c) => c.toUpperCase()),
    // Configured trading currencies with no rate yet still belong on the screen: "this
    // currency has no rate" is the state an operator most needs to see.
    ...(((biz.currencies as string[] | null) ?? []).map((c) => c.toUpperCase()) ?? []),
  ]);
  if (base) codes.delete(base); // the base needs no rate against itself
  return [...codes].sort().map((currency) => {
    const raw = rates[currency];
    const s = sources[currency] ?? {};
    return {
      currency,
      rate: raw == null ? null : String(raw),
      source: s.source === "auto" ? "auto" : "manual",
      updatedAt: s.updated_at ?? null,
      provider: s.provider ?? null,
      lastError: s.last_error ?? null,
    };
  });
}

/** Merge one currency's rate + provenance into the two maps, preserving the rest. */
function writeCurrency(
  biz: RateColumns,
  currency: string,
  next: {
    rate?: string | null;
    source: RateSource;
    updatedAt: string | null;
    provider: string | null;
    lastError: string | null;
  },
): { exchangeRates: RatesMap | null; exchangeRateSources: SourcesMap } {
  const ccy = currency.toUpperCase();
  const rates: RatesMap = { ...asRates(biz) };
  const sources: SourcesMap = { ...asSources(biz) };
  if (next.rate !== undefined) {
    if (next.rate === null) delete rates[ccy];
    else rates[ccy] = next.rate;
  }
  sources[ccy] = {
    source: next.source,
    updated_at: next.updatedAt,
    provider: next.provider,
    last_error: next.lastError,
  };
  return {
    // An empty map is stored as NULL, matching what every existing reader already treats
    // as "no rates" (`?? {}`), so this column never drifts into `{}` vs null ambiguity.
    exchangeRates: Object.keys(rates).length > 0 ? rates : null,
    exchangeRateSources: sources,
  };
}

/**
 * ── #37 · the audit half of a currency write ──────────────────────────────────
 *
 * `setCurrencyRateSource` and `removeCurrency` are the only two paths that touch
 * `exchange_rate_sources`, and until 2026-09-04 both UPDATEd `businesses` directly
 * instead of going through the audited settings patch — so `audit_logs` held nothing
 * for them and "who switched INR to auto, and when" was unanswerable, on the field
 * that decides what every conversion uses.
 *
 * The audit row is written with the CALLER'S `tx` (see `writeAuditLog`'s docblock): a
 * row that can survive a rolled-back change, or a change that can survive without its
 * row, is worse than no audit at all.
 */

/**
 * One currency's audited fields, keyed exactly as they are STORED in
 * `exchange_rate_sources` (`last_error`, not `lastError`), so the diff an operator
 * reads has the same names as the column it came from.
 *
 * `null` throughout means "this currency had no rate row" — which is a real state and
 * distinct from `manual`, the value `currencyRateStates` defaults an unknown source to.
 */
type AuditedRate = {
  source: RateSource | null;
  rate: string | null;
  updated_at: string | null;
  provider: string | null;
  last_error: string | null;
  /** The business's enabled-currency list; a rate write can extend it, a removal shrinks it. */
  currencies: string[] | null;
};

const auditedRate = (
  biz: RateColumns,
  currency: string,
  currencies: string[] | null,
): AuditedRate => {
  const s = currencyRateStates(biz).find((x) => x.currency === currency);
  return {
    source: s?.source ?? null,
    rate: s?.rate ?? null,
    updated_at: s?.updatedAt ?? null,
    provider: s?.provider ?? null,
    last_error: s?.lastError ?? null,
    currencies,
  };
};

/**
 * The changed-fields diff (LOG-3: `before`/`after` carry ONLY what changed, never whole
 * rows), with `currency` on both sides.
 *
 * `currency` never changes and is still on both sides deliberately: `resource_id` is the
 * BUSINESS, so without it the row would read "source: manual → auto" of nothing.
 *
 * ⚠️ A field that did not change is ABSENT from both sides, and on this resource that is
 * load-bearing. Switching a currency to `auto` attempts one inline fetch, and a FAILED
 * fetch is still a 200: the currency is auto, the previous rate stands, and `last_error`
 * says why. That row must record the SOURCE change without implying the rate moved — so
 * it reads `source: manual → auto, provider: null → ecb, last_error: null → "…"` with no
 * `rate` key at all, rather than repeating a number that never moved.
 */
function rateAuditDiff(
  currency: string,
  before: AuditedRate,
  after: AuditedRate,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const b: Record<string, unknown> = { currency };
  const a: Record<string, unknown> = { currency };
  for (const key of Object.keys(after) as Array<keyof AuditedRate>) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    b[key] = before[key];
    a[key] = after[key];
  }
  return { before: b, after: a };
}

export class ExchangeRateError extends Error {}

/**
 * Set ONE currency to manual (with a rate) or to auto — the write behind the
 * Manage-currency dialog.
 *
 * Switching to `auto` attempts ONE fetch inline, because the dialog shows the resulting
 * rate the moment it is applied and an "auto" currency with no rate would be a control
 * that appears to have done nothing. The fetch has a hard timeout and its failure is NOT
 * an error for the request: the currency is still recorded as auto, the previous rate (if
 * any) stands, and `lastError` says why it did not move. The daily job will fix it, and
 * the caller can see from the returned state whether it did or did not update — a success
 * that does not say which mechanism ran is the failure this codebase has already paid for
 * once (the mail-transport lesson).
 */
export async function setCurrencyRateSource(input: {
  organizationId: string;
  businessId: string;
  currency: string;
  source: RateSource;
  /** Required for `manual`; ignored for `auto`. Decimal string or number, > 0. */
  rate?: string | number;
  now: Date;
  provider?: FxProvider;
}): Promise<CurrencyRateState> {
  const ccy = input.currency.toUpperCase();
  const provider = input.provider ?? ecbFxProvider;

  const biz = await withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    return row ?? null;
  });
  if (!biz) throw new ExchangeRateError("No such business");

  const base = biz.defaultCurrency?.toUpperCase();
  if (!base) {
    throw new ExchangeRateError(
      "This business has no default currency, so there is nothing to quote a rate against. Set a default currency first.",
    );
  }
  if (ccy === base) {
    // Not a rate at all: a currency against itself is 1 by definition, and storing a
    // settable "rate" for it would invite someone to set it to something else.
    throw new ExchangeRateError(
      `${ccy} is this business's default currency. It needs no exchange rate, because its rate is always 1.`,
    );
  }

  let next: Parameters<typeof writeCurrency>[2];
  if (input.source === "manual") {
    const n = Number(input.rate);
    if (input.rate == null || !Number.isFinite(n) || n <= 0) {
      throw new ExchangeRateError(`A manual rate must be a positive number, not '${input.rate}'`);
    }
    next = {
      // The operator's own string, not `String(Number(x))` — a typed `94.9537410` keeps
      // its trailing zero, and `numeric` preserves it.
      rate: typeof input.rate === "string" ? input.rate.trim() : String(input.rate),
      source: "manual",
      updatedAt: input.now.toISOString(),
      provider: null,
      lastError: null,
    };
  } else {
    const prior = currencyRateStates(biz).find((s) => s.currency === ccy);
    try {
      const fetched = await provider.fetchRates(base, [ccy]);
      const rate = fetched.rates[ccy];
      if (rate == null) {
        // The provider answered but does not quote this currency. Recorded as an error on
        // THIS currency rather than thrown: the operator's choice is honoured, and the
        // screen can say which currency the source will not quote.
        next = {
          source: "auto",
          updatedAt: prior?.updatedAt ?? null,
          provider: provider.name,
          lastError: `${provider.name} does not quote ${ccy} against ${base}`,
          rate: undefined,
        };
      } else {
        next = {
          rate,
          source: "auto",
          updatedAt: fetched.asOf.toISOString(),
          provider: provider.name,
          lastError: null,
        };
      }
    } catch (e) {
      const why = e instanceof FxProviderError || e instanceof Error ? e.message : String(e);
      log.warn("inline FX fetch failed", {
        businessId: input.businessId,
        currency: ccy,
        // `error`, not `err` — same rule, and the logger gives a real Error its
        // `error_message` + `stack` treatment under the canonical key.
        error: why,
      });
      next = {
        source: "auto",
        updatedAt: prior?.updatedAt ?? null,
        provider: provider.name,
        lastError: why,
        rate: undefined,
      };
    }
  }

  const patch = writeCurrency(biz, ccy, next);

  /**
   * Setting a rate ENABLES the currency, when the business keeps a restrictive list.
   *
   * "+ Add Currency" is one dialog that picks the currency and its rate mode
   * together, so a rate for a currency the business does not transact in would be a rate
   * nothing can use — and the operator would have to go and enable it in a second place
   * to make the thing they just configured take effect. A null `currencies` means
   * unrestricted, where there is nothing to add.
   */
  const enabled = (biz.currencies as string[] | null) ?? null;
  const currenciesPatch =
    enabled && !enabled.map((c) => c.toUpperCase()).includes(ccy)
      ? { currencies: [...enabled, ccy] }
      : {};

  const after = { ...biz, ...patch, ...currenciesPatch } as RateColumns;
  // #37: computed from the same two views the caller gets back, so the audit row can
  // never describe a different write than the one that lands below.
  const diff = rateAuditDiff(
    ccy,
    auditedRate(biz, ccy, enabled),
    auditedRate(after, ccy, currenciesPatch.currencies ?? enabled),
  );

  await withTenant(input.organizationId, async (tx) => {
    await tx
      .update(businesses)
      .set({ ...patch, ...currenciesPatch, updatedAt: input.now })
      .where(eq(businesses.id, input.businessId));
    // Written even when nothing actually differs: the operator DID perform this action,
    // and a diff carrying only `currency` says plainly that it changed nothing.
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "business.set_currency_rate_source",
        resourceType: "business",
        resourceId: biz.publicId,
        before: diff.before,
        after: diff.after,
      },
      tx,
    );
    // The rate we just wrote replaced whatever stood there. Observed, in the same
    // transaction, or the previous value is gone.
    await recordExchangeRateObservations(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      observedAt: input.now,
    });
  });

  return currencyRateStates(after).find((s) => s.currency === ccy)!;
}

/**
 * Stop transacting in a currency: drop it from the enabled list AND delete its rate and
 * provenance — the `⋯ → Remove` on the currencies screen.
 *
 * Both halves, deliberately. Removing it from `currencies` alone would leave a rate
 * behind that no screen shows and the daily refresh would keep updating forever; deleting
 * the rate alone would leave the currency sellable with nothing to convert it by. A
 * half-remove that looks complete is the failure mode here.
 *
 * The BASE currency is refused: it is what every other rate is quoted against, and
 * removing it would orphan all of them at once. Change the default first.
 *
 * Prices and invoices already in that currency are untouched — they are history, and an
 * invoice's own `exchange_rate` snapshot (0228) keeps converting even after the live rate
 * is gone. That is the point of stamping it.
 */
export async function removeCurrency(input: {
  organizationId: string;
  businessId: string;
  currency: string;
  now: Date;
}): Promise<{ currency: string }> {
  const ccy = input.currency.toUpperCase();
  const biz = await withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(businesses)
      .where(eq(businesses.id, input.businessId))
      .limit(1);
    return row ?? null;
  });
  if (!biz) throw new ExchangeRateError("No such business");
  if (biz.defaultCurrency?.toUpperCase() === ccy) {
    throw new ExchangeRateError(
      `${ccy} is this business's default currency. We quote every other rate against it. Change the default currency first.`,
    );
  }

  const rates: RatesMap = { ...asRates(biz) };
  const sources: SourcesMap = { ...asSources(biz) };
  delete rates[ccy];
  delete sources[ccy];
  const enabled = (biz.currencies as string[] | null) ?? null;
  const nextEnabled = enabled ? enabled.filter((c) => c.toUpperCase() !== ccy) : null;

  const nextCurrencies =
    nextEnabled && nextEnabled.length > 0
      ? nextEnabled
      : biz.defaultCurrency
        ? [biz.defaultCurrency.toUpperCase()]
        : null;
  const nextColumns = {
    exchangeRates: Object.keys(rates).length > 0 ? rates : null,
    exchangeRateSources: Object.keys(sources).length > 0 ? sources : null,
    // An emptied list would mean "unrestricted", which is the opposite of what
    // removing the last additional currency means — keep the base in it.
    currencies: nextCurrencies,
  };
  // #37: the removal's diff is the rate and its provenance going to null — an explicit
  // "these are gone", not a silently shorter list.
  const diff = rateAuditDiff(
    ccy,
    auditedRate(biz, ccy, enabled),
    auditedRate({ ...biz, ...nextColumns } as RateColumns, ccy, nextCurrencies),
  );

  await withTenant(input.organizationId, async (tx) => {
    await tx
      .update(businesses)
      .set({ ...nextColumns, updatedAt: input.now })
      .where(eq(businesses.id, input.businessId));
    await writeAuditLog(
      {
        organizationId: input.organizationId,
        businessId: input.businessId,
        action: "business.remove_currency",
        resourceType: "business",
        resourceId: biz.publicId,
        before: diff.before,
        after: diff.after,
      },
      tx,
    );
    // Removal is an observation too: the currency has NO usable rate from here on, which
    // is a different fact from the last one it held.
    await recordExchangeRateObservations(tx, {
      organizationId: input.organizationId,
      businessId: input.businessId,
      observedAt: input.now,
    });
  });
  return { currency: ccy };
}

export interface FxRefreshOutcome {
  /** Businesses that had at least one `auto` currency. */
  businessesConsidered: number;
  /** (business, currency) pairs whose rate was written. */
  currenciesUpdated: number;
  /** (business, currency) pairs left standing on their previous rate, with the reason. */
  failures: Array<{ businessId: string; currency: string; reason: string }>;
  /** Distinct base currencies fetched — one provider call each. */
  basesFetched: string[];
  /** Organizations with a `base_currency` set — the only ones with a map to maintain. */
  organizationsConsidered: number;
  /** (organization, currency) pairs whose account-level rate was written. */
  organizationCurrenciesUpdated: number;
  /** (organization, currency) pairs with no usable rate this pass, with the reason. */
  organizationFailures: Array<{ organizationId: string; currency: string; reason: string }>;
}

/** One organization's account-level rate map, plus the currencies its businesses bill in. */
interface OrgRateTarget {
  id: string;
  base: string;
  /** Every currency any of its businesses transacts in, upper-case, base excluded. */
  billed: Set<string>;
  rates: RatesMap;
  sources: SourcesMap;
}

/**
 * Organizations with a base currency, and the currencies they actually bill in.
 *
 * An organization's rate map is only as wide as its book: a rate for a currency nothing
 * bills in is a number nothing can use, and a currency that IS billed and has no rate is
 * what `missing_rates` exists to name. So the wanted set is read from the businesses
 * themselves — each one's default currency plus its enabled list — rather than configured
 * a second time.
 */
async function organizationRateTargets(onlyOrganizationId?: string): Promise<OrgRateTarget[]> {
  const orgRows = await systemDb
    .select({
      id: organizations.id,
      baseCurrency: organizations.baseCurrency,
      exchangeRates: organizations.exchangeRates,
      exchangeRateSources: organizations.exchangeRateSources,
    })
    .from(organizations)
    .where(
      onlyOrganizationId
        ? sql`${organizations.baseCurrency} is not null and ${organizations.id} = ${onlyOrganizationId}`
        : sql`${organizations.baseCurrency} is not null`,
    );
  if (orgRows.length === 0) return [];

  const bizRows = await systemDb
    .select({
      organizationId: businesses.organizationId,
      defaultCurrency: businesses.defaultCurrency,
      currencies: businesses.currencies,
    })
    .from(businesses)
    .where(
      inArray(
        businesses.organizationId,
        orgRows.map((o) => o.id),
      ),
    );

  const billedByOrg = new Map<string, Set<string>>();
  for (const b of bizRows) {
    const set = billedByOrg.get(b.organizationId) ?? new Set<string>();
    if (b.defaultCurrency) set.add(b.defaultCurrency.toUpperCase());
    for (const c of (b.currencies as string[] | null) ?? []) set.add(c.toUpperCase());
    billedByOrg.set(b.organizationId, set);
  }

  return orgRows.map((o) => {
    const base = o.baseCurrency!.toUpperCase();
    const billed = billedByOrg.get(o.id) ?? new Set<string>();
    billed.delete(base); // the base converts at 1 and is never stored
    return {
      id: o.id,
      base,
      billed,
      rates: (o.exchangeRates ?? {}) as RatesMap,
      sources: (o.exchangeRateSources ?? {}) as SourcesMap,
    };
  });
}

/**
 * Which of an organization's billed currencies automation owns.
 *
 * Same rule as the business path, read through the same `currencyRateStates`: a stored
 * `manual` source is the operator's and is never touched, and a rate present with NO
 * provenance reads as manual too — it got there by hand.
 *
 * The one thing the business path has no equivalent for: a billed currency with neither a
 * rate nor a provenance entry is claimed by automation. The business map is filled a
 * currency at a time through the Manage-currency dialog, so "unknown" there means an
 * operator wrote it before 0229; this map has no dialog and no history, so unknown means
 * nobody has ever spoken for it — and leaving it alone would mean nothing ever fills it.
 */
function organizationAutoCurrencies(t: OrgRateTarget): CurrencyRateState[] {
  const shaped = {
    defaultCurrency: t.base,
    currencies: [...t.billed],
    exchangeRates: t.rates,
    exchangeRateSources: t.sources,
  } as RateColumns;
  return currencyRateStates(shaped).filter(
    (s) => s.source === "auto" || (s.rate === null && t.sources[s.currency] == null),
  );
}

/** One base's fetch outcome, shared by the business and the organization writers. */
type FetchedBase = { rates: Record<string, string>; asOf: Date } | { error: string };

/**
 * Write one organization's account-level map from the pass's fetched rates.
 *
 * Two failure modes, told apart exactly as the business writer tells them apart, because
 * they mean different things:
 *
 *  - THE BASE FAILED TO FETCH (outage, timeout, bad feed). Says nothing about any
 *    currency, so every rate we hold stands and `last_error` records why it did not move.
 *  - THE PROVIDER ANSWERED AND DOES NOT QUOTE THIS CURRENCY. That is a positive statement
 *    that no rate exists, so the key is REMOVED. Downstream reads presence as truth and
 *    cannot see provenance: a converted total excludes what has no rate and names it in
 *    `missing_rates`, which is honest, where a silently retained old rate would move the
 *    number. Never 0, never 1, never last week's.
 */
async function applyOrganizationRates(
  t: OrgRateTarget,
  autos: CurrencyRateState[],
  fetched: Map<string, FetchedBase>,
  provider: FxProvider,
  now: Date,
  outcome: FxRefreshOutcome,
): Promise<void> {
  if (autos.length === 0) return;
  const got = fetched.get(t.base);
  if (!got) return;

  const rates: RatesMap = { ...t.rates };
  const sources: SourcesMap = { ...t.sources };

  for (const state of autos) {
    const ccy = state.currency;
    if ("error" in got) {
      sources[ccy] = {
        source: "auto",
        updated_at: state.updatedAt,
        provider: provider.name,
        last_error: got.error,
      };
      outcome.organizationFailures.push({
        organizationId: t.id,
        currency: ccy,
        reason: got.error,
      });
      continue;
    }
    // A NUMBER here, not the provider's decimal string: this map is read as
    // `Record<string, number>` by the conversion that divides by it, and the business map's
    // string form is tolerated there only by JS coercion. A rate is a number, not money.
    const n = Number(got.rates[ccy]);
    if (got.rates[ccy] == null || !Number.isFinite(n) || n <= 0) {
      const reason = `${provider.name} does not quote ${ccy} against ${t.base}`;
      delete rates[ccy];
      sources[ccy] = {
        source: "auto",
        updated_at: null,
        provider: provider.name,
        last_error: reason,
      };
      outcome.organizationFailures.push({ organizationId: t.id, currency: ccy, reason });
      continue;
    }
    rates[ccy] = n;
    sources[ccy] = {
      source: "auto",
      updated_at: got.asOf.toISOString(),
      provider: provider.name,
      last_error: null,
    };
    outcome.organizationCurrenciesUpdated += 1;
  }

  // The base converts at 1 by definition; a stored "rate" for it would be something to set
  // wrongly.
  delete rates[t.base];
  delete sources[t.base];

  await withTenant(t.id, async (tx) => {
    await tx
      .update(organizations)
      .set({
        exchangeRates: Object.keys(rates).length > 0 ? rates : null,
        exchangeRateSources: Object.keys(sources).length > 0 ? sources : null,
      })
      .where(eq(organizations.id, t.id));
  });
}

/**
 * Refresh every `auto` currency across every business. The daily job's entry point.
 *
 * CROSS-ORGANIZATION, so it uses `systemDb` rather than `withTenant`: this is
 * exactly the "admin operation that spans organizations" case `platform/db.ts` documents.
 * Every other path into these columns is tenant-scoped.
 *
 * ONE FETCH PER DISTINCT BASE CURRENCY, not per business and not per currency: rates are
 * not tenant-specific, so a hundred businesses on a USD base cost one provider call. That
 * is also what keeps this polite to a free public feed we do not pay for.
 *
 * A FETCH FAILURE IS NOT FATAL to the pass. The base that failed is recorded against each
 * of its currencies and the other bases still refresh — a feed outage must not stop a
 * business on a different base from updating, and it must never clear a good rate.
 *
 * THE ACCOUNT-LEVEL MAPS RIDE ALONG (0269). An organization with a `base_currency` holds
 * its own rates, quoted against that base, for the currencies its businesses bill in — the
 * only way one total can be stated across businesses with four different defaults. Same
 * pass, same provider, same `auto`/`manual` provenance, so the two levels can never
 * disagree about where a number came from or how old it is. An organization with no base
 * currency has nothing to quote against and is not touched.
 */
export async function refreshAutoExchangeRates(input: {
  now: Date;
  provider?: FxProvider;
  /**
   * Restrict the pass to ONE organization.
   *
   * For a verify suite driving a stubbed provider, and for an operator re-running a single
   * account after fixing its configuration. Absent — the cron case — the pass is
   * estate-wide as before.
   */
  onlyOrganizationId?: string;
}): Promise<FxRefreshOutcome> {
  const provider = input.provider ?? ecbFxProvider;

  // Only businesses that actually asked for auto rates. The `@>`-style containment test is
  // done in SQL so a deployment with thousands of businesses does not read them all: the
  // column is jsonb and `exchange_rate_sources::text LIKE '%"auto"%'` would be a lie of a
  // filter (it would match a currency literally named auto), so the check is structural.
  const rows = await systemDb
    .select({
      id: businesses.id,
      organizationId: businesses.organizationId,
      defaultCurrency: businesses.defaultCurrency,
      currencies: businesses.currencies,
      exchangeRates: businesses.exchangeRates,
      exchangeRateSources: businesses.exchangeRateSources,
    })
    .from(businesses)
    .where(
      sql`exists (
            select 1
              from jsonb_each(coalesce(${businesses.exchangeRateSources}, '{}'::jsonb)) as e(ccy, meta)
             where meta->>'source' = 'auto'
          )
          ${
            input.onlyOrganizationId
              ? sql`and ${businesses.organizationId} = ${input.onlyOrganizationId}`
              : sql``
          }`,
    );

  const orgTargets = await organizationRateTargets(input.onlyOrganizationId);

  const outcome: FxRefreshOutcome = {
    businessesConsidered: rows.length,
    currenciesUpdated: 0,
    failures: [],
    basesFetched: [],
    organizationsConsidered: orgTargets.length,
    organizationCurrenciesUpdated: 0,
    organizationFailures: [],
  };
  if (rows.length === 0 && orgTargets.length === 0) return outcome;

  /** base → the union of auto quote currencies wanted against it. */
  const wanted = new Map<string, Set<string>>();
  const want = (base: string, quotes: Iterable<string>) => {
    const set = wanted.get(base) ?? new Set<string>();
    for (const q of quotes) set.add(q);
    wanted.set(base, set);
  };
  for (const r of rows) {
    const base = r.defaultCurrency?.toUpperCase();
    if (!base) continue; // nothing to quote against; left alone rather than guessed at
    const autos = currencyRateStates(r).filter((s) => s.source === "auto");
    if (autos.length === 0) continue;
    want(
      base,
      autos.map((a) => a.currency),
    );
  }
  // The account-level maps ride the SAME fetch: an org on a base a business already uses
  // costs no extra provider call, and one on its own base costs exactly one.
  const orgAutos = new Map<string, CurrencyRateState[]>();
  for (const t of orgTargets) {
    const autos = organizationAutoCurrencies(t);
    orgAutos.set(t.id, autos);
    if (autos.length === 0) continue;
    want(
      t.base,
      autos.map((a) => a.currency),
    );
  }

  /** base → fetched rates, or the error that base failed with. */
  const fetched = new Map<
    string,
    { rates: Record<string, string>; asOf: Date } | { error: string }
  >();
  for (const [base, quotes] of wanted) {
    try {
      const r = await provider.fetchRates(base, [...quotes]);
      fetched.set(base, { rates: r.rates, asOf: r.asOf });
      outcome.basesFetched.push(base);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log.warn("FX refresh: provider fetch failed for this base", { base, error: why });
      fetched.set(base, { error: why });
    }
  }

  for (const r of rows) {
    const base = r.defaultCurrency?.toUpperCase();
    if (!base) continue;
    const got = fetched.get(base);
    if (!got) continue;

    let rates = (r.exchangeRates ?? {}) as RatesMap;
    let sources = (r.exchangeRateSources ?? {}) as SourcesMap;
    let touched = false;

    for (const state of currencyRateStates(r)) {
      if (state.source !== "auto") continue; // manual rates are the operator's, untouched
      const ccy = state.currency;
      if ("error" in got) {
        sources = {
          ...sources,
          [ccy]: {
            source: "auto",
            // The rate we still hold is unchanged, so its publication date is too.
            updated_at: state.updatedAt,
            provider: provider.name,
            last_error: got.error,
          },
        };
        outcome.failures.push({ businessId: r.id, currency: ccy, reason: got.error });
        touched = true;
        continue;
      }
      const rate = got.rates[ccy];
      if (rate == null) {
        const reason = `${provider.name} does not quote ${ccy} against ${base}`;
        sources = {
          ...sources,
          [ccy]: {
            source: "auto",
            updated_at: state.updatedAt,
            provider: provider.name,
            last_error: reason,
          },
        };
        outcome.failures.push({ businessId: r.id, currency: ccy, reason });
        touched = true;
        continue;
      }
      rates = { ...rates, [ccy]: rate };
      sources = {
        ...sources,
        [ccy]: {
          source: "auto",
          updated_at: got.asOf.toISOString(),
          provider: provider.name,
          last_error: null,
        },
      };
      outcome.currenciesUpdated += 1;
      touched = true;
    }

    if (!touched) continue;
    // Tenant-scoped for the write, though the PASS is cross-organization: the observation
    // must commit with the rate it describes, and it is an org-scoped row.
    await withTenant(r.organizationId, async (tx) => {
      await tx
        .update(businesses)
        .set({
          exchangeRates: Object.keys(rates).length > 0 ? rates : null,
          exchangeRateSources: sources,
          updatedAt: input.now,
        })
        .where(eq(businesses.id, r.id));
      await recordExchangeRateObservations(tx, {
        organizationId: r.organizationId,
        businessId: r.id,
        observedAt: input.now,
      });
    });
  }

  for (const t of orgTargets) {
    await applyOrganizationRates(
      t,
      orgAutos.get(t.id) ?? [],
      fetched,
      provider,
      input.now,
      outcome,
    );
  }

  log.info("FX refresh pass complete", {
    businesses: outcome.businessesConsidered,
    updated: outcome.currenciesUpdated,
    failed: outcome.failures.length,
    bases: outcome.basesFetched,
    organizations: outcome.organizationsConsidered,
    organizationsUpdated: outcome.organizationCurrenciesUpdated,
    organizationsFailed: outcome.organizationFailures.length,
  });
  return outcome;
}
