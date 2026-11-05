/**
 * A paid credit grant given by hand (design G3 §3.2, C4): raises a manual invoice with one
 * pack line, creates the `pending` grant against it, and with `markPaid` records the offline
 * payment so activation runs in the same transaction. Paid credit never exists without an
 * invoice (CHECK `credit_grants_paid_invoice_ck`).
 *
 * The route (`credits-routes.ts`) checks `credits:manage` AND `invoices:manage` before this.
 */
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/platform/db";
import { stampNow } from "@/platform/clock";
import { postEntries } from "@/modules/ledger/service";
import {
  CREDIT_LEDGER_ACCOUNTS,
  creditGrants,
  type CreditApplicability,
  type CreditOnExhausted,
  type CreditTaxTreatment,
} from "@db/schema";
import { createManualInvoice, recordOfflinePaymentInTx } from "@/modules/invoicing/ops";
import {
  creditUnitByKey,
  CreditNotFoundError,
  CreditRuleError,
  customerByPublicId,
  insertCreditGrant,
  type CreditGrant,
} from "./service";
import { activatePaidCreditGrants } from "./packs";
import { formatSteps } from "./units";

export interface ManualPaidGrantInput {
  organizationId: string;
  businessId: string;
  customerPublicId: string;
  /** Null = money. */
  unitKey: string | null;
  currency?: string;
  /** In the unit's smallest step. */
  amount: bigint;
  /** Net price, excl. tax: the cost basis. */
  priceMinor: bigint;
  taxTreatment: CreditTaxTreatment;
  priority?: number;
  expiresAt?: Date | null;
  applicability?: CreditApplicability;
  onExhausted?: CreditOnExhausted | null;
  metadata?: Record<string, unknown> | null;
  markPaid?: { method: string; reference?: string; paidAt?: Date };
  createdByUserId?: string | null;
}

export async function createManualPaidGrant(
  input: ManualPaidGrantInput,
): Promise<{ grant: CreditGrant; invoicePublicId: string }> {
  if (input.priceMinor <= 0n)
    throw new CreditRuleError(
      "We could not create the credit grant. price_minor must be more than 0.",
    );
  if (input.taxTreatment === "taxed_at_use" && input.unitKey)
    throw new CreditRuleError(
      "We could not create the credit grant. Credit in a custom unit is taxed at purchase.",
    );
  if (
    input.markPaid?.paidAt &&
    input.markPaid.paidAt.getTime() > stampNow(input.businessId).getTime()
  )
    throw new CreditRuleError(
      "We could not create the credit grant. The payment date is in the future.",
    );

  const { customer, unit } = await withTenant(input.organizationId, async (tx) => {
    const customer = await customerByPublicId(tx, input.businessId, input.customerPublicId);
    const unit = input.unitKey ? await creditUnitByKey(tx, input.businessId, input.unitKey) : null;
    if (input.unitKey && !unit)
      throw new CreditNotFoundError(`No such credit unit: ${input.unitKey}`);
    return { customer, unit };
  });
  const currency = (unit?.currency ?? input.currency ?? customer.currency ?? "").toUpperCase();
  if (!currency)
    throw new CreditRuleError("We could not create the credit grant. Send a currency.");
  if (unit && input.currency && input.currency.toUpperCase() !== unit.currency)
    throw new CreditRuleError(
      `We could not create the credit grant. The credit unit ${unit.key} is priced in ${unit.currency}.`,
    );
  const what = unit
    ? `${formatSteps(input.amount, unit.decimals)} ${input.amount === 10n ** BigInt(unit.decimals) ? unit.name : unit.pluralName}`
    : `${currency} credit`;

  let grant: CreditGrant | null = null;
  const { invoice } = await createManualInvoice({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: customer.id,
    currency,
    applyTax: true,
    collect: false,
    lines: [
      {
        description: `Credit: ${what}`,
        amountMinor: input.priceMinor,
        quantity: 1,
        kind: "one_time",
        creditPack: input.taxTreatment,
      },
    ],
    inTx: async (tx, created) => {
      const line = created.lines[0]!;
      grant = await insertCreditGrant(tx, {
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: customer.id,
        currency,
        unit,
        amount: input.amount,
        costBasisMinor: input.priceMinor,
        category: "paid",
        priority: input.priority,
        effectiveAt: created.invoice.createdAt,
        expiresAt: input.expiresAt ?? null,
        applicability: input.applicability,
        source: "manual",
        sourceRef: line.id,
        invoiceId: created.invoice.id,
        taxTreatment: input.taxTreatment,
        onExhausted: input.onExhausted ?? null,
        status: "pending",
        metadata: input.metadata ?? null,
        createdByUserId: input.createdByUserId ?? null,
      });
      // The sale moves into pending credit until the invoice is paid (as a pack does).
      await postEntries(
        {
          organizationId: input.organizationId,
          businessId: input.businessId,
          customerId: customer.id,
          sourceType: "invoice",
          sourceId: created.invoice.publicId,
          lines: [
            { account: "revenue", direction: "debit", amountMinor: input.priceMinor, currency },
            {
              account: CREDIT_LEDGER_ACCOUNTS.pending,
              direction: "credit",
              amountMinor: input.priceMinor,
              currency,
            },
          ],
        },
        tx,
      );
      if (input.markPaid && created.invoice.status !== "paid") {
        const paidAt = input.markPaid.paidAt;
        await recordOfflinePaymentInTx(
          tx,
          {
            organizationId: input.organizationId,
            businessId: input.businessId,
            invoicePublicId: created.invoice.publicId,
            method: input.markPaid.method,
            reference: input.markPaid.reference,
            // A payment cannot predate its invoice; an earlier date books at the invoice's.
            occurredAt:
              paidAt && paidAt.getTime() >= created.invoice.createdAt.getTime()
                ? paidAt
                : undefined,
          },
          created.invoice,
        );
      }
      // Paid already (by the customer's money balances, or just now): active in this response.
      await activatePaidCreditGrants(tx, {
        organizationId: input.organizationId,
        invoiceId: created.invoice.id,
      });
    },
  });
  const g = grant as CreditGrant | null;
  if (!g) throw new Error("manual paid grant: the invoice transaction created no grant");
  const fresh = await withTenant(input.organizationId, async (tx) => {
    const [row] = await tx
      .select()
      .from(creditGrants)
      .where(and(eq(creditGrants.id, g.id), eq(creditGrants.businessId, input.businessId)))
      .limit(1);
    return row!;
  });
  return { grant: fresh, invoicePublicId: invoice.publicId };
}
