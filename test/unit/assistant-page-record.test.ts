import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pageContextOf, RECORD_FOLDER_PAGES, recordHref } from "../../dashboard/lib/assistant";

describe("recordHref", () => {
  it("links an imported id by the folder of the record it came from", () => {
    expect(recordHref("biz_1", "Qx7LmN2pRt4VwY9Za", "customers")).toBe(
      "/businesses/biz_1/customers/Qx7LmN2pRt4VwY9Za",
    );
    expect(recordHref("biz_1", "Qx7LmN2pRt4VwY9Za")).toBeNull();
    expect(recordHref("biz_1", "inv_9", "customers")).toBe("/businesses/biz_1/invoices/inv_9");
  });
});

const BIZ_APP = join(__dirname, "../../dashboard/app/(dashboard)/businesses/[biz]");

describe("pageContextOf", () => {
  it("reads an imported id with no prefix as the page's record", () => {
    expect(pageContextOf("/businesses/biz_1/customers/Qx7LmN2pRt4VwY9Za").page.record).toEqual({
      type: "customer",
      id: "Qx7LmN2pRt4VwY9Za",
    });
    expect(pageContextOf("/businesses/biz_1/invoices/100042").page.record).toEqual({
      type: "invoice",
      id: "100042",
    });
  });
  it("keeps a prefixed id as it is, and on a record's sub-page", () => {
    expect(pageContextOf("/businesses/biz_1/subscriptions/sub_9/edit").page.record).toEqual({
      type: "subscription",
      id: "sub_9",
    });
  });
  it("has no record on a list or a create page", () => {
    expect(pageContextOf("/businesses/biz_1/customers").page.record).toBeNull();
    expect(pageContextOf("/businesses/biz_1/customers/new").page.record).toBeNull();
    expect(pageContextOf("/businesses/biz_1/settings/credits").page.record).toBeNull();
  });
  it("knows every literal page beside a record id in the record folders", () => {
    // A new literal route (customers/import) must join RECORD_FOLDER_PAGES, or the
    // assistant reads it as a record id.
    for (const folder of [
      "customers",
      "invoices",
      "subscriptions",
      "credit_notes",
      "transactions",
      "payment_intents",
    ]) {
      const literal = readdirSync(join(BIZ_APP, folder), { withFileTypes: true })
        .filter((d) => d.isDirectory() && !/^[[(]/.test(d.name))
        .map((d) => d.name);
      for (const name of literal)
        expect(RECORD_FOLDER_PAGES.has(name), `${folder}/${name}`).toBe(true);
    }
  });
});
