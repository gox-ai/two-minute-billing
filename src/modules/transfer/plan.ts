/**
 * The field-by-field plan of one transfer pair (source → destination): what each section
 * would write, what it skips and why, and what blocks the run. `previewTransfer` serializes
 * it; `runTransfer` rebuilds it inside the write transaction and applies exactly that.
 *
 * Read-only: nothing here writes.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray, like, ne, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import {
  appliedTaxes,
  businesses,
  coupons,
  creditNotes,
  invoices,
  prices,
  productGroups,
  products,
  taxProfiles,
  taxRateComponents,
  taxRegions,
  taxStateRegistrations,
} from "@db/schema";
import { isEncryptedWithCurrentKey } from "@/platform/secrets";
import { readSmtpPassword, writeSmtpPassword } from "@/modules/emails/smtp-config";
import { readSesSecret, writeSesSecret } from "@/modules/emails/ses-config";
import { resolveInvoiceCustomization } from "@/modules/invoicing/customization";

export type Biz = typeof businesses.$inferSelect;
type Patch = Partial<typeof businesses.$inferInsert>;

export type TransferSection =
  | "catalog"
  | "coupons"
  | "tax_rates"
  | "settings"
  | "company_profile"
  | "email_sending";
export const ALL_SECTIONS: TransferSection[] = [
  "catalog",
  "coupons",
  "tax_rates",
  "settings",
  "company_profile",
  "email_sending",
];
/** A request that names no sections gets these. The two newer sections are opt-in. */
export const DEFAULT_SECTIONS: TransferSection[] = ["catalog", "coupons", "tax_rates", "settings"];
/** What a LIVE destination takes only under the live override. Catalog and coupons never. */
export const OVERRIDE_SECTIONS: TransferSection[] = [
  "settings",
  "company_profile",
  "email_sending",
  "tax_rates",
];

export type MergeMode = "overwrite" | "skip_existing";

export interface Numbering {
  invoicePrefix?: string;
  creditNotePrefix?: string;
}

/** Company profile: the seller's legal identity on documents. */
const PROFILE_FIELDS = [
  "address",
  "taxRegistrationNumber",
  "invoiceIssuer",
  "defaultTaxCode",
  "defaultTaxBehavior",
  "taxSettings",
] as const satisfies ReadonlyArray<keyof Biz>;

/**
 * Billing behaviour a settings copy carries. Not here: the number prefixes (set through
 * `numbering` only), counters, name, currency, branding, contact details, timezone.
 */
export const SETTINGS_FIELDS = [
  "defaultInvoiceNotes",
  "defaultDueDays",
  "dunningRetryDays",
  "dunningConfig",
  "createPendingInvoices",
  "autoClosePendingAfterDays",
  "invoiceRounding",
  "defaultProrateOnChange",
  "defaultInvoiceImmediately",
  "defaultCancelOption",
  "defaultCreditOptionForCancel",
  "defaultUnbilledOnCancel",
  "defaultArHandlingOnCancel",
  "defaultRefundableCreditsOnCancel",
  "unbilledChargesConfig",
  "pauseConfig",
  "backdatingConfig",
  "defaultCreditNoteOnVoid",
  "viesValidationEnabled",
  "prorateFixedAmountCoupons",
  "storefrontConfig",
  "chargebackConfig",
  "checkoutFieldConfig",
  "portalFieldConfig",
] as const satisfies ReadonlyArray<keyof Biz>;

/** Storefront keys that point at the destination's own site or speak in its words. */
export const STOREFRONT_KEEP_DEST = [
  "default_return_url",
  "default_cancel_url",
  "portal_link_error_html",
];

/** `email_config` keys copied. `subjectPrefix` and `footerNote` are brand text, like templates. */
const EMAIL_KEYS = [
  "enabled",
  "fromName",
  "fromAddress",
  "replyTo",
  "cc",
  "bcc",
  "attachments",
  "types",
];

export const MASK = "••••";

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────

