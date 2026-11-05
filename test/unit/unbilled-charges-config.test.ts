import { describe, it, expect } from "vitest";
import {
  resolveUnbilledChargesConfig,
  isInvoiceImmediately,
  DEFAULT_UNBILLED_CHARGES_CONFIG,
  type UnbilledChargesConfig,
} from "@/modules/subscriptions/unbilled-charges-config";

// The three keys this engine has a decision point for. on_reactivate and
// on_trial_to_active were withdrawn (no call site reads a business default), joining
// on_term_extend / on_future_to_active / on_advance_charge (zero engine references) —
// all five recorded in docs/PROGRESS.md, none of them keys here.
const FIXED_DEFAULT_KEYS = [["on_create", "onCreate"]] as const;
const INHERITING_KEYS = [
  ["on_change", "onChange"],
  ["on_one_time_charge", "onOneTimeCharge"],
] as const;
const ALL_KEYS = [...FIXED_DEFAULT_KEYS, ...INHERITING_KEYS] as const;

describe("unbilled charges config: resolved shape is exactly three keys", () => {
  it("has exactly onCreate / onChange / onOneTimeCharge, nothing else", () => {
    expect(Object.keys(resolveUnbilledChargesConfig(null)).sort()).toEqual(
      ["onChange", "onCreate", "onOneTimeCharge"].sort(),
    );
  });

  it("a stored row carrying withdrawn keys (on_reactivate, on_trial_to_active) resolves without them", () => {
    const cfg = resolveUnbilledChargesConfig({
      unbilledChargesConfig: {
        on_reactivate: "add_to_unbilled",
        on_trial_to_active: "add_to_unbilled",
        on_term_extend: "add_to_unbilled",
        on_future_to_active: "add_to_unbilled",
        on_advance_charge: "add_to_unbilled",
      },
    });
    expect(Object.keys(cfg).sort()).toEqual(["onChange", "onCreate", "onOneTimeCharge"].sort());
    expect(cfg).toEqual(DEFAULT_UNBILLED_CHARGES_CONFIG);
    // Not present under any spelling — a withdrawn key must not resurface as a
    // field nothing reads, camelCase or snake_case.
    expect(cfg).not.toHaveProperty("onReactivate");
    expect(cfg).not.toHaveProperty("onTrialToActive");
  });
});

describe("unbilled charges config: fixed defaults", () => {
  it("on_create defaults to invoice_immediately regardless of default_invoice_immediately", () => {
    expect(DEFAULT_UNBILLED_CHARGES_CONFIG.onCreate).toBe("invoice_immediately");
    expect(resolveUnbilledChargesConfig({ defaultInvoiceImmediately: true }).onCreate).toBe(
      "invoice_immediately",
    );
    expect(resolveUnbilledChargesConfig({ defaultInvoiceImmediately: false }).onCreate).toBe(
      "invoice_immediately",
    );
  });

  it("null resolves on_create to invoice_immediately", () => {
    expect(resolveUnbilledChargesConfig(null).onCreate).toBe("invoice_immediately");
  });
});

