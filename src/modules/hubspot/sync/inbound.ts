import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@/platform/db";
import { currentEventContext, runWithEventContext } from "@/platform/event-context";
import {
  SubdivisionError,
  allCountries,
  isValidCountry,
  normalizeStateCode,
  subdivisionsFor,
} from "@/platform/geo";

import {
  CustomerError,
  updateCustomer,
  type CustomerAddress,
  type CustomerFields,
} from "@/modules/customers/service";
import { updateSubscriptionSettings } from "@/modules/subscriptions/service";
import { CustomFieldError, listDefinitionsTx } from "@/modules/custom-fields/service";
import { customers, hubspotLinks, subscriptions, type HubSpotConflictField } from "@db/schema";
import type { Connection } from "../client";
import type { HubSpotSettings } from "../settings";
import type { SyncContext } from "./context";
import { customerPushHash } from "./customers";
import { subscriptionPushHash } from "./deals";
import type { SyncOutcome } from "./links";
import { markResolved, openConflict, type Conflict } from "./conflicts";

/**
 * HubSpot → billing for one linked record. A property counts as changed in HubSpot when it differs
 * from the value we last saw there (`hubspot_links.remote_values`) and from ours. Writes go through
 * the customer and subscription services, so every validation rule applies.
 */

export type PullObject = "contacts" | "companies" | "deals";
export const REMOTE_TYPE = { contacts: "contact", companies: "company", deals: "deal" } as const;
export const LOCAL_TYPE = {
  contacts: "customer",
  companies: "customer",
  deals: "subscription",
} as const;

type Link = typeof hubspotLinks.$inferSelect;
type Customer = typeof customers.$inferSelect;
type Subscription = typeof subscriptions.$inferSelect;
export interface RemoteRecord {
  id: string;
  properties: Record<string, string | null>;
  updatedAt: Date;
}
interface PullField {
  remote: string;
  local: string;
}
interface Change {
  field: PullField;
  value: unknown;
  ours: string | null;
  theirs: string | null;
}
type CfTypes = Map<string, string>;

/** A first sighting modified no later than this after our own push is our write, not an edit. */
const OWN_WRITE_SLACK_MS = 60_000;

/** Customer fields a HubSpot value may overwrite. Ids, money and dates are ours alone. */
const WRITABLE_CUSTOMER = new Set([
  "email",
  "first_name",
  "last_name",
  "phone",
  "company",
  "locale",
  "auto_collection",
  "net_term_days",
  "vat_number",
  "billing_line1",
  "billing_city",
  "billing_state",
  "billing_zip",
  "billing_country",
]);
/** The engine owns subscription state: only plain settings with no billing side effect are pulled. */
const WRITABLE_SUBSCRIPTION = new Set(["auto_collection"]);

const LABEL: Record<string, string> = {
  email: "Email",
  first_name: "First name",
  last_name: "Last name",
  phone: "Phone",
  company: "Company name",
  locale: "Language",
  auto_collection: "Auto-collection",
  net_term_days: "Net term (days)",
  vat_number: "VAT number",
  contact_address: "Billing address",
  billing_line1: "Billing address line 1",
  billing_line2: "Billing address line 2",
  billing_city: "Billing city",
  billing_state: "Billing state",
  billing_zip: "Billing postcode",
  billing_country: "Billing country",
};
const ADDRESS_FIELDS = new Set([
  "contact_address",
  "billing_line1",
  "billing_line2",
  "billing_city",
  "billing_state",
  "billing_zip",
  "billing_country",
]);

/**
 * Fields the settings keep out of a pull. Still read and baselined in `remote_values`, so turning
 * a switch on later does not replay edits made while it was off.
 */
export function heldBack(s: HubSpotSettings): (local: string) => boolean {
  const { pullAddress, pullEmail } = s.updates;
  return (local) =>
    (!pullAddress && ADDRESS_FIELDS.has(local)) || (!pullEmail && local === "email");
}

const labelOf = (local: string) =>
  local.startsWith("cf_") ? local.slice(3) : (LABEL[local] ?? local);

