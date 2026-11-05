/**
 * WHO the invoice is addressed to — the bill-to identity rule, pinned.
 *
 * Two separate bugs live here and both were shipped:
 *
 *  1. The document printed `customers.name` — a column our importer synthesises from
 *     first+last — and never read the `billing_*` columns, so an invoice addressed to a
 *     company's accounts-payable contact named whichever individual signed up. The
 *     reference row below is that shape: the document must read "Accounts Payable /
 *     Kavi Analytics Pvt Ltd / 4 Anna Salai", with "Priya Raghunathan" nowhere on it.
 *
 *  2. Once the header name was fixed, it was still resolved from the LIVE customer row while
 *     the address block came from the invoice's `billing_address` SNAPSHOT. A customer who
 *     changed their billing contact after issue then got two different names on one document
 *     — new in the header, old as an address line — and the de-duplication guard could not
 *     fire because they differ. The snapshot owns both, or neither.
 *
 * The precedence chains themselves are pinned by `customer-names.test.ts`; this suite pins
 * the SNAPSHOT-vs-LIVE-ROW decision and the printed line composition on top of them.
 */
import { describe, it, expect } from "vitest";
import {
  billToName,
  customerAddressLines,
  snapshotAddressLines,
} from "@/modules/invoicing/document";

/** The reference customer. `name` is our synthesised column. */
const CUSTOMER = {
  publicId: "cus_kavi",
  email: "priya@kavi.example",
  name: "Priya Raghunathan",
  firstName: "Priya",
  lastName: "Raghunathan",
  company: "Kavi Analytics",
  billingFirstName: "Accounts",
  billingLastName: "Payable",
  billingCompany: "Kavi Analytics Pvt Ltd",
  addressLine1: "4 Anna Salai",
  addressLine2: null,
  addressLine3: null,
  city: "Chennai",
  state: "Tamil Nadu",
  postalCode: "600002",
  country: "IN",
} as unknown as Parameters<typeof customerAddressLines>[0];

/** An invoice's `billing_address` snapshot naming a contact the customer row has since lost. */
const SNAPSHOT_WITH_CONTACT = {
  first_name: "Ravi",
  last_name: "Kumar",
  company: "Kavi Analytics LLP",
  line1: "9 Snapshot Way",
  line3: "Gate 2",
  city: "Mumbai",
  postal_code: "400001",
  country: "IN",
};

describe("bill-to identity: the snapshot outranks the live customer row", () => {
  it("takes the header name from the snapshot contact, not from the current customer", () => {
    expect(billToName(SNAPSHOT_WITH_CONTACT, CUSTOMER, "cust-row-id")).toBe("Ravi Kumar");
  });

  it("prints ONE name on the document — the snapshot contact is not repeated as an address line", () => {
    const name = billToName(SNAPSHOT_WITH_CONTACT, CUSTOMER, "cust-row-id");
    const lines = snapshotAddressLines(SNAPSHOT_WITH_CONTACT, name);
    expect(lines).not.toContain("Ravi Kumar");
    // …and the live row's contact must not leak in alongside it.
    expect(lines).not.toContain("Accounts Payable");
    expect(lines).not.toContain("Priya Raghunathan");
    // The company is a different fact and still prints, above the street lines.
    expect(lines).toEqual([
      "Kavi Analytics LLP",
      "9 Snapshot Way",
      "Gate 2",
      "Mumbai, 400001",
      "India",
    ]);
  });

  it("falls back to the company when the snapshot names no person", () => {
    const snap = { company: "Kavi Analytics LLP", line1: "9 Snapshot Way", country: "IN" };
    const name = billToName(snap, CUSTOMER, "cust-row-id");
    expect(name).toBe("Kavi Analytics LLP");
    // Won the name chain, so it must not print twice either.
    // 'India', not 'IN': the STORED address holds the alpha-2 (the inputs above still do),
    // and the renderer expands it — an invoice is read by people and by tax officers.
    // See `countryLabel` in invoicing/document.ts.
    expect(snapshotAddressLines(snap, name)).toEqual(["9 Snapshot Way", "India"]);
  });

  it("falls back to the CUSTOMER when the snapshot carries no contact at all", () => {
    // The street-only shape `verify-invoicing-parity` writes: taking an address snapshot
    // must never blank a name that was printing before it was taken.
    const snap = { line1: "9 Snapshot Way", city: "Mumbai", country: "IN" };
    expect(billToName(snap, CUSTOMER, "cust-row-id")).toBe("Accounts Payable");
  });

  it("falls back to the customer public id, then the raw row id, when there is no name anywhere", () => {
    const nameless = { publicId: "cus_bare" } as unknown as Parameters<typeof billToName>[1];
    expect(billToName(null, nameless, "cust-row-id")).toBe("cus_bare");
    expect(billToName(null, null, "cust-row-id")).toBe("cust-row-id");
  });
});

describe("bill-to identity: no snapshot", () => {
  it("addresses the document to the BILLING CONTACT, never to the account holder", () => {
    expect(billToName(null, CUSTOMER, "cust-row-id")).toBe("Accounts Payable");
  });

  it("prints the billing company above the street lines, with the name de-duplicated", () => {
    const name = billToName(null, CUSTOMER, "cust-row-id");
    expect(customerAddressLines(CUSTOMER, name)).toEqual([
      "Kavi Analytics Pvt Ltd",
      "4 Anna Salai",
      "Chennai, Tamil Nadu, 600002",
      "India",
    ]);
  });

  it("falls back to the account holder for a customer with no billing contact of its own", () => {
    // The address block never carries a copy of the customer name, so without this
    // fallback it would print a bare street line and no identity at all.
    const noContact = {
      ...(CUSTOMER as object),
      billingFirstName: null,
      billingLastName: null,
      billingCompany: null,
    } as typeof CUSTOMER;
    const name = billToName(null, noContact, "cust-row-id");
    expect(name).toBe("Priya Raghunathan");
    expect(customerAddressLines(noContact, name)).toEqual([
      "Kavi Analytics",
      "4 Anna Salai",
      "Chennai, Tamil Nadu, 600002",
      "India",
    ]);
  });
});
