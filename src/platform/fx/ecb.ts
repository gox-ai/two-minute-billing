import { createLogger } from "@/platform/logger";
import { FxProviderError, type FxProvider, type FxRates } from "./types";

const log = createLogger("fx.ecb");

/**
 * The European Central Bank's daily reference rates.
 *
 * WHY THE ECB. It is free, needs no account or API key (so no secret to rotate and no
 * quota to exhaust mid-month), and it is a public institution publishing a figure it is
 * accountable for — which matters more than convenience here, because this number ends up
 * stamped on tax invoices and someone may have to say later where it came from.
 *
 * THREE PROPERTIES OF THE FEED THAT LEAK INTO THE PRODUCT, and must be shown rather than
 * smoothed over:
 *
 *  1. **It is EUR-based.** Every rate is `X per 1 EUR`. Any other base is a CROSS-RATE
 *     computed from two legs (`eur[quote] / eur[base]`), which is arithmetic on two
 *     rounded published figures, not a quoted market rate. Fine for a reporting roll-up;
 *     worth knowing before anyone reconciles it against a bank statement to the paisa.
 *  2. **Weekdays only**, published around 16:00 CET. A Saturday or Sunday refresh returns
 *     FRIDAY's rates, and `asOf` says so — which is why `asOf` comes from the feed's own
 *     `time` attribute and never from `new Date()`. A screen that showed the fetch time
 *     would claim a Sunday rate exists.
 *  3. **~30 currencies, not all of them.** A currency the ECB does not quote simply has no
 *     key in the result; the caller reports that currency as un-refreshable instead of
 *     inventing a rate for it.
 *
 * PARSED WITH A REGEX, deliberately. The document is a fixed three-level `Cube` structure
 * that has not changed shape in twenty years, and the alternative is adding an XML parser
 * to the dependency tree to read forty self-closing tags. The regex is anchored on both
 * attributes and the parse FAILS LOUDLY (`FxProviderError`) if it finds no rates or no
 * date, so a feed that does change shape stops the refresh rather than half-reading it.
 */
const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

/**
 * Hard ceiling on the fetch. The lesson is bought and paid for: one unreachable SMTP host
 * stalled the billing clock for three days (2026-09-01), and the remedy was isolation plus
 * a deadline on every outbound call. This runs on its own cron line, off the billing
 * queue, AND with a timeout — a rate feed being down must cost a stale rate, never a tick.
 */
const FETCH_TIMEOUT_MS = 10_000;

/** `<Cube currency='USD' rate='1.0812'/>` — attribute order fixed by the feed. */
const RATE_RE = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/?>/g;
/** `<Cube time='2026-09-01'>` — the publication day. */
const TIME_RE = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/;

/** 10 decimal places to match `numeric(20,10)`; no exponent notation, ever. */
function toRateString(n: number): string {
  return n.toFixed(10);
}

