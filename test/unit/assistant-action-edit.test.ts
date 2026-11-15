import { beforeEach, describe, expect, it, vi } from "vitest";
import { assistantActions, businesses } from "@db/schema";
import type { RouteResult } from "@/modules/assistant-tools/route-call";

// The stored proposal and the business, served by a fake tenant transaction.
const db = vi.hoisted(() => ({
  row: null as Record<string, unknown> | null,
  biz: { publicId: "biz_T1", livemode: "test", currency: "USD", timezone: "Asia/Kolkata" },
  writes: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
}));
vi.mock("@/platform/db", () => {
  const tx = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () =>
          table === assistantActions
            ? db.row
              ? [db.row]
              : []
            : table === businesses
              ? [db.biz]
              : [],
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          const write = () => db.writes.push({ table, set });
          return {
            returning: async () => (write(), [{ id: 1 }]),
            then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
              Promise.resolve(write()).then(() => ok(undefined), ko),
          };
        },
      }),
    }),
  };
  return { withTenant: async (_org: string, fn: (t: typeof tx) => unknown) => fn(tx) };
});

import { ActionError, editAction, type ProposalView } from "@/modules/assistant/actions";
import {
  coerceEdit,
  requestLines,
  type Line,
  type LineInput,
} from "@/modules/assistant/action-lines";
import { tierOf } from "@/modules/assistant/actions";

const ctx = { currency: "USD", timezone: "Asia/Kolkata", operation: "POST coupons" };
const byKey = (lines: Line[]) =>
  Object.fromEntries(lines.filter((l) => l.key).map((l) => [l.key, l]));

describe("lines say which fields the member may change", () => {
  const lines = requestLines(
    {},
    {
      code: "SAVE50",
      kind: "percentage",
      percent_off_bps: 5000,
      duration_type: "once",
      redeem_by: "2026-12-31",
      valid_from: "2026-12-01T04:30:00Z",
      max_redemptions: 10,
      metadata: { team: "growth" },
      item_constraints: [{ item_kind: "plan", constraint_type: "all" }],
    },
    ctx,
  );
  const k = byKey(lines);

  it("tags each top-level scalar with its key and control", () => {
    expect(k.code!.input).toEqual({ kind: "text", value: "SAVE50" });
    expect(k.percent_off_bps!.input).toEqual({ kind: "number", unit: "bps", value: "50" });
    expect(k.redeem_by!.input).toEqual({ kind: "date", value: "2026-12-31" });
    // The instant reads in the business's zone, as the line does.
    expect(k.valid_from!.input).toEqual({ kind: "datetime", value: "2026-12-01T10:00" });
    expect(k.max_redemptions!.input).toEqual({ kind: "number", value: "10" });
    expect(k.duration_type!.input).toMatchObject({ kind: "select", value: "once" });
    expect(k.duration_type!.input!.options).toContainEqual({ value: "forever", label: "Forever" });
  });
  it("offers no control for nested values, lists or records", () => {
    expect(k.metadata).toBeUndefined();
    expect(k.item_constraints).toBeUndefined();
    const sub = requestLines(
      { cus: "cus_XXXXXXXXXXXX01" },
      { price: "price_XXXXXXXXXXXX01", trial_days: 7 },
      { currency: "USD", operation: "POST customers/{cus}/subscriptions" },
    );
    expect(sub[0]!.key).toBeUndefined();
    expect(byKey(sub).price).toBeUndefined();
    expect(byKey(sub).trial_days!.input).toEqual({ kind: "number", value: "7" });
  });
  it("an amount is typed in major units of the line's currency", () => {
    const [amount] = requestLines({}, { amount_off_minor: 1250 }, { ...ctx, currency: "INR" });
    expect(amount).toMatchObject({
      key: "amount_off_minor",
      input: { kind: "amount", unit: "minor", currency: "INR", value: "12.50" },
    });
    const [yen] = requestLines({}, { amount_off_minor: 1200 }, { ...ctx, currency: "JPY" });
    expect(yen!.input!.value).toBe("1200");
  });
  it("a switch carries the labels of its two sides", () => {
    const [tax] = requestLines(
      {},
      { tax_exempt: true },
      { currency: "USD", operation: "POST customers" },
    );
    expect(tax!.input).toEqual({
      kind: "boolean",
      value: true,
      options: [
        { value: "true", label: "Tax exempt" },
        { value: "false", label: "Not tax exempt" },
      ],
    });
  });
});