export const isWritable = (object: PullObject, local: string) =>
  local.startsWith("cf_") ||
  (object === "deals" ? WRITABLE_SUBSCRIPTION : WRITABLE_CUSTOMER).has(local);

/**
 * HubSpot property → our field, for every property a pull reads. Standard ones mirror what a push
 * writes; the contact's free-text `company` only while companies are not synced (the company's
 * `name` owns it otherwise). Email is pulled but guarded in `guardEmail`.
 */
export function pullFields(s: HubSpotSettings, object: PullObject): PullField[] {
  const c = s.customers;
  const out = new Map<string, string>();
  const address = !c.billingAddressViaCustomFields;
  if (object === "contacts") {
    Object.entries({
      firstname: "first_name",
      lastname: "last_name",
      phone: "phone",
      email: "email",
    }).forEach(([r, l]) => out.set(r, l));
    if (!c.companyMatch) out.set("company", "company");
    if (address)
      Object.entries({
        address: "contact_address",
        city: "billing_city",
        state: "billing_state",
        zip: "billing_zip",
        country: "billing_country",
      }).forEach(([r, l]) => out.set(r, l));
  } else if (object === "companies") {
    out.set("name", "company");
    if (address)
      Object.entries({
        address: "billing_line1",
        address2: "billing_line2",
        city: "billing_city",
        state: "billing_state",
        zip: "billing_zip",
        country: "billing_country",
      }).forEach(([r, l]) => out.set(r, l));
  }
  const mapped =
    object === "deals" ? s.deals.fields : object === "contacts" ? c.contactFields : c.companyFields;
  for (const m of mapped)
    if (m.direction !== "to_remote" && isWritable(object, m.local)) out.set(m.remote, m.local);
  return [...out].map(([remote, local]) => ({ remote, local }));
}

// ── Values ────────────────────────────────────────────────────────────────────

type Parsed = { ok: true; value: unknown; key: string | null } | { ok: false; reason: string };

const emailSchema = z.string().email();
const trim = (v: unknown) => (v == null ? "" : String(v).trim());