/** Order-independent JSON, so `{a,b}` and `{b,a}` compare equal. */
export function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)))
      : typeof x === "bigint"
        ? x.toString()
        : x,
  );
}
const same = (a: unknown, b: unknown) => canon(a ?? null) === canon(b ?? null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : null;
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ── plan shape ───────────────────────────────────────────────────────────────────────────

export interface FieldChange {
  section: "settings" | "company_profile" | "email_sending" | "numbering";
  column: keyof Biz;
  from: unknown;
  to: unknown;
  changed: boolean;
  secret: boolean;
  /** For a secret: what happens to the envelope. */
  note?: string;
}

export interface TaxLine {
  text: string;
  action: "create" | "update" | "same" | "kept" | "rename" | "delete";
}

/** Where a blocker message goes. Each section gets its own, so a blocker names its section. */
type Sink = { push(message: string): unknown };

export interface Blocker {
  section: TransferSection | "numbering";
  message: string;
}

export type SectionStatus = "copy" | "needs_live_override";

export interface SectionPlan {
  section: TransferSection | "numbering";
  status: SectionStatus;
  /** catalog / coupons: rows by key. `deleted`: destination rows a clear-first removes. */
  objects?: {
    create: number;
    existing: number;
    existingAction: "update" | "keep";
    deleted?: number;
  };
  fields?: FieldChange[];
  tax?: TaxLine[];
  changes: number;
}

export interface PairPlan {
  source: Biz;
  destination: Biz;
  mode: MergeMode;
  /** The live override applies to this pair (preview: it would apply). */
  override: boolean;
  sections: SectionPlan[];
  blockers: Blocker[];
  /** The destination's catalog, coupons and taxes are deleted first (test destinations only). */
  wipe: boolean;
  patch: Patch;
  auditBefore: Record<string, unknown>;
  auditAfter: Record<string, unknown>;
  taxChanges: number;
  renameDefaultProfile: { id: string; from: string; to: string } | null;
  digest: string;
}

// ── secrets ──────────────────────────────────────────────────────────────────────────────

/**
 * The destination's next envelope for one secret. Same plaintext → keep the destination's
 * ciphertext (a re-run changes nothing). Otherwise the source's envelope is copied: the
 * cipher has no AAD or business binding, so it decrypts for any business. An envelope
 * under a rotation-fallback key is re-encrypted under the current one.
 */
function nextSecret(
  label: string,
  srcEnc: string | null,
  destEnc: string | null,
  read: (e: string) => string | null,
  write: (plain: string) => string,
  blockers: Sink,
): { next: string | null; note: string } {
  if (!srcEnc) return { next: null, note: destEnc ? "remove" : "none" };
  let srcPlain: string | null;
  try {
    srcPlain = read(srcEnc);
  } catch {
    srcPlain = null;
  }
  if (srcPlain == null) {
    blockers.push(`We could not read the source's ${label}. Enter it again on the source.`);
    return { next: destEnc, note: "unreadable" };
  }
  let destPlain: string | null = null;
  try {
    destPlain = destEnc ? read(destEnc) : null;
  } catch {
    destPlain = null;
  }
  if (destPlain === srcPlain) return { next: destEnc, note: "same" };
  if (isEncryptedWithCurrentKey(srcEnc)) return { next: srcEnc, note: "copy" };
  return { next: write(srcPlain), note: "re-encrypt" };
}

// ── tax ──────────────────────────────────────────────────────────────────────────────────

async function loadTax(tx: Tx, businessId: string) {
  const profiles = await tx
    .select()
    .from(taxProfiles)
    .where(eq(taxProfiles.businessId, businessId));
  const regions = await tx.select().from(taxRegions).where(eq(taxRegions.businessId, businessId));
  const ids = regions.map((r) => r.id);
  const components = ids.length
    ? await tx.select().from(taxRateComponents).where(inArray(taxRateComponents.taxRegionId, ids))
    : [];
  const regs = ids.length
    ? await tx
        .select()
        .from(taxStateRegistrations)
        .where(inArray(taxStateRegistrations.taxRegionId, ids))
    : [];
  return { profiles, regions, components, regs };
}

const IDENTITY = new Set([
  "id",
  "organizationId",
  "businessId",
  "publicId",
  "taxProfileId",
  "taxRegionId",
  "createdAt",
  "updatedAt",
  "resourceVersion",
]);
const values = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !IDENTITY.has(k)));
const sortedValues = (rows: Array<Record<string, unknown>>) =>
  rows.map(values).sort((a, b) => canon(a).localeCompare(canon(b)));
