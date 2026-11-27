/**
 * Undo a file import: delete what the run created (its `import_records.run_id` rows), and
 * nothing else. Refused once billing touched any of it — an invoice, a payment, usage, a
 * change after the import — because a customer delete cascades to invoices and payments:
 * the checks below are the guard, not the foreign keys.
 */
import { sql, type SQL } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { postEntries, type LedgerLine } from "@/modules/ledger/service";
import type { RunRow } from "./runs";

export interface UndoReason {
  code: string;
  message: string;
  count: number;
}

export interface RunTargets {
  customers: string[];
  subscriptions: string[];
  prices: string[];
  products: string[];
  coupons: string[];
  paymentMethods: string[];
  appliedCoupons: string[];
  contacts: string[];
  invoices: string[];
  creditNotes: string[];
  payments: string[];
  refunds: string[];
  gatewayTransactions: string[];
  usageRecords: string[];
}

const TYPE_KEY: Record<string, keyof RunTargets> = {
  customer: "customers",
  subscription: "subscriptions",
  price: "prices",
  product: "products",
  coupon: "coupons",
  payment_method: "paymentMethods",
  applied_coupon: "appliedCoupons",
  contact: "contacts",
  invoice: "invoices",
  credit_note: "creditNotes",
  payment: "payments",
  refund: "refunds",
  gateway_transaction: "gatewayTransactions",
  usage_record: "usageRecords",
};

/** A change this long after the run ended is an operator's (or the clock's), not the import's. */
const SETTLE_MS = 60_000;

const ids = (list: string[]) => sql`${`{${list.join(",")}}`}::uuid[]`;

export async function runTargets(tx: Tx, runId: string): Promise<RunTargets> {
  const rows = (await tx.execute(
    sql`select target_type, target_id::text as target_id from import_records where run_id = ${runId}::uuid`,
  )) as unknown as Array<{ target_type: string; target_id: string }>;
  const out: RunTargets = {
    customers: [],
    subscriptions: [],
    prices: [],
    products: [],
    coupons: [],
    paymentMethods: [],
    appliedCoupons: [],
    contacts: [],
    invoices: [],
    creditNotes: [],
    payments: [],
    refunds: [],
    gatewayTransactions: [],
    usageRecords: [],
  };
  for (const r of rows) {
    const k = TYPE_KEY[r.target_type];
    if (k) out[k].push(r.target_id);
  }
  return out;
}

async function count(tx: Tx, q: SQL): Promise<number> {
  const [r] = (await tx.execute(sql`select count(*)::int as n from (${q}) x`)) as unknown as Array<{
    n: number;
  }>;
  return r?.n ?? 0;
}