function parseDate(s: string): string | null {
  if (/^-?\d+$/.test(s)) {
    const d = new Date(Number(s));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** HubSpot string → our typed value, plus a comparable key. A blank is `{ value: null, key: null }`. */
function parseRemote(local: string, raw: unknown, cfTypes: CfTypes): Parsed {
  const s = trim(raw);
  if (s === "") return { ok: true, value: null, key: null };
  const bool = (): Parsed =>
    s === "true"
      ? { ok: true, value: true, key: "true" }
      : s === "false"
        ? { ok: true, value: false, key: "false" }
        : { ok: false, reason: `"${s}" is not true or false` };
  switch (local) {
    case "email": {
      const e = s.toLowerCase();
      return emailSchema.safeParse(e).success
        ? { ok: true, value: e, key: e }
        : { ok: false, reason: `"${s}" is not an email address` };
    }
    case "auto_collection": {
      const b = bool();
      return b.ok ? { ok: true, value: b.value ? "on" : "off", key: b.key } : b;
    }
    case "net_term_days":
      return /^\d{1,4}$/.test(s)
        ? { ok: true, value: Number(s), key: String(Number(s)) }
        : { ok: false, reason: `"${s}" is not a whole number of days` };
    case "billing_country": {
      const code = countryCodeFrom(s);
      return code
        ? { ok: true, value: code, key: code }
        : { ok: false, reason: `"${s}" is not a country we recognize` };
    }
  }
  if (local.startsWith("cf_")) {
    switch (cfTypes.get(local.slice(3))) {
      case "number": {
        const n = Number(s);
        return Number.isFinite(n)
          ? { ok: true, value: n, key: String(n) }
          : { ok: false, reason: `"${s}" is not a number` };
      }
      case "boolean":
        return bool();
      case "date": {
        const d = parseDate(s);
        return d ? { ok: true, value: d, key: d } : { ok: false, reason: `"${s}" is not a date` };
      }
    }
  }
  return { ok: true, value: s, key: s };
}

function cfKey(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return String(v).trim() || null;
}

const text = (v: string | null | undefined) => v?.trim() || null;
const join = (...parts: Array<string | null | undefined>) =>
  parts.filter((p) => p && p.trim()).join(", ") || null;

function customerKey(c: Customer, local: string): string | null {
  switch (local) {
    case "email":
      return c.email?.trim().toLowerCase() || null;
    case "first_name":
      return text(c.firstName);
    case "last_name":
      return text(c.lastName);
    case "phone":
      return text(c.phone);
    case "company":
      return text(c.company);
    case "locale":
      return text(c.locale);
    case "auto_collection":
      return c.autoCollection === "on" ? "true" : "false";
    case "net_term_days":
      return String(c.netTermDays);
    case "vat_number":
      return text(c.vatNumber);
    case "contact_address":
      return join(c.addressLine1, join(c.addressLine2, c.addressLine3));
    case "billing_line1":
      return text(c.addressLine1);
    case "billing_line2":
      return join(c.addressLine2, c.addressLine3);
    case "billing_city":
      return text(c.city);
    case "billing_state":
      return text(c.state);
    case "billing_zip":
      return text(c.postalCode);
    case "billing_country":
      return c.country?.trim().toUpperCase() || null;
  }
  return local.startsWith("cf_")
    ? cfKey((c.customFields as Record<string, unknown> | null)?.[local.slice(3)])
    : null;
}

function subscriptionKey(s: Subscription, local: string): string | null {
  if (local === "auto_collection")
    return s.autoCollection ? String(s.autoCollection === "on") : null;
  return local.startsWith("cf_")
    ? cfKey((s.customFields as Record<string, unknown> | null)?.[local.slice(3)])
    : null;
}

export async function cfTypesFor(conn: Connection, object: PullObject): Promise<CfTypes> {
  const defs = await withTenant(conn.organizationId, (tx) =>
    listDefinitionsTx(tx, conn.businessId, {
      entityType: LOCAL_TYPE[object],
      includeArchived: true,
    }),
  );
  return new Map(defs.map((d) => [d.apiName, d.dataType]));
}

/**
 * What HubSpot changed. `snapshot` null + `baseline` records what HubSpot holds without writing;
 * `snapshot` null alone compares every property with ours.
 */
function diff(
  fields: PullField[],
  remote: RemoteRecord,
  snapshot: Record<string, string | null> | null,
  opts: {
    baseline: boolean;
    blankOverwrites: boolean;
    cfTypes: CfTypes;
    ours: (local: string) => string | null;
    held: (local: string) => boolean;
  },
) {
  const changes: Change[] = [];
  const notes: string[] = [];
  const seen: Record<string, string | null> = {};
  for (const f of fields) {
    const raw = remote.properties[f.remote];
    const p = parseRemote(f.local, raw, opts.cfTypes);
    const key = p.ok ? p.key : trim(raw) || null;
    seen[f.remote] = key;
    if (opts.baseline || opts.held(f.local)) continue;
    if (snapshot && f.remote in snapshot) {
      // A pushed value is stored as sent (a date as epoch ms), so both sides are normalized.
      const was = parseRemote(f.local, snapshot[f.remote], opts.cfTypes);
      if ((was.ok ? was.key : trim(snapshot[f.remote]) || null) === key) continue;
    }
    if (!p.ok) {
      notes.push(`${labelOf(f.local)} not pulled: ${p.reason}`);
      continue;
    }
    if (p.key === null && !opts.blankOverwrites) continue;
    const ours = opts.ours(f.local);
    if (ours === p.key) continue;
    changes.push({ field: f, value: p.value, ours, theirs: p.key });
  }
  return { changes, notes, seen };
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Email is how contacts are matched and where invoices go: never take one another customer holds. */
async function guardEmail(
  conn: Connection,
  customer: Customer,
  changes: Change[],
  notes: string[],
) {
  const i = changes.findIndex((c) => c.field.local === "email");
  if (i < 0) return;
  const email = changes[i]!.value as string;
  const [taken] = await withTenant(conn.organizationId, (tx) =>
    tx
      .select({ id: customers.id })
      .from(customers)
      .where(
        and(
          eq(customers.businessId, conn.businessId),
          ne(customers.id, customer.id),
          sql`lower(${customers.email}) = ${email}`,
        ),
      )
      .limit(1),
  );
  if (taken) {
    changes.splice(i, 1);
    notes.push(`Email not pulled: another customer already uses ${email}`);
  }
}

const hubspotContext = (conn: Connection) => ({
  source: "hubspot" as const,
  actor: `hubspot:${conn.portalId}:sync`,
});

async function applyToCustomer(
  conn: Connection,
  customer: Customer,
  changes: Change[],
): Promise<void> {
  const input: CustomerFields = {};
  const cf: Record<string, unknown> = {};
  let addr: CustomerAddress | null = null;
  const a = () =>
    (addr ??= {
      line1: customer.addressLine1,
      line2: customer.addressLine2,
      line3: customer.addressLine3,
      city: customer.city,
      state: customer.state,
      stateCode: customer.stateCode,
      postalCode: customer.postalCode,
      country: customer.country,
      firstName: customer.billingFirstName,
      lastName: customer.billingLastName,
      company: customer.billingCompany,
      phone: customer.billingPhone,
    });
  for (const { field, value } of changes) {
    const v = value as never;
    switch (field.local) {
      case "email":
        input.email = v;
        break;
      case "first_name":
        input.firstName = v;
        break;
      case "last_name":
        input.lastName = v;
        break;
      case "phone":
        input.phone = v;
        break;
      case "company":
        input.company = v;
        break;
      case "locale":
        input.locale = v;
        break;
      case "vat_number":
        input.vatNumber = v;
        break;
      case "auto_collection":
        input.autoCollection = v;
        break;
      case "net_term_days":
        input.netTermDays = v;
        break;
      case "contact_address":
        Object.assign(a(), { line1: v, line2: null, line3: null });
        break;
      case "billing_line1":
        a().line1 = v;
        break;
      case "billing_line2":
        Object.assign(a(), { line2: v, line3: null });
        break;
      case "billing_city":
        a().city = v;
        break;
      case "billing_state":
        a().state = v;
        break;
      case "billing_zip":
        a().postalCode = v;
        break;
      case "billing_country":
        a().country = v;
        break;
      default:
        if (field.local.startsWith("cf_")) cf[field.local.slice(3)] = value ?? "";
    }
  }
  const address = addr as CustomerAddress | null;
  if (address && (address.state !== customer.state || address.country !== customer.country)) {
    // The tax code follows the new state only when HubSpot's value names a real subdivision.
    address.stateCode = stateCodeFrom(address.country, address.state);
  }
  await runWithEventContext(hubspotContext(conn), () =>
    updateCustomer({
      organizationId: conn.organizationId,
      businessId: conn.businessId,
      customerPublicId: customer.publicId,
      expectedVersion: customer.resourceVersion,
      ...input,
      ...(address ? { address } : {}),
      ...(Object.keys(cf).length > 0 ? { customFields: cf } : {}),
    }),
  );
}

async function applyToSubscription(
  conn: Connection,
  sub: Subscription,
  changes: Change[],
): Promise<void> {
  const cf: Record<string, unknown> = {};
  let autoCollection: "on" | "off" | null | undefined;
  for (const { field, value } of changes) {
    if (field.local === "auto_collection") autoCollection = value as "on" | "off" | null;
    else if (field.local.startsWith("cf_")) cf[field.local.slice(3)] = value ?? "";
  }
  await runWithEventContext(hubspotContext(conn), () =>
    updateSubscriptionSettings({
      organizationId: conn.organizationId,
      businessId: conn.businessId,
      subscriptionPublicId: sub.publicId,
      ...(autoCollection !== undefined ? { autoCollection } : {}),
      ...(Object.keys(cf).length > 0 ? { customFields: cf } : {}),
    }),
  );
}

/** Validation the record itself fails; logged and not retried until HubSpot changes it again. */
const isTerminal = (err: unknown) =>
  err instanceof CustomFieldError ||
  err instanceof CustomerError ||
  err instanceof SubdivisionError;

// ── Links ─────────────────────────────────────────────────────────────────────

export async function linksFor(
  conn: Connection,
  object: PullObject,
  remoteIds: string[],
): Promise<Link[]> {
  if (remoteIds.length === 0) return [];
  return withTenant(conn.organizationId, (tx) =>
    tx
      .select()
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.businessId, conn.businessId),
          eq(hubspotLinks.localType, LOCAL_TYPE[object]),
          eq(hubspotLinks.remoteType, REMOTE_TYPE[object]),
          inArray(hubspotLinks.remoteId, remoteIds),
        ),
      ),
  );
}

