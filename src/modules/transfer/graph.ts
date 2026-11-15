/**
 * The pure half of an async transfer plan: item order, dependency effects, exclusions, counts
 * and the run's end state. No database access, so the rules are unit-tested directly.
 */

export type ItemAction = "create" | "update" | "unchanged" | "skip" | "blocked" | "delete";
export type ItemStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type RunStatus =
  | "planned"
  | "queued"
  | "running"
  | "succeeded"
  | "partially_failed"
  | "failed"
  | "cancelled"
  | "superseded";
export type Pair = "main" | "twin";
export type ItemKind =
  | "clear"
  | "meter"
  | "credit_unit"
  | "tax_default_rename"
  | "tax_profile"
  | "product_group"
  | "product"
  | "price"
  | "attached_item"
  | "differential_price"
  | "coupon"
  | "coupon_constraint"
  | "field";

/**
 * Apply order. A row comes after everything it references: prices reference meters and credit
 * units, products reference tax profiles and groups, coupon constraints reference coupons.
 */
export const KIND_ORDER: ItemKind[] = [
  "clear",
  "meter",
  "credit_unit",
  "tax_default_rename",
  "tax_profile",
  "product_group",
  "product",
  "price",
  "attached_item",
  "differential_price",
  "coupon",
  "coupon_constraint",
  "field",
];
/** Field sections apply in this order, after every object. */
export const FIELD_SECTION_ORDER = ["settings", "company_profile", "numbering", "email_sending"];

export const ACTIVE_RUN: RunStatus[] = ["queued", "running"];
export const TERMINAL_RUN: RunStatus[] = [
  "succeeded",
  "partially_failed",
  "failed",
  "cancelled",
  "superseded",
];

export type Policy = "skip" | "update";
export type ConflictPolicy = Partial<Record<string, Policy>>;

/** A test destination takes updates by default; a live one keeps what it has. */
export function defaultPolicy(destLive: boolean, sections: string[]): ConflictPolicy {
  return Object.fromEntries(sections.map((s) => [s, destLive ? "skip" : "update"]));
}

export interface ItemMessage {
  level: "error" | "warning";
  message: string;
}

/** The fields the graph rules need. A stored item and a freshly planned one both fit. */
export interface GraphItem {
  pair: Pair;
  section: string;
  kind: ItemKind;
  key: string;
  label: string;
  action: ItemAction;
  excluded: boolean;
  dependsOn: string[];
  messages: ItemMessage[];
}

export const pairKey = (i: { pair: Pair; key: string }) => `${i.pair}:${i.key}`;

