import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  invoiceContactName,
  accountHolderName,
  billingContact,
  hasBillingName,
  type NameFields,
} from "@/modules/customers/names";
import { accountHolderNameSql } from "@/modules/customers/name-sql";
import { filterSql } from "@/platform/list-query";

/**
 * The precedence rules in `modules/customers/names.ts`, pinned.
 *
 * The fixture below is a customer whose account holder and billing contact deliberately
 * disagree. The invoice for it must read
 *
 *     BILLED TO
 *     Accounts Payable
 *     Kavi Analytics Pvt Ltd
 *
 * — the BILLING contact, with the account holder ("Priya Raghunathan") absent from the
 * document entirely. Any change that makes `invoiceContactName` return the account
 * holder here is a regression, not a preference.
 */
const splitContactCustomer = {
  firstName: "Priya",
  lastName: "Raghunathan",
  company: "Kavi Analytics",
  email: "priya@example.com",
  billingFirstName: "Accounts",
  billingLastName: "Payable",
  billingCompany: "Kavi Analytics Pvt Ltd",
};

describe("invoiceContactName — what gets printed", () => {
  it("prefers the billing contact over the account holder", () => {
    expect(invoiceContactName(splitContactCustomer)).toBe("Accounts Payable");
  });

  it("falls back through account holder → company → email", () => {
    const base = { billingFirstName: null, billingLastName: null, billingCompany: null };
    expect(invoiceContactName({ ...base, firstName: "Priya", lastName: "Raghunathan" })).toBe(
      "Priya Raghunathan",
    );
    expect(invoiceContactName({ ...base, company: "Kavi Analytics" })).toBe("Kavi Analytics");
    expect(invoiceContactName({ ...base, email: "a@b.example" })).toBe("a@b.example");
    expect(invoiceContactName(base)).toBeNull();
  });

  it("uses the billing COMPANY when the contact has no personal name", () => {
    expect(
      invoiceContactName({ firstName: "Priya", billingCompany: "Kavi Analytics Pvt Ltd" }),
    ).toBe("Kavi Analytics Pvt Ltd");
  });

  it("IGNORES the deprecated `name` column completely", () => {
    // `NameFields` no longer declares `name`, so the compiler stops this at every
    // typed call site — these casts are the untyped ones (a raw row spread, a JSON
    // body). The point is that the RUNTIME does not consult it either: a legacy name
    // must not resurface as a printed billing identity now that no form collects it
    // and nothing writes it. See the deprecation note in `names.ts`.
    expect(invoiceContactName({ name: "Legacy Import Name" } as NameFields)).toBeNull();
    expect(invoiceContactName({ name: "Wrong", email: "a@b.example" } as NameFields)).toBe(
      "a@b.example",
    );
    expect(
      invoiceContactName({
        name: "Wrong",
        firstName: "Priya",
        lastName: "Raghunathan",
      } as NameFields),
    ).toBe("Priya Raghunathan");
  });

  it("treats whitespace-only values as absent", () => {
    expect(invoiceContactName({ billingFirstName: "   ", firstName: "Priya" })).toBe("Priya");
  });

  it("handles a half-filled contact without a stray space", () => {
    expect(invoiceContactName({ billingLastName: "Payable" })).toBe("Payable");
    expect(invoiceContactName({ billingFirstName: "Accounts" })).toBe("Accounts");
  });
});

describe("accountHolderName — who the human is", () => {
  it("ignores the billing contact entirely", () => {
    // Greeting this buyer "Hi Accounts Payable" is the bug this function exists to stop.
    expect(accountHolderName(splitContactCustomer)).toBe("Priya Raghunathan");
  });

  it("falls back company → email, and never the deprecated `name`", () => {
    expect(accountHolderName({ company: "Kavi Analytics", billingFirstName: "Accounts" })).toBe(
      "Kavi Analytics",
    );
    expect(accountHolderName({ name: "Legacy Import Name" } as NameFields)).toBeNull();
    expect(accountHolderName({ email: "a@b.example" })).toBe("a@b.example");
    expect(accountHolderName({})).toBeNull();
  });

  it("disagrees with invoiceContactName on the same row, on purpose", () => {
    expect(accountHolderName(splitContactCustomer)).not.toBe(
      invoiceContactName(splitContactCustomer),
    );
  });
});

describe("billingContact — the address block", () => {
  it("returns the address own contact when it has one", () => {
    expect(billingContact(splitContactCustomer)).toEqual({
      first_name: "Accounts",
      last_name: "Payable",
      company: "Kavi Analytics Pvt Ltd",
    });
  });

  it("falls back to the account holder as a WHOLE, never mixing the two", () => {
    // A row with a billing company but no billing person must not borrow the
    // customer's first/last: "Priya Raghunathan / Kavi Analytics Pvt Ltd" is a
    // contact that exists in neither column.
    expect(
      billingContact({
        firstName: "Priya",
        lastName: "Raghunathan",
        billingCompany: "Kavi Pvt Ltd",
      }),
    ).toEqual({
      first_name: null,
      last_name: null,
      company: "Kavi Pvt Ltd",
    });
  });

  it("gives the customer contact to an address that has none", () => {
    expect(
      billingContact({ firstName: "Priya", lastName: "Raghunathan", company: "Kavi Analytics" }),
    ).toEqual({
      first_name: "Priya",
      last_name: "Raghunathan",
      company: "Kavi Analytics",
    });
  });

  it("is all-null for a row with no names at all", () => {
    expect(billingContact({ email: "a@b.example" })).toEqual({
      first_name: null,
      last_name: null,
      company: null,
    });
  });
});

