import type { ItemAction, TransferItem } from "@/lib/api/transfer";
import { fieldLabel } from "./sections";

/** What the plan does with an item, as the review shows it. */
export type ItemKind =
  | "new"
  | "updated"
  | "deleted"
  | "unchanged"
  | "kept"
  | "blocked"
  | "left_out";

export const KIND_LABEL: Record<ItemKind, string> = {
  new: "New",
  updated: "Updated",
  deleted: "Deleted first",
  unchanged: "Unchanged",
  kept: "Kept",
  blocked: "Blocked",
  left_out: "Left out",
};

export const KIND_TONE: Record<ItemKind, "green" | "blue" | "gray" | "red" | "tan"> = {
  new: "green",
  updated: "blue",
  deleted: "tan",
  unchanged: "gray",
  kept: "gray",
  blocked: "red",
  left_out: "gray",
};

const BY_ACTION: Record<ItemAction, ItemKind> = {
  create: "new",
  update: "updated",
  delete: "deleted",
  unchanged: "unchanged",
  skip: "kept",
  blocked: "blocked",
};

export function kindOf(i: TransferItem): ItemKind {
  if (i.excluded) return "left_out";
  if (i.blocked) return "blocked";
  return BY_ACTION[i.action];
}

/** An item the member can leave out: it writes, or it is blocked. */
export const canLeaveOut = (i: TransferItem) =>
  i.excluded ||
  i.blocked ||
  i.action === "create" ||
  i.action === "update" ||
  i.action === "delete";

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export interface DiffRow {
  key: string;
  label: string;
  from: unknown;
  to: unknown;
}

/** One row per value that differs, descending into nested objects: `Dunning · mode`. */
function walk(key: string, label: string, from: unknown, to: unknown, out: DiffRow[]) {
  if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return;
  if (!isObj(from) && !isObj(to)) {
    out.push({ key, label, from, to });
    return;
  }
  const a = isObj(from) ? from : {};
  const b = isObj(to) ? to : {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
    walk(`${key}.${k}`, `${label} · ${k.replace(/_/g, " ")}`, a[k], b[k], out);
}

export function flatDiff(diff: TransferItem["diff"]): DiffRow[] {
  const out: DiffRow[] = [];
  for (const d of diff ?? []) walk(d.field, fieldLabel(d.field), d.from, d.to, out);
  return out;
}

export function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not set";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" || typeof v === "number") return String(v);
  return JSON.stringify(v);
}

/** Items the apply queued: the rest were skipped at once as left out or unchanged. */
export const wasQueued = (i: TransferItem) =>
  !(i.status === "skipped" && (i.skip_reason === "excluded" || i.skip_reason === "unchanged"));