export async function undoBlockers(tx: Tx, run: RunRow): Promise<UndoReason[]> {
  const t = await runTargets(tx, run.id);
  const C = ids(t.customers);
  const S = ids(t.subscriptions);
  const P = ids(t.prices);
  const K = ids(t.coupons);
  const M = ids(t.paymentMethods);
  // The run's own history is not activity: each check leaves it out.
  const I = ids(t.invoices);
  const N = ids(t.creditNotes);
  const Y = ids(t.payments);
  const X = ids(t.gatewayTransactions);
  const U = ids(t.usageRecords);
  const since = new Date((run.finishedAt ?? new Date()).getTime() + SETTLE_MS).toISOString();
  const checks: Array<[string, string, SQL]> = [
    [
      "invoices",
      "invoices",
      sql`select 1 from invoices where (customer_id = any(${C}) or subscription_id = any(${S})) and id <> all(${I})`,
    ],
    [
      "payments",
      "payments",
      sql`select 1 from payments where (customer_id = any(${C}) or payment_method_id = any(${M}) or invoice_id = any(${I}))
            and id <> all(${Y})`,
    ],
    [
      "transactions",
      "gateway transactions",
      sql`select 1 from transactions where (customer_id = any(${C}) or invoice_id = any(${I})) and id <> all(${X})`,
    ],
    [
      "payment_intents",
      "payment attempts",
      sql`select 1 from payment_intents where customer_id = any(${C}) or invoice_id = any(${I})`,
    ],
    [
      "credit_notes",
      "credit notes",
      sql`select 1 from credit_notes where (customer_id = any(${C}) or invoice_id = any(${I})) and id <> all(${N})`,
    ],
    [
      "refunds",
      "refunds of its payments",
      sql`select 1 from refunds where payment_id = any(${Y}) and id <> all(${ids(t.refunds)})`,
    ],
    [
      "allocations",
      "credits applied to its invoices",
      sql`select 1 from credit_note_allocations where invoice_id = any(${I}) and credit_note_id <> all(${N})`,
    ],
    [
      "ledger",
      "ledger entries",
      sql`select 1 from ledger_entries where customer_id = any(${C})
            and not (source_type = 'import' and source_id in (
              select public_id from invoices where id = any(${I})
              union all select public_id from credit_notes where id = any(${N})))`,
    ],
    [
      "usage",
      "usage records",
      sql`select 1 from usage_records where subscription_id = any(${S}) and id <> all(${U})`,
    ],
    [
      "billed_usage",
      "invoices raised after the import for subscriptions with its usage",
      sql`select 1 from invoices where id <> all(${I}) and created_at > ${(run.finishedAt ?? new Date()).toISOString()}::timestamptz
            and subscription_id in (select subscription_id from usage_records where id = any(${U}))`,
    ],
    [
      "changed_invoices",
      "invoices changed after the import",
      sql`select 1 from invoices where id = any(${I}) and updated_at > ${since}::timestamptz`,
    ],
    [
      "changed_credit_notes",
      "credit notes voided or paid out after the import",
      sql`select 1 from credit_notes where id = any(${N})
            and (voided_at > ${since}::timestamptz or payout_attempt_at > ${since}::timestamptz)`,
    ],
    [
      "credit_note_refunds",
      "refunds of its credit notes",
      sql`select 1 from transactions where credit_note_id = any(${N}) and id <> all(${X})`,
    ],
    [
      "charges",
      "unbilled charges",
      sql`select 1 from unbilled_charges where subscription_id = any(${S})`,
    ],
    [
      "scheduled_changes",
      "scheduled changes",
      sql`select 1 from scheduled_changes where subscription_id = any(${S})`,
    ],
    [
      "pending_changes",
      "pending plan changes",
      sql`select 1 from subscription_pending_changes where subscription_id = any(${S})`,
    ],
    [
      "other_subscriptions",
      "subscriptions created after the import that use its customers or prices",
      sql`select 1 from subscriptions s where s.id <> all(${S}) and (s.customer_id = any(${C})
            or exists (select 1 from subscription_items i where i.subscription_id = s.id and i.price_id = any(${P})))`,
    ],
    [
      "later_prices",
      "prices added later to the plans and add-ons it created",
      sql`select 1 from prices where product_id = any(${ids(t.products)}) and id <> all(${P})`,
    ],
    [
      "invoice_lines",
      "invoice lines that bill its prices",
      sql`select 1 from invoice_line_items where price_id = any(${P}) and invoice_id <> all(${I})`,
    ],
    [
      "coupon_use",
      "uses of its coupons outside the import",
      sql`select 1 from applied_coupons where coupon_id = any(${K}) and (subscription_id is null or subscription_id <> all(${S}))`,
    ],
    [
      "payment_methods",
      "payment methods added after the import",
      sql`select 1 from payment_methods where customer_id = any(${C}) and id <> all(${M})`,
    ],
    [
      "changed_subscriptions",
      "subscriptions changed after the import",
      sql`select 1 from subscriptions where id = any(${S}) and updated_at > ${since}::timestamptz`,
    ],
    [
      "changed_customers",
      "customers changed after the import",
      sql`select 1 from customers where id = any(${C}) and updated_at > ${since}::timestamptz`,
    ],
  ];
  const out: UndoReason[] = [];
  for (const [code, label, q] of checks) {
    const n = await count(tx, q);
    if (n) out.push({ code, count: n, message: `${n} ${label}` });
  }
  return out;
}