async function markSeen(
  conn: Connection,
  link: Link,
  remote: RemoteRecord,
  seen: Record<string, string | null>,
  hash?: string,
) {
  await withTenant(conn.organizationId, (tx) =>
    tx
      .update(hubspotLinks)
      .set({
        remoteUpdatedAt: remote.updatedAt,
        lastPulledAt: new Date(),
        remoteValues: { ...(link.remoteValues ?? {}), ...seen },
        ...(hash !== undefined ? { lastPushedHash: hash } : {}),
      })
      .where(and(eq(hubspotLinks.id, link.id), eq(hubspotLinks.businessId, conn.businessId))),
  );
}

async function enqueuePush(conn: Connection, type: string, id: string) {
  await withTenant(conn.organizationId, (tx) =>
    tx.execute(sql`
      INSERT INTO hubspot_sync_queue (organization_id, business_id, connection_id, resource_type, resource_id, reason)
      VALUES (${conn.organizationId}, ${conn.businessId}, ${conn.id}, ${type}, ${id}, 'hubspot_conflict')
      ON CONFLICT (connection_id, resource_type, resource_id) WHERE locked_at IS NULL
      DO UPDATE SET reason = EXCLUDED.reason
    `),
  );
}

// ── One record ────────────────────────────────────────────────────────────────