/** A component's natural key inside its region (`tax_rate_components_region_state_name_uq`). */
export const componentKey = (c: { stateCode: string | null; name: string }) =>
  `${c.stateCode ?? ""}|${c.name}`;

/**
 * What `copyTaxRates` will do, matched on the natural keys it uses. In `skip_existing` mode a
 * matched profile is kept as it is (only new profiles are created).
 */
async function planTax(
  tx: Tx,
  src: Biz,
  dest: Biz,
  mode: MergeMode,
  plan: PairPlan,
  lines: TaxLine[],
  blockers: Sink,
): Promise<string> {
  const s = await loadTax(tx, src.id);
  const d = await loadTax(tx, dest.id);
  const overwrite = mode === "overwrite";

  const srcDefault = s.profiles.find((p) => p.isDefault);
  const destDefault = d.profiles.find((p) => p.isDefault);
  if (overwrite && srcDefault && destDefault && srcDefault.name !== destDefault.name) {
    // Two defaults would break the one-default-per-business index mid-copy.
    if (d.regions.some((r) => r.taxProfileId === destDefault.id)) {
      blockers.push(
        `The destination's default tax profile "${destDefault.name}" has regions, and its name is ` +
          `not the same as the source's default "${srcDefault.name}". Rename one of them first.`,
      );
    } else if (d.profiles.some((p) => p.name === srcDefault.name)) {
      blockers.push(
        `The destination has a "${destDefault.name}" (default) and a "${srcDefault.name}" tax profile. ` +
          `Delete or rename one of them first.`,
      );
    } else {
      plan.renameDefaultProfile = {
        id: destDefault.id,
        from: destDefault.name,
        to: srcDefault.name,
      };
      lines.push({
        text: `Profile "${destDefault.name}" (default, no regions): rename to "${srcDefault.name}". Products linked to it keep their link.`,
        action: "rename",
      });
      plan.taxChanges++;
    }
  }
  const destByName = (name: string) =>
    d.profiles.find(
      (p) =>
        p.name === name ||
        (plan.renameDefaultProfile?.id === p.id && plan.renameDefaultProfile.to === name),
    );

  for (const sp of s.profiles) {
    const dp = destByName(sp.name);
    const pDiff = !dp || !same(values(sp), { ...values(dp), name: sp.name });
    const pAction: TaxLine["action"] = !dp
      ? "create"
      : !overwrite
        ? "kept"
        : pDiff
          ? "update"
          : "same";
    lines.push({
      text: `Profile "${sp.name}"${sp.isDefault ? " (default)" : ""}`,
      action: pAction,
    });
    if (pAction === "create" || pAction === "update") plan.taxChanges++;
    if (dp && !overwrite) continue;
    for (const sr of s.regions.filter((r) => r.taxProfileId === sp.id)) {
      const dr = dp
        ? d.regions.find((r) => r.taxProfileId === dp.id && r.country === sr.country)
        : undefined;
      const srcComps = s.components.filter((c) => c.taxRegionId === sr.id);
      const destComps = dr ? d.components.filter((c) => c.taxRegionId === dr.id) : [];
      const sc = sortedValues(srcComps);
      const sg = sortedValues(s.regs.filter((g) => g.taxRegionId === sr.id));
      const dc = sortedValues(destComps);
      const dg = dr ? sortedValues(d.regs.filter((g) => g.taxRegionId === dr.id)) : [];
      const changed = !dr || !same(values(sr), values(dr)) || !same(sc, dc) || !same(sg, dg);
      const action: TaxLine["action"] = !dr ? "create" : changed ? "update" : "same";
      const comps =
        srcComps
          .map(
            (c) =>
              `${c.stateCode ? `${c.stateCode}:` : ""}${c.name} ${c.rateBps / 100}% (${c.appliesTo})`,
          )
          .join(", ") || "no components";
      lines.push({
        text: `  Region ${sr.country} · ${sr.regime} · ${sr.priceType}: ${comps}`,
        action,
      });
      if (action !== "same") plan.taxChanges++;

      // A destination-only component is deleted by the copy. Deleting one an issued invoice
      // points at would detach that invoice's tax line (ON DELETE SET NULL).
      if (dr && changed) {
        const srcKeys = new Set(srcComps.map(componentKey));
        const stale = destComps.filter((c) => !srcKeys.has(componentKey(c)));
        if (stale.length && dest.livemode === "live") {
          const [ref] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(appliedTaxes)
            .where(
              inArray(
                appliedTaxes.taxComponentId,
                stale.map((c) => c.id),
              ),
            );
          if ((ref?.n ?? 0) > 0)
            blockers.push(
              `Region ${dr.country} of the destination has ${stale
                .map((c) => c.name)
                .join(", ")}, which the source does not have and issued invoices use. ` +
                `The copy cannot remove ${stale.length === 1 ? "it" : "them"}. Add the same component to the source, or copy without taxes.`,
            );
        }
      }
    }
  }
  for (const dp of d.profiles) {
    if (s.profiles.some((p) => p.name === dp.name) || plan.renameDefaultProfile?.id === dp.id)
      continue;
    lines.push({ text: `Profile "${dp.name}" (only on the destination)`, action: "kept" });
  }
  // The digest must move when the destination's tax rows move, not only when the lines do.
  return sha(
    canon([
      sortedValues(d.profiles),
      sortedValues(d.regions),
      sortedValues(d.components),
      sortedValues(d.regs),
    ]),
  );
}

