import { describe, expect, it } from "vitest";
import {
  balanceView,
  hasMoneyValue,
  unitCount,
  unitInfo,
  unitOptionLabel,
  type CreditUnit,
} from "../../dashboard/lib/credits";
import { creditRows, historyAmount } from "../../dashboard/lib/portal-credits-view";

const unit = (id: string, minor_per_unit: string | null, decimals = 0): CreditUnit => ({
  object: "credit_unit",
  id,
  name: id,
  plural_name: `${id}s`,
  currency: "USD",
  minor_per_unit,
  decimals,
  locked: true,
  locked_at: null,
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
});
const units = [unit("token", "1"), unit("export", null, 1)];
const info = (key: string | null) => unitInfo(units, key, "USD");
const bal = (available_minor: number, grants_minor: number, rows: Array<[string, number]>) => ({
  currency: "USD",
  available_minor,
  grants_minor,
  available_units: rows.map(([u, n]) => ({ unit: u, units: n })),
});

describe("customer balance card", () => {
  it("leads with units when the customer holds only credit with no money value", () => {
    const v = balanceView(
      bal(0, 0, [
        ["USD", 0],
        ["export", 400],
      ]),
      info,
    );
    expect(v.lead).toBe("units");
    expect(v.unrated.map((r) => [r.unit.key, r.units])).toEqual([["export", 400]]);
    expect(unitCount(400, v.unrated[0]!.unit)).toBe("40");
  });
  it("leads with money when money credit is held, and keeps the unit out of the money rows", () => {
    const v = balanceView(
      bal(1500, 1500, [
        ["USD", 1500],
        ["token", 1500],
        ["export", 400],
      ]),
      info,
    );
    expect(v.lead).toBe("money");
    // The money entry is credit before open holds: the available figure stands for it.
    expect(v.rated.map((r) => r.unit.key)).toEqual(["token"]);
    expect(v.unrated.map((r) => r.unit.key)).toEqual(["export"]);
  });
  it("carries held and unsettled units of a unit with no money value", () => {
    const v = balanceView(
      {
        currency: "USD",
        available_minor: 0,
        grants_minor: 0,
        available_units: [{ unit: "export", units: 950, held_units: 900, unsettled_units: 150 }],
      },
      info,
    );
    expect(v.unrated).toMatchObject([{ units: 950, held: 900, unsettled: 150 }]);
  });
  it("a customer with rated credit only: money lead, every unit with a rate in the money block", () => {
    const v = balanceView(
      bal(1500, 1500, [
        ["USD", 1500],
        ["token", 1500],
      ]),
      info,
    );
    expect(v).toMatchObject({ lead: "money", unrated: [] });
    expect(v.rated.map((r) => r.unit.key)).toEqual(["token"]);
  });
  it("leads with money when nothing is held at all, or money credit is used up", () => {
    expect(balanceView(bal(0, 0, [["export", 0]]), info).lead).toBe("money");
    expect(balanceView(bal(0, 1500, [["export", 400]]), info).lead).toBe("money");
  });
});

describe("transactions: the Value column", () => {
  it("is hidden only when no row has a money value", () => {
    expect(hasMoneyValue([info("export")])).toBe(false);
    expect(hasMoneyValue([info("export"), info("token")])).toBe(true);
    expect(hasMoneyValue([info(null)])).toBe(true);
    // An unknown unit counts as one with a value, as before.
    expect(hasMoneyValue([info("gone")])).toBe(true);
  });
});

describe("unit option label", () => {
  it("shows the currency only for a unit with a money value", () => {
    expect(unitOptionLabel(units[0]!)).toBe("tokens (USD)");
    expect(unitOptionLabel(units[1]!)).toBe("exports");
  });
});

const ub = (unit: string | null, rated: boolean) => ({ unit, rated });
const grant = (id: string, unit: string | null, unit_rated?: boolean, currency = "USD") => ({
  id,
  currency,
  unit,
  unit_rated,
});
type Rows = ReturnType<
  typeof creditRows<
    { currency: string; available_minor: number; units: ReturnType<typeof ub>[] },
    ReturnType<typeof grant>
  >
>;
const kinds = (rows: Rows) =>
  rows.map((r) =>
    r.kind === "grant"
      ? `grant:${r.grant.id}`
      : r.kind === "unit"
        ? `unit:${r.unit.unit}`
        : `money:${r.balance.currency}`,
  );

describe("portal credit rows", () => {
  it("leaves out a money row of 0 when the buyer holds only credit with no money value", () => {
    const rows = creditRows({
      balances: [{ currency: "USD", available_minor: 0, units: [ub("export", false)] }],
      grants: [grant("g1", "export", false)],
    });
    expect(kinds(rows)).toEqual(["unit:export", "grant:g1"]);
  });
  it("puts each grant under its own figure for a buyer with both", () => {
    const rows = creditRows({
      balances: [
        {
          currency: "USD",
          available_minor: 1500,
          units: [ub("token", true), ub("export", false), ub("point", false)],
        },
      ],
      grants: [
        grant("e1", "export", false),
        grant("t1", "token", true),
        grant("m1", null, true),
        grant("p1", "point", false),
        grant("e2", "export", false),
      ],
    });
    expect(kinds(rows)).toEqual([
      "money:USD",
      "grant:t1",
      "grant:m1",
      "unit:export",
      "grant:e1",
      "grant:e2",
      "unit:point",
      "grant:p1",
    ]);
  });
  it("keeps a money row of 0 that still has a grant with a money value", () => {
    const rows = creditRows({
      balances: [{ currency: "USD", available_minor: 0, units: [ub("export", false)] }],
      grants: [grant("m1", null, true)],
    });
    expect(kinds(rows)).toEqual(["money:USD", "grant:m1", "unit:export"]);
  });
  it("keeps the old order with no such unit: every money row, then every grant", () => {
    const rows = creditRows({
      balances: [
        { currency: "USD", available_minor: 0, units: [ub("token", true)] },
        { currency: "EUR", available_minor: 500, units: [] },
      ],
      // An older API sends no `unit_rated`.
      grants: [grant("e1", null, undefined, "EUR"), grant("t1", "token")],
    });
    expect(kinds(rows)).toEqual(["money:USD", "money:EUR", "grant:e1", "grant:t1"]);
  });
  it("never drops a grant", () => {
    const rows = creditRows({
      balances: [{ currency: "USD", available_minor: 0, units: [ub("export", false)] }],
      grants: [grant("x1", "other", false), grant("g1", null, true, "EUR")],
    });
    expect(kinds(rows)).toEqual(["unit:export", "grant:x1", "grant:g1"]);
  });
});

describe("portal credit history amount", () => {
  const base = { currency: "USD", unit_name: "export", unit_plural_name: "exports" };
  it("shows units, signed, for a unit with no money value", () => {
    const t = { ...base, face_minor: 0, unit: "export", unit_rated: false, decimals: 1 };
    expect(historyAmount({ ...t, units: 1000 })).toBe("100 exports");
    expect(historyAmount({ ...t, units: -10 })).toBe("-1 export");
  });
  it("shows money for money and for a unit with a rate, as before", () => {
    expect(historyAmount({ currency: "USD", face_minor: -1500 })).toBe("-$15.00");
    expect(
      historyAmount({ ...base, face_minor: 900, units: 150, unit: "token", unit_rated: true }),
    ).toBe("$9.00");
  });
});