type Local = { kind: "customer"; row: Customer } | { kind: "subscription"; row: Subscription };

async function loadLocal(
  conn: Connection,
  object: PullObject,
  localId: string,
): Promise<Local | null> {
  return withTenant(conn.organizationId, async (tx) => {
    if (object === "deals") {
      const [row] = await tx
        .select()
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.id, localId),
            eq(subscriptions.businessId, conn.businessId),
            isNull(subscriptions.deletedAt),
          ),
        )
        .limit(1);
      return row ? { kind: "subscription" as const, row } : null;
    }
    const [row] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.id, localId), eq(customers.businessId, conn.businessId)))
      .limit(1);
    return row ? { kind: "customer" as const, row } : null;
  });
}

const keyOf = (local: Local) => (f: string) =>
  local.kind === "customer" ? customerKey(local.row, f) : subscriptionKey(local.row, f);

async function pushHash(
  ctx: SyncContext,
  object: PullObject,
  local: Local,
): Promise<string | null> {
  return local.kind === "customer"
    ? customerPushHash(ctx, local.row, REMOTE_TYPE[object] as "contact" | "company")
    : subscriptionPushHash(ctx, local.row.id);
}

async function apply(conn: Connection, local: Local, changes: Change[]) {
  if (local.kind === "customer") await applyToCustomer(conn, local.row, changes);
  else await applyToSubscription(conn, local.row, changes);
}

const names = (changes: Change[]) => changes.map((c) => labelOf(c.field.local)).join(", ");

/**
 * Pull one HubSpot record into one linked local record. Returns null when there was nothing to
 * log. Throws only for what a later pass may fix (a concurrent edit, the database, HubSpot).
 */