// ── numbering ────────────────────────────────────────────────────────────────────────────

/** What a number starts with under this business's first separator: `TMB` → `TMB-`. */
function numberLead(prefix: string, separator1: "none" | "hyphen"): string {
  return separator1 === "hyphen" ? `${prefix.replace(/-$/, "")}-` : prefix;
}

/** Refuse a prefix whose numbers another document of this organization already carries. */
async function checkNumbering(
  tx: Tx,
  dest: Biz,
  kind: "invoice" | "credit_note",
  prefix: string,
  blockers: Sink,
): Promise<void> {
  const numbering = resolveInvoiceCustomization(dest);
  const sep =
    kind === "invoice"
      ? numbering.invoiceNumbering.separator1
      : numbering.creditNoteNumbering.separator1;
  const lead = numberLead(prefix, sep);
  const label = kind === "invoice" ? "invoice prefix" : "credit note prefix";
  const peers = await tx
    .select({
      id: businesses.id,
      publicId: businesses.publicId,
      invoicePrefix: businesses.invoicePrefix,
      creditNotePrefix: businesses.creditNotePrefix,
    })
    .from(businesses)
    .where(
      and(
        eq(businesses.organizationId, dest.organizationId),
        eq(businesses.livemode, dest.livemode),
        ne(businesses.id, dest.id),
      ),
    );
  const bare = (p: string) => p.replace(/-$/, "");
  for (const p of peers) {
    const theirs = kind === "invoice" ? p.invoicePrefix : p.creditNotePrefix;
    if (bare(theirs) === bare(prefix)) {
      blockers.push(
        `The ${label} ${prefix} is already in use by ${p.publicId}. Use a different prefix.`,
      );
      return;
    }
  }
  const table = kind === "invoice" ? invoices : creditNotes;
  const count = async (ids: string[]) =>
    ids.length === 0
      ? 0
      : ((
          await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(table)
            .where(and(inArray(table.businessId, ids), like(table.number, `${lead}%`)))
        )[0]?.n ?? 0);
  const docs = kind === "invoice" ? "invoices" : "credit notes";
  const peerDocs = await count(peers.map((p) => p.id));
  if (peerDocs > 0) {
    blockers.push(
      `${peerDocs} ${docs} in other businesses have numbers that start with ${lead}. Use a different prefix.`,
    );
    return;
  }
  // The same prefix already = the same series: its counter only goes up, so it cannot repeat.
  const current = kind === "invoice" ? dest.invoicePrefix : dest.creditNotePrefix;
  if (current !== prefix) {
    const own = await count([dest.id]);
    if (own > 0)
      blockers.push(
        `The destination has ${own} ${docs} with numbers that start with ${lead} under a different prefix. Use a different prefix.`,
      );
  }
}

