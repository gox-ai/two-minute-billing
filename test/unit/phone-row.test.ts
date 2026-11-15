import { describe, expect, it } from "vitest";
import { planPhoneRow, type PhoneColumn } from "../../dashboard/lib/phone-row";

const col = (id: string, extra: Partial<PhoneColumn> = {}): PhoneColumn => ({ id, ...extra });

describe("planPhoneRow", () => {
  it("leads with the first data column and lists the rest, skipping the table's own columns", () => {
    expect(planPhoneRow([col("__select"), col("name"), col("created_at"), col("__menu")])).toEqual({
      title: "name",
      aside: [],
      detail: ["created_at"],
    });
  });

  it("leads with the grow column, as the desktop row gives it the spare width", () => {
    expect(planPhoneRow([col("created_at"), col("action", { grow: true }), col("actor")])).toEqual({
      title: "action",
      aside: [],
      detail: ["created_at", "actor"],
    });
  });

  it("an explicit title beats grow; a hidden column goes nowhere", () => {
    expect(
      planPhoneRow([
        col("a", { grow: true }),
        col("b", { phone: "title" }),
        col("c", { phone: "hide" }),
      ]),
    ).toEqual({ title: "b", aside: [], detail: ["a"] });
  });

  it("never makes an aside or hidden column the title", () => {
    expect(
      planPhoneRow([
        col("amount", { phone: "aside", grow: true }),
        col("x", { phone: "hide" }),
        col("y"),
      ]),
    ).toEqual({ title: "y", aside: ["amount"], detail: [] });
  });

  it("puts the money first and the status chip under it, whatever the column order", () => {
    expect(
      planPhoneRow([
        col("invoice"),
        col("status"),
        col("total", { phone: "aside" }),
        col("created_at"),
      ]),
    ).toEqual({ title: "invoice", aside: ["total", "status"], detail: ["created_at"] });
  });

  it("lets a status column opt out of the first line", () => {
    expect(planPhoneRow([col("name"), col("status", { phone: "detail" })]).aside).toEqual([]);
    expect(planPhoneRow([col("name"), col("status", { phone: "hide" })])).toEqual({
      title: "name",
      aside: [],
      detail: [],
    });
  });

  it("has no title for a table with no data columns", () => {
    expect(planPhoneRow([col("__select"), col("__menu")]).title).toBeUndefined();
  });
});
