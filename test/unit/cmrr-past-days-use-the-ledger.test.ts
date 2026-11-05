import { describe, expect, it } from "vitest";
import {
  committedMrrOf,
  ledgerBalancesAt,
  ledgerBookedAt,
  type LedgerRow,
} from "@/modules/metrics/snapshots";

const t = (s: string) => new Date(`${s}T12:00:00.000Z`);
const row = (subscriptionId: string, at: string, deltaMinor: bigint): LedgerRow => ({
  subscriptionId,
  occurredAt: t(at),
  deltaMinor,
});

// What the engine books: a trial is booked and reversed at trial start, earns from conversion.
// `trial` converts at 8083 and expands to 12166 later; `lapsed` earns, churns, comes back.
const ledger: LedgerRow[] = [
  row("lapsed", "2025-02-25", 6200n),
  row("lapsed", "2025-09-11", -6200n),
  row("trial", "2026-08-13", 8083n),
  row("trial", "2026-08-13", -8083n),
  row("trial", "2026-08-27", 8083n),
  row("lapsed", "2026-06-29", 6200n),
  row("trial", "2026-09-28", 4083n),
  // Imported trial (no ledger), cancelled without a movement, reactivated: first row is late.
  row("reactivated", "2026-10-28", 9700n),
].sort((a, b) => +a.occurredAt - +b.occurredAt);

const cmrrOn = (id: string, day: string, rateToday: bigint, started = true) => {
  const at = t(day);
  const balances = ledgerBalancesAt(ledger, at);
  const earned = new Map([...balances].filter(([, v]) => v !== 0n));
  return committedMrrOf(id, earned, ledgerBookedAt(ledger, at), rateToday, started);
};

describe("CMRR on a past day reads the ledger, not today's rate", () => {
  it("a trial day is 0, and a later expansion does not reach back into it", () => {
    expect(cmrrOn("trial", "2026-08-14", 12166n)).toBe(0n);
    expect(cmrrOn("trial", "2026-08-14", 8083n)).toBe(0n);
  });

  it("a converted day carries the rate booked then", () => {
    expect(cmrrOn("trial", "2026-09-01", 12166n)).toBe(8083n);
    expect(cmrrOn("trial", "2026-09-28", 12166n)).toBe(12166n);
  });

  it("a lapse between churn and reactivation is 0, whatever the row says today", () => {
    expect(cmrrOn("lapsed", "2026-01-15", 6200n)).toBe(0n);
    expect(cmrrOn("lapsed", "2026-07-01", 6200n)).toBe(6200n);
  });

  it("a subscription the ledger has not booked yet is committed at its rate", () => {
    expect(cmrrOn("future", "2026-08-14", 9900n, false)).toBe(9900n);
    expect(cmrrOn("trial", "2026-08-12", 8083n, false)).toBe(8083n);
  });

  it("a STARTED subscription the ledger has not booked yet earned nothing — no rate fills the gap", () => {
    expect(cmrrOn("reactivated", "2026-09-15", 9700n)).toBe(0n);
    expect(cmrrOn("reactivated", "2026-10-20", 9700n)).toBe(0n);
    expect(cmrrOn("reactivated", "2026-10-29", 9700n)).toBe(9700n);
  });
});
