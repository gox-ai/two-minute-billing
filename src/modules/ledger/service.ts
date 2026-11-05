import { sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { uuidv7 } from "@/platform/ids";
import { ledgerEntries } from "@db/schema";
import { createLogger } from "@/platform/logger";

const log = createLogger("ledger");

export type Direction = "debit" | "credit";

export interface LedgerLine {
  account: string;
  direction: Direction;
  amountMinor: bigint;
  currency: string;
  memo?: string;
}

export interface PostEntriesInput {
  organizationId: string;
  businessId: string;
  /** Optional customer this transaction is attributable to (e.g. credits). */
  customerId?: string;
  sourceType: string; // e.g. 'invoice' | 'payment' | 'refund'
  sourceId: string;
  lines: LedgerLine[];
  /** When the money moved, if not now — a backdated offline payment. Stamps `created_at`. */
  occurredAt?: Date;
}

export class LedgerImbalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerImbalanceError";
  }
}

/** A valid double-entry transaction nets to zero per currency, all amounts > 0. */
function assertBalanced(lines: LedgerLine[]): void {
  if (lines.length < 2) {
    throw new LedgerImbalanceError("A ledger transaction needs at least two lines");
  }
  const net = new Map<string, bigint>();
  for (const l of lines) {
    if (l.amountMinor <= 0n) {
      throw new LedgerImbalanceError(`Amount must be positive (${l.account}: ${l.amountMinor})`);
    }
    const currency = l.currency.toUpperCase();
    const signed = l.direction === "debit" ? l.amountMinor : -l.amountMinor;
    net.set(currency, (net.get(currency) ?? 0n) + signed);
  }
  for (const [currency, balance] of net) {
    if (balance !== 0n) {
      throw new LedgerImbalanceError(
        `Unbalanced ${currency}: Σdebits − Σcredits = ${balance} (must be 0)`,
      );
    }
  }
}

/**
 * Post a balanced, append-only double-entry transaction (BLUEPRINT ADR-004).
 * Enforces Σ debits = Σ credits per currency, then inserts all lines under one
 * `transactionId`. Pass `tx` to post inside an existing withTenant transaction
 * (e.g. atomically with an invoice in Phase 2); otherwise opens its own.
 */
export async function postEntries(
  input: PostEntriesInput,
  tx?: Tx,
): Promise<{ transactionId: string }> {
  assertBalanced(input.lines);
  const transactionId = uuidv7();
  const rows = input.lines.map((l) => ({
    organizationId: input.organizationId,
    businessId: input.businessId,
    customerId: input.customerId ?? null,
    transactionId,
    account: l.account,
    direction: l.direction,
    amountMinor: l.amountMinor,
    currency: l.currency.toUpperCase(),
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    memo: l.memo ?? null,
    ...(input.occurredAt ? { createdAt: input.occurredAt } : {}),
  }));

  const insert = (t: Tx) => t.insert(ledgerEntries).values(rows);
  if (tx) await insert(tx);
  else await withTenant(input.organizationId, async (t) => void (await insert(t)));

  // Debug, not info: this fires for every money movement in the system. It exists so
  // a trace can be replayed as the postings it produced — the ledger rows say WHAT
  // was booked, the traceId on this line says which execution booked them.
  log.debug("ledger entries posted", {
    transactionId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    lines: rows.map((r) => ({
      account: r.account,
      direction: r.direction,
      amountMinor: r.amountMinor.toString(),
      currency: r.currency,
    })),
  });

  return { transactionId };
}

/** Derived balance for one account+currency of a business (debits − credits). */
export async function accountBalance(
  organizationId: string,
  businessId: string,
  account: string,
  currency: string,
): Promise<bigint> {
  return withTenant(organizationId, async (tx) => {
    const res = await tx.execute(sql`
      select coalesce(sum(
        case when direction = 'debit' then amount_minor else -amount_minor end
      ), 0)::bigint as bal
      from ledger_entries
      where business_id = ${businessId}
        and account = ${account}
        and currency = ${currency.toUpperCase()}
    `);
    const row = (res as unknown as Array<{ bal: string | number }>)[0];
    return BigInt(row?.bal ?? 0);
  });
}