export const ecbFxProvider: FxProvider = {
  name: "ecb",

  async fetchRates(base: string, quotes: readonly string[]): Promise<FxRates> {
    const res = await fetch(ECB_DAILY_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/xml" },
    }).catch((e: unknown) => {
      // A timeout and a DNS failure are the same thing to the caller — the rates did not
      // arrive — but the message has to say which, or a week of stale rates is unreadable.
      const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      throw new FxProviderError(`ECB fetch failed (${why})`, "ecb");
    });
    if (!res.ok) {
      throw new FxProviderError(`ECB fetch failed (HTTP ${res.status})`, "ecb");
    }
    const xml = await res.text();

    const day = TIME_RE.exec(xml)?.[1];
    if (!day) {
      throw new FxProviderError("ECB feed carried no <Cube time=…> publication date", "ecb");
    }

    /** `currency → per 1 EUR`. EUR itself is the base and is never listed. */
    const perEur = new Map<string, number>([["EUR", 1]]);
    for (const m of xml.matchAll(RATE_RE)) {
      const rate = Number(m[2]);
      if (Number.isFinite(rate) && rate > 0) perEur.set(m[1]!.toUpperCase(), rate);
    }
    // 1 is the EUR seed, so a successful parse has more than one entry. Exactly one means
    // the document arrived but nothing in it matched — a shape change, not an empty day.
    if (perEur.size <= 1) {
      throw new FxProviderError("ECB feed carried no parseable <Cube currency=… rate=…>", "ecb");
    }

    const baseUp = base.toUpperCase();
    const perEurBase = perEur.get(baseUp);
    if (perEurBase == null) {
      throw new FxProviderError(
        `ECB does not quote ${baseUp}, so no rate can be expressed against it`,
        "ecb",
      );
    }

    const rates: Record<string, string> = {};
    const missing: string[] = [];
    for (const q of quotes) {
      const qUp = q.toUpperCase();
      if (qUp === baseUp) {
        // Parity is a fact, and asking the feed for it would be a way to get it wrong.
        rates[qUp] = toRateString(1);
        continue;
      }
      const perEurQuote = perEur.get(qUp);
      if (perEurQuote == null) {
        missing.push(qUp);
        continue;
      }
      // The cross-rate: (quote per EUR) / (base per EUR) = quote per base.
      rates[qUp] = toRateString(perEurQuote / perEurBase);
    }

    if (missing.length > 0) {
      // Not an error: the other currencies refreshed fine, and the caller records the gap
      // per-currency so the screen can say WHICH currency the ECB will not quote.
      log.info("ECB does not quote some of the requested currencies", {
        base: baseUp,
        missing,
        asOf: day,
      });
    }

    return { base: baseUp, asOf: new Date(`${day}T00:00:00Z`), rates };
  },
};

/** The ECB's historical series API — the same reference rates, any date range, as CSV. */
const ECB_HISTORY_URL = "https://data-api.ecb.europa.eu/service/data/EXR";

/**
 * Every published day between `from` and `to` (inclusive, `YYYY-MM-DD`) for `currencies`,
 * as `currency → per 1 EUR`. For the one-off history backfill, not the refresh, so it gets a
 * longer deadline: years of daily rows are one request.
 */
export async function fetchEcbHistory(
  currencies: readonly string[],
  from: string,
  to: string,
): Promise<{ day: string; perEur: Map<string, number> }[]> {
  const quoted = [...new Set(currencies.map((c) => c.toUpperCase()).filter((c) => c !== "EUR"))];
  if (quoted.length === 0) return [];
  const url =
    `${ECB_HISTORY_URL}/D.${quoted.join("+")}.EUR.SP00.A` +
    `?startPeriod=${from}&endPeriod=${to}&format=csvdata`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }).catch((e: unknown) => {
    const why = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new FxProviderError(`ECB history fetch failed (${why})`, "ecb");
  });
  if (!res.ok) throw new FxProviderError(`ECB history fetch failed (HTTP ${res.status})`, "ecb");
  const lines = (await res.text()).split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = lines.shift()?.split(",") ?? [];
  const col = (name: string) => head.indexOf(name);
  const [iCcy, iDay, iValue] = [col("CURRENCY"), col("TIME_PERIOD"), col("OBS_VALUE")];
  if (iCcy < 0 || iDay < 0 || iValue < 0) {
    throw new FxProviderError(
      "ECB history carried no CURRENCY/TIME_PERIOD/OBS_VALUE columns",
      "ecb",
    );
  }
  const byDay = new Map<string, Map<string, number>>();
  for (const line of lines) {
    // The columns read here come before the first quoted field, so a plain split is exact.
    const f = line.split(",");
    const rate = Number(f[iValue]);
    if (!Number.isFinite(rate) || rate <= 0) continue;
    const day = f[iDay]!;
    const m = byDay.get(day) ?? new Map<string, number>([["EUR", 1]]);
    m.set(f[iCcy]!.toUpperCase(), rate);
    byDay.set(day, m);
  }
  return [...byDay.entries()].map(([day, perEur]) => ({ day, perEur }));
}
