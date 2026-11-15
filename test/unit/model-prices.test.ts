import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { majorTextToMinorFixed12, numericText } from "@/modules/model-prices/decimal";
import {
  aliasesOf,
  FeedSchemaError,
  feedPriceKeyOf,
  parseFeed,
  priceKey,
} from "@/modules/model-prices/parse";
import { keyOf, planSync, suspectFingerprint, type HeldRow } from "@/modules/model-prices/sync";
import { perUnitText, tierOrder } from "@/modules/model-prices/units";
import {
  canonicalMediaModels,
  mediaFieldOf,
  mediaKeyOf,
  mediaProviderOf,
  parseMediaFeed,
} from "@/modules/model-prices/parse-media";
import {
  ModelPriceBook,
  type Candidate,
  type CostRow,
  type ListRow,
} from "@/modules/model-prices/resolve";
import { FIXED12_SCALE } from "@/platform/fixed";

const FEED = readFileSync(new URL("./fixtures/model-prices-feed.json", import.meta.url), "utf8");
const MEDIA_FEED = readFileSync(
  new URL("./fixtures/model-prices-media-feed.json", import.meta.url),
  "utf8",
);
const IN = priceKey("input", "token");
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

  it("maps every feed suffix to a kind, a unit and a divisor", () => {
    expect(feedPriceKeyOf("cache_write_1h_mtok")).toEqual({
      tokenType: "cache_write_1h",
      unit: "token",
      divisor: 1_000_000n,
    });
    expect(feedPriceKeyOf("web_searches_kcount")).toEqual({
      tokenType: "web_searches",
      unit: "request",
      divisor: 1000n,
    });
    expect(feedPriceKeyOf("input_audio_hours")).toEqual({
      tokenType: "input",
      unit: "audio_second",
      divisor: 3600n,
    });
    expect(feedPriceKeyOf("audio_hours")).toEqual({
      tokenType: "audio",
      unit: "audio_second",
      divisor: 3600n,
    });
    expect(feedPriceKeyOf("input_mchars")).toEqual({
      tokenType: "input",
      unit: "character",
      divisor: 1_000_000n,
    });
    expect(feedPriceKeyOf("input_document_kpages")).toEqual({
      tokenType: "input_document",
      unit: "page",
      divisor: 1000n,
    });
    expect(feedPriceKeyOf("input_annotated_document_kpages")).toMatchObject({
      tokenType: "input_annotated_document",
      unit: "page",
    });
    expect(feedPriceKeyOf("output_gpixels")).toEqual({
      tokenType: "output",
      unit: "pixel",
      divisor: 1_000_000_000n,
    });
    expect(feedPriceKeyOf("input_furlongs")).toBeNull();
    expect(feedPriceKeyOf("hours")).toBeNull();
    // A model priced only in characters is now a list model.
    expect(model("groq", "canopylabs/orpheus-arabic-saudi").entries[0]!.prices.size).toBe(1);
  });

  it("keeps media prices exactly as the source wrote them, per unit", () => {
    const media = parseFeed(MEDIA_FEED);
    const m = (id: string) => media.models.find((x) => x.model === id)!;
    // $0.36 per audio hour = 36 cents per 3,600 seconds, no float.
    expect(m("whisper-1").entries[0]!.prices.get(priceKey("input", "audio_second"))).toEqual({
      tokenType: "input",
      unit: "audio_second",
      value: 36n * C,
      divisor: 3600n,
      rounded: false,
    });
    expect(m("tts-1").entries[0]!.prices.get(priceKey("input", "character"))).toMatchObject({
      value: 1500n * C,
      divisor: 1_000_000n,
    });
    expect(
      m("mistral-ocr-2512").entries[0]!.prices.get(priceKey("input_document", "page")),
    ).toMatchObject({ value: 200n * C, divisor: 1000n });
    // The same kind in two units: both kept, under different keys.
    const vox = m("voxtral-small-24b-2507").entries.at(-1)!.prices;
    expect(vox.get(priceKey("input", "token"))).toMatchObject({ value: 10n * C });
    expect(vox.get(priceKey("input", "audio_second"))).toMatchObject({
      value: 24n * C,
      divisor: 3600n,
    });
    // An odd value is kept to the digit: 0.006 USD per hour = 0.6 cents.
    const odd = parseFeed(
      '[{"id":"p","models":[{"id":"m","prices":{"input_audio_hours":0.006}}]}]',
    );
    expect(odd.models[0]!.entries[0]!.prices.get(priceKey("input", "audio_second"))!.value).toBe(
      6n * 10n ** 11n,
    );
    expect(media.summary.skippedUnits).toBe(0);
  });

  it("keeps dated lists, the base of a context tier, and ignores variants", () => {
    const opus = model("anthropic", "claude-opus-4-6");
    expect(opus.entries.map((e) => e.startDate)).toEqual([null, "2026-03-13"]);
    expect(opus.entries[0]!.prices.get(IN)).toEqual({
      tokenType: "input",
      unit: "token",
      value: 500n * C,
      divisor: 1_000_000n,
      rounded: false,
    });
    // Batch variants (input $2.50) never appear.
    expect(opus.entries.every((e) => e.prices.get(IN)!.value === 500n * C)).toBe(true);
    const haiku = model("anthropic", "claude-haiku-5-5");
    expect(haiku.entries[0]!.prices.get(IN)!.value).toBe(10n * C);
    expect(haiku.contextTiers).toMatchObject({
      input: { base: "0.1", tiers: [{ start: "100000", price: "0.5" }] },
    });
  });

  it("skips time-of-day entries: the standard price only", () => {
    const chat = model("deepseek", "deepseek-chat");
    expect(chat.entries).toHaveLength(1);
    expect(chat.entries[0]!.prices.get(IN)!.value).toBe(135n * 10n ** 11n);
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

  // Past dates all apply from the sync instant, so two of them collide on one key and the
  // earlier one used to win: the list then held an old price as the current one.
  it("a new key with several past-dated prices takes only the one in effect today", () => {
    const feed = one(
      '[{"prices":{"input_mtok":0.3}},' +
        '{"constraint":{"start_date":"2026-08-17"},"prices":{"input_mtok":0.22}},' +
        '{"constraint":{"start_date":"2026-09-10"},"prices":{"input_mtok":0.15}},' +
        '{"constraint":{"start_date":"2026-12-01"},"prices":{"input_mtok":0.1}}]',
    );
    expect(
      planSync(feed, new Map(), now).rows.map((r) => [r.from, r.unitAmount, r.sourceEffectiveFrom]),
    ).toEqual([
      ["-infinity", "30.000000000000", null],
      ["2026-09-10", "15.000000000000", "2026-09-10"],
      ["2026-12-01", "10.000000000000", "2026-12-01"],
    ]);
    // No undated entry: still one past price only.
    const dated = one(
      '[{"constraint":{"start_date":"2026-08-17"},"prices":{"input_mtok":0.22}},' +
        '{"constraint":{"start_date":"2026-09-10"},"prices":{"input_mtok":0.15}}]',
    );
    expect(planSync(dated, new Map(), now).rows.map((r) => [r.from, r.unitAmount])).toEqual([
      ["2026-09-10", "15.000000000000"],
    ]);
  });

  // A key stored by the old rule (the earliest past price as current) corrects itself.
  it("a key that holds an old past price as current moves to the live price on the next plan", () => {
    const feed = one(
      '[{"constraint":{"start_date":"2026-08-17"},"prices":{"input_mtok":0.22}},' +
        '{"constraint":{"start_date":"2026-09-10"},"prices":{"input_mtok":0.15}}]',
    );
    const current = new Map([[keyOf("p", "m", "input"), [row(now.getTime() - 3_600_000, 22n)]]]);
    const plan = planSync(feed, current, now);
    expect(plan.rows.map((r) => [r.from, r.unitAmount, r.oldUnitAmount])).toEqual([
      ["now", "15.000000000000", "22.000000000000"],
    ]);
  });

  it("the same price writes nothing; a change applies from now and keeps the source date", () => {
    const current = new Map([[keyOf("p", "m", "input"), [row(Number.NEGATIVE_INFINITY, 300n)]]]);
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
    const current = new Map([[keyOf("p", "m", "input"), [row(Number.NEGATIVE_INFINITY, 300n)]]]);
    const feed = one(
      '[{"prices":{"input_mtok":3}},{"constraint":{"start_date":"2026-12-01"},"prices":{"input_mtok":2.5}}]',
    );
    expect(planSync(feed, current, now).rows.map((r) => r.from)).toEqual(["2026-12-01"]);
    current.get(keyOf("p", "m", "input"))!.push(row(Date.parse("2026-12-01T00:00:00Z"), 250n));
    expect(planSync(feed, current, now).rows).toEqual([]);
  });

  it("holds a run that moves a price tenfold, zeroes one, or changes > 25% of keys", () => {
    const current = new Map([
      [keyOf("p", "m", "input"), [row(Number.NEGATIVE_INFINITY, 300n)]],
      [keyOf("p", "m", "output"), [row(Number.NEGATIVE_INFINITY, 1500n)]],
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
      types.map((t) => [keyOf("p", "m", t), [row(Number.NEGATIVE_INFINITY, 300n)]]),
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

describe("media prices: sync plan", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const tok = (fromMs: number, cents: bigint) => ({
    fromMs,
    value: cents * C,
    divisor: 1_000_000n,
  });

  it("a feed that only gains new keys applies them: no hold, no change to notify", () => {
    // Two known token keys and one request key, as the list held them before media prices.
    const current = new Map([
      [keyOf("openai", "whisper-1", "input"), [tok(Number.NEGATIVE_INFINITY, 1n)]],
      [keyOf("mistral", "voxtral-small-24b-2507", "input"), [tok(Number.NEGATIVE_INFINITY, 10n)]],
      [
        keyOf("mistral", "voxtral-small-24b-2507", "web_searches", "request"),
        [{ fromMs: Number.NEGATIVE_INFINITY, value: 1000n * C, divisor: 1000n }],
      ],
    ]);
    const models = parseFeed(MEDIA_FEED).models;
    const plan = planSync(models, current, now);
    expect(plan.reasons).toEqual([]);
    expect(plan.changedKeys).toBe(0);
    expect(plan.knownKeys).toBe(3);
    // Every planned row is a new key (no old price), so `changesOf` makes no notice of it.
    expect(plan.rows.length).toBeGreaterThan(5);
    expect(plan.rows.every((r) => r.oldUnitAmount === null)).toBe(true);
    expect(plan.rows.find((r) => r.model === "whisper-1" && r.tokenType === "input")).toMatchObject(
      { unit: "audio_second", divisor: "3600", unitAmount: "36.000000000000" },
    );
    // The known token price of the same kind is untouched by its audio twin.
    expect(
      plan.rows.some(
        (r) =>
          r.model === "voxtral-small-24b-2507" && r.tokenType === "input" && r.unit === "token",
      ),
    ).toBe(false);
  });

  it("many new keys against a small known list still never hold", () => {
    const current = new Map([[keyOf("p", "m", "input"), [tok(Number.NEGATIVE_INFINITY, 300n)]]]);
    const feed = parseFeed(
      `[{"id":"p","models":[{"id":"m","prices":{"input_mtok":3,"input_audio_hours":1,"audio_hours":2,"input_mchars":4,"input_document_kpages":5}}]}]`,
    ).models;
    const plan = planSync(feed, current, now);
    expect(plan.reasons).toEqual([]);
    expect(plan.rows.map((r) => `${r.tokenType}/${r.unit}`).sort()).toEqual([
      "audio/audio_second",
      "input/audio_second",
      "input/character",
      "input_document/page",
    ]);
  });

  it("a held row from before units reads as its old unit", () => {
    const old = {
      provider: "p",
      model: "m",
      tokenType: "web_searches",
      unitAmount: "1000.000000000000",
      divisor: "1000",
      rounded: false,
      from: "now",
      sourceEffectiveFrom: null,
      oldUnitAmount: "0.000000000000",
    } satisfies HeldRow;
    const fresh: HeldRow = { ...old, unit: "request", quality: "", resolution: "" };
    const fp = (r: HeldRow) => suspectFingerprint({ rows: [r], reasons: ["many_keys_changed"] });
    // Same suspect prices before and after the deploy: the settle clock keeps running.
    expect(fp(old)).toBe(fp(fresh));
    expect(fp({ ...fresh, unit: "audio_second" })).not.toBe(fp(old));
  });
});

describe("media prices: resolver units and tiers", () => {
  const T = Date.parse("2026-11-15T10:00:00Z");
  const row = (over: Partial<ListRow>): ListRow => ({
    id: over.public_id ?? "id",
    public_id: "mpr_1",
    provider: "openai",
    model: "img",
    token_type: "output",
    currency: "USD",
    unit_amount_decimal: "4",
    quantity_divisor: "1",
    from_ms: null,
    source: "genai-prices",
    source_version: null,
    source_effective_from: null,
    ...over,
  });
  const cost = (over: Partial<CostRow>): CostRow => ({
    id: over.public_id ?? "c",
    public_id: "mco_1",
    provider: null,
    model: "img",
    token_type: "output",
    currency: "USD",
    unit_amount_decimal: "3",
    quantity_divisor: "1",
    from_ms: String(T - 3_600_000),
    to_ms: null,
    ...over,
  });
  const book = (rows: ListRow[], costs: CostRow[] = []) =>
    new ModelPriceBook(
      new Map([["img", [{ provider: "openai", model: "img", exact: true }]]]),
      new Map([["openai\u0000img\u0000output\u0000USD", rows]]),
      costs,
    );
  const k = { model: "img", tokenType: "output", currency: "USD" };
  const at = new Date(T);

  it("no unit resolves token, else request; a named unit only that unit", () => {
    const legacy = book([row({ public_id: "mpr_req", unit: "request", quantity_divisor: "1000" })]);
    expect(legacy.listPrice(k, at)).toMatchObject({ publicId: "mpr_req", unit: "request" });
    const both = book([
      row({ public_id: "mpr_req", unit: "request" }),
      row({ public_id: "mpr_tok" }),
      row({ public_id: "mpr_img", unit: "image" }),
    ]);
    expect(both.listPrice(k, at)).toMatchObject({ publicId: "mpr_tok", unit: "token" });
    expect(both.listPrice({ ...k, unit: "image" }, at)).toMatchObject({ publicId: "mpr_img" });
    expect(both.listPrice({ ...k, unit: "audio_second" }, at)).toEqual({
      kind: null,
      reason: "not_found",
    });
    // A unit-less key never reaches a media row.
    expect(book([row({ unit: "image" })]).listPrice(k, at)).toEqual({
      kind: null,
      reason: "not_found",
    });
  });

  it("tiers: exact, then quality alone, then resolution alone, then no tier", () => {
    expect(tierOrder("hd", "1024x1024")).toEqual([
      ["hd", "1024x1024"],
      ["hd", ""],
      ["", "1024x1024"],
      ["", ""],
    ]);
    expect(tierOrder()).toEqual([["", ""]]);
    const img = { ...k, unit: "image" };
    const all = [
      cost({ public_id: "both", unit: "image", quality: "hd", resolution: "1024x1024" }),
      cost({ public_id: "q", unit: "image", quality: "hd" }),
      cost({ public_id: "r", unit: "image", resolution: "1024x1024" }),
      cost({ public_id: "none", unit: "image" }),
    ];
    const pick = (costs: CostRow[], q?: string, r?: string) =>
      book([], costs).ownCost({ ...img, quality: q, resolution: r }, at);
    expect(pick(all, "hd", "1024x1024")).toMatchObject({ publicId: "both" });
    expect(pick(all.slice(1), "hd", "1024x1024")).toMatchObject({ publicId: "q" });
    expect(pick(all.slice(2), "hd", "1024x1024")).toMatchObject({ publicId: "r" });
    expect(pick(all.slice(3), "hd", "1024x1024")).toMatchObject({ publicId: "none" });
    expect(pick(all, "standard")).toMatchObject({ publicId: "none" });
    expect(pick(all)).toMatchObject({ publicId: "none" });
    expect(pick(all.slice(0, 3))).toEqual({ kind: null, reason: "not_found" });
    // An ended exact row falls through to the next tier live at the instant.
    const ended = [cost({ ...all[0], to_ms: String(T - 1) }), all[3]!];
    expect(pick(ended, "hd", "1024x1024")).toMatchObject({ publicId: "none" });
  });

  it("an image cost row prices an event; the list fills in when there is none", () => {
    const b = book(
      [row({ public_id: "mpr_img", unit: "image", unit_amount_decimal: "4" })],
      [cost({ public_id: "mco_hd", unit: "image", quality: "hd", unit_amount_decimal: "8" })],
    );
    expect(b.modelCost({ ...k, unit: "image", quality: "hd" }, at)).toMatchObject({
      kind: "cost",
      publicId: "mco_hd",
      quality: "hd",
    });
    expect(b.modelCost({ ...k, unit: "image", quality: "standard" }, at)).toMatchObject({
      kind: "list",
      publicId: "mpr_img",
    });
    // A token cost row never prices an image.
    const t = book([], [cost({ public_id: "mco_tok" })]);
    expect(t.ownCost({ ...k, unit: "image" }, at)).toEqual({ kind: null, reason: "not_found" });
    expect(t.ownCost(k, at)).toMatchObject({ publicId: "mco_tok", unit: "token" });
  });
});

describe("price per unit, as people read it", () => {
  it("names the unit and the amount it is for", () => {
    expect(perUnitText("token", "1000000")).toBe("per 1M tokens");
    expect(perUnitText("request", "1000")).toBe("per 1K requests");
    expect(perUnitText("audio_second", "3600")).toBe("per hour of audio");
    expect(perUnitText("video_second", "1")).toBe("per second of video");
    expect(perUnitText("character", "1000000")).toBe("per 1M characters");
    expect(perUnitText("page", "1000")).toBe("per 1K pages");
    expect(perUnitText("image", "1")).toBe("per image");
    expect(perUnitText("pixel", "1000000000")).toBe("per 1B pixels");
    expect(perUnitText("token", "2500")).toBe("per 2,500 tokens");
  });
});

// ── The second source: media prices ─────────────────────────────────────────────────────────

const LITELLM = readFileSync(
  new URL("./fixtures/model-prices-litellm.json", import.meta.url),
  "utf8",
);

describe("second source: exponent numbers stay exact", () => {
  it("reads exponent text digit by digit, never as a float", () => {
    // 8.39233e-08 USD = 0.00000839233 cents.
    expect(majorTextToMinorFixed12("8.39233e-08")).toEqual({ value: 8_392_330n, rounded: false });
    expect(majorTextToMinorFixed12("1.5E+2")).toEqual({ value: 15_000n * C, rounded: false });
    expect(majorTextToMinorFixed12("2.5e-06").value).toBe(250_000_000n);
    // 1.59263611e-07 USD has 13 places in cents: half-up once, marked.
    expect(majorTextToMinorFixed12("1.59263611e-07")).toEqual({
      value: 15_926_361n,
      rounded: true,
    });
    expect(majorTextToMinorFixed12("1.59263615e-07")).toEqual({
      value: 15_926_362n,
      rounded: true,
    });
  });

  it("an exponent in the JSON text reaches the price unchanged", () => {
    const f = parseMediaFeed(
      '{"m": {"litellm_provider": "openai", "mode": "audio_speech", "input_cost_per_character": 8.39233e-08}}',
    );
    expect(f.models[0]!.entries[0]!.prices.get(priceKey("input", "character"))).toMatchObject({
      value: 8_392_330n,
      divisor: 1n,
      rounded: false,
    });
  });
});

describe("second source: fields, modes and tiers", () => {
  it("maps each imported field to a kind, a unit and a resolution", () => {
    const img = "image_generation";
    expect(mediaFieldOf("output_cost_per_image", img)).toEqual({
      tokenType: "output",
      unit: "image",
      resolution: "",
    });
    expect(mediaFieldOf("output_cost_per_image_4K", img)).toMatchObject({ resolution: "4k" });
    expect(mediaFieldOf("output_cost_per_image_0.5K", img)).toMatchObject({ resolution: "0.5k" });
    expect(mediaFieldOf("output_cost_per_image_1024", img)).toMatchObject({ resolution: "1024" });
    expect(mediaFieldOf("input_cost_per_image", "embedding")).toMatchObject({
      tokenType: "input",
      unit: "image",
    });
    expect(mediaFieldOf("input_cost_per_character", "audio_speech")).toMatchObject({
      tokenType: "input",
      unit: "character",
    });
    expect(mediaFieldOf("input_cost_per_video_per_second", "chat")).toMatchObject({
      unit: "video_second",
    });
    expect(mediaFieldOf("output_cost_per_video_per_second", "video_generation")).toMatchObject({
      tokenType: "output",
      unit: "video_second",
    });
    // Variants and token prices are not imported.
    for (const f of [
      "output_cost_per_image_token",
      "output_cost_per_image_token_batches",
      "input_cost_per_image_above_128k_tokens",
      "input_cost_per_character_above_128k_tokens",
      "output_cost_per_character",
      "input_cost_per_token",
      "input_cost_per_pixel",
      "input_cost_per_video_per_second_above_8s_interval",
    ])
      expect(mediaFieldOf(f, img)).toBe("skip");
  });

  it("per-second prices take their unit from the mode, and skip when it says neither", () => {
    expect(mediaFieldOf("output_cost_per_second", "video_generation")).toMatchObject({
      unit: "video_second",
    });
    expect(mediaFieldOf("output_cost_per_second_1080p", "video_generation")).toMatchObject({
      unit: "video_second",
      resolution: "1080p",
    });
    expect(mediaFieldOf("output_cost_per_second", "audio_speech")).toMatchObject({
      unit: "audio_second",
    });
    expect(mediaFieldOf("input_cost_per_second", "audio_transcription")).toMatchObject({
      tokenType: "input",
      unit: "audio_second",
    });
    expect(mediaFieldOf("input_cost_per_second", "chat")).toBe("mode_unclear");
    expect(mediaFieldOf("output_cost_per_second", "realtime")).toBe("mode_unclear");
    expect(mediaFieldOf("output_cost_per_second", undefined)).toBe("mode_unclear");
    expect(mediaFieldOf("input_cost_per_second", "video_generation")).toBe("mode_unclear");
  });

  it("key prefixes become tiers; the provider prefix and the model stay apart", () => {
    expect(mediaKeyOf("azure/high/1024-x-1024/gpt-image-1", "azure")).toEqual({
      model: "gpt-image-1",
      quality: "high",
      resolution: "1024x1024",
    });
    expect(mediaKeyOf("1024-x-1024/50-steps/bedrock/amazon.nova-canvas-v1:0", "bedrock")).toEqual({
      model: "amazon.nova-canvas-v1:0",
      quality: "50-steps",
      resolution: "1024x1024",
    });
    expect(mediaKeyOf("standard/1024-x-1536/gpt-image-1.5", "openai")).toEqual({
      model: "gpt-image-1.5",
      quality: "standard",
      resolution: "1024x1536",
    });
    expect(mediaKeyOf("fal_ai/low/1024-x-768/openai/gpt-image-2", "fal_ai")).toEqual({
      model: "openai/gpt-image-2",
      quality: "low",
      resolution: "1024x768",
    });
    expect(mediaKeyOf("vertex_ai/veo-3.1-generate-001", "vertex_ai-video-models")).toMatchObject({
      model: "veo-3.1-generate-001",
    });
    // Tier words inside the model path, and a model that is one word, stay the model.
    expect(mediaKeyOf("fal_ai/fal-ai/kling-video/o1/standard/edit", "fal_ai")).toEqual({
      model: "fal-ai/kling-video/o1/standard/edit",
      quality: "",
      resolution: "",
    });
    expect(mediaKeyOf("aws_polly/standard", "aws_polly")).toMatchObject({ model: "standard" });
    // Not mapped cleanly: skipped, never guessed.
    expect(mediaKeyOf("max-x-max/50-steps/stability.stable-diffusion-xl-v0", "bedrock")).toBeNull();
    expect(mediaKeyOf("high/50-steps/x", "openai")).toBeNull();
    expect(mediaKeyOf("512-x-512/1024-x-1024/x", "openai")).toBeNull();
  });

  it("maps providers only where the seller is the same; others keep their own id", () => {
    expect(mediaProviderOf("openai")).toBe("openai");
    expect(mediaProviderOf("bedrock")).toBe("aws");
    expect(mediaProviderOf("xai")).toBe("x-ai");
    expect(mediaProviderOf("gemini")).toBe("google");
    expect(mediaProviderOf("vertex_ai-video-models")).toBe("google");
    expect(mediaProviderOf("azure_ai")).toBe("azure");
    expect(mediaProviderOf("fal_ai")).toBe("fal_ai");
    expect(mediaProviderOf("aws_polly")).toBe("aws_polly");
    expect(mediaProviderOf("Some_Vendor")).toBe("some_vendor");
  });
});

describe("second source: the file", () => {
  const f = parseMediaFeed(LITELLM);
  const price = (p: string, m: string, ...k: Parameters<typeof priceKey>) =>
    f.models.find((x) => x.provider === p && x.model === m)?.entries[0]!.prices.get(priceKey(...k));

  it("keeps media prices with their tiers, exactly", () => {
    expect(
      price("aws", "amazon.nova-canvas-v1:0", "output", "image", "50-steps", "1024x1024"),
    ).toMatchObject({ value: 6n * C, divisor: 1n });
    expect(
      price("aws", "stability.stable-diffusion-xl-v1", "output", "image", "max-steps", "1024x1024"),
    ).toMatchObject({ value: 8n * C });
    expect(price("fal_ai", "fal-ai/nano-banana-2", "output", "image", "", "2k")).toMatchObject({
      value: 12n * C,
    });
    expect(price("fal_ai", "fal-ai/nano-banana-2", "output", "image")).toMatchObject({
      value: 8n * C,
    });
    expect(price("dashscope", "wan3.0-video", "output", "video_second", "", "720p")).toMatchObject({
      value: 8_251_300_000_000n,
    });
    expect(
      price("google", "veo-3.1-generate-001", "output", "video_second", "", "4k"),
    ).toMatchObject({
      value: 60n * C,
    });
    expect(price("openai", "whisper-1", "input", "audio_second")).toMatchObject({
      value: 10_000_000_000n,
    });
    expect(price("openai", "tts-1", "input", "character")).toMatchObject({ value: 1_500_000_000n });
    expect(
      price("openai", "gpt-image-1.5", "input", "image", "standard", "1024x1024"),
    ).toBeDefined();
    expect(price("x-ai", "grok-imagine-image", "input", "image")).toMatchObject({ value: 2n * C });
    // The same price under `vertex_ai/x` and `x` is one key.
    expect(price("google", "gemini-2.5-flash-image", "output", "image")).toMatchObject({
      value: 39n * 10n ** 11n,
    });
  });

  it("imports no token price, and counts what it skips", () => {
    expect(
      f.models.every((m) =>
        [...m.entries[0]!.prices.values()].every((p) => p.unit !== "token" && p.unit !== "request"),
      ),
    ).toBe(true);
    // Token-only and pixel-only entries add no model.
    expect(f.models.some((m) => m.model === "gpt-image-1")).toBe(false);
    expect(f.summary.entries).toBe(21);
    // assemblyai output_cost_per_second 0.0
    expect(f.summary.skipped.zero).toBe(1);
    // a chat entry with input_cost_per_second
    expect(f.summary.skipped.mode_unclear).toBe(1);
    // max-x-max
    expect(f.summary.skipped.unmapped_tier).toBe(1);
    expect(f.summary.skipped.conflict).toBe(0);
    expect(f.summary.keysByUnit.image).toBeGreaterThan(5);
  });

  it("two keys giving one price key different prices: neither is used", () => {
    const c = parseMediaFeed(
      '{"vertex_ai/x": {"litellm_provider": "vertex_ai", "mode": "image_generation", "output_cost_per_image": 0.04},' +
        '"x": {"litellm_provider": "vertex_ai", "mode": "image_generation", "output_cost_per_image": 0.05}}',
    );
    expect(c.models).toEqual([]);
    expect(c.summary.skipped.conflict).toBe(2);
  });

  it("an id that is the first feed's alias under the same provider takes that model's name", () => {
    const m = parseMediaFeed(
      '{"voxtral-mini-latest": {"litellm_provider": "mistral", "mode": "audio_transcription", "input_cost_per_second": 0.0001},' +
        '"voxtral-mini-2602": {"litellm_provider": "mistral", "mode": "audio_transcription", "output_cost_per_second": 0.0002},' +
        '"azure/voxtral-mini-latest": {"litellm_provider": "azure", "mode": "audio_transcription", "input_cost_per_second": 0.0001}}',
    ).models;
    const aliasOf = (p: string, id: string) =>
      p === "mistral" && id === "voxtral-mini-latest" ? "voxtral-mini-2602" : undefined;
    const c = canonicalMediaModels(m, aliasOf);
    expect(c.renamed).toBe(1);
    expect(
      c.models.map((x) => `${x.provider}/${x.model}/${x.entries[0]!.prices.size}`).sort(),
    ).toEqual(["azure/voxtral-mini-latest/1", "mistral/voxtral-mini-2602/2"]);
    // Two ids that meet on one model and price one key differently: the key is dropped.
    const clash = canonicalMediaModels(
      parseMediaFeed(
        '{"a": {"litellm_provider": "p", "mode": "image_generation", "output_cost_per_image": 0.04},' +
          '"b": {"litellm_provider": "p", "mode": "image_generation", "output_cost_per_image": 0.05}}',
      ).models,
      (_p, id) => (id === "b" ? "a" : undefined),
    );
    expect(clash).toMatchObject({ models: [], conflicts: 1 });
  });

  it("refuses a body that is not the file", () => {
    expect(() => parseMediaFeed("[1]")).toThrow(FeedSchemaError);
    expect(() => parseMediaFeed("{oops")).toThrow(FeedSchemaError);
  });
});

describe("second source: one merged plan", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const first = (json: string) => parseFeed(json).models;
  const media = (json: string) => parseMediaFeed(json).models;
  /** The rows a plan wrote, as the next run's current state. */
  const currentOf = (rows: HeldRow[]) => {
    const m = new Map<
      string,
      Array<{ fromMs: number; value: bigint; divisor: bigint; source?: string }>
    >();
    for (const r of rows) {
      const k = keyOf(r.provider, r.model, r.tokenType, r.unit, r.quality, r.resolution);
      m.set(k, [
        ...(m.get(k) ?? []),
        {
          fromMs: Number.NEGATIVE_INFINITY,
          value: BigInt(r.unitAmount.replace(".", "")),
          divisor: BigInt(r.divisor),
          source: r.source,
        },
      ]);
    }
    return m;
  };
  const A = (chars: number) =>
    first(
      `[{"id":"openai","models":[{"id":"tts-1","prices":{"input_mtok":2,"input_mchars":${chars}}}]}]`,
    );
  const B = (perChar: string) =>
    media(
      `{"tts-1": {"litellm_provider": "openai", "mode": "audio_speech", "input_cost_per_character": ${perChar}}}`,
    );

  it("a media key priced by both takes the second source; token keys keep the first", () => {
    // 15 USD per 1M characters vs 1.6e-05 per character (6.7 % apart).
    const plan = planSync(A(15), new Map(), now, { media: B("1.6e-05"), mediaVersion: '"m1"' });
    const chars = plan.rows.filter((r) => r.unit === "character");
    expect(chars).toHaveLength(1);
    expect(chars[0]).toMatchObject({
      source: "litellm",
      sourceVersion: '"m1"',
      unitAmount: "0.001600000000",
      divisor: "1",
    });
    expect(plan.rows.find((r) => r.unit === "token")).toMatchObject({ source: "genai-prices" });
    expect(plan.reasons).toEqual([]);
    // The model keeps the first feed's names (no media-only flag).
    expect(plan.models).toEqual([
      { provider: "openai", model: "tts-1", aliases: [], contextTiers: null },
    ]);
  });

  it("one price written two ways (within 1 %) stays with the source that holds it", () => {
    // 0.111 USD per hour vs 3.083e-05 per second: a rounding, not a change.
    const first111 = first(
      '[{"id":"groq","models":[{"id":"w","prices":{"input_audio_hours":0.111}}]}]',
    );
    const media111 = media(
      '{"groq/w": {"litellm_provider": "groq", "mode": "audio_transcription", "input_cost_per_second": 3.083e-05}}',
    );
    const held = currentOf(planSync(first111, new Map(), now).rows);
    expect(planSync(first111, held, now, { media: media111 }).rows).toEqual([]);
    expect(planSync(first111, new Map(), now, { media: media111 }).rows[0]).toMatchObject({
      source: "genai-prices",
      divisor: "3600",
    });
    // Held by the second source: it keeps it.
    const second = currentOf(planSync([], new Map(), now, { media: media111 }).rows);
    expect(planSync(first111, second, now, { media: media111 }).rows).toEqual([]);
  });

  it("the same plan twice writes nothing: the sources never fight over a key", () => {
    const p1 = planSync(A(15), new Map(), now, { media: B("1.6e-05") });
    const again = planSync(A(15), currentOf(p1.rows), now, { media: B("1.6e-05") });
    expect(again.rows).toEqual([]);
  });

  it("cross-check: more than 25 % apart holds the key with both prices; 25 % or less applies", () => {
    // 15 USD per 1M = 1.5e-05 per character. 1.875e-05 is +25 % exactly.
    expect(planSync(A(15), new Map(), now, { media: B("1.875e-05") }).reasons).toEqual([]);
    const plan = planSync(A(15), new Map(), now, { media: B("1.9e-05") });
    expect(plan.reasons).toEqual(["sources_disagree"]);
    const row = plan.rows.find((r) => r.unit === "character")!;
    expect(row).toMatchObject({
      source: "litellm",
      unitAmount: "0.001900000000",
      crossCheck: { source: "genai-prices", unitAmount: "1500.000000000000", divisor: "1000000" },
    });
    // The rest of the run is not held by it; the fingerprint carries both prices.
    expect(plan.rows.filter((r) => !r.crossCheck).every((r) => r.unit === "token")).toBe(true);
    expect(suspectFingerprint(plan)).toContain("genai-prices=1500.000000000000/1000000");
    expect(suspectFingerprint(plan)).not.toBe(
      suspectFingerprint(planSync(A(16), new Map(), now, { media: B("1.9e-05") })),
    );
    // Below the margin the other way too.
    expect(planSync(A(15), new Map(), now, { media: B("1.2e-05") }).reasons).toEqual([]);
    expect(planSync(A(15), new Map(), now, { media: B("1.1e-05") }).reasons).toEqual([
      "sources_disagree",
    ]);
  });

  it("a source that fails leaves the keys it owns alone; the other still applies", () => {
    const both = planSync(A(15), new Map(), now, { media: B("1.6e-05") });
    const current = currentOf(both.rows);
    // The media feed failed (null): its key is not taken back by the first feed's price.
    const mediaDown = planSync(A(14), current, now, { media: null });
    expect(mediaDown.rows).toEqual([]);
    expect(mediaDown.frozenKeys).toBe(1);
    // …while the first feed's own keys still change.
    const tokenMove = planSync(
      first(
        '[{"id":"openai","models":[{"id":"tts-1","prices":{"input_mtok":2.2,"input_mchars":14}}]}]',
      ),
      current,
      now,
      { media: null },
    );
    expect(tokenMove.rows.map((r) => `${r.unit}/${r.unitAmount}`)).toEqual([
      "token/220.000000000000",
    ]);
    // The first feed failed: the media feed cannot take over a key the first feed owns.
    const firstOnly = currentOf(planSync(A(15), new Map(), now).rows);
    const firstDown = planSync([], firstOnly, now, {
      media: B("1.6e-05"),
      primaryAvailable: false,
    });
    expect(firstDown.rows).toEqual([]);
    expect(firstDown.frozenKeys).toBe(1);
    // With both read, it does.
    expect(planSync(A(15), firstOnly, now, { media: B("1.6e-05") }).rows).toHaveLength(1);
    // A media key nobody else prices applies even when the first feed is down.
    const newKey = planSync([], firstOnly, now, {
      media: media(
        '{"img": {"litellm_provider": "openai", "mode": "image_generation", "output_cost_per_image": 0.04}}',
      ),
      primaryAvailable: false,
    });
    expect(newKey.rows.map((r) => [r.model, r.unit, r.from])).toEqual([
      ["img", "image", "-infinity"],
    ]);
    expect(newKey.models).toEqual([
      { provider: "openai", model: "img", aliases: [], contextTiers: null, source: "litellm" },
    ]);
  });

  it("the first run that adds the whole second source never holds and notifies nothing", () => {
    // The list as the first feed left it.
    const firstModels = [...parseFeed(FEED).models, ...parseFeed(MEDIA_FEED).models];
    const current = currentOf(planSync(firstModels, new Map(), now).rows);
    const plan = planSync(firstModels, current, now, { media: parseMediaFeed(LITELLM).models });
    expect(plan.reasons).toEqual([]);
    expect(plan.changedKeys).toBe(0);
    expect(plan.rows.length).toBeGreaterThan(20);
    // Every row is a new key: `changesOf` sends no notice for a row with no old price.
    expect(plan.rows.every((r) => r.oldUnitAmount === null && r.source === "litellm")).toBe(true);
  });

  it("the share rule counts per source: one feed's new keys never dilute the other's", () => {
    const types = ["t1", "t2", "t3", "t4"];
    const firstFeed = (v: number) =>
      first(
        `[{"id":"p","models":[{"id":"m","prices":{${types.map((t) => `"${t}_mtok":${t === "t1" ? v : 3}`).join(",")}}}]}]`,
      );
    const many = media(
      `{${Array.from({ length: 20 }, (_, i) => `"img${i}": {"litellm_provider": "p", "mode": "image_generation", "output_cost_per_image": 0.04}`).join(",")}}`,
    );
    const current = currentOf([
      ...planSync(firstFeed(3), new Map(), now).rows,
      ...planSync([], new Map(), now, { media: many }).rows,
    ]);
    // Two of four first-feed keys change: 50 % of its own keys, held as before.
    const two = first(
      `[{"id":"p","models":[{"id":"m","prices":{"t1_mtok":3.5,"t2_mtok":3.5,"t3_mtok":3,"t4_mtok":3}}]}]`,
    );
    expect(planSync(two, current, now, { media: many }).reasons).toEqual(["many_keys_changed"]);
    expect(planSync(firstFeed(3.5), current, now, { media: many }).reasons).toEqual([]);
  });
});

describe("second source: resolution does not regress", () => {
  const T = Date.parse("2026-11-15T10:00:00Z");
  const at = new Date(T);
  const row = (over: Partial<ListRow>): ListRow => ({
    id: "id",
    public_id: "mpr_tok",
    provider: "openai",
    model: "gpt-x",
    token_type: "input",
    currency: "USD",
    unit_amount_decimal: "300",
    quantity_divisor: "1000000",
    from_ms: null,
    source: "genai-prices",
    source_version: null,
    source_effective_from: null,
    ...over,
  });
  const img = (provider: string, model = "gpt-x") =>
    row({
      public_id: `mpr_${provider}`,
      provider,
      model,
      token_type: "output",
      unit: "image",
      quantity_divisor: "1",
      unit_amount_decimal: "4",
      source: "litellm",
    });
  const rowsBy = (rows: ListRow[]) => {
    const m = new Map<string, ListRow[]>();
    for (const r of rows) {
      const k = `${r.provider}\u0000${r.model}\u0000${r.token_type}\u0000${r.currency}`;
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return m;
  };
  const before = new ModelPriceBook(
    new Map([
      ["gpt-x", [{ provider: "openai", model: "gpt-x", exact: true }]],
      ["gpt-x-0324", [{ provider: "openai", model: "gpt-x", exact: false }]],
    ]),
    rowsBy([row({})]),
    [],
  );
  // The second source lists the same model under three more providers, with image prices
  // only, and one of them under the alias's own name.
  const after = new ModelPriceBook(
    new Map([
      [
        "gpt-x",
        ["openai", "azure", "aws", "google"].map((p) => ({
          provider: p,
          model: "gpt-x",
          exact: true,
        })),
      ],
      [
        "gpt-x-0324",
        [
          { provider: "openai", model: "gpt-x", exact: false },
          { provider: "azure", model: "gpt-x-0324", exact: true },
        ],
      ],
    ]),
    rowsBy([
      row({}),
      img("openai"),
      img("azure"),
      img("aws"),
      img("google"),
      img("azure", "gpt-x-0324"),
    ]),
    [],
  );
  const tok = { model: "gpt-x", tokenType: "input", currency: "USD" };

  it("a token lookup with no provider resolves the same row before and after", () => {
    expect(before.listPrice(tok, at)).toMatchObject({ kind: "list", publicId: "mpr_tok" });
    expect(after.listPrice(tok, at)).toEqual(before.listPrice(tok, at));
    expect(after.changeInstants(tok, new Date(T - 1), new Date(T + 1))).toEqual([]);
  });

  it("alias matching is unaffected", () => {
    const alias = { ...tok, model: "gpt-x-0324" };
    expect(after.listPrice(alias, at)).toEqual(before.listPrice(alias, at));
    expect(after.listPrice(alias, at)).toMatchObject({ model: "gpt-x", provider: "openai" });
  });

  it("only units count, never kinds: two providers that both price tokens stay ambiguous", () => {
    // azure prices gpt-y tokens but not cache_read: before the second source this was
    // ambiguous, and it still is (picking openai would guess azure has no such price).
    const b = new ModelPriceBook(
      new Map([
        [
          "gpt-y",
          [
            { provider: "openai", model: "gpt-y", exact: true },
            { provider: "azure", model: "gpt-y", exact: true },
          ],
        ],
      ]),
      rowsBy([
        row({ model: "gpt-y", token_type: "cache_read" }),
        row({ model: "gpt-y", provider: "azure", public_id: "mpr_az" }),
      ]),
      [],
    );
    expect(b.listPrice({ ...tok, model: "gpt-y", tokenType: "cache_read" }, at)).toEqual({
      kind: null,
      reason: "ambiguous_provider",
    });
  });

  it("an image lookup priced by several providers is ambiguous until the provider is named", () => {
    const image = { model: "gpt-x", tokenType: "output", currency: "USD", unit: "image" };
    expect(after.listPrice(image, at)).toEqual({ kind: null, reason: "ambiguous_provider" });
    expect(after.listPrice({ ...image, provider: "azure" }, at)).toMatchObject({
      publicId: "mpr_azure",
    });
  });
});