describe("unbilled charges config: on_change / on_one_time_charge inherit default_invoice_immediately", () => {
  it("inherits add_to_unbilled when default_invoice_immediately is false (the column's own DB default)", () => {
    const cfg = resolveUnbilledChargesConfig({ defaultInvoiceImmediately: false });
    expect(cfg.onChange).toBe("add_to_unbilled");
    expect(cfg.onOneTimeCharge).toBe("add_to_unbilled");
  });

  it("inherits invoice_immediately when default_invoice_immediately is true", () => {
    const cfg = resolveUnbilledChargesConfig({ defaultInvoiceImmediately: true });
    expect(cfg.onChange).toBe("invoice_immediately");
    expect(cfg.onOneTimeCharge).toBe("invoice_immediately");
  });

  it("null / absent business inherits add_to_unbilled (false is the column's own default)", () => {
    expect(resolveUnbilledChargesConfig(null).onChange).toBe("add_to_unbilled");
    expect(resolveUnbilledChargesConfig(undefined).onChange).toBe("add_to_unbilled");
    expect(resolveUnbilledChargesConfig({}).onOneTimeCharge).toBe("add_to_unbilled");
  });

  it("a malformed default_invoice_immediately (not exactly boolean true) inherits add_to_unbilled", () => {
    for (const v of ["true", 1, null, undefined, "yes"]) {
      expect(resolveUnbilledChargesConfig({ defaultInvoiceImmediately: v }).onChange).toBe(
        "add_to_unbilled",
      );
    }
  });

  it("an explicit key value beats inheritance in both directions", () => {
    // default_invoice_immediately says invoice_immediately, key explicitly says otherwise.
    expect(
      resolveUnbilledChargesConfig({
        defaultInvoiceImmediately: true,
        unbilledChargesConfig: { on_change: "add_to_unbilled" },
      }).onChange,
    ).toBe("add_to_unbilled");
    // default_invoice_immediately says add_to_unbilled, key explicitly overrides it.
    expect(
      resolveUnbilledChargesConfig({
        defaultInvoiceImmediately: false,
        unbilledChargesConfig: { on_one_time_charge: "invoice_immediately" },
      }).onOneTimeCharge,
    ).toBe("invoice_immediately");
  });

  it("a saved config holding only on_create (both others on Follow) leaves them to default_invoice_immediately", () => {
    for (const flag of [true, false]) {
      const want = flag ? "invoice_immediately" : "add_to_unbilled";
      const cfg = resolveUnbilledChargesConfig({
        defaultInvoiceImmediately: flag,
        unbilledChargesConfig: { on_create: "invoice_immediately" },
      });
      expect(cfg.onChange).toBe(want);
      expect(cfg.onOneTimeCharge).toBe(want);
    }
  });

  it("a key set for one event decides that event only; the other still follows the flag", () => {
    const cfg = resolveUnbilledChargesConfig({
      defaultInvoiceImmediately: true,
      unbilledChargesConfig: { on_change: "add_to_unbilled" },
    });
    expect(cfg.onChange).toBe("add_to_unbilled");
    expect(cfg.onOneTimeCharge).toBe("invoice_immediately");
  });

  it("DEFAULT_UNBILLED_CHARGES_CONFIG matches every column at its own DB default", () => {
    expect(DEFAULT_UNBILLED_CHARGES_CONFIG.onChange).toBe("add_to_unbilled");
    expect(DEFAULT_UNBILLED_CHARGES_CONFIG.onOneTimeCharge).toBe("add_to_unbilled");
    expect(resolveUnbilledChargesConfig(null)).toEqual(DEFAULT_UNBILLED_CHARGES_CONFIG);
  });
});

describe("unbilled charges config: only an explicit valid value opts out", () => {
  it("each key independently accepts the opposite of its own default and leaves the rest alone", () => {
    for (const [snake, camel] of ALL_KEYS) {
      const opposite =
        DEFAULT_UNBILLED_CHARGES_CONFIG[camel] === "invoice_immediately"
          ? "add_to_unbilled"
          : "invoice_immediately";
      const cfg = resolveUnbilledChargesConfig({
        unbilledChargesConfig: { [snake]: opposite },
      });
      expect(cfg[camel]).toBe(opposite);
      for (const [, otherCamel] of ALL_KEYS) {
        if (otherCamel === camel) continue;
        expect(cfg[otherCamel]).toBe(DEFAULT_UNBILLED_CHARGES_CONFIG[otherCamel]);
      }
    }
  });

  it("malformed key values fall back to the key's own default rather than opting out", () => {
    const junk: Array<unknown> = [
      "add-to-unbilled", // wrong separator
      "INVOICE_IMMEDIATELY", // wrong case
      "invoice_immediately ", // stray whitespace
      "", // empty string
      true,
      false,
      0,
      null,
      {},
      ["invoice_immediately"],
    ];
    for (const v of junk) {
      const cfg = resolveUnbilledChargesConfig({ unbilledChargesConfig: { on_create: v } });
      expect(cfg.onCreate).toBe("invoice_immediately");
    }
  });

  it("a malformed unbilledChargesConfig blob (not an object) resolves every key to its own default", () => {
    for (const blob of ["garbage", 42, true, []]) {
      expect(resolveUnbilledChargesConfig({ unbilledChargesConfig: blob })).toEqual(
        DEFAULT_UNBILLED_CHARGES_CONFIG,
      );
    }
  });

  it("multiple explicit overrides combine independently", () => {
    const cfg = resolveUnbilledChargesConfig({
      unbilledChargesConfig: {
        on_create: "add_to_unbilled",
        on_change: "invoice_immediately",
      },
    });
    const expected: UnbilledChargesConfig = {
      ...DEFAULT_UNBILLED_CHARGES_CONFIG,
      onCreate: "add_to_unbilled",
      onChange: "invoice_immediately",
    };
    expect(cfg).toEqual(expected);
  });
});

describe("isInvoiceImmediately", () => {
  it("is true only for invoice_immediately", () => {
    expect(isInvoiceImmediately("invoice_immediately")).toBe(true);
    expect(isInvoiceImmediately("add_to_unbilled")).toBe(false);
  });
});