/** Twin pair first, then by kind, field section, and key. */
export function sortItems<T extends Pick<GraphItem, "pair" | "kind" | "section" | "key">>(
  items: T[],
): T[] {
  const rank = (i: T) =>
    (i.pair === "twin" ? 0 : 1) * 10_000 +
    KIND_ORDER.indexOf(i.kind) * 100 +
    (i.kind === "field" ? Math.max(0, FIELD_SECTION_ORDER.indexOf(i.section)) : 0);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/** An item that writes when applied. */
export const writes = (i: Pick<GraphItem, "action" | "excluded">) =>
  !i.excluded && (i.action === "create" || i.action === "update" || i.action === "delete");

export interface Effective {
  /** blocked by itself or by a dependency */
  blocked: boolean;
  messages: ItemMessage[];
}

/**
 * Each item's blocking state after exclusions. A dependency that is blocked blocks its
 * dependants; one that is left out blocks them only when the destination lacks it (`create`).
 * Items must be in apply order (dependencies first).
 */
export function effectiveState(items: GraphItem[]): Map<string, Effective> {
  const out = new Map<string, Effective>();
  const byKey = new Map(items.map((i) => [pairKey(i), i]));
  for (const i of items) {
    const messages = [...i.messages];
    let blocked = i.action === "blocked";
    for (const dep of i.dependsOn) {
      const d = byKey.get(`${i.pair}:${dep}`);
      if (!d) continue;
      const ds = out.get(pairKey(d));
      if (ds?.blocked && !d.excluded) {
        blocked = true;
        messages.push({ level: "error", message: `It needs ${d.label}, which cannot be copied.` });
      } else if (d.excluded && d.action === "create") {
        blocked = true;
        messages.push({
          level: "error",
          message: `It needs ${d.label}, which is left out and is not in the destination.`,
        });
      }
    }
    out.set(pairKey(i), { blocked, messages });
  }
  return out;
}

/** The errors that stop the apply: blocked items that are not left out. */
export function blockingErrors(items: GraphItem[]): Array<{ key: string; message: string }> {
  const eff = effectiveState(items);
  const errs: Array<{ key: string; message: string }> = [];
  for (const i of items) {
    if (i.excluded) continue;
    const e = eff.get(pairKey(i))!;
    if (!e.blocked) continue;
    const msg = e.messages.find((m) => m.level === "error")?.message ?? "It cannot be copied.";
    errs.push({ key: pairKey(i), message: `${i.label}: ${msg}` });
  }
  return errs;
}

export function warnings(items: GraphItem[]): Array<{ key: string; message: string }> {
  return items
    .filter((i) => !i.excluded)
    .flatMap((i) =>
      i.messages
        .filter((m) => m.level === "warning")
        .map((m) => ({ key: pairKey(i), message: `${i.label}: ${m.message}` })),
    );
}

/** A live destination changes only through updates and deletes; creating is always allowed. */
export function needsLiveOverride(items: GraphItem[], destLive: boolean): boolean {
  return destLive && items.some((i) => i.pair === "main" && writes(i) && i.action !== "create");
}

/** Keys an exclusion request may name: only items that write. Unknown keys are refused. */
export function checkExclusionKeys(items: GraphItem[], keys: string[]): string[] {
  const known = new Set(items.map(pairKey));
  return keys.filter((k) => !known.has(k));
}

export interface Counts {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

export function countStatuses(items: Array<{ status: ItemStatus; queued: boolean }>): Counts {
  const c: Counts = { total: 0, pending: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const i of items) {
    if (!i.queued) continue;
    c.total++;
    c[i.status]++;
  }
  return c;
}

/** What the plan does with an item, as the review shows it. */
export type ResultKind =
  | "new"
  | "updated"
  | "deleted"
  | "unchanged"
  | "kept"
  | "blocked"
  | "left_out";
export const RESULT_KINDS: ResultKind[] = [
  "new",
  "updated",
  "deleted",
  "unchanged",
  "kept",
  "blocked",
  "left_out",
];
export const RESULT_OF_ACTION: Record<ItemAction, ResultKind> = {
  create: "new",
  update: "updated",
  delete: "deleted",
  unchanged: "unchanged",
  skip: "kept",
  blocked: "blocked",
};

/** Left out wins over blocked; `blocked` is the effective state (dependencies included). */
export function resultOf(i: Pick<GraphItem, "action" | "excluded">, blocked: boolean): ResultKind {
  if (i.excluded) return "left_out";
  if (blocked) return "blocked";
  return RESULT_OF_ACTION[i.action];
}

/** Items the apply queued: the rest were skipped at once as left out or unchanged. */
export const wasQueued = (i: { status: string; skipReason?: string | null }) =>
  !(i.status === "skipped" && (i.skipReason === "excluded" || i.skipReason === "unchanged"));

/** A failed item, or one a failure or drift held back: what a retry queues again. */
export const retryable = (i: { status: string; skipReason?: string | null }) =>
  i.status === "failed" ||
  (i.status === "skipped" && (i.skipReason === "dependency" || i.skipReason === "drift"));

export type ResultCounts = Record<ResultKind, number>;
export type Applied = Record<"new" | "updated" | "deleted", number>;
export type Progress = Pick<
  Counts,
  "total" | "pending" | "running" | "done" | "failed" | "skipped"
>;

export interface SectionSummary {
  pair: Pair;
  section: string;
  results: ResultCounts;
  /** Queued items only, by status. */
  progress: Progress;
  /** Items the copy wrote, by result. */
  applied: Applied;
}

export interface RunSummary {
  total: number;
  results: ResultCounts;
  /** Twin pair first, then sections in apply order. */
  sections: SectionSummary[];
  /** Blocked items not left out: the apply refuses while any remain. */
  blocked: Array<{
    key: string;
    pair: Pair;
    section: string;
    label: string;
    messages: ItemMessage[];
  }>;
  retryable: number;
}

const zeroResults = (): ResultCounts =>
  Object.fromEntries(RESULT_KINDS.map((k) => [k, 0])) as ResultCounts;
const zeroProgress = (): Progress => ({
  total: 0,
  pending: 0,
  running: 0,
  done: 0,
  failed: 0,
  skipped: 0,
});

/** Counts per section × result and the open blockers. Items in apply order. */
export function summarize(
  items: Array<GraphItem & { status: ItemStatus; skipReason?: string | null }>,
  eff: Map<string, Effective> = effectiveState(items),
): RunSummary {
  const out: RunSummary = {
    total: items.length,
    results: zeroResults(),
    sections: [],
    blocked: [],
    retryable: 0,
  };
  const bySection = new Map<string, SectionSummary>();
  for (const i of items) {
    const e = eff.get(pairKey(i));
    const r = resultOf(i, e?.blocked ?? false);
    const id = `${i.pair}:${i.section}`;
    let s = bySection.get(id);
    if (!s) {
      s = {
        pair: i.pair,
        section: i.section,
        results: zeroResults(),
        progress: zeroProgress(),
        applied: { new: 0, updated: 0, deleted: 0 },
      };
      bySection.set(id, s);
    }
    out.results[r]++;
    s.results[r]++;
    if (wasQueued(i)) {
      s.progress.total++;
      s.progress[i.status]++;
    }
    if (i.status === "done" && (r === "new" || r === "updated" || r === "deleted")) s.applied[r]++;
    if (retryable(i)) out.retryable++;
    if (r === "blocked")
      out.blocked.push({
        key: pairKey(i),
        pair: i.pair,
        section: i.section,
        label: i.label,
        messages: e?.messages ?? i.messages,
      });
  }
  out.sections = [...bySection.values()].sort(
    (a, b) => (a.pair === "twin" ? 0 : 1) - (b.pair === "twin" ? 0 : 1),
  );
  return out;
}

/** The run's end state from its item counts. */
export function finalStatus(c: Counts, cancelled: boolean): RunStatus {
  if (cancelled) return "cancelled";
  if (c.failed === 0) return "succeeded";
  return c.done > 0 ? "partially_failed" : "failed";
}

/**
 * Which item a dependency failure skips: the item's own dependencies, and for the main pair,
 * any failed twin item (the test businesses go first; a failure there leaves live untouched).
 */
export function dependencyBlocker<
  T extends { pair: Pair; key: string; label: string; status: ItemStatus; skipReason?: string },
>(
  item: { pair: Pair; dependsOn: string[] },
  byKey: Map<string, T>,
  twinFailed: boolean,
): string | null {
  if (item.pair === "main" && twinFailed)
    return "Skipped: the copy into the test business did not finish.";
  for (const dep of item.dependsOn) {
    const d = byKey.get(`${item.pair}:${dep}`);
    if (!d) continue;
    if (d.status === "failed" || (d.status === "skipped" && d.skipReason === "dependency"))
      return `Skipped: it needs ${d.label}, which was not copied.`;
  }
  return null;
}
