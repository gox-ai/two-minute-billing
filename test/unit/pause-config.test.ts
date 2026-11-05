import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAUSE_CONFIG,
  PAUSE_CONFIG_KEYS,
  resolvePauseConfig,
  withoutLegacyChargesOnResume,
} from "@/modules/subscriptions/pause-config";

/**
 * What regresses: a business that never opened the Pause & resume screen must resolve to
 * the same five answers forever, and a hand-edited jsonb blob must not be able to change a
 * billing default or smuggle a string into `locked`.
 *
 * Every default is the engine's real fallback for an omitted argument. `dunning_on_pause`
 * must stay `continue` (a `stop` default would halt collection), and `charges_on_resume`
 * must BILL an out-of-term resume — the retired `next_renewal` gave the new term away.
 *
 * The other half of the suite guards the SHAPE. Four values were excluded because each
 * needs an argument only the call can supply (`pause_option: specific_date` /
 * `billing_cycles`, and the whole `pause_duration` / `resume_option` pair), and a stored
 * one must fall back rather than reach a call site that would throw or ignore it.
 */
describe("resolvePauseConfig — defaults", () => {
  it.each([[null], [undefined], [{}], [{ pauseConfig: null }], [{ pauseConfig: undefined }]])(
    "resolves an unconfigured business to the defaults (%j)",
    (biz) => {
      expect(resolvePauseConfig(biz as { pauseConfig?: unknown } | null)).toEqual(
        DEFAULT_PAUSE_CONFIG,
      );
    },
  );

  it("pins the five default values", () => {
    expect(DEFAULT_PAUSE_CONFIG).toEqual({
      pauseOption: "immediately",
      unbilledOnPause: "retain",
      dunningOnPause: "continue",
      chargesOnResume: "invoice_immediately",
      unpaidInvoicesOnResume: "no_action",
      locked: [],
    });
  });

  it("stores five keys and no more — the locked vocabulary is the same five", () => {
    expect([...PAUSE_CONFIG_KEYS]).toEqual([
      "pause_option",
      "unbilled_on_pause",
      "dunning_on_pause",
      "charges_on_resume",
      "unpaid_invoices_on_resume",
    ]);
  });

  // The two 0242 corrections, pinned by name so a revert cannot pass quietly. Both would
  // have changed billing for a business that never opened the screen.
  it("leaves dunning RUNNING by default — pauseSubscriptionWithOptions only acts on 'stop'", () => {
    expect(DEFAULT_PAUSE_CONFIG.dunningOnPause).toBe("continue");
  });

  it("bills an out-of-term resume by default — no member means 'free'", () => {
    expect(DEFAULT_PAUSE_CONFIG.chargesOnResume).toBe("invoice_immediately");
  });
});

describe("resolvePauseConfig — an explicit valid value opts out", () => {
  it("takes every field from a fully populated row", () => {
    expect(
      resolvePauseConfig({
        pauseConfig: {
          pause_option: "end_of_term",
          unbilled_on_pause: "invoice",
          dunning_on_pause: "stop",
          charges_on_resume: "add_to_unbilled_charges",
          unpaid_invoices_on_resume: "schedule_payment_collection",
          locked: ["pause_option"],
        },
      }),
    ).toEqual({
      pauseOption: "end_of_term",
      unbilledOnPause: "invoice",
      dunningOnPause: "stop",
      chargesOnResume: "add_to_unbilled_charges",
      unpaidInvoicesOnResume: "schedule_payment_collection",
      locked: ["pause_option"],
    });
  });

  it.each([["invoice_immediately"], ["add_to_unbilled_charges"]] as const)(
    "round-trips charges_on_resume: %s",
    (v) => {
      expect(resolvePauseConfig({ pauseConfig: { charges_on_resume: v } }).chargesOnResume).toBe(v);
    },
  );

  it("reads the retired next_renewal as add_to_unbilled_charges, never as free", () => {
    expect(
      resolvePauseConfig({ pauseConfig: { charges_on_resume: "next_renewal" } }).chargesOnResume,
    ).toBe("add_to_unbilled_charges");
    expect(
      withoutLegacyChargesOnResume({
        charges_on_resume: "next_renewal",
        pause_option: "end_of_term",
      }),
    ).toEqual({ charges_on_resume: "add_to_unbilled_charges", pause_option: "end_of_term" });
    expect(withoutLegacyChargesOnResume(null)).toBeNull();
  });

  it("round-trips pause_option: end_of_term — the choice that survived", () => {
    expect(resolvePauseConfig({ pauseConfig: { pause_option: "end_of_term" } }).pauseOption).toBe(
      "end_of_term",
    );
  });

  it("round-trips dunning_on_pause: stop", () => {
    expect(resolvePauseConfig({ pauseConfig: { dunning_on_pause: "stop" } }).dunningOnPause).toBe(
      "stop",
    );
  });

  it("leaves the other four alone when one key is set", () => {
    const cfg = resolvePauseConfig({ pauseConfig: { unbilled_on_pause: "invoice" } });
    expect(cfg).toEqual({ ...DEFAULT_PAUSE_CONFIG, unbilledOnPause: "invoice" });
  });

  it("accepts a default that is ALSO the fallback value, rather than treating it as absent", () => {
    // `pause_option: 'immediately'` stored explicitly and resolved by default are the same
    // answer; the point is that the check is against the union, so nothing here can be
    // read as "unset" and re-derived later.
    expect(resolvePauseConfig({ pauseConfig: { pause_option: "immediately" } }).pauseOption).toBe(
      "immediately",
    );
  });
});