// ── catalog counts ───────────────────────────────────────────────────────────────────────

async function countByKey(
  tx: Tx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  keyCol: "publicId" | "code",
  srcBiz: string,
  destBiz: string,
): Promise<{ create: number; existing: number }> {
  const srcKeys = (
    await tx.select({ k: table[keyCol] }).from(table).where(eq(table.businessId, srcBiz))
  ).map((r: { k: string }) => r.k);
  if (srcKeys.length === 0) return { create: 0, existing: 0 };
  const hit = await tx
    .select({ k: table[keyCol] })
    .from(table)
    .where(and(eq(table.businessId, destBiz), inArray(table[keyCol], srcKeys)));
  return { create: srcKeys.length - hit.length, existing: hit.length };
}

/** Rows a clear-first deletes. The "default" product group is kept, so it is not counted. */
async function countRows(
  tx: Tx,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  destBiz: string,
  keepsDefault: boolean,
): Promise<number> {
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(
      keepsDefault
        ? and(eq(table.businessId, destBiz), ne(table.publicId, "default"))
        : eq(table.businessId, destBiz),
    );
  return r?.n ?? 0;
}

// ── the plan ─────────────────────────────────────────────────────────────────────────────

/**
 * Plan one pair. `allowLiveWrites` is the live override: without it, a LIVE destination's
 * override sections come back `needs_live_override` and write nothing. A preview passes true
 * so the operator sees what the override would do; the digest covers that plan.
 */