describe("coerceEdit", () => {
  it("converts what the member typed back to the body's form", () => {
    const amount = { kind: "amount", unit: "minor", currency: "USD", value: "" } as const;
    expect(coerceEdit(amount, "12.5", 100)).toEqual({ value: 1250 });
    expect(coerceEdit({ ...amount, currency: "JPY" }, "1200", 0)).toEqual({ value: 1200 });
    expect(coerceEdit({ kind: "number", unit: "bps", value: "" }, "12.5", 0)).toEqual({
      value: 1250,
    });
    expect(coerceEdit({ kind: "number", value: "" }, 3, 0)).toEqual({ value: 3 });
    expect(coerceEdit({ kind: "boolean", value: false }, "true", false)).toEqual({ value: true });
    expect(coerceEdit({ kind: "date", value: "" }, "2027-01-31", "")).toEqual({
      value: "2027-01-31",
    });
    expect(coerceEdit({ kind: "text", value: "x" }, "  ", "x")).toEqual({ value: null });
  });
  it("keeps an instant in the shape the body had, read in the business's zone", () => {
    const dt = { kind: "datetime", value: "" } as const;
    expect(coerceEdit(dt, "2026-12-19T05:30", 1, "Asia/Kolkata")).toEqual({ value: 1797638400 });
    expect(coerceEdit(dt, "2026-12-19T05:30", "2026-01-01T00:00:00Z", "Asia/Kolkata")).toEqual({
      value: "2026-12-19T00:00:00Z",
    });
  });
  it("refuses a value the control cannot hold", () => {
    expect(coerceEdit({ kind: "number", value: "" }, "ten", 0)).toHaveProperty("error");
    expect(coerceEdit({ kind: "date", value: "" }, "31/01/2027", "")).toHaveProperty("error");
    const select: LineInput = {
      kind: "select",
      value: "once",
      options: [{ value: "once", label: "Once" }],
    };
    expect(coerceEdit(select, "weekly", "once")).toHaveProperty("error");
    expect(coerceEdit({ kind: "boolean", value: true }, "yes", true)).toHaveProperty("error");
  });
});

// ── editAction ───────────────────────────────────────────────────────────────

function proposal(operation: string, path: string, body: Record<string, unknown>, lines: Line[]) {
  const view: ProposalView = {
    id: "aact_T1",
    operation,
    title: "A change",
    tier: tierOf(operation, body)!,
    livemode: "test",
    kind: "create",
    fields: lines.length,
    lines,
    preview_lines: [],
    money: null,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    status: "proposed",
  };
  db.row = {
    id: 1,
    publicId: "aact_T1",
    businessId: "b1",
    operation,
    method: operation.split(" ")[0],
    path,
    body,
    tier: view.tier,
    status: "proposed",
    summary: view,
    expiresAt: new Date(Date.now() + 600_000),
  };
}

const ok = (body: unknown): RouteResult => ({ status: 200, body });
type Get = (rel: string) => Promise<RouteResult>;
type Post = (rel: string, body: unknown) => Promise<RouteResult>;
const routes =
  (get: Get = async () => ok({}), post: Post = async () => ok({})) =>
  () => ({ get, post });
const edit = (
  fields: Record<string, unknown>,
  more: Partial<Parameters<typeof editAction>[0]> = {},
) =>
  editAction({
    organizationId: "org_1",
    userId: "u1",
    id: "aact_T1",
    fields,
    moneyEnabled: false,
    routes: routes(),
    ...more,
  });

const COUPON = {
  code: "SAVE50",
  name: "Save half",
  kind: "percentage",
  percent_off_bps: 5000,
  duration_type: "once",
};

beforeEach(() => {
  db.writes = [];
  proposal("POST coupons", "coupons", COUPON, requestLines({}, COUPON, ctx));
});