describe("resolvePauseConfig — malformed values fall back, never through", () => {
  // Every one of these is a value a hand-edited row or a bad importer can produce, and
  // truthiness would let most of them past.
  it.each([
    // The four values that need a per-call argument. A stored one must fall back, or a
    // wiring site gets `specific_date` with no date (which throws) or a duration/timing it
    // has no parameter for.
    [
      "pause_option: specific_date, which needs a pause_date",
      { pause_option: "specific_date" },
      "pauseOption",
    ],
    [
      "pause_option: billing_cycles, which needs a cycle count",
      { pause_option: "billing_cycles" },
      "pauseOption",
    ],
    ["the wrong case", { pause_option: "Immediately" }, "pauseOption"],
    // 0242's original short spelling. It never matched `ResumeChargesHandling`, so a row
    // written against it must resolve to the default rather than to a value the engine
    // would not recognise.
    [
      "the pre-correction short spelling",
      { charges_on_resume: "add_to_unbilled" },
      "chargesOnResume",
    ],
    // 0242's original wording. Renamed to the engine's literal, so the old
    // spelling must fall back rather than reach a call site that would not recognise it.
    [
      "the pre-correction wording",
      { unpaid_invoices_on_resume: "collect" },
      "unpaidInvoicesOnResume",
    ],
    ["its counterpart", { unpaid_invoices_on_resume: "retain" }, "unpaidInvoicesOnResume"],
    ["an empty string", { dunning_on_pause: "" }, "dunningOnPause"],
    ["a number", { charges_on_resume: 1 }, "chargesOnResume"],
    ["a boolean", { unbilled_on_pause: true }, "unbilledOnPause"],
    ["null", { unpaid_invoices_on_resume: null }, "unpaidInvoicesOnResume"],
    ["an object", { pause_option: { value: "end_of_term" } }, "pauseOption"],
    ["an array", { pause_option: ["end_of_term"] }, "pauseOption"],
  ] as const)("%s resolves to the default", (_label, stored, field) => {
    const cfg = resolvePauseConfig({ pauseConfig: stored });
    expect(cfg[field]).toBe(DEFAULT_PAUSE_CONFIG[field]);
  });

  it.each([["a string"], [42], [true], [[]]])(
    "a whole column that is not an object resolves to the defaults (%j)",
    (stored) => {
      expect(resolvePauseConfig({ pauseConfig: stored })).toEqual(DEFAULT_PAUSE_CONFIG);
    },
  );

  it("a removed key in a stored row is ignored, not carried into the resolved config", () => {
    // Rows written against the seven-key contract exist; the two withdrawn keys must
    // vanish rather than reappear as fields nothing reads.
    const cfg = resolvePauseConfig({
      pauseConfig: { pause_duration: "until_date", resume_option: "specific_date" },
    });
    expect(cfg).toEqual(DEFAULT_PAUSE_CONFIG);
    expect(Object.keys(cfg).sort()).toEqual([
      "chargesOnResume",
      "dunningOnPause",
      "locked",
      "pauseOption",
      "unbilledOnPause",
      "unpaidInvoicesOnResume",
    ]);
  });

  it("one malformed key does not drag the valid ones down with it", () => {
    const cfg = resolvePauseConfig({
      pauseConfig: { pause_option: "whenever", unbilled_on_pause: "invoice" },
    });
    expect(cfg.pauseOption).toBe("immediately");
    expect(cfg.unbilledOnPause).toBe("invoice");
  });
});

describe("resolvePauseConfig — locked is sanitised", () => {
  it("keeps only known key names", () => {
    expect(
      resolvePauseConfig({
        pauseConfig: {
          // `pause_duration` was a key once and is not one now — it must be filtered too.
          locked: ["pause_option", "drop_table_users", "dunningOnPause", "pause_duration", ""],
        },
      }).locked,
    ).toEqual(["pause_option"]);
  });

  it("de-duplicates and orders by PAUSE_CONFIG_KEYS, so two equivalent rows resolve equal", () => {
    const a = resolvePauseConfig({
      pauseConfig: { locked: ["dunning_on_pause", "pause_option", "pause_option"] },
    });
    const b = resolvePauseConfig({
      pauseConfig: { locked: ["pause_option", "dunning_on_pause"] },
    });
    expect(a.locked).toEqual(["pause_option", "dunning_on_pause"]);
    expect(a.locked).toEqual(b.locked);
  });

  it("accepts all seven keys", () => {
    expect(resolvePauseConfig({ pauseConfig: { locked: [...PAUSE_CONFIG_KEYS] } }).locked).toEqual([
      ...PAUSE_CONFIG_KEYS,
    ]);
  });

  it.each([["not-an-array"], [{ pause_option: true }], [null], [7]])(
    "a non-array locked resolves to [] (%j)",
    (locked) => {
      expect(resolvePauseConfig({ pauseConfig: { locked } }).locked).toEqual([]);
    },
  );

  it("drops non-string members without discarding the string ones", () => {
    expect(
      resolvePauseConfig({ pauseConfig: { locked: [null, 3, "charges_on_resume", { a: 1 }] } })
        .locked,
    ).toEqual(["charges_on_resume"]);
  });
});

describe("resolvePauseConfig — purity", () => {
  it("does not mutate the stored blob and does not share the default's locked array", () => {
    const stored = { locked: ["pause_option", "nope"] };
    const cfg = resolvePauseConfig({ pauseConfig: stored });
    expect(stored.locked).toEqual(["pause_option", "nope"]);
    expect(cfg.locked).not.toBe(DEFAULT_PAUSE_CONFIG.locked);
  });

  it("resolves the same input to the same output", () => {
    const biz = { pauseConfig: { dunning_on_pause: "continue", locked: ["dunning_on_pause"] } };
    expect(resolvePauseConfig(biz)).toEqual(resolvePauseConfig(biz));
  });
});