export async function pullRecord(
  ctx: SyncContext,
  object: PullObject,
  remote: RemoteRecord,
  link: Link,
  cfTypes: CfTypes,
): Promise<SyncOutcome | null> {
  const { conn, settings } = ctx;
  if (link.remoteUpdatedAt && remote.updatedAt.getTime() <= link.remoteUpdatedAt.getTime())
    return null;
  const local = await loadLocal(conn, object, link.localId);
  if (!local) return null;

  const base = {
    localType: local.kind,
    localRef: local.row.publicId,
    remoteType: REMOTE_TYPE[object],
    remoteId: remote.id,
  };
  const snapshot = link.remoteValues ?? null;
  const baseline =
    !snapshot &&
    !!link.lastPushedAt &&
    remote.updatedAt.getTime() <= link.lastPushedAt.getTime() + OWN_WRITE_SLACK_MS;
  const { changes, notes, seen } = diff(pullFields(settings, object), remote, snapshot, {
    baseline,
    blankOverwrites: object === "deals",
    cfTypes,
    ours: keyOf(local),
    held: heldBack(settings),
  });
  if (local.kind === "customer") {
    if (local.row.piiCleared === "cleared") changes.length = 0;
    else await guardEmail(conn, local.row, changes, notes);
  }

  const note = notes.join("; ");
  if (changes.length === 0) {
    await markSeen(conn, link, remote, seen);
    return notes.length > 0 ? { ...base, action: "skipped", message: note } : null;
  }

  // Ours moved too when a push now would write something other than what it last wrote.
  const localChanged =
    settings.updates.localChange === "overwrite_remote" &&
    link.lastPushedHash !== null &&
    (await pushHash(ctx, object, local)) !== link.lastPushedHash;

  if (localChanged && settings.updates.conflict === "flag") {
    await openConflict(conn, {
      localType: local.kind,
      localId: local.row.id,
      localRef: local.row.publicId,
      remoteType: REMOTE_TYPE[object],
      remoteId: remote.id,
      remoteUpdatedAt: remote.updatedAt,
      fields: changes.map<HubSpotConflictField>((c) => ({
        local: c.field.local,
        remote: c.field.remote,
        label: labelOf(c.field.local),
        ours: c.ours,
        theirs: c.theirs,
      })),
    });
    return {
      ...base,
      action: "skipped",
      message: "Changed here and in HubSpot. Flagged for a decision.",
    };
  }
  if (localChanged && settings.updates.conflict === "local_wins") {
    await markSeen(conn, link, remote, seen);
    await enqueuePush(conn, local.kind, local.row.id);
    return {
      ...base,
      action: "skipped",
      message: "Changed here and in HubSpot. We kept ours and will update HubSpot.",
    };
  }

  try {
    await apply(conn, local, changes);
  } catch (err) {
    if (!isTerminal(err)) throw err;
    await markSeen(conn, link, remote, seen);
    return {
      ...base,
      action: "failed",
      message: `We could not apply the HubSpot changes: ${(err as Error).message}`,
    };
  }

  if (localChanged) {
    // remote_wins: the queued push re-reads the record, so it carries HubSpot's values, not the stale ones.
    await markSeen(conn, link, remote, seen);
    await enqueuePush(conn, local.kind, local.row.id);
    return {
      ...base,
      action: "updated",
      message: [`Changed here and in HubSpot. We took HubSpot's ${names(changes)}`, note]
        .filter(Boolean)
        .join("; "),
    };
  }

  // In step with HubSpot now: store what a push would write, so the echo push is a no-op.
  const fresh = await loadLocal(conn, object, local.row.id);
  const hash =
    link.lastPushedHash !== null && fresh
      ? ((await pushHash(ctx, object, fresh)) ?? undefined)
      : undefined;
  await markSeen(conn, link, remote, seen, hash);
  return {
    ...base,
    action: "updated",
    message: [`Pulled from HubSpot: ${names(changes)}`, note].filter(Boolean).join("; "),
  };
}

// ── Conflict resolution ───────────────────────────────────────────────────────

export class ConflictGoneError extends Error {}

const OBJECT_OF: Record<string, PullObject> = {
  contact: "contacts",
  company: "companies",
  deal: "deals",
};

async function linkOf(conn: Connection, c: Conflict): Promise<Link | null> {
  const [row] = await withTenant(conn.organizationId, (tx) =>
    tx
      .select()
      .from(hubspotLinks)
      .where(
        and(
          eq(hubspotLinks.connectionId, conn.id),
          eq(hubspotLinks.businessId, conn.businessId),
          eq(hubspotLinks.localType, c.localType),
          eq(hubspotLinks.localId, c.localId),
          eq(hubspotLinks.remoteType, c.remoteType),
        ),
      )
      .limit(1),
  );
  return row ?? null;
}

/**
 * `ours`: the next push writes our record whatever its hash. `theirs`: HubSpot's current values for
 * the conflicting fields land here, then the push sends the merged record back.
 */