describe("hasBillingName — the card-setup gate", () => {
  it("passes on a billing contact, an account holder, or a company", () => {
    expect(hasBillingName({ billingFirstName: "Accounts" })).toBe(true);
    expect(hasBillingName({ firstName: "Priya" })).toBe(true);
    expect(hasBillingName({ company: "Kavi Analytics" })).toBe(true);
  });

  it("is NOT satisfied by the deprecated `name` column", () => {
    // This gate is what blocks card setup, so it is the one place where widening the
    // chain is tempting: a legacy-only customer now fails it and is asked for a name.
    // That is the correct outcome — the buyer HAS a form for first/last/company, and
    // none for `name`, so passing them on a value they cannot see or edit would put
    // them back in the dead-end this gate was rewritten to escape.
    expect(hasBillingName({ name: "Legacy Import Name" } as NameFields)).toBe(false);
  });

  it("is NOT satisfied by an email — a gateway needs a name, not an address", () => {
    // Deliberately stricter than invoiceContactName, which may fall through to email
    // for display. Card networks want a billing name; "priya@example.com" is not one.
    expect(hasBillingName({ email: "priya@example.com" })).toBe(false);
    expect(invoiceContactName({ email: "priya@example.com" })).toBe("priya@example.com");
  });

  it("is false for an empty row and for whitespace-only names", () => {
    expect(hasBillingName({})).toBe(false);
    expect(hasBillingName({ firstName: "\t", company: "  " })).toBe(false);
  });
});

/**
 * The SQL mirror of `holderName` (`modules/customers/name-sql.ts`), which the
 * `customer_name` filter on the invoices and subscriptions lists compares against.
 *
 * These assertions exist because the failure they guard is silent and one-directional:
 * the predicate compiled fine when it read `customers.name` alone — it just answered
 * "no such customer" for anyone whose name lives in the structured columns, which is
 * every customer created through the API. A filter that returns an empty page looks
 * exactly like a genuinely empty result, so only the SQL itself can be checked here —
 * `scripts/verify-list-pagination.ts` runs the matching half against real rows.
 */
describe("accountHolderNameSql — the same precedence, in the WHERE clause", () => {
  const compile = (q: SQL) => new PgDialect().sqlToQuery(q);
  const spec = { column: accountHolderNameSql, kind: "text" as const };

  it("reads first+last, then company — in that order, and NOT the legacy name", () => {
    const text = compile(accountHolderNameSql).sql;
    expect(text).toContain("coalesce");
    expect(text).toContain("concat_ws");
    // Precedence is positional in a coalesce, so the column ORDER is the rule.
    const at = (col: string) => text.indexOf(col);
    expect(at('"first_name"')).toBeLessThan(at('"last_name"'));
    expect(at('"last_name"')).toBeLessThan(at('"company"'));
    // The deprecated column is out of the mirror too — if it came back HERE only, the
    // list would render one name and the filter would match another, which is the
    // exact failure this file exists to prevent.
    expect(text).not.toContain('"name"');
  });

  it("leaves the email out — `customer_email` is its own field, and is_present must stay answerable", () => {
    expect(compile(accountHolderNameSql).sql).not.toContain("email");
  });

  it("matches a customer who has ONLY first_name/last_name — the case that was broken", () => {
    const q = compile(filterSql(spec, "contains", "priya")!);
    expect(q.params).toEqual(["%priya%"]);
    expect(q.sql).toContain('"first_name"');
    expect(q.sql).toContain('"last_name"');
    expect(q.sql).toContain("ILIKE");
  });

  it("matches the `first last` concatenation, so a two-word search hits", () => {
    // Neither column contains "priya raghunathan"; only the joined form does.
    const q = compile(filterSql(spec, "contains", "priya raghunathan")!);
    expect(q.params).toEqual(["%priya raghunathan%"]);
    expect(q.sql).toContain("concat_ws");
  });

  it('is_present asks "is there any name at all", not "is the legacy column set"', () => {
    const present = compile(filterSql(spec, "is_present", "true")!).sql;
    const absent = compile(filterSql(spec, "is_present", "false")!).sql;
    for (const text of [present, absent]) {
      for (const col of ['"first_name"', '"last_name"', '"company"']) {
        expect(text).toContain(col);
      }
    }
    expect(present).toContain("IS NOT NULL");
    expect(absent).toContain("IS NULL");
  });
});
