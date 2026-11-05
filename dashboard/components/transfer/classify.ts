import type { PreviewField, PreviewPair, TransferPreview } from "@/lib/api/transfer";
import { SECTION_LABEL, fieldLabel } from "./sections";

export type ChangeKind = "new" | "replaced" | "left_out";

export interface ChangeRow {
  key: string;
  /** "Test businesses" for the twin pair, else null. */
  pair: string | null;
  section: string;
  sectionId: string;
  item: string;
  from?: unknown;
  to?: unknown;
  kind: ChangeKind;
  /** Why a row is left out. */
  reason?: string;
  /** A blocker: the copy cannot run until it is corrected or its section is left out. */
  problem?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const empty = (v: unknown) => v === null || v === undefined || v === "";

/** One row per value that differs, descending into nested settings: `Dunning · mode`. */
function diff(
  key: string,
  label: string,
  from: unknown,
  to: unknown,
  out: Array<{ key: string; label: string; from: unknown; to: unknown }>,
) {
  if (JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return;
  if (!isObj(from) && !isObj(to)) {
    out.push({ key, label, from, to });
    return;
  }
  const a = isObj(from) ? from : {};
  const b = isObj(to) ? to : {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
    diff(`${key}.${k}`, `${label} · ${k.replace(/_/g, " ")}`, a[k], b[k], out);
}

function fieldRows(fields: PreviewField[]) {
  const out: Array<{ key: string; label: string; from: unknown; to: unknown }> = [];
  for (const f of fields) {
    if (!f.changed) continue;
    if (f.secret) out.push({ key: f.field, label: fieldLabel(f.field), from: f.from, to: f.to });
    else diff(f.field, fieldLabel(f.field), f.from, f.to, out);
  }
  return out;
}

/** What a live business takes only with "Also update what is there". */
const UPDATE_ONLY = new Set([
  "settings",
  "company_profile",
  "email_sending",
  "tax_rates",
  "numbering",
]);

const HELD = "Only “Also update what is there” copies this into a live business.";

function pairRows(p: PreviewPair, pairLabel: string | null, update: boolean): ChangeRow[] {
  const rows: ChangeRow[] = [];
  const live = p.destination_livemode === "live";
  const id = (s: string) => `${p.destination_business}:${s}`;
  for (const b of p.blockers) {
    // A section that writes nothing cannot stop the copy.
    if (live && !update && UPDATE_ONLY.has(b.section)) continue;
    rows.push({
      key: id(`blocker:${b.section}:${b.message}`),
      pair: pairLabel,
      sectionId: b.section,
      section: SECTION_LABEL[b.section] ?? b.section,
      item: "Cannot copy",
      kind: "left_out",
      reason: b.message,
      problem: true,
    });
  }
  for (const s of p.sections) {
    const section = SECTION_LABEL[s.section] ?? s.section;
    const held = s.status === "needs_live_override" && live && !update;
    if (s.objects) {
      const o = s.objects;
      if (o.deleted)
        rows.push({
          key: id(`${s.section}:deleted`),
          pair: pairLabel,
          sectionId: s.section,
          section,
          item: `${o.deleted} on the destination, deleted first`,
          kind: "replaced",
        });
      if (o.create)
        rows.push({
          key: id(`${s.section}:create`),
          pair: pairLabel,
          sectionId: s.section,
          section,
          item: `${o.create} not on the destination yet`,
          kind: "new",
        });
      if (o.existing)
        rows.push(
          o.existing_action === "update"
            ? {
                key: id(`${s.section}:existing`),
                pair: pairLabel,
                sectionId: s.section,
                section,
                item: `${o.existing} already on the destination, updated`,
                kind: "replaced",
              }
            : {
                key: id(`${s.section}:existing`),
                pair: pairLabel,
                sectionId: s.section,
                section,
                item: `${o.existing} already on the destination`,
                kind: "left_out",
                reason: "A live business keeps the records it has.",
              },
        );
    }
    if (s.fields) {
      for (const r of fieldRows(s.fields))
        rows.push({
          key: id(`${s.section}:${r.key}`),
          pair: pairLabel,
          sectionId: s.section,
          section,
          item: r.label,
          from: r.from,
          to: r.to,
          kind: held ? "left_out" : empty(r.from) ? "new" : "replaced",
          reason: held ? HELD : undefined,
        });
      const same = s.fields.filter((f) => !f.changed).length;
      if (same)
        rows.push({
          key: id(`${s.section}:same`),
          pair: pairLabel,
          sectionId: s.section,
          section,
          item: `${same} ${same === 1 ? "value" : "values"}`,
          kind: "left_out",
          reason: "Already the same.",
        });
    }
    if (s.tax) {
      // Region lines belong to the profile above them: without the update, only a NEW profile
      // (and its regions) reaches a live business.
      let profileIsNew = false;
      s.tax.forEach((t, i) => {
        const region = t.text.startsWith("  ");
        if (!region) profileIsNew = t.action === "create";
        const goes = !held || profileIsNew;
        const kind: ChangeKind =
          !goes || t.action === "same" || t.action === "kept"
            ? "left_out"
            : t.action === "create"
              ? "new"
              : "replaced";
        rows.push({
          key: id(`tax:${i}`),
          pair: pairLabel,
          sectionId: s.section,
          section,
          item: (t.action === "delete" ? "Deleted first: " : "") + t.text.trim(),
          kind,
          reason:
            kind !== "left_out"
              ? undefined
              : t.action === "same"
                ? "Already the same."
                : t.action === "kept"
                  ? "Only on the destination. It stays."
                  : HELD,
        });
      });
    }
  }
  return rows;
}

export function classify(preview: TransferPreview, update: boolean): ChangeRow[] {
  const twin = preview.pairs.length > 1;
  return preview.pairs.flatMap((p, i) =>
    pairRows(p, twin && i === 0 ? "Test businesses" : null, update),
  );
}

/** The sections whose blockers stop the copy. */
export function blockedSections(rows: ChangeRow[]): string[] {
  return [...new Set(rows.filter((r) => r.problem).map((r) => r.sectionId))];
}
