import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq } from "drizzle-orm";
import { paymentInFlightCondition } from "@/modules/invoicing/service";
import { payments } from "@db/schema/payments";

/**
 * `paymentInFlightCondition` is the ONE definition of "a live attempt already owns this
 * invoice" — extracted so `pendingPaymentForInvoice` and `pendingPaymentsForInvoices`
 * cannot drift from each other (they were already identical; this pins that fact so a
 * future edit to one is forced through the shared spot). The invariant checks restate the
 * same predicate as raw SQL and are not this file's concern.
 *
 * The predicate is `payments.status = 'pending'` and NOTHING else — no `transactions`
 * join, no other status. A `requires_action` payment is not a booked attempt (it hasn't
 * reached `bookPending` yet) and `succeeded`/`failed` are terminal, so neither counts.
 */
const compile = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(q);

describe("paymentInFlightCondition — the payments.status predicate", () => {
  it("compiles to payments.status = 'pending', nothing more", () => {
    const { sql, params } = compile(paymentInFlightCondition());
    expect(sql).toContain('"status"');
    expect(params).toEqual(["pending"]);
  });

  it("does not reach into transactions — only payments.status decides in-flight", () => {
    const { sql } = compile(paymentInFlightCondition());
    expect(sql).not.toMatch(/transactions/i);
  });

  it("ONLY 'pending' counts — succeeded, failed and requires_action are not this predicate", () => {
    // The predicate is an equality, not a set membership check, so no other status
    // string appears in the compiled query at all.
    const { sql, params } = compile(paymentInFlightCondition());
    expect(params).not.toContain("succeeded");
    expect(params).not.toContain("failed");
    expect(params).not.toContain("requires_action");
    expect(sql.match(/\$\d/g)?.length).toBe(1);
  });

  it("combines with an invoice filter exactly as pendingPaymentForInvoice does", () => {
    const invoiceId = "11111111-1111-1111-1111-111111111111";
    const { sql, params } = compile(
      and(eq(payments.invoiceId, invoiceId), paymentInFlightCondition())!,
    );
    expect(sql).toMatch(/and/i);
    expect(sql).toContain('"invoice_id"');
    expect(sql).toContain('"status"');
    expect(params).toEqual([invoiceId, "pending"]);
  });
});