/**
 * Delete the run's records, children first. Runs in one transaction: a row a check missed
 * that a foreign key still protects fails the whole undo and nothing is deleted.
 */
export async function performUndo(org: string, run: RunRow): Promise<Record<string, number>> {
  return withTenant(org, async (tx) => {
    const reasons = await undoBlockers(tx, run);
    if (reasons.length)
      throw new UndoRefusedError(
        `Records this import created are in use: ${reasons.map((r) => r.message).join(", ")}.`,
      );
    const t = await runTargets(tx, run.id);
    const deleted: Record<string, number> = {};
    const del = async (label: string, q: SQL) => {
      const res = (await tx.execute(q)) as unknown as { count?: number };
      deleted[label] = (deleted[label] ?? 0) + (res.count ?? 0);
    };
    const C = ids(t.customers);
    const S = ids(t.subscriptions);
    const I = ids(t.invoices);
    const N = ids(t.creditNotes);

    // The ledger is append-only: the opening balances the history posted (open invoices,
    // refundable credit) are reversed, not deleted. Their documents are deleted below.
    const opening = (await tx.execute(sql`
      select source_id, customer_id::text as customer_id, account, direction,
             amount_minor::text as amount_minor, currency
        from ledger_entries
       where business_id = ${run.businessId}::uuid and source_type = 'import'
         and source_id in (select public_id from invoices where id = any(${I})
                           union all select public_id from credit_notes where id = any(${N}))
       order by source_id`)) as unknown as Array<{
      source_id: string;
      customer_id: string | null;
      account: string;
      direction: "debit" | "credit";
      amount_minor: string;
      currency: string;
    }>;
    const bySource = new Map<string, typeof opening>();
    for (const e of opening) bySource.set(e.source_id, [...(bySource.get(e.source_id) ?? []), e]);
    for (const [sourceId, lines] of bySource)
      await postEntries(
        {
          organizationId: run.organizationId,
          businessId: run.businessId,
          customerId: lines[0]!.customer_id ?? undefined,
          sourceType: "import_undo",
          sourceId,
          lines: lines.map((l) => ({
            account: l.account as LedgerLine["account"],
            direction: l.direction === "debit" ? "credit" : "debit",
            amountMinor: BigInt(l.amount_minor),
            currency: l.currency,
            memo: "Reversed: the import was undone",
          })),
        },
        tx,
      );
    deleted.ledger_reversals = bySource.size;

    await del(
      "usage_records",
      sql`delete from usage_records where id = any(${ids(t.usageRecords)})`,
    );
    await del(
      "gateway_transactions",
      sql`delete from transactions where id = any(${ids(t.gatewayTransactions)})`,
    );
    await del("refunds", sql`delete from refunds where id = any(${ids(t.refunds)})`);
    await del("payments", sql`delete from payments where id = any(${ids(t.payments)})`);
    await del("credit_notes", sql`delete from credit_notes where id = any(${N})`);
    await del("invoices", sql`delete from invoices where id = any(${I})`);
    await del(
      "applied_coupons",
      sql`delete from applied_coupons where subscription_id = any(${S}) or id = any(${ids(t.appliedCoupons)})`,
    );
    // mrr_movements is append-only to the app role; its rows go with their subscription and
    // customer (ON DELETE CASCADE), as in a test-business reset.
    await del("subscriptions", sql`delete from subscriptions where id = any(${S})`);
    await del(
      "payment_methods",
      sql`delete from payment_methods where id = any(${ids(t.paymentMethods)})`,
    );
    await del("customers", sql`delete from customers where id = any(${C})`);
    await del("coupons", sql`delete from coupons where id = any(${ids(t.coupons)})`);
    await del("prices", sql`delete from prices where id = any(${ids(t.prices)})`);
    await del("products", sql`delete from products where id = any(${ids(t.products)})`);
    await tx.execute(sql`delete from import_records where run_id = ${run.id}::uuid`);
    return deleted;
  });
}

export class UndoRefusedError extends Error {}
