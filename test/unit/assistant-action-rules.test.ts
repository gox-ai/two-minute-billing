import { describe, expect, it } from "vitest";
import { ACTION_OPS, storedRefusal } from "@/modules/assistant/actions";
import {
  CREATES,
  NO_BODY_OPS,
  UPDATE_READS,
  bodyError,
  changedFields,
  effectSentence,
  fitError,
  opKind,
  requiredGroups,
} from "@/modules/assistant/action-rules";
import { changeLines, requestLines } from "@/modules/assistant/action-lines";

/** What the member reads on a line, without the edit control. */
const shown = (ls: Array<{ label: string; value: string; before?: string }>) =>
  ls.map(({ label, value, before }) =>
    before === undefined ? { label, value } : { label, value, before },
  );

const OPS = Object.keys(ACTION_OPS);
const CREATE_OPS = OPS.filter((op) => opKind(op) === "create");

describe("every operation has a body rule", () => {
  it("names only operations Billy can prepare", () => {
    for (const op of [...Object.keys(CREATES), ...Object.keys(NO_BODY_OPS)])
      expect(ACTION_OPS[op], op).toBeTruthy();
  });
  it("an update reads its record; no update or create runs on an empty body", () => {
    for (const op of OPS) {
      if (opKind(op) === "update") expect(UPDATE_READS[op], op).toBeTruthy();
      if (NO_BODY_OPS[op]) expect(opKind(op), op).toBe("command");
    }
  });
  it("an operation outside the no-body list needs at least one field", () => {
    for (const op of OPS) {
      if (NO_BODY_OPS[op] || opKind(op) === "update") continue;
      expect(requiredGroups(op, {}).length, op).toBeGreaterThan(0);
    }
  });
});

describe("an empty or meaningless create is refused", () => {
  for (const op of CREATE_OPS)
    it(op, () => expect(bodyError(op, {}), op).toMatch(/needs .* Ask the member/));

  it("a customer needs an email or a name", () => {
    expect(bodyError("POST customers", {})).toContain("one of email, first_name");
    expect(bodyError("POST customers", { currency: "USD" })).not.toBeNull();
    expect(bodyError("POST customers", { email: "  " })).not.toBeNull();
    expect(bodyError("POST customers", { email: "ana@example.com" })).toBeNull();
    expect(bodyError("POST customers", { company: "Harbour Works" })).toBeNull();
  });
  it("a coupon needs its discount", () => {
    expect(bodyError("POST coupons", { code: "SAVE50", kind: "percentage" })).toContain(
      "percent_off_bps",
    );
    expect(
      bodyError("POST coupons", { code: "SAVE50", kind: "percentage", percent_off_bps: 5000 }),
    ).toBeNull();
    expect(bodyError("POST coupons", { code: "SAVE5", kind: "fixed_amount" })).toContain(
      "amount_off_minor",
    );
  });
  it("an invoice with no lines is refused", () => {
    expect(bodyError("POST invoices", { customer: "cus_XXXXXXXXXXXX01", lines: [] })).toContain(
      "lines",
    );
  });
  it("tells the model never to invent a value", () => {
    expect(bodyError("POST customers", {})).toContain("Never fill in a value");
  });
});

describe("no-body operations are allowed", () => {
  for (const op of Object.keys(NO_BODY_OPS)) it(op, () => expect(bodyError(op, {})).toBeNull());
});

