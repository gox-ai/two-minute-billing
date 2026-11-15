import { describe, expect, it } from "vitest";
import {
  costIssue,
  costSentence,
  creditCostBody,
  creditCostDraft,
  creditCostErrorField,
  creditCostRefusal,
  creditsLabel,
  eventCreditLines,
  groupDecimal,
  refusedForCredit,
  type EventCreditEntry,
} from "../../dashboard/lib/meter-credit-cost";
import {
  buysLine,
  majorText,
  purchaseLimitLines,
  thresholdLine,
  unitTopupBody,
  unitTopupDraft,
  unitTopupErrorField,
  unitTopupState,
  unitsText,
  type UnitTopupDraft,
} from "../../dashboard/lib/unit-topup";
import { holdLeaseLines, resolveCreditConfig, type CreditUnit } from "../../dashboard/lib/credits";

const credit = { name: "credit", plural: "credits" };

describe("credit amounts", () => {
  it("groups a decimal without a float", () => {
    expect(groupDecimal("12500")).toBe("12,500");
    expect(groupDecimal("1234567.500000")).toBe("1,234,567.5");
    expect(groupDecimal("0.000001")).toBe("0.000001");
    expect(groupDecimal("007")).toBe("7");
  });
  it("names one credit in the singular only", () => {
    expect(creditsLabel("1", credit)).toBe("1 credit");
    expect(creditsLabel("1.0", credit)).toBe("1 credit");
    expect(creditsLabel("0.5", credit)).toBe("0.5 credits");
    expect(creditsLabel("12500", credit)).toBe("12,500 credits");
  });
});

