import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { majorTextToMinorFixed12, numericText } from "@/modules/model-prices/decimal";
import { aliasesOf, FeedSchemaError, parseFeed, tokenTypeOf } from "@/modules/model-prices/parse";
import { planSync, suspectFingerprint } from "@/modules/model-prices/sync";
import {
  ModelPriceBook,
  type Candidate,
  type CostRow,
  type ListRow,
} from "@/modules/model-prices/resolve";
import { FIXED12_SCALE } from "@/platform/fixed";

const FEED = readFileSync(new URL("./fixtures/model-prices-feed.json", import.meta.url), "utf8");
const C = FIXED12_SCALE;

describe("source decimals → cents (Fixed12)", () => {
  it("moves digits, never a float: 0.29 USD = 29 cents exactly", () => {
    expect(majorTextToMinorFixed12("0.29")).toEqual({ value: 29n * C, rounded: false });
    expect(numericText(29n * C)).toBe("29.000000000000");
    // The float path this replaces: 0.29 × 100 × 10^12 is not 29 × 10^12.
    expect(BigInt(Math.trunc(0.29 * 100 * 1e12))).not.toBe(29n * C);
  });

  it("reads integers, exponents and long fractions", () => {
    expect(majorTextToMinorFixed12("8").value).toBe(800n * C);
    expect(majorTextToMinorFixed12("1.5e-3").value).toBe(15n * 10n ** 10n);
    expect(majorTextToMinorFixed12("0.0028").value).toBe(28n * 10n ** 10n);
  });

  it("rounds half-up once past 12 places in cents and marks it", () => {
    // 0.000000000000125 USD = 0.0000000000125 cents (13 places) → 0.000000000013.
    expect(majorTextToMinorFixed12("0.000000000000125")).toEqual({ value: 13n, rounded: true });
    expect(majorTextToMinorFixed12("0.000000000000124")).toEqual({ value: 12n, rounded: true });
    expect(majorTextToMinorFixed12("0.041666666666666664").rounded).toBe(true);
  });

  it("refuses negatives and junk", () => {
    expect(() => majorTextToMinorFixed12("-1")).toThrow();
    expect(() => majorTextToMinorFixed12("abc")).toThrow();
  });
});

describe("feed parser", () => {
  const feed = parseFeed(FEED);
  const model = (p: string, m: string) =>
    feed.models.find((x) => x.provider === p && x.model === m)!;

  it("maps units: _mtok per 1M, _kcount per 1K; hours, pages and characters are skipped", () => {
    expect(tokenTypeOf("cache_write_1h_mtok")).toEqual({
      tokenType: "cache_write_1h",
      divisor: 1_000_000n,
    });
    expect(tokenTypeOf("web_searches_kcount")).toEqual({
      tokenType: "web_searches",
      divisor: 1000n,
    });
    expect(tokenTypeOf("input_mchars")).toBeNull();
    expect(tokenTypeOf("input_document_kpages")).toBeNull();
    expect(tokenTypeOf("audio_hours")).toBeNull();
    // A model priced only in characters is not a list model.
    expect(feed.models.some((m) => m.provider === "groq")).toBe(false);
    expect(feed.summary.skippedUnits).toBeGreaterThan(0);
  });

  it("keeps dated lists, the base of a context tier, and ignores variants", () => {
    const opus = model("anthropic", "claude-opus-4-6");
    expect(opus.entries.map((e) => e.startDate)).toEqual([null, "2026-03-13"]);
    expect(opus.entries[0]!.prices.get("input")).toEqual({
      value: 500n * C,
      divisor: 1_000_000n,
      rounded: false,
    });
    // Batch variants (input $2.50) never appear.
    expect(opus.entries.every((e) => e.prices.get("input")!.value === 500n * C)).toBe(true);
    const haiku = model("anthropic", "claude-haiku-5-5");
    expect(haiku.entries[0]!.prices.get("input")!.value).toBe(10n * C);
    expect(haiku.contextTiers).toMatchObject({
      input: { base: "0.1", tiers: [{ start: "100000", price: "0.5" }] },
    });
  });

  it("skips time-of-day entries: the standard price only", () => {
    const chat = model("deepseek", "deepseek-chat");
    expect(chat.entries).toHaveLength(1);
    expect(chat.entries[0]!.prices.get("input")!.value).toBe(135n * 10n ** 11n);
    expect(feed.summary.skippedTimeOfDay).toBe(1);
  });

  it("takes aliases from `equals` only, never patterns or the id itself", () => {
    expect(model("anthropic", "claude-opus-4-0").aliases).toEqual([
      "claude-opus-4",
      "claude-opus-4-20250514",
    ]);
    expect(model("anthropic", "claude-haiku-5-5").aliases).toEqual([]);
    expect(aliasesOf({ and: [{ equals: "x" }] }, "y")).toEqual([]);
  });

  it("refuses a body that is not the feed", () => {
    expect(() => parseFeed("{not json")).toThrow(FeedSchemaError);
    expect(() => parseFeed('{"providers": []}')).toThrow(FeedSchemaError);
    expect(() => parseFeed('[{"id": "x", "models": [{"id": "m", "prices": "free"}]}]')).toThrow(
      FeedSchemaError,
    );
  });
});