describe("an update must change something", () => {
  it("an update with no field is refused", () => {
    expect(bodyError("PATCH customers/{cus}", {})).toContain("no field");
  });
  it("drops fields that already have the value, and keeps the rest", () => {
    const d = changedFields(
      "PATCH customers/{cus}",
      { email: "Ana@Example.com", dunning_excluded: true, billing_cc_emails: ["b@example.com"] },
      { email: "ana@example.com", dunning_excluded: false, billing_cc_emails: ["b@example.com"] },
    );
    expect(d.changed).toEqual({ dunning_excluded: true });
    expect(d.before).toEqual({ dunning_excluded: false });
    expect(d.unchanged.sort()).toEqual(["billing_cc_emails", "email"]);
  });
  it("a date in another form is the same date", () => {
    const d = changedFields(
      "PATCH invoices/{inv}",
      { expected_payment_date: 1797638400, po_number: "" },
      { expected_payment_date: "2026-12-19T00:00:00.000Z", po_number: null },
    );
    expect(d.changed).toEqual({});
  });
  it("reads a subscription's payment method under its own name", () => {
    const d = changedFields(
      "PATCH subscriptions/{sub}",
      { payment_method: "pm_XXXXXXXXXXXX02" },
      { default_payment_method: "pm_XXXXXXXXXXXX01" },
    );
    expect(d.before).toEqual({ payment_method: "pm_XXXXXXXXXXXX01" });
  });
  it("a field the record does not show counts as a change", () => {
    const d = changedFields("PATCH subscriptions/{sub}/items/{item}", { markup_percent: "20" }, {});
    expect(d.changed).toEqual({ markup_percent: "20" });
    expect(d.before).toEqual({});
  });
});

describe("the card shows what will change", () => {
  const ctx = {
    currency: "USD",
    timezone: "Asia/Kolkata",
    names: new Map([["cus_XXXXXXXXXXXX01", "Harbour Works"]]),
  };
  it("a create: every field, in the dashboard's words", () => {
    const lines = requestLines(
      {},
      { email: "ana@example.com", first_name: "Ana", tax_exempt: true },
      { ...ctx, operation: "POST customers" },
    );
    expect(shown(lines)).toEqual([
      { label: "Email", value: "ana@example.com" },
      { label: "First name", value: "Ana" },
      { label: "Tax", value: "Tax exempt" },
    ]);
  });
  it("an update: before → after, only for what changes", () => {
    const lines = changeLines(
      { cus: "cus_XXXXXXXXXXXX01" },
      { dunning_excluded: true, email: "new@example.com" },
      { dunning_excluded: false, email: "old@example.com" },
      { ...ctx, operation: "PATCH customers/{cus}" },
    );
    expect(shown(lines)).toEqual([
      { label: "Customer", value: "Harbour Works" },
      { label: "Dunning", value: "Exclude from dunning", before: "Include in dunning" },
      { label: "Email", value: "new@example.com", before: "old@example.com" },
    ]);
  });
  it("a no-body operation: one sentence naming the record", () => {
    const names = new Map([["inv_XXXXXXXXXXXX01", "INV-0042"]]);
    expect(
      effectSentence("POST invoices/{inv}/void", { inv: "inv_XXXXXXXXXXXX01" }, names, 3),
    ).toBe("Void invoice INV-0042. You cannot undo this.");
    expect(
      effectSentence("POST subscriptions/{sub}/pause", { sub: "sub_XXXXXXXXXXXX01" }, names, 2),
    ).toBe("Pause subscription sub_XXXXXXXXXXXX01.");
    expect(effectSentence("POST customers", {}, names, 1)).toBeNull();
  });
  it("a coupon says which prices it applies to", () => {
    const names = new Map([
      ["price_XXXXXXXXXXXX01", "Lite Yearly"],
      ["price_XXXXXXXXXXXX02", "Pro Yearly"],
    ]);
    const lines = requestLines(
      {},
      {
        code: "SAVE50",
        kind: "percentage",
        percent_off_bps: 5000,
        duration_type: "once",
        apply_on: "each_specified_item",
        item_constraints: [
          {
            item_kind: "plan",
            constraint_type: "specific",
            price_ids: ["price_XXXXXXXXXXXX01", "price_XXXXXXXXXXXX02"],
          },
        ],
      },
      { ...ctx, names, operation: "POST coupons" },
    );
    expect(shown(lines)).toContainEqual({ label: "Percentage", value: "50%" });
    expect(shown(lines)).toContainEqual({ label: "Duration", value: "Once" });
    expect(shown(lines)).toContainEqual({
      label: "Applies to",
      value: "Plans: Lite Yearly, Pro Yearly",
    });
  });
  it("a coupon says the billing periods it is limited to", () => {
    const applies = (billing_periods?: unknown) =>
      requestLines(
        {},
        {
          code: "SAVE50",
          item_constraints: [
            {
              item_kind: "plan",
              constraint_type: "all",
              ...(billing_periods ? { billing_periods } : {}),
            },
          ],
        },
        { ...ctx, operation: "POST coupons" },
      ).find((l) => l.label === "Applies to")?.value;
    expect(applies()).toBe("Plans: all");
    expect(applies([])).toBe("Plans: all");
    expect(applies([{ interval: "year", interval_count: 1 }])).toBe("Plans: all, yearly only");
    expect(applies([{ interval: "month" }, { interval: "month", interval_count: 3 }])).toBe(
      "Plans: all, monthly or every 3 months only",
    );
  });
});