describe("meter credit cost", () => {
  it("allows a count, or a sum that does not carry over, on an active meter", () => {
    expect(creditCostRefusal({ aggregation: "count", recurring: false, status: "active" })).toBe(
      null,
    );
    expect(creditCostRefusal({ aggregation: "sum", recurring: false, status: "active" })).toBe(
      null,
    );
    expect(creditCostRefusal({ aggregation: "sum", recurring: true, status: "active" })).toMatch(
      /carries its level/,
    );
    expect(creditCostRefusal({ aggregation: "max", recurring: false, status: "active" })).toMatch(
      /Only a meter that counts events/,
    );
    expect(creditCostRefusal({ aggregation: "count", recurring: false, status: "archived" })).toBe(
      "An archived meter cannot have a credit cost.",
    );
  });
  it("says what the cost is charged on", () => {
    expect(costSentence("1", credit, "count", null)).toBe("Each event costs 1 credit.");
    // The raw property name is not shown: the reader set a value, not a key.
    expect(costSentence("0.5", credit, "sum", "tokens")).toBe(
      "Each unit of the value costs 0.5 credits.",
    );
  });
  it("takes a cost above 0 with at most 6 decimals", () => {
    expect(costIssue("0.000001")).toBeNull();
    expect(costIssue("3")).toBeNull();
    for (const bad of ["0", "0.0", "", "-1", "1.0000001", "1e3", "abc"])
      expect(costIssue(bad)).not.toBeNull();
  });
  it("starts from the stored cost, or the one unit there is", () => {
    expect(creditCostDraft(null, [{ id: "credits" }])).toEqual({
      unit: "credits",
      cost: "",
      plans: [],
    });
    expect(creditCostDraft(null, [{ id: "a" }, { id: "b" }]).unit).toBe("");
    expect(
      creditCostDraft(
        {
          unit: "credits",
          credits_per_unit: "2",
          overrides: [
            { product: "prod_pro", credits_per_unit: "1" },
            { subscription: "sub_1", credits_per_unit: "0.5" },
          ],
        },
        [],
      ),
    ).toEqual({ unit: "credits", cost: "2", plans: [{ product: "prod_pro", cost: "1" }] });
  });
  it("puts the plans first and sends the subscription overrides back unchanged", () => {
    const r = creditCostBody(
      { unit: "credits", cost: " 2 ", plans: [{ product: "prod_pro", cost: "1.5" }] },
      [{ subscription: "sub_1", credits_per_unit: "0.5" }],
    );
    expect(r).toEqual({
      ok: true,
      body: {
        unit: "credits",
        credits_per_unit: "2",
        overrides: [
          { product: "prod_pro", credits_per_unit: "1.5" },
          { subscription: "sub_1", credits_per_unit: "0.5" },
        ],
      },
    });
  });
  it("keys each mistake to its field", () => {
    const r = creditCostBody(
      {
        unit: "",
        cost: "0",
        plans: [
          { product: "prod_pro", cost: "1" },
          { product: "prod_pro", cost: "2" },
          { product: "prod_team", cost: "x" },
        ],
      },
      [],
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(
      ["credits_per_unit", "plan_cost_1", "plan_cost_2", "unit"].sort(),
    );
    expect(r.errors.plan_cost_1).toBe("This plan is in the list two times.");
  });
  it("maps an API refusal to the field it names", () => {
    expect(creditCostErrorField("… overrides[1].credits_per_unit must be …", 2)).toBe(
      "plan_cost_1",
    );
    expect(creditCostErrorField("… overrides[2]: the product x is not a plan.", 2)).toBeNull();
    expect(creditCostErrorField("… credits_per_unit must be a number …", 0)).toBe(
      "credits_per_unit",
    );
    expect(
      creditCostErrorField("Usage of this meter was paid in a different credit unit.", 0),
    ).toBe("unit");
  });
});

describe("usage event credit lines", () => {
  const base: EventCreditEntry = {
    meter: "illustrations",
    unit: "credits",
    status: "taken",
    reason: null,
    quantity: "1",
    credits_per_unit: "3",
    cost_source: "meter",
    credits_due: "3",
    credits_taken: "3",
    credits_from_closed_grant: "0",
    credits_uncovered: "0",
    covered_by_hold: false,
  };
  it("says what an accepted event took, with no currency", () => {
    expect(eventCreditLines(base, credit)).toEqual(["Took 3 credits."]);
    expect(eventCreditLines({ ...base, cost_source: "plan", credits_taken: "1" }, credit)).toEqual([
      "Took 1 credit at the plan's cost.",
    ]);
  });
  it("names the uncovered part and a hold", () => {
    expect(
      eventCreditLines(
        { ...base, credits_taken: "2", credits_uncovered: "1", covered_by_hold: true },
        credit,
      ),
    ).toEqual(["Took 2 credits.", "Credit did not pay 1 credit.", "A hold paid for it."]);
  });
  it("shows a refusal for lack of credit with what it needed", () => {
    const refused = { ...base, status: "refused" as const, reason: "insufficient_credit" as const };
    expect(eventCreditLines(refused, credit)).toEqual(["Not enough credit. It needed 3 credits."]);
    expect(refusedForCredit({ credit: [refused] })).toBe(true);
    expect(refusedForCredit({ refused_at: "2026-11-13T00:00:00Z" })).toBe(true);
    expect(refusedForCredit({ credit: [base] })).toBe(false);
  });
  it("a backfill takes nothing", () => {
    expect(eventCreditLines({ ...base, status: "skipped", reason: "backfill" }, credit)).toEqual([
      "Sent as a backfill. It took no credits.",
    ]);
  });
});

describe("automatic top-up in units", () => {
  const draft = (patch: Partial<UnitTopupDraft> = {}): UnitTopupDraft => ({
    ...unitTopupDraft(null, [{ value: "price_pack" }], "USD"),
    method: "fixed",
    threshold_units: "50",
    monthly_cap: "100",
    ...patch,
  });
  const ctx = { unit: "credits", currency: "USD", decimals: 1, packMinor: 2000 };

  it("preselects the one pack and starts at one pack and three a day", () => {
    const d = unitTopupDraft(null, [{ value: "price_pack" }], "USD");
    expect(d.pack_price).toBe("price_pack");
    expect(d.pack_quantity).toBe("1");
    expect(d.max_runs_per_day).toBe("3");
    expect(d.method).toBe("");
  });
  it("reads a stored config back, limits in major units", () => {
    const d = unitTopupDraft(
      {
        id: "atu_1",
        currency: "USD",
        unit: "credits",
        trigger: "threshold",
        method: "target",
        threshold_units: "10",
        target_units: "500",
        pack_price: "price_pack",
        pack_quantity: null,
        purchase_limits: { day: { count: 2, amount_minor: 5000 } },
        monthly_cap_minor: 10000,
        max_runs_per_day: 4,
        payment_method: null,
        status: "active",
        disabled_reason: null,
        disabled_at: null,
      },
      [],
      "USD",
    );
    expect(d.method).toBe("target");
    expect(d.target_units).toBe("500");
    expect(d.monthly_cap).toBe("100.00");
    expect(d.limits.day).toEqual({ count: "2", amount: "50.00" });
    expect(d.limits.hour).toEqual({ count: "", amount: "" });
  });
  it("builds a fixed top-up body with only the limits that are set", () => {
    const d = draft({ pack_quantity: "2" });
    d.limits.day = { count: "3", amount: "" };
    d.limits.month = { count: "", amount: "80" };
    expect(unitTopupBody(d, ctx)).toEqual({
      ok: true,
      body: {
        unit: "credits",
        trigger: "threshold",
        threshold_units: "50",
        method: "fixed",
        pack_price: "price_pack",
        pack_quantity: 2,
        monthly_cap_minor: 10000,
        max_runs_per_day: 3,
        payment_method: null,
        purchase_limits: { day: { count: 3 }, month: { amount_minor: 8000 } },
      },
    });
  });
  it("builds a recharge body and clears the limits with null", () => {
    const r = unitTopupBody(draft({ method: "target", target_units: "500.5" }), ctx);
    expect(r.ok && r.body).toMatchObject({
      method: "target",
      target_units: "500.5",
      purchase_limits: null,
    });
    expect(r.ok && "pack_quantity" in r.body).toBe(false);
  });
  it("refuses what the API refuses, on the field at fault", () => {
    const r = unitTopupBody(
      draft({
        pack_price: "",
        method: "target",
        threshold_units: "0.25",
        target_units: "0",
        monthly_cap: "10",
        max_runs_per_day: "11",
        limits: {
          hour: { count: "0", amount: "" },
          day: { count: "", amount: "x" },
          week: { count: "", amount: "" },
          month: { count: "", amount: "" },
        },
      }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(
      [
        "limit_day_amount",
        "limit_hour_count",
        "max_runs_per_day",
        "monthly_cap",
        "pack_price",
        "target_units",
        "threshold_units",
      ].sort(),
    );
    expect(r.errors.monthly_cap).toBe("Enter $20.00 or more. That is the price of one pack.");
    expect(r.errors.threshold_units).toBe(
      "Enter 0 or more, as a number with at most 1 decimal place.",
    );
  });
  it("needs a recharge amount above the threshold, and a cap of one fixed top-up", () => {
    const t = unitTopupBody(draft({ method: "target", target_units: "50" }), ctx);
    expect(!t.ok && t.errors.target_units).toBe(
      "Enter more than the balance that starts a top-up.",
    );
    const f = unitTopupBody(draft({ pack_quantity: "6" }), ctx);
    expect(!f.ok && f.errors.monthly_cap).toBe(
      "Enter $120.00 or more. That is the price of one top-up.",
    );
    expect(unitTopupBody(draft({ method: "" }), ctx).ok).toBe(false);
  });
  it("parses credits and money as typed", () => {
    expect(unitsText("0", 0, true)).toBe("0");
    expect(unitsText("0", 0, false)).toBeNull();
    expect(unitsText("1.25", 1, true)).toBeNull();
    expect(majorText("12.5", "USD")).toBe(1250);
    expect(majorText("12.555", "USD")).toBeNull();
    expect(majorText("500", "JPY")).toBe(500);
    expect(majorText("0", "USD")).toBeNull();
  });
  it("maps an API refusal to its field", () => {
    expect(unitTopupErrorField("purchase_limits.week needs count or amount_minor")).toBe(
      "limit_week_count",
    );
    expect(unitTopupErrorField("target_units must be more than threshold_units.")).toBe(
      "target_units",
    );
    expect(unitTopupErrorField("monthly_cap_minor must be the price of the pack or more.")).toBe(
      "monthly_cap",
    );
    expect(
      unitTopupErrorField("The price x is not an active credit pack that grants credits."),
    ).toBe("pack_price");
    expect(unitTopupErrorField("Something else.")).toBeNull();
  });
  it("states on, a retry, and each way it turns off", () => {
    const cfg = { id: "atu_1", status: "active" as const, disabled_reason: null };
    expect(unitTopupState(cfg, []).label).toBe("On");
    const retry = unitTopupState(cfg, [
      {
        id: "r2",
        auto_topup: "atu_1",
        status: "created",
        attempts: 1,
        charge_after: "2026-11-13T12:00:00Z",
        amount_minor: 2000,
        currency: "USD",
        decline_code: "insufficient_funds",
        failure_message: null,
        created_at: "2026-11-13T08:00:00Z",
      },
    ]);
    expect(retry).toMatchObject({ tone: "tan", retryAt: "2026-11-13T12:00:00Z", failedTries: 1 });
    expect(retry.detail).toBe("The last payment was declined 1 time. We try again.");
    // A run of another top-up says nothing about this one.
    expect(
      unitTopupState(cfg, [
        {
          id: "r9",
          auto_topup: "atu_2",
          status: "created",
          attempts: 2,
          charge_after: "2026-11-13T12:00:00Z",
          amount_minor: 2000,
          currency: "USD",
          decline_code: null,
          failure_message: null,
          created_at: "2026-11-13T08:00:00Z",
        },
      ]).retryAt,
    ).toBeNull();
    const off = (reason: string) =>
      unitTopupState({ id: "atu_1", status: "disabled", disabled_reason: reason }, []);
    expect(off("payment_declined")).toMatchObject({ tone: "red", label: "Off" });
    expect(off("retries_exhausted").detail).toBe("The payment was declined on each try.");
    expect(off("customer").detail).toBe("The customer disabled it in the portal.");
    expect(off("operator").detail).toBe("You disabled it.");
  });
  it("says the rule and the limits in words", () => {
    expect(thresholdLine({ threshold_units: "50" }, credit)).toBe(
      "When the balance is 50 credits or less",
    );
    expect(buysLine({ method: "fixed", pack_quantity: 2, target_units: null }, credit)).toBe(
      "Buys 2 packs",
    );
    expect(buysLine({ method: "target", pack_quantity: null, target_units: "5000" }, credit)).toBe(
      "Buys packs until the balance is 5,000 credits or more",
    );
    expect(
      purchaseLimitLines({ day: { count: 1, amount_minor: 5000 }, week: { count: 4 } }, "USD"),
    ).toEqual(["Calendar day: 1 purchase, $50.00", "Last 7 days: 4 purchases"]);
  });
});

describe("holds in units", () => {
  const units = [
    {
      id: "credits",
      name: "credit",
      plural_name: "credits",
      decimals: 0,
      currency: "USD",
      minor_per_unit: null,
    },
  ] as unknown as CreditUnit[];
  it("shows what a lease reserved and captured once a step is captured", () => {
    expect(
      holdLeaseLines(
        { unit: "credits", units: "900", captured_units: "200", currency: "USD" },
        units,
      ),
    ).toEqual(["Reserved 900 credits", "Captured 200 credits"]);
  });
  it("adds nothing for a hold with no capture or a hold in money", () => {
    expect(
      holdLeaseLines(
        { unit: "credits", units: "900", captured_units: "0", currency: "USD" },
        units,
      ),
    ).toEqual([]);
    expect(holdLeaseLines({ unit: null, units: null, currency: "USD" }, units)).toEqual([]);
  });
});

describe("credit settings defaults", () => {
  it("the portal switch is off and late events wait 12 hours when unset", () => {
    const c = resolveCreditConfig(null);
    expect(c.portal_auto_topup).toBe(false);
    expect(c.late_event_grace_hours).toBe(12);
    expect(resolveCreditConfig({ late_event_grace_hours: 0 }).late_event_grace_hours).toBe(0);
  });
});
