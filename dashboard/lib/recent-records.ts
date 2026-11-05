/**
 * Records this browser opened, for the ⌘K palette's Recent group. A per-viewer
 * convenience: localStorage only, keyed by business, and every access is guarded
 * because storage can be missing or throw (private window, blocked site data).
 *
 * Holds identity and labels only — never status or amounts, which would go stale.
 */
export type RecentKind = "customer" | "subscription" | "invoice";

export interface RecentRecord {
  kind: RecentKind;
  id: string;
  label: string;
  detail: string;
  /** Epoch ms of the visit. */
  at: number;
}

const CAP = 8;
const key = (biz: string) => `tmb:recent:${biz}`;
export const RECENT_EVENT = "tmb:recent-changed";

export function readRecent(biz: string): RecentRecord[] {
  try {
    const raw = window.localStorage.getItem(key(biz));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list)
      ? list.filter((r): r is RecentRecord => !!r && typeof r.id === "string").slice(0, CAP)
      : [];
  } catch {
    return [];
  }
}

export function recordVisit(biz: string, rec: Omit<RecentRecord, "at">): void {
  try {
    const next = [
      { ...rec, at: Date.now() },
      ...readRecent(biz).filter((r) => r.id !== rec.id),
    ].slice(0, CAP);
    window.localStorage.setItem(key(biz), JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(RECENT_EVENT));
  } catch {
    // Storage unavailable — Recent simply stays empty.
  }
}

export function clearRecent(biz: string): void {
  try {
    window.localStorage.removeItem(key(biz));
    window.dispatchEvent(new CustomEvent(RECENT_EVENT));
  } catch {
    // ignore
  }
}