describe("sync plan", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const one = (prices: string, extra = "") =>
    parseFeed(`[{"id":"p","models":[{"id":"m","prices":${prices}}${extra}]}]`).models;
  const row = (fromMs: number, cents: bigint) => ({
    fromMs,
    value: cents * C,
    divisor: 1_000_000n,
  });

  it("a new key gets its whole dated history; the undated first entry from -infinity", () => {
    const plan = planSync(
      one(
        '[{"prices":{"input_mtok":3}},{"constraint":{"start_date":"2026-12-01"},"prices":{"input_mtok":2.5}}]',
      ),
      new Map(),
      now,
    );
    expect(plan.rows.map((r) => [r.from, r.unitAmount, r.oldUnitAmount])).toEqual([
      ["-infinity", "300.000000000000", null],
      ["2026-12-01", "250.000000000000", null],
    ]);
    expect(plan.reasons).toEqual([]);
  });

  it("the same price writes nothing; a change applies from now and keeps the source date", () => {
    const current = new Map([["p\u0000m\u0000input", [row(Number.NEGATIVE_INFINITY, 300n)]]]);
    expect(planSync(one('{"input_mtok":3}'), current, now).rows).toEqual([]);
    const plan = planSync(
      one(
        '[{"prices":{"input_mtok":3}},{"constraint":{"start_date":"2026-10-01"},"prices":{"input_mtok":2.5}}]',
      ),
      current,
      now,
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      from: "now",
      sourceEffectiveFrom: "2026-10-01",
      unitAmount: "250.000000000000",
      oldUnitAmount: "300.000000000000",
    });
  });

  it("a future-dated change is planned on its date, once", () => {
    const current = new Map([["p\u0000m\u0000input", [row(Number.NEGATIVE_INFINITY, 300n)]]]);
    const feed = one(
      '[{"prices":{"input_mtok":3}},{"constraint":{"start_date":"2026-12-01"},"prices":{"input_mtok":2.5}}]',
    );
    expect(planSync(feed, current, now).rows.map((r) => r.from)).toEqual(["2026-12-01"]);
    current.get("p\u0000m\u0000input")!.push(row(Date.parse("2026-12-01T00:00:00Z"), 250n));
    expect(planSync(feed, current, now).rows).toEqual([]);
  });

  it("holds a run that moves a price tenfold, zeroes one, or changes > 25% of keys", () => {
    const current = new Map([
      ["p\u0000m\u0000input", [row(Number.NEGATIVE_INFINITY, 300n)]],
      ["p\u0000m\u0000output", [row(Number.NEGATIVE_INFINITY, 1500n)]],
    ]);
    expect(planSync(one('{"input_mtok":300,"output_mtok":15}'), current, now).reasons).toEqual([
      "many_keys_changed",
      "price_moved_tenfold",
    ]);
    expect(planSync(one('{"input_mtok":0,"output_mtok":15}'), current, now).reasons).toContain(
      "price_to_zero",
    );
    // ×10 exactly is not "more than": 1 of 2 keys is 50 %, so the share still holds it.
    expect(planSync(one('{"input_mtok":30,"output_mtok":15}'), current, now).reasons).toEqual([
      "many_keys_changed",
    ]);
  });

  it("the settle fingerprint changes only with the suspect prices", () => {
    // Eight keys, so two changes (25 %) stay under the share rule.
    const types = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
    const current = new Map(
      types.map((t) => [`p\u0000m\u0000${t}`, [row(Number.NEGATIVE_INFINITY, 300n)]]),
    );
    const feed = (t1: number, t2: number) =>
      JSON.stringify(
        Object.fromEntries(
          types
            .map((t) => [`${t}_mtok`, 3])
            .concat([
              ["t1_mtok", t1],
              ["t2_mtok", t2],
            ]),
        ),
      );
    const plan = (t1: number, t2: number) => planSync(one(feed(t1, t2)), current, now);
    expect(plan(300, 3).reasons).toEqual(["price_moved_tenfold"]);
    const spike = suspectFingerprint(plan(300, 3));
    expect(spike).not.toBe("");
    // Another key moves a little: same suspect prices, the clock keeps running.
    expect(plan(300, 3.5).reasons).toEqual(["price_moved_tenfold"]);
    expect(suspectFingerprint(plan(300, 3.5))).toBe(spike);
    // The suspect price itself moves: a new clock.
    expect(suspectFingerprint(plan(200, 3))).not.toBe(spike);
  });
});

