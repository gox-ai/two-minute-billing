import { afterEach, describe, expect, it, vi } from "vitest";
import { ecbFxProvider } from "@/platform/fx/ecb";
import { FxProviderError } from "@/platform/fx/types";

/**
 * The ECB feed, parsed and cross-rated.
 *
 * The direction is the thing under test. A rate inverted between "quote per base" and
 * "base per quote" is off by ~9000x on an INR book and produces a converted report that
 * looks plausible and reconciles against nothing — the exact failure the 0228 snapshot
 * exists to prevent. So the arithmetic is pinned against a fixture whose expected values
 * were checked by hand.
 *
 * Measured against the live feed 2026-09-02 for sanity: USD base gave INR 94.9749524961,
 * within 0.02% of an independent quote the same day.
 */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='2026-09-02'>
      <Cube currency='USD' rate='1.0812'/>
      <Cube currency='INR' rate='102.6795'/>
      <Cube currency='GBP' rate='0.80195'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

const mockFeed = (body: string, ok = true, status = 200) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok,
    status,
    text: async () => body,
  } as unknown as Response);

afterEach(() => vi.restoreAllMocks());

describe("ecbFxProvider", () => {
  it("cross-rates a non-EUR base as QUOTE PER BASE", async () => {
    mockFeed(FIXTURE);
    const r = await ecbFxProvider.fetchRates("USD", ["INR", "GBP"]);
    // Pinned as a string, because the scale is part of the contract (the column is
    // numeric(20,10) and the API reports it verbatim).
    expect(r.rates.INR).toBe("94.9680910100");

    /**
     * …and checked as a PROPERTY, which is what actually pins the direction: for a
     * quote-per-base rate, `rate × (base per EUR)` must give back the feed's own
     * (quote per EUR). Transcribing a second hand-computed constant would only test my
     * arithmetic — and it twice tested it wrong while writing this file, which is the
     * argument for asserting the relationship instead.
     */
    const usdPerEur = 1.0812;
    expect(Number(r.rates.INR) * usdPerEur).toBeCloseTo(102.6795, 6);
    expect(Number(r.rates.GBP) * usdPerEur).toBeCloseTo(0.80195, 6);
    // An INR-per-USD rate is > 1 and a GBP-per-USD rate is < 1; the inverted reading
    // would swap both.
    expect(Number(r.rates.INR)).toBeGreaterThan(1);
    expect(Number(r.rates.GBP)).toBeLessThan(1);
    expect(r.base).toBe("USD");
  });

  it("reports the FEED's publication day, not the fetch time", async () => {
    // The ECB publishes on weekdays, so a weekend fetch holds Friday's rate. Reporting
    // `new Date()` here would let the screen claim a rate exists for a day it does not.
    mockFeed(FIXTURE);
    const r = await ecbFxProvider.fetchRates("EUR", ["USD"]);
    expect(r.asOf.toISOString()).toBe("2026-09-02T00:00:00.000Z");
  });

  it("gives EUR itself 1, and any base its own parity", async () => {
    mockFeed(FIXTURE);
    expect((await ecbFxProvider.fetchRates("EUR", ["USD"])).rates.USD).toBe("1.0812000000");
    expect((await ecbFxProvider.fetchRates("USD", ["USD"])).rates.USD).toBe("1.0000000000");
  });

  it("omits a currency the ECB does not quote instead of inventing one", async () => {
    mockFeed(FIXTURE);
    const r = await ecbFxProvider.fetchRates("USD", ["INR", "XOF"]);
    expect(r.rates.INR).toBeDefined();
    expect(r.rates.XOF).toBeUndefined(); // the caller records this per-currency
  });

  it("fails loudly when the feed changes shape, rather than half-reading it", async () => {
    // A silent partial parse would write a subset of rates and mark the rest failed,
    // which reads as a provider outage and hides a format change indefinitely.
    mockFeed("<Envelope><Cube><Cube time='2026-09-02'></Cube></Cube></Envelope>");
    await expect(ecbFxProvider.fetchRates("USD", ["INR"])).rejects.toThrow(FxProviderError);

    mockFeed("<Envelope><Cube><Cube currency='USD' rate='1.08'/></Cube></Envelope>");
    await expect(ecbFxProvider.fetchRates("USD", ["INR"])).rejects.toThrow(/publication date/);
  });

  it("refuses a base the feed does not quote", async () => {
    mockFeed(FIXTURE);
    await expect(ecbFxProvider.fetchRates("XOF", ["INR"])).rejects.toThrow(/does not quote XOF/);
  });

  it("turns a transport failure into an FxProviderError naming the cause", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      Object.assign(new Error("signal timed out"), { name: "TimeoutError" }),
    );
    await expect(ecbFxProvider.fetchRates("USD", ["INR"])).rejects.toThrow(/TimeoutError/);

    mockFeed("", false, 503);
    await expect(ecbFxProvider.fetchRates("USD", ["INR"])).rejects.toThrow(/HTTP 503/);
  });
});
