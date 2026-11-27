import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import { invoiceRows, Skipped, toCells, headerOf } from "@/modules/bulk-export/writers";
import { centralDirectory, FileWriter, localHeader } from "@/modules/bulk-export/zip";
import { ENTITY_FIELDS } from "@/modules/bulk-import/templates";

const inv = (lines: Array<{ amount: number; kind?: string; description?: string }>, h = {}) =>
  lines.map((l, i) => ({
    id: "u1",
    public_id: "inv_1",
    number: "A-1",
    status: "paid",
    currency: "USD",
    created_at: "2026-01-01T00:00:00Z",
    total_minor: 7390,
    amount_due_minor: 0,
    customer_public_id: "c1",
    line_description: l.description ?? `L${i}`,
    line_amount: l.amount,
    line_quantity: 1,
    line_kind: l.kind ?? "recurring",
    ...h,
  }));

describe("bulk export: invoice rows", () => {
  it("reads tax lines as the tax and the rest of the gap as the discount, on the first line only", () => {
    const out = invoiceRows(
      inv([{ amount: 4900 }, { amount: 2500 }, { amount: 490, kind: "tax" }]),
    );
    if (out instanceof Skipped) throw new Error(out.reason);
    expect(out.map((r) => r.line_amount)).toEqual(["49.00", "25.00"]);
    expect([out[0]!.tax, out[0]!.discount]).toEqual(["4.90", "5.00"]);
    expect([out[1]!.tax, out[1]!.discount]).toEqual([null, null]);
  });

  it("turns a negative discount line into the discount", () => {
    const out = invoiceRows(
      inv([{ amount: 5000 }, { amount: -1000, kind: "discount" }], { total_minor: 4000 }),
    );
    if (out instanceof Skipped) throw new Error(out.reason);
    expect(out).toHaveLength(1);
    expect([out[0]!.discount, out[0]!.tax]).toEqual(["10.00", "0.00"]);
  });

  it("puts tax not kept as lines into the tax", () => {
    const out = invoiceRows(inv([{ amount: 1000 }], { total_minor: 1180 }));
    if (out instanceof Skipped) throw new Error(out.reason);
    expect([out[0]!.tax, out[0]!.discount]).toEqual(["1.80", "0.00"]);
  });

  it("leaves out drafts and invoices with no charge lines", () => {
    expect(invoiceRows(inv([{ amount: 100 }], { status: "pending" }))).toBeInstanceOf(Skipped);
    expect(invoiceRows(inv([{ amount: 100, kind: "tax" }]))).toBeInstanceOf(Skipped);
  });

  it("names open invoices open and voided ones void", () => {
    const open = invoiceRows(
      inv([{ amount: 7390 }], { status: "payment_due", amount_due_minor: 7390 }),
    );
    const voided = invoiceRows(inv([{ amount: 7390 }], { status: "voided" }));
    if (open instanceof Skipped || voided instanceof Skipped) throw new Error("skipped");
    expect([open[0]!.status, voided[0]!.status]).toEqual(["open", "void"]);
  });
});

describe("bulk export: cells", () => {
  const sub = (h: Record<string, unknown>) =>
    toCells("subscriptions", {
      public_id: "s1",
      customer_public_id: "c1",
      price_public_id: "p1",
      quantity: 2,
      currency: "USD",
      price_amount: "4900",
      snapshot_amount: "4900",
      current_period_end: "2026-02-01T00:00:00Z",
      ...h,
    });

  it("speaks the import's subscription states", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: "in_trial" }, "trialing"],
      [{ status: "active", cancel_at_period_end: true }, "non_renewing"],
      [{ status: "active", cancel_at_period_end: false }, "active"],
      [{ status: "cancelled" }, "cancelled"],
    ];
    for (const [h, want] of cases) {
      const c = sub(h);
      if (c instanceof Skipped) throw new Error(c.reason);
      expect(c.status).toBe(want);
    }
  });

  it("writes a negotiated price only when it differs from the price's", () => {
    const same = sub({ status: "active" });
    const own = sub({ status: "active", snapshot_amount: "3900" });
    if (same instanceof Skipped || own instanceof Skipped) throw new Error("skipped");
    expect([same.unit_price, own.unit_price]).toEqual([null, "39.00"]);
  });

  it("leaves out usage prices and models the import cannot read", () => {
    expect(toCells("plans", { model: "flat", meter_id: "m1", currency: "USD" })).toBeInstanceOf(
      Skipped,
    );
    expect(toCells("plans", { model: "package", currency: "USD" })).toBeInstanceOf(Skipped);
  });

  it("starts every header with the import's columns", () => {
    for (const e of ["plans", "customers", "invoices", "usage"] as const)
      expect(headerOf(e).slice(0, ENTITY_FIELDS[e].length)).toEqual(
        ENTITY_FIELDS[e].map((f) => f.key),
      );
  });
});

describe("bulk export: zip", () => {
  it("stores pages as one deflate stream that a zip reader inflates whole", async () => {
    const parts: Buffer[] = [];
    const w = new FileWriter(async (_seq, data) => {
      parts.push(data);
    });
    const pages = ["a,b\r\n", "1,2\r\n".repeat(5000), "3,4\r\n"];
    for (const p of pages) await w.write(p);
    await w.end();
    const data = Buffer.concat(parts);
    expect(inflateRawSync(data).toString()).toBe(pages.join(""));
    const at = new Date("2026-11-27T10:00:00Z");
    const file = { name: "x.csv", crc: w.crc, size: w.size, compressed: w.compressed };
    const head = localHeader(file, at);
    const zip = Buffer.concat([
      head,
      data,
      centralDirectory([{ ...file, offset: 0 }], at, head.length + data.length),
    ]);
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50);
    expect(zip.readUInt32LE(zip.length - 22 + 16)).toBe(head.length + data.length);
  });
});