export async function buildPairPlan(
  tx: Tx,
  src: Biz,
  dest: Biz,
  opts: {
    sections: TransferSection[];
    numbering?: Numbering;
    allowLiveWrites: boolean;
    wipe?: boolean;
  },
): Promise<PairPlan> {
  const live = dest.livemode === "live";
  const wipe = !!opts.wipe && !live;
  const override = live && opts.allowLiveWrites;
  const plan: PairPlan = {
    source: src,
    destination: dest,
    mode: live ? "skip_existing" : "overwrite",
    override,
    sections: [],
    blockers: [],
    wipe,
    patch: {},
    auditBefore: {},
    auditAfter: {},
    taxChanges: 0,
    renameDefaultProfile: null,
    digest: "",
  };
  const has = (s: TransferSection) => opts.sections.includes(s);
  const writes = (s: TransferSection) =>
    !live || !OVERRIDE_SECTIONS.includes(s) || opts.allowLiveWrites;
  const status = (s: TransferSection): SectionStatus =>
    live && OVERRIDE_SECTIONS.includes(s) ? "needs_live_override" : "copy";
  const digestParts: unknown[] = [src.id, dest.id, opts.sections, opts.allowLiveWrites, wipe];
  // A section that writes nothing cannot block the run.
  const sink = (section: TransferSection | "numbering"): Sink =>
    !live ||
    opts.allowLiveWrites ||
    (section !== "numbering" && !OVERRIDE_SECTIONS.includes(section))
      ? { push: (message: string) => plan.blockers.push({ section, message }) }
      : { push: () => 0 };

  /** `secret`: the source envelope and what happens to it. Secrets enter the digest as hashes. */
  const addField = (
    sec: SectionPlan,
    column: keyof Biz,
    from: unknown,
    to: unknown,
    secret?: { srcEnc: string | null; note: string },
  ) => {
    const changed = !same(from, to);
    sec.fields!.push({
      section: sec.section as FieldChange["section"],
      column,
      from,
      to,
      changed,
      secret: !!secret,
      note: secret?.note,
    });
    // A re-encryption makes a fresh envelope every time, so a secret's `to` cannot be hashed:
    // the destination's envelope, the source's envelope and the planned step stand for it.
    digestParts.push(
      secret
        ? [column, sha(String(from ?? "")), sha(String(secret.srcEnc ?? "")), secret.note]
        : [column, from ?? null, to ?? null],
    );
    if (!changed) return;
    sec.changes++;
    (plan.patch as Record<string, unknown>)[column] = to;
    plan.auditBefore[snake(String(column))] = secret ? (from ? MASK : null) : (from ?? null);
    plan.auditAfter[snake(String(column))] = secret ? (to ? MASK : null) : (to ?? null);
  };

  for (const [section, table] of [
    ["catalog", products],
    ["coupons", coupons],
  ] as const) {
    if (!has(section)) continue;
    const tables = section === "catalog" ? [table, productGroups, prices] : [table];
    const c = { create: 0, existing: 0 };
    let deleted = 0;
    for (const t of tables) {
      const k = t === coupons ? "code" : "publicId";
      const more = await countByKey(tx, t, k, src.id, dest.id);
      c.create += more.create;
      c.existing += more.existing;
      if (wipe) deleted += await countRows(tx, t, dest.id, t === productGroups);
    }
    // A clear-first deletes the destination's rows, so every source row is created anew.
    if (wipe) {
      c.create += c.existing;
      c.existing = 0;
    }
    const existingAction = live ? "keep" : "update";
    plan.sections.push({
      section,
      status: "copy",
      objects: { ...c, existingAction, ...(wipe ? { deleted } : {}) },
      changes: c.create + (existingAction === "update" ? c.existing : 0) + deleted,
    });
    digestParts.push([section, c, deleted]);
  }

  if (has("tax_rates")) {
    const sec: SectionPlan = {
      section: "tax_rates",
      status: status("tax_rates"),
      tax: [],
      changes: 0,
    };
    if (wipe) {
      // Every destination profile is deleted (the cascade takes the rest), then the source's created.
      const sp = await tx.select().from(taxProfiles).where(eq(taxProfiles.businessId, src.id));
      const dp = await tx.select().from(taxProfiles).where(eq(taxProfiles.businessId, dest.id));
      for (const p of dp) sec.tax!.push({ text: `Profile "${p.name}"`, action: "delete" });
      for (const p of sp)
        sec.tax!.push({
          text: `Profile "${p.name}"${p.isDefault ? " (default)" : ""}`,
          action: "create",
        });
      plan.taxChanges = sp.length + dp.length;
      digestParts.push(["tax", sec.tax]);
    } else {
      const taxMode: MergeMode = writes("tax_rates") ? "overwrite" : "skip_existing";
      // A test destination plans like an override: same matching, same blockers.
      const destTax = await planTax(tx, src, dest, taxMode, plan, sec.tax!, sink("tax_rates"));
      digestParts.push(["tax", sec.tax, destTax]);
    }
    sec.changes = plan.taxChanges;
    plan.sections.push(sec);
  }

  if (has("company_profile")) {
    const sec: SectionPlan = {
      section: "company_profile",
      status: status("company_profile"),
      fields: [],
      changes: 0,
    };
    for (const f of PROFILE_FIELDS) addField(sec, f, dest[f], src[f]);
    plan.sections.push(sec);
  }

  if (has("settings")) {
    const sec: SectionPlan = {
      section: "settings",
      status: status("settings"),
      fields: [],
      changes: 0,
    };
    for (const f of SETTINGS_FIELDS) {
      let to: unknown = src[f];
      if (f === "storefrontConfig") {
        const next = obj(src.storefrontConfig) ?? {};
        const d = obj(dest.storefrontConfig) ?? {};
        for (const k of STOREFRONT_KEEP_DEST) {
          if (k in d) next[k] = d[k];
          else delete next[k];
        }
        to = Object.keys(next).length ? next : null;
      }
      // Dunning policies are not copied, so plan → policy assignments stay the destination's.
      if (f === "dunningConfig" && obj(src.dunningConfig)) {
        const next = { ...obj(src.dunningConfig)! };
        const kept = obj(dest.dunningConfig)?.plan_policies;
        if (kept !== undefined) next.plan_policies = kept;
        else delete next.plan_policies;
        to = next;
      }
      addField(sec, f, dest[f], to);
    }
    plan.sections.push(sec);
  }

  if (opts.numbering?.invoicePrefix != null || opts.numbering?.creditNotePrefix != null) {
    const sec: SectionPlan = {
      section: "numbering",
      status: live ? "needs_live_override" : "copy",
      fields: [],
      changes: 0,
    };
    const inv = opts.numbering.invoicePrefix;
    const cn = opts.numbering.creditNotePrefix;
    if (inv != null) {
      if (inv !== dest.invoicePrefix)
        await checkNumbering(tx, dest, "invoice", inv, sink("numbering"));
      addField(sec, "invoicePrefix", dest.invoicePrefix, inv);
    }
    if (cn != null) {
      if (cn !== dest.creditNotePrefix)
        await checkNumbering(tx, dest, "credit_note", cn, sink("numbering"));
      addField(sec, "creditNotePrefix", dest.creditNotePrefix, cn);
    }
    plan.sections.push(sec);
  }

  if (has("email_sending")) {
    const sec: SectionPlan = {
      section: "email_sending",
      status: status("email_sending"),
      fields: [],
      changes: 0,
    };
    const se = obj(src.emailConfig);
    const de = obj(dest.emailConfig);
    let email: Record<string, unknown> | null = de;
    if (se || de) {
      email = { ...(de ?? {}) };
      for (const k of EMAIL_KEYS) {
        if (se && k in se) email[k] = se[k];
        else delete email[k];
      }
      if (Object.keys(email).length === 0) email = null;
    }
    addField(sec, "emailConfig", dest.emailConfig, email);
    addField(sec, "smtpConfig", dest.smtpConfig, src.smtpConfig);
    addField(sec, "sesConfig", dest.sesConfig, src.sesConfig);
    const smtp = nextSecret(
      "SMTP password",
      src.smtpCredentialsEnc,
      dest.smtpCredentialsEnc,
      readSmtpPassword,
      writeSmtpPassword,
      sink("email_sending"),
    );
    addField(sec, "smtpCredentialsEnc", dest.smtpCredentialsEnc, smtp.next, {
      srcEnc: src.smtpCredentialsEnc,
      note: smtp.note,
    });
    const ses = nextSecret(
      "SES secret key",
      src.sesCredentialsEnc,
      dest.sesCredentialsEnc,
      readSesSecret,
      writeSesSecret,
      sink("email_sending"),
    );
    addField(sec, "sesCredentialsEnc", dest.sesCredentialsEnc, ses.next, {
      srcEnc: src.sesCredentialsEnc,
      note: ses.note,
    });
    plan.sections.push(sec);
  }

  // A section a live destination takes only under the override writes nothing without it.
  if (live && !override) {
    for (const sec of plan.sections) {
      if (sec.status !== "needs_live_override" || sec.section === "tax_rates") continue;
      for (const f of sec.fields ?? []) {
        delete (plan.patch as Record<string, unknown>)[f.column];
        delete plan.auditBefore[snake(String(f.column))];
        delete plan.auditAfter[snake(String(f.column))];
      }
    }
  }

  plan.digest = sha(canon(digestParts));
  return plan;
}

