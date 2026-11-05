/**
 * The FX rate source, behind an interface.
 *
 * The engine has exactly one rule about external services (CLAUDE.md, locked decision 8's
 * neighbour): it talks to them through an adapter, never by importing a vendor SDK at the
 * call site. That rule was written for payment providers; it earns its keep here too,
 * because a rate feed is the same shape of dependency — someone else's uptime, someone
 * else's number format, and a switch to a different one later that must not touch the
 * refresh logic.
 *
 * What a provider is NOT allowed to be is authoritative over money. Nothing in the
 * billing path reads these rates: they feed the reporting roll-up and the 0228 invoice
 * snapshot, both of which describe money that has already been decided in its own
 * currency. A fetched number that could change what a customer is charged would put a
 * third-party feed inside a bill.
 */

/** One fetch's worth of rates, all against `base`. */
export interface FxRates {
  /** The currency the rates are quoted against, upper-case ISO. */
  base: string;
  /**
   * The day the SOURCE published these — not when we fetched them. ECB publishes once
   * per weekday, so a Sunday fetch legitimately returns Friday's date, and the screen
   * shows the publication date rather than implying we have Sunday's rate.
   */
  asOf: Date;
  /**
   * `quote → rate` as a DECIMAL STRING: units of the quote currency per 1 unit of `base`
   * (`{ INR: "94.9537410000" }` on a USD base). Strings because these land in
   * `numeric(20,10)` columns and a float round-trip is how an exact rate becomes
   * `94.95374099999999`. Only currencies the source actually quotes appear — a missing
   * key means "this source does not publish that currency", which the caller must report
   * rather than paper over.
   */
  rates: Record<string, string>;
}

export interface FxProvider {
  /** Stored on each refreshed currency as `provider`, so a rate can be sourced later. */
  readonly name: string;
  /**
   * Fetch `quotes` against `base`. Throws on transport failure, a malformed feed, or a
   * timeout — the caller keeps the last good rate and records the error, because a stale
   * rate is a reporting inaccuracy while an absent one breaks the roll-up outright.
   */
  fetchRates(base: string, quotes: readonly string[]): Promise<FxRates>;
}

/** Unusable-feed marker, so the refresh can tell a bad response from a network fault. */
export class FxProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = "FxProviderError";
  }
}