describe("editAction", () => {
  it("stores the edited body and a card built from it", async () => {
    const view = await edit({ percent_off_bps: "25" });
    expect(view.lines).toContainEqual(
      expect.objectContaining({ label: "Percentage", value: "25%" }),
    );
    const action = db.writes.find((w) => w.table === assistantActions)!;
    expect(action.set.body).toEqual({ ...COUPON, percent_off_bps: 2500 });
    expect((action.set.summary as ProposalView).lines).toEqual(view.lines);
    // The conversation's copy of the card follows.
    expect(db.writes.length).toBe(2);
  });

  it("refuses a field the card does not offer, and changes nothing", async () => {
    await expect(edit({ item_constraints: "all" })).rejects.toBeInstanceOf(ActionError);
    await expect(edit({ percent_off_bps: "half" })).rejects.toThrow(
      /Enter a number for Percentage/,
    );
    expect(db.writes).toEqual([]);
  });

  it("refuses an edit the engine's checks refuse, and changes nothing", async () => {
    // A fixed-amount coupon needs its amount.
    await expect(edit({ kind: "fixed_amount" })).rejects.toMatchObject({ status: 422 });
    expect(db.writes).toEqual([]);
  });

  it("shows the preview's refusal and keeps the stored card", async () => {
    const op = "POST subscriptions/{sub}/cancel";
    const body = { cancel_option: "end_of_term" };
    proposal(
      op,
      "subscriptions/sub_XXXXXXXXXXXX01/cancel",
      body,
      requestLines({ sub: "sub_XXXXXXXXXXXX01" }, body, { currency: "USD", operation: op }),
    );
    const post = vi.fn(async (_rel: string, _body: unknown) => ({
      status: 400,
      body: { error: { message: "The cancel date is in the past." } },
    }));
    await expect(
      edit({ cancel_option: "specific_date" }, { routes: routes(undefined, post) }),
    ).rejects.toThrow("We could not save your changes. The cancel date is in the past.");
    expect(post.mock.calls[0]![0]).toBe("subscriptions/sub_XXXXXXXXXXXX01/cancel_estimate");
    expect(db.writes).toEqual([]);
  });

  it("an edit that makes the change move money needs money changes on", async () => {
    const op = "POST subscriptions/{sub}/cancel";
    const body = { cancel_option: "end_of_term" };
    proposal(
      op,
      "subscriptions/sub_XXXXXXXXXXXX01/cancel",
      body,
      requestLines({ sub: "sub_XXXXXXXXXXXX01" }, body, { currency: "USD", operation: op }),
    );
    await expect(edit({ cancel_option: "immediately" })).rejects.toMatchObject({ status: 403 });
    const view = await edit({ cancel_option: "immediately" }, { moneyEnabled: true });
    expect(view.tier).toBe(3);
    expect(view.money).toMatch(/^Cancel a subscription\./);
    expect(db.writes.find((w) => w.table === assistantActions)!.set.tier).toBe(3);
  });

  it("an update is compared with the record again", async () => {
    const op = "PATCH customers/{cus}";
    const body = { email: "new@example.com" };
    proposal(
      op,
      "customers/cus_XXXXXXXXXXXX01",
      body,
      requestLines({ cus: "cus_XXXXXXXXXXXX01" }, body, { currency: "USD", operation: op }),
    );
    const get = vi.fn(async (_rel: string) =>
      ok({ id: "cus_XXXXXXXXXXXX01", email: "old@example.com" }),
    );
    await expect(edit({ email: "old@example.com" }, { routes: routes(get) })).rejects.toThrow(
      /Nothing would change/,
    );
    const view = await edit({ email: "other@example.com" }, { routes: routes(get) });
    expect(view.lines).toContainEqual(
      expect.objectContaining({
        key: "email",
        value: "other@example.com",
        before: "old@example.com",
      }),
    );
  });

  it("only while the change waits for confirmation", async () => {
    db.row!.status = "done";
    await expect(edit({ percent_off_bps: 2500 })).rejects.toMatchObject({ status: 409 });
    db.row!.status = "proposed";
    db.row!.expiresAt = new Date(Date.now() - 1000);
    await expect(edit({ percent_off_bps: 2500 })).rejects.toMatchObject({ status: 409 });
  });

  it("the note goes only on a new email", async () => {
    await expect(
      editAction({
        organizationId: "o",
        userId: "u",
        id: "aact_T1",
        note: "Hi",
        moneyEnabled: false,
        routes: routes(),
      }),
    ).rejects.toThrow(/only on a new email/);
  });
});