describe("confirm checks the stored proposal again", () => {
  it("refuses an empty create stored before the checks (the production card)", () => {
    expect(
      storedRefusal({
        operation: "POST customers",
        body: {},
        summary: { title: "Create a customer", lines: [], preview_lines: [] },
      }),
    ).toContain("did not include the details");
  });
  it("refuses a create or update whose stored card has no field line", () => {
    expect(
      storedRefusal({
        operation: "PATCH customers/{cus}",
        body: { email: "ana@example.com" },
        summary: { lines: [{ label: "Customer", value: "Harbour Works" }], preview_lines: [] },
      }),
    ).not.toBeNull();
    expect(
      storedRefusal({
        operation: "POST customers",
        body: { email: "ana@example.com" },
        summary: { kind: "create", fields: 0, lines: [], preview_lines: [] },
      }),
    ).not.toBeNull();
  });
  it("lets a complete proposal and a no-body operation through", () => {
    expect(
      storedRefusal({
        operation: "POST customers",
        body: { email: "ana@example.com" },
        summary: { kind: "create", fields: 1, lines: [{ label: "Email", value: "a" }] },
      }),
    ).toBeNull();
    expect(
      storedRefusal({
        operation: "POST invoices/{inv}/void",
        body: {},
        summary: { kind: "command", fields: 0, lines: [{ label: "Invoice", value: "INV-0042" }] },
      }),
    ).toBeNull();
    expect(
      storedRefusal({ operation: "DELETE scheduled_changes/{sch}", body: null, summary: {} }),
    ).toBeNull();
  });
});

describe("the operation fits the turn", () => {
  const allowed = OPS;
  it("a customer with nothing in it is refused, whatever the member wrote (the production turn)", () => {
    // A coupon request turned into an empty POST customers: the required fields stop it.
    expect(bodyError("POST customers", {})).toContain("email");
    expect(fitError({ operation: "POST customers", body: {}, allowed })).toBeNull();
  });
  it("refuses an operation about another record than the Show me guide", () => {
    const e = fitError({
      operation: "POST customers",
      body: { email: "ana@example.com" },
      guidePath: "/businesses/biz_XXXXXXXXXXXX01/catalog/coupons/new",
      allowed,
    });
    expect(e).toContain("Show me guide");
    expect(e).toContain("POST coupons");
  });
  it("lets the matching operation through", () => {
    expect(
      fitError({
        operation: "POST coupons",
        body: { code: "SAVE50X" },
        guidePath: "/businesses/biz_XXXXXXXXXXXX01/catalog/coupons/new",
        allowed,
      }),
    ).toBeNull();
    expect(
      fitError({
        operation: "POST customers/{cus}/credit_grants",
        body: { amount: 500 },
        guidePath: "/businesses/biz_XXXXXXXXXXXX01/customers/cus_XXXXXXXXXXXX01",
        allowed,
      }),
    ).toBeNull();
  });
  it("never refuses without a guide", () => {
    for (const op of CREATE_OPS) expect(fitError({ operation: op, body: {}, allowed })).toBeNull();
  });
});
