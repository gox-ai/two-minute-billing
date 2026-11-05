/**
 * What `verify:gateway-conformance` has not proven for a gateway yet, and the availability flag
 * built on it: a gateway with open gaps is not offered, and a method listed in
 * `live-proof-pending.json` is not offered. The files are written by hand, and the suite fails
 * when they disagree with what it measures or with the catalog (`scripts/conformance/README.md`).
 */
import knownGaps from "./known-gaps.json";
import exclusions from "./exclusions.json";
import livePending from "./live-proof-pending.json";
import { gatewayDefinition } from "../gateway-catalog";

export interface ConformanceGap {
  /** A suite row (`S7.locate-found`), or `fixtures` when the gateway has no fixture module. */
  row: string;
  reason: string;
  /** The plan item that closes it (`3f Square`, `3f new`). */
  planRef: string;
}

export interface KnownGapEntry {
  reason: string;
  planRef: string;
}

export interface Exclusion {
  /** `test-gateway`: never offered for money. `pending`: fixtures not written yet. */
  kind: "test-gateway" | "pending";
  reason: string;
  planRef?: string;
}

type GapFile = Record<string, Record<string, KnownGapEntry> | string>;
type ExclusionFile = Record<string, Exclusion | string>;

/** The parsed files, without their `$comment` keys. */
export function knownGapsByGateway(
  file: GapFile = knownGaps as GapFile,
): Record<string, Record<string, KnownGapEntry>> {
  return Object.fromEntries(
    Object.entries(file).filter(
      (e): e is [string, Record<string, KnownGapEntry>] =>
        !e[0].startsWith("$") && typeof e[1] === "object",
    ),
  );
}

export function conformanceExclusions(
  file: ExclusionFile = exclusions as ExclusionFile,
): Record<string, Exclusion> {
  return Object.fromEntries(
    Object.entries(file).filter(
      (e): e is [string, Exclusion] => !e[0].startsWith("$") && typeof e[1] === "object",
    ),
  );
}

/**
 * The open gaps of one gateway. Empty only when its fixture module passes every row. A gateway
 * with no fixture module has one gap, `fixtures`; the test gateway has none.
 */
export function conformanceGaps(
  gatewayKey: string,
  gaps: Record<string, Record<string, KnownGapEntry>> = knownGapsByGateway(),
  excluded: Record<string, Exclusion> = conformanceExclusions(),
): ConformanceGap[] {
  const rows = gaps[gatewayKey];
  if (rows)
    return Object.entries(rows)
      .map(([row, g]) => ({ row, reason: g.reason, planRef: g.planRef }))
      .sort((a, b) => a.row.localeCompare(b.row));
  const ex = excluded[gatewayKey];
  if (ex?.kind === "test-gateway") return [];
  return [
    {
      row: "fixtures",
      reason: ex?.reason ?? "No conformance fixtures for this gateway.",
      planRef: ex?.planRef ?? "3e",
    },
  ];
}

// ── Availability flag ───────────────────────────────────────────────────────

export interface LiveProofPendingEntry {
  reason: string;
  planRef: string;
}

/** gateway → method → why it is not proven live yet. */
export type PendingMethods = Record<string, Record<string, LiveProofPendingEntry>>;

type PendingFile = Record<string, Record<string, LiveProofPendingEntry> | string>;

/** The parsed `live-proof-pending.json`, without its `$comment` key. */
export function liveProofPending(file: PendingFile = livePending as PendingFile): PendingMethods {
  return Object.fromEntries(
    Object.entries(file).filter(
      (e): e is [string, Record<string, LiveProofPendingEntry>] =>
        !e[0].startsWith("$") && typeof e[1] === "object",
    ),
  );
}

/** Where the flag reads from. Tests pass fakes; production reads the checked-in files. */
export interface AvailabilitySources {
  gaps?: Record<string, Record<string, KnownGapEntry>>;
  exclusions?: Record<string, Exclusion>;
  pending?: PendingMethods;
}

/** Operator-facing reasons (STE). The internal reasons in the files are not shown. */
export const GATEWAY_NOT_AVAILABLE_REASON = "Our tests for this gateway are not complete.";
export const METHOD_NOT_AVAILABLE_REASON = "Our tests for this payment method are not complete.";

/**
 * Whether operators may connect new accounts of this gateway. Only new accounts: an existing
 * account keeps charging, refunding and taking webhooks, because money already moves on it.
 */
export function gatewayOffered(gatewayKey: string, src: AvailabilitySources = {}): boolean {
  if (
    conformanceGaps(
      gatewayKey,
      src.gaps ?? knownGapsByGateway(),
      src.exclusions ?? conformanceExclusions(),
    ).length
  )
    return false;
  // A gateway whose every method still waits on its live proof has nothing to offer.
  const methods = gatewayDefinition(gatewayKey)?.advertisedMethods ?? [];
  const pending = src.pending ?? liveProofPending();
  return !(methods.length > 0 && methods.every((m) => !methodOffered(gatewayKey, m, pending)));
}

/**
 * Whether buyers may be offered this method on this gateway, and new instruments of it set up.
 * A method already saved keeps charging; nothing on the charge path reads this.
 */
export function methodOffered(
  gatewayKey: string,
  method: string,
  pending: PendingMethods = liveProofPending(),
): boolean {
  return !pending[gatewayKey]?.[method];
}
