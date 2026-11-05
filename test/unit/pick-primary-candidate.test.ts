import { describe, it, expect } from "vitest";
import {
  MAX_INSTRUMENTS_PER_RUN,
  orderBackups,
  pickPrimaryCandidate,
} from "@/modules/invoicing/collection";

/**
 * Which instruments collection charges, and in what order. Rows arrive newest-first,
 * as `resolveChargeCandidates` orders them.
 */
const pm = (id: string, role: string | null, status: string | null, fp: string | null = null) => ({
  id,
  role,
  status,
  instrumentFingerprint: fp,
});

describe("pickPrimaryCandidate", () => {
  it("a DESIGNATED primary wins even when we have written it off", () => {
    // Somebody named it on purpose, and charging it is the only route back for a card
    // wrongly invalidated. The backups are what stop this costing the collection.
    const rows = [pm("new", "backup", "valid"), pm("chosen", "primary", "invalid")];
    expect(pickPrimaryCandidate(rows)?.id).toBe("chosen");
  });

  it("with no primary, a USABLE backup beats a newer dead one", () => {
    const rows = [pm("newest", "backup", "invalid"), pm("older", "backup", "valid")];
    expect(pickPrimaryCandidate(rows)?.id).toBe("older");
  });

  it("with no primary and nothing usable, the newest backup still gets an attempt", () => {
    const rows = [pm("newest", "backup", "invalid"), pm("older", "backup", "expired")];
    expect(pickPrimaryCandidate(rows)?.id).toBe("newest");
  });

  it("a card REMOVED from collection is never picked", () => {
    const rows = [pm("removed", "none", "valid"), pm("kept", "backup", "invalid")];
    expect(pickPrimaryCandidate(rows)?.id).toBe("kept");
    expect(pickPrimaryCandidate([pm("removed", "none", "valid")])).toBeNull();
  });

  it("no cards at all is null, not a throw", () => {
    expect(pickPrimaryCandidate([])).toBeNull();
  });
});

describe("orderBackups", () => {
  const P = pm("primary", "primary", "valid", "fp_p");

  it("every backup is tried, valid before expiring, newest first", () => {
    const rows = [pm("exp", "backup", "expiring"), pm("b1", "backup", "valid"), P];
    expect(orderBackups(P, rows).map((r) => r.id)).toEqual(["b1", "exp"]);
  });

  it("skips removed, written-off and expired cards", () => {
    const rows = [
      pm("removed", "none", "valid"),
      pm("dead", "backup", "invalid"),
      pm("expired", "backup", "expired"),
      pm("ok", "backup", "valid"),
      P,
    ];
    expect(orderBackups(P, rows).map((r) => r.id)).toEqual(["ok"]);
  });

  it("never re-presents the same physical card — not the primary's, not another backup's", () => {
    const rows = [
      pm("dup-of-primary", "backup", "valid", "fp_p"),
      pm("a", "backup", "valid", "fp_a"),
      pm("dup-of-a", "backup", "valid", "fp_a"),
      P,
    ];
    expect(orderBackups(P, rows).map((r) => r.id)).toEqual(["a"]);
  });

  it(`caps the run at ${MAX_INSTRUMENTS_PER_RUN} instruments including the primary`, () => {
    const rows = [
      pm("b1", "backup", "valid"),
      pm("b2", "backup", "valid"),
      pm("b3", "backup", "valid"),
      P,
    ];
    expect(orderBackups(P, rows)).toHaveLength(MAX_INSTRUMENTS_PER_RUN - 1);
  });

  it("excludes the primary itself", () => {
    const self = pm("x", "backup", "valid");
    expect(orderBackups(self, [self])).toEqual([]);
  });
});