export async function resolveConflict(
  ctx: SyncContext,
  conflict: Conflict,
  keep: "ours" | "theirs",
): Promise<Conflict> {
  const { conn } = ctx;
  const object = OBJECT_OF[conflict.remoteType]!;
  const link = await linkOf(conn, conflict);
  const by = currentEventContext()?.actor ?? null;

  if (keep === "theirs" && link) {
    const local = await loadLocal(conn, object, conflict.localId);
    const wanted = new Set(conflict.fields.map((f) => f.remote));
    const fields = pullFields(ctx.settings, object).filter((f) => wanted.has(f.remote));
    const res = await ctx.client.request<{
      results?: Array<{
        id: string;
        properties?: Record<string, string | null>;
        updatedAt?: string;
      }>;
    }>("POST", `/crm/v3/objects/${object}/batch/read`, {
      inputs: [{ id: conflict.remoteId }],
      properties: fields.map((f) => f.remote),
    });
    const found = res?.results?.find((r) => String(r.id) === conflict.remoteId);
    if (local && found) {
      const remote: RemoteRecord = {
        id: conflict.remoteId,
        properties: found.properties ?? {},
        updatedAt: found.updatedAt
          ? new Date(found.updatedAt)
          : (conflict.remoteUpdatedAt ?? new Date()),
      };
      const cfTypes = await cfTypesFor(conn, object);
      const { changes, seen } = diff(fields, remote, null, {
        baseline: false,
        blankOverwrites: object === "deals",
        cfTypes,
        ours: keyOf(local),
        held: heldBack(ctx.settings),
      });
      if (local.kind === "customer") await guardEmail(conn, local.row, changes, []);
      if (changes.length > 0) await apply(conn, local, changes);
      await markSeen(conn, link, remote, seen);
    }
  }

  return withTenant(conn.organizationId, async (tx) => {
    const done = await markResolved(tx, conflict, keep, by);
    if (!done) throw new ConflictGoneError("This conflict was already resolved");
    if (link && keep === "ours") {
      const theirs = Object.fromEntries(conflict.fields.map((f) => [f.remote, f.theirs]));
      await tx
        .update(hubspotLinks)
        .set({
          lastPushedHash: null,
          remoteValues: { ...(link.remoteValues ?? {}), ...theirs },
          ...(conflict.remoteUpdatedAt ? { remoteUpdatedAt: conflict.remoteUpdatedAt } : {}),
        })
        .where(eq(hubspotLinks.id, link.id));
    }
    await tx.execute(sql`
      INSERT INTO hubspot_sync_queue (organization_id, business_id, connection_id, resource_type, resource_id, reason)
      VALUES (${conn.organizationId}, ${conn.businessId}, ${conn.id}, ${conflict.localType}, ${conflict.localId}, 'hubspot_conflict_resolved')
      ON CONFLICT (connection_id, resource_type, resource_id) WHERE locked_at IS NULL
      DO UPDATE SET reason = EXCLUDED.reason
    `);
    return done;
  });
}

/** HubSpot's country is free text: an ISO code or a country name we hold. Null otherwise. */
function countryCodeFrom(raw: string): string | null {
  const s = raw.trim();
  if (/^[A-Za-z]{2}$/.test(s) && isValidCountry(s)) return s.toUpperCase();
  const lower = s.toLowerCase();
  return allCountries().find((c) => c.name.toLowerCase() === lower)?.code ?? null;
}

/**
 * The subdivision code for a state HubSpot gave as a code or a name. Null when it matches no
 * listed subdivision — free text must never become a tax code.
 */
function stateCodeFrom(
  country: string | null | undefined,
  state: string | null | undefined,
): string | null {
  if (!country || !state?.trim()) return null;
  const subs = subdivisionsFor(country);
  if (!subs) return null;
  const code = normalizeStateCode(country, state.trim());
  const byCode = subs.find((x) => x.value === code);
  if (byCode) return byCode.value;
  const name = state.trim().toLowerCase();
  return subs.find((x) => x.label.toLowerCase() === name)?.value ?? null;
}