/** True when a pair would write nothing at all. */
export function planIsEmpty(plan: PairPlan): boolean {
  return Object.keys(plan.patch).length === 0 && plan.taxChanges === 0;
}

// ── serialization ────────────────────────────────────────────────────────────────────────

const shown = (f: FieldChange, v: unknown) => (f.secret ? (v ? MASK : null) : (v ?? null));

/** The API shape of a pair plan. Secrets are masked; nothing here can carry an envelope. */
export function serializePairPlan(plan: PairPlan) {
  return {
    source_business: plan.source.publicId,
    destination_business: plan.destination.publicId,
    destination_name: plan.destination.name,
    destination_livemode: plan.destination.livemode,
    clear_first: plan.wipe,
    blockers: plan.blockers,
    sections: plan.sections.map((s) => ({
      section: s.section,
      status: s.status,
      changes: s.changes,
      ...(s.objects
        ? {
            objects: {
              create: s.objects.create,
              existing: s.objects.existing,
              existing_action: s.objects.existingAction,
              ...(s.objects.deleted != null ? { deleted: s.objects.deleted } : {}),
            },
          }
        : {}),
      ...(s.fields
        ? {
            fields: s.fields.map((f) => ({
              field: snake(String(f.column)).replace(/_enc$/, ""),
              from: shown(f, f.from),
              to: shown(f, f.to),
              changed: f.changed,
              secret: f.secret,
            })),
          }
        : {}),
      ...(s.tax ? { tax: s.tax } : {}),
    })),
  };
}