describe("price book (resolvers)", () => {
  const listRow = (over: Partial<ListRow>): ListRow => ({
    id: "id",
    public_id: "mpr_1",
    provider: "openai",
    model: "gpt-x",
    token_type: "input",
    currency: "USD",
    unit_amount_decimal: "300",
    quantity_divisor: "1000000",
    from_ms: null,
    source: "genai-prices",
    source_version: "v1",
    source_effective_from: null,
    ...over,
  });
  const costRow = (over: Partial<CostRow>): CostRow => ({
    id: "c",
    public_id: "mco_1",
    provider: null,
    model: "gpt-x",
    token_type: "input",
    currency: "USD",
    unit_amount_decimal: "200",
    quantity_divisor: "1000000",
    from_ms: String(Date.parse("2026-11-01T00:00:00Z")),
    to_ms: null,
    ...over,
  });
  const T = Date.parse("2026-11-15T10:00:00Z");
  const cands = (m: Record<string, Candidate[]>) => new Map(Object.entries(m));
  const key = (k: string) => `openai\u0000gpt-x\u0000input\u0000USD${k}`;
  const book = (costs: CostRow[] = []) =>
    new ModelPriceBook(
      cands({
        "gpt-x": [{ provider: "openai", model: "gpt-x", exact: true }],
        "gpt-x-0324": [{ provider: "openai", model: "gpt-x", exact: false }],
        shared: [
          { provider: "openai", model: "shared", exact: true },
          { provider: "azure", model: "shared", exact: true },
        ],
      }),
      new Map([
        [
          key(""),
          [
            listRow({}),
            listRow({ public_id: "mpr_2", unit_amount_decimal: "250", from_ms: String(T) }),
          ],
        ],
      ]),
      costs,
    );
  const k = { model: "gpt-x", tokenType: "input", currency: "USD" };

  it("the list price is the row with the greatest start at or before the instant", () => {
    const b = book();
    expect(b.listPrice(k, new Date(T - 1))).toMatchObject({
      publicId: "mpr_1",
      effectiveFrom: null,
    });
    expect(b.listPrice(k, new Date(T))).toMatchObject({ publicId: "mpr_2" });
    expect(b.listPrice({ ...k, model: "gpt-x-0324" }, new Date(T))).toMatchObject({
      publicId: "mpr_2",
      model: "gpt-x",
    });
  });

  it("an unknown provider under several providers is ambiguous", () => {
    expect(book().listPrice({ ...k, model: "shared" }, new Date(T))).toEqual({
      kind: null,
      reason: "ambiguous_provider",
    });
  });

  it("never converts a list price to another currency", () => {
    expect(book().listPrice({ ...k, currency: "INR" }, new Date(T))).toEqual({
      kind: null,
      reason: "not_found",
    });
    const inr = book([costRow({ currency: "INR", unit_amount_decimal: "16000" })]);
    expect(inr.modelCost({ ...k, currency: "INR" }, new Date(T))).toMatchObject({
      kind: "cost",
      currency: "INR",
    });
  });

  it("your cost wins while live; the list after it ends; an exact provider beats any", () => {
    const b = book([
      costRow({ to_ms: String(T + 3_600_000) }),
      costRow({ public_id: "mco_2", provider: "openai", unit_amount_decimal: "190" }),
    ]);
    expect(b.modelCost({ ...k, provider: "openai" }, new Date(T))).toMatchObject({
      kind: "cost",
      publicId: "mco_2",
    });
    expect(b.modelCost(k, new Date(T))).toMatchObject({ kind: "cost", publicId: "mco_1" });
    expect(b.modelCost(k, new Date(T + 3_600_000))).toMatchObject({
      kind: "list",
      publicId: "mpr_2",
    });
    // The list price itself ignores your cost.
    expect(b.listPrice(k, new Date(T))).toMatchObject({ kind: "list", publicId: "mpr_2" });
  });

  it("splits a window where a list row or a cost row starts or ends", () => {
    const b = book([costRow({ from_ms: String(T + 60_000), to_ms: String(T + 120_000) })]);
    const start = new Date(T - 3_600_000);
    const end = new Date(T + 3_600_000);
    expect(b.changeInstants(k, start, end).map((d) => d.getTime())).toEqual([
      T,
      T + 60_000,
      T + 120_000,
    ]);
  });
});
