import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData, type EventType } from "@/modules/events/registry";
import { customerAddresses, customers, subscriptions } from "@db/schema";
import { normalizeShippingAddress } from "./serialize";

/**
 * The shipping address book (0360). One live default per customer, mirrored into
 * `customers.shipping_address` so readers of the old single-address field keep working.
 * Every write here re-syncs the mirror in the same transaction.
 */

export type AddressRow = typeof customerAddresses.$inferSelect;

export class ShippingAddressError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 409 = 400,
  ) {
    super(message);
    this.name = "ShippingAddressError";
  }
}

/** The address fields, camelCase. `undefined` = leave alone on update. */
export interface ShippingAddressFields {
  label?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  state?: string | null;
  stateCode?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

const FIELD_KEYS = [
  "label",
  "firstName",
  "lastName",
  "company",
  "phone",
  "line1",
  "line2",
  "line3",
  "city",
  "state",
  "stateCode",
  "postalCode",
  "country",
] as const satisfies ReadonlyArray<keyof ShippingAddressFields>;

const blank = (v: string | null | undefined) =>
  v === undefined ? undefined : v == null || v.trim() === "" ? null : v.trim();

function toColumns(f: ShippingAddressFields): Partial<typeof customerAddresses.$inferInsert> {
  const out: Partial<typeof customerAddresses.$inferInsert> = {};
  for (const k of FIELD_KEYS) {
    const v = blank(f[k]);
    if (v !== undefined) out[k] = k === "country" && v ? v.toUpperCase() : v;
  }
  return out;
}

/**
 * The canonical snake_case address object (the `shipping_address` shape used by the
 * customer mirror, invoice snapshots and the PDF). No label: it is a book entry's name,
 * not part of where the parcel goes.
 */
export function addressObject(row: AddressRow): Record<string, string | null> {
  return {
    line1: row.line1,
    line2: row.line2,
    line3: row.line3,
    city: row.city,
    state: row.state,
    state_code: row.stateCode,
    postal_code: row.postalCode,
    country: row.country,
    first_name: row.firstName,
    last_name: row.lastName,
    company: row.company,
    phone: row.phone,
  };
}

/** The legacy single-address shape → book fields (accepts `zip` and noise via normalize). */
export function fieldsFromAddressObject(raw: unknown): ShippingAddressFields | null {
  const a = normalizeShippingAddress(raw);
  if (!a) return null;
  return {
    firstName: a.first_name,
    lastName: a.last_name,
    company: a.company,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    line3: a.line3,
    city: a.city,
    state: a.state,
    stateCode: a.state_code,
    postalCode: a.postal_code,
    country: a.country,
  };
}

export function serializeShippingAddress(row: AddressRow, customerPublicId?: string) {
  return {
    object: "shipping_address",
    id: row.publicId,
    ...(customerPublicId ? { customer_id: customerPublicId } : {}),
    label: row.label,
    ...addressObject(row),
    is_default: row.isDefault,
    archived: row.archivedAt != null,
    archived_at: row.archivedAt,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function assertWritable(tx: Tx, customerId: string): Promise<{ publicId: string }> {
  const [cust] = await tx
    .select({ publicId: customers.publicId, piiCleared: customers.piiCleared })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!cust) throw new ShippingAddressError("No such customer");
  if (cust.piiCleared === "cleared")
    throw new ShippingAddressError(
      "You cannot add an address to a customer whose personal data is cleared",
    );
  return cust;
}

/** A shipping address needs somewhere to go: a first line and a country. */
function assertDeliverable(row: Partial<typeof customerAddresses.$inferInsert>): void {
  if (!row.line1 || !row.country)
    throw new ShippingAddressError("A shipping address needs at least line1 and country");
}

/**
 * The mirror value a legacy `shipping_address` write leads to. Callers that write the
 * customer row anyway store this, so the later sync is a no-op and the row is not bumped
 * twice.
 */
export function legacyShippingMirror(raw: unknown): Record<string, string | null> | null {
  const fields = fieldsFromAddressObject(raw);
  if (!fields) return null;
  const c = toColumns(fields);
  return {
    line1: c.line1 ?? null,
    line2: c.line2 ?? null,
    line3: c.line3 ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    state_code: c.stateCode ?? null,
    postal_code: c.postalCode ?? null,
    country: c.country ?? null,
    first_name: c.firstName ?? null,
    last_name: c.lastName ?? null,
    company: c.company ?? null,
    phone: c.phone ?? null,
  };
}

/** Re-point `customers.shipping_address` at the current default (or null). */
export async function syncShippingMirror(tx: Tx, customerId: string): Promise<void> {
  const [def] = await tx
    .select()
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.customerId, customerId),
        eq(customerAddresses.isDefault, true),
        isNull(customerAddresses.archivedAt),
      ),
    )
    .limit(1);
  const mirror = def ? addressObject(def) : null;
  // Unchanged → no write, so `resource_version` moves once per real change.
  await tx
    .update(customers)
    .set({ shippingAddress: mirror })
    .where(
      and(
        eq(customers.id, customerId),
        sql`${customers.shippingAddress} IS DISTINCT FROM ${JSON.stringify(mirror)}::jsonb`,
      ),
    );
}

/** Drop the default flag from every other live row, so `row` can take it. */
async function clearOtherDefaults(tx: Tx, customerId: string, keepId?: string): Promise<void> {
  await tx
    .update(customerAddresses)
    .set({ isDefault: false })
    .where(
      and(
        eq(customerAddresses.customerId, customerId),
        eq(customerAddresses.isDefault, true),
        ...(keepId ? [ne(customerAddresses.id, keepId)] : []),
      ),
    );
}

async function emitAddressEvent(
  tx: Tx,
  type: EventType,
  row: AddressRow,
  customerPublicId: string,
): Promise<void> {
  await emitEvent(tx, {
    organizationId: row.organizationId,
    businessId: row.businessId,
    type,
    data: buildEventData(type, { id: customerPublicId }, null, {
      shipping_address: serializeShippingAddress(row),
    }),
  });
}

export async function listShippingAddresses(
  organizationId: string,
  customerId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<AddressRow[]> {
  return withTenant(organizationId, (tx) =>
    tx
      .select()
      .from(customerAddresses)
      .where(
        and(
          eq(customerAddresses.customerId, customerId),
          ...(opts.includeArchived ? [] : [isNull(customerAddresses.archivedAt)]),
        ),
      )
      .orderBy(asc(customerAddresses.createdAt)),
  );
}

export async function findShippingAddress(
  tx: Tx,
  businessId: string,
  customerId: string,
  addressPublicId: string,
): Promise<AddressRow | null> {
  const [row] = await tx
    .select()
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.businessId, businessId),
        eq(customerAddresses.customerId, customerId),
        eq(customerAddresses.publicId, addressPublicId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Insert inside a caller's transaction. The first live address becomes the default. */
export async function insertShippingAddress(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    fields: ShippingAddressFields;
    makeDefault?: boolean;
    emit?: boolean;
  },
): Promise<AddressRow> {
  const cust = await assertWritable(tx, input.customerId);
  const cols = toColumns(input.fields);
  assertDeliverable(cols);
  const [existingDefault] = await tx
    .select({ id: customerAddresses.id })
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.customerId, input.customerId),
        eq(customerAddresses.isDefault, true),
        isNull(customerAddresses.archivedAt),
      ),
    )
    .limit(1);
  const isDefault = input.makeDefault === true || !existingDefault;
  if (isDefault) await clearOtherDefaults(tx, input.customerId);
  const [row] = await tx
    .insert(customerAddresses)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      publicId: publicId("addr"),
      ...cols,
      isDefault,
    })
    .returning();
  if (isDefault) await syncShippingMirror(tx, input.customerId);
  if (input.emit !== false)
    await emitAddressEvent(tx, "customer_shipping_address_added", row!, cust.publicId);
  return row!;
}

export async function createShippingAddress(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  fields: ShippingAddressFields;
  makeDefault?: boolean;
}): Promise<AddressRow> {
  return withTenant(input.organizationId, (tx) => insertShippingAddress(tx, input));
}

/** Update inside a caller's transaction. Null when the address is not this customer's. */
export async function patchShippingAddress(
  tx: Tx,
  input: {
    businessId: string;
    customerId: string;
    addressPublicId: string;
    fields: ShippingAddressFields;
    /** true = make this the default; false = stop it being the default. */
    isDefault?: boolean;
  },
): Promise<AddressRow | null> {
  const current = await findShippingAddress(
    tx,
    input.businessId,
    input.customerId,
    input.addressPublicId,
  );
  if (!current) return null;
  const cust = await assertWritable(tx, input.customerId);
  if (current.archivedAt) throw new ShippingAddressError("You cannot change an archived address");
  const cols = toColumns(input.fields);
  assertDeliverable({ ...current, ...cols });
  if (input.isDefault === true) {
    await clearOtherDefaults(tx, input.customerId, current.id);
    cols.isDefault = true;
  } else if (input.isDefault === false) {
    cols.isDefault = false;
  }
  const [row] =
    Object.keys(cols).length === 0
      ? [current]
      : await tx
          .update(customerAddresses)
          .set(cols)
          .where(eq(customerAddresses.id, current.id))
          .returning();
  if (row!.isDefault || current.isDefault) await syncShippingMirror(tx, input.customerId);
  if (row !== current)
    await emitAddressEvent(tx, "customer_shipping_address_updated", row!, cust.publicId);
  return row!;
}

export async function updateShippingAddress(
  input: { organizationId: string } & Parameters<typeof patchShippingAddress>[1],
): Promise<AddressRow | null> {
  return withTenant(input.organizationId, (tx) => patchShippingAddress(tx, input));
}

/** Subscriptions that would lose their ship-to if `addressId` went away. */
const LIVE_SUB_STATUSES = ["future", "in_trial", "active", "paused"] as const;

/**
 * Archive an address. Refused while a live subscription ships to it: archiving must not
 * silently re-route a delivery to the default. The row stays so invoices and cancelled
 * subscriptions that point at it still resolve.
 */
export async function archiveShippingAddress(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  addressPublicId: string;
}): Promise<AddressRow | null> {
  return withTenant(input.organizationId, async (tx) => {
    const current = await findShippingAddress(
      tx,
      input.businessId,
      input.customerId,
      input.addressPublicId,
    );
    if (!current) return null;
    if (current.archivedAt) return current;
    const users = await tx
      .select({ publicId: subscriptions.publicId })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.shippingAddressId, current.id),
          inArray(subscriptions.status, [...LIVE_SUB_STATUSES]),
          isNull(subscriptions.deletedAt),
        ),
      );
    if (users.length > 0)
      throw new ShippingAddressError(
        `We could not archive this address. Subscription ${users.map((u) => u.publicId).join(", ")} ships to it. Change the subscription's shipping address first.`,
        409,
      );
    // Subscriptions with no address of their own ship to the default, so it is in use too.
    if (current.isDefault) {
      const onDefault = await tx
        .select({ publicId: subscriptions.publicId })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.customerId, input.customerId),
            isNull(subscriptions.shippingAddressId),
            inArray(subscriptions.status, [...LIVE_SUB_STATUSES]),
            isNull(subscriptions.deletedAt),
          ),
        );
      if (onDefault.length > 0)
        throw new ShippingAddressError(
          `We could not archive this address. It is the default, and subscription ${onDefault.map((u) => u.publicId).join(", ")} ships to the default. Make another address the default first.`,
          409,
        );
    }
    const [row] = await tx
      .update(customerAddresses)
      .set({ archivedAt: new Date(), isDefault: false })
      .where(eq(customerAddresses.id, current.id))
      .returning();
    if (current.isDefault) await syncShippingMirror(tx, input.customerId);
    const [cust] = await tx
      .select({ publicId: customers.publicId })
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .limit(1);
    await emitAddressEvent(tx, "customer_shipping_address_archived", row!, cust!.publicId);
    return row!;
  });
}

/** Bring an archived address back. It returns as a non-default entry. */
export async function restoreShippingAddress(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  addressPublicId: string;
}): Promise<AddressRow | null> {
  return withTenant(input.organizationId, async (tx) => {
    const current = await findShippingAddress(
      tx,
      input.businessId,
      input.customerId,
      input.addressPublicId,
    );
    if (!current) return null;
    if (!current.archivedAt) return current;
    const cust = await assertWritable(tx, input.customerId);
    const [row] = await tx
      .update(customerAddresses)
      .set({ archivedAt: null })
      .where(eq(customerAddresses.id, current.id))
      .returning();
    await emitAddressEvent(tx, "customer_shipping_address_updated", row!, cust.publicId);
    return row!;
  });
}

/**
 * The legacy `customer.shipping_address` write: replace the default book entry's fields
 * (insert one when there is none). `null` stops any row being the default; the row stays.
 */
export async function setDefaultShippingFromLegacy(
  tx: Tx,
  input: { organizationId: string; businessId: string; customerId: string; raw: unknown },
): Promise<void> {
  const fields = fieldsFromAddressObject(input.raw);
  const [def] = await tx
    .select()
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.customerId, input.customerId),
        eq(customerAddresses.isDefault, true),
        isNull(customerAddresses.archivedAt),
      ),
    )
    .limit(1);
  const [cust] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!fields) {
    if (def) {
      const [row] = await tx
        .update(customerAddresses)
        .set({ isDefault: false })
        .where(eq(customerAddresses.id, def.id))
        .returning();
      await emitAddressEvent(tx, "customer_shipping_address_updated", row!, cust!.publicId);
    }
    await syncShippingMirror(tx, input.customerId);
    return;
  }
  // Importers may send a partial address; the legacy field never required line1/country,
  // so this path stores what it is given rather than refusing the whole customer write.
  const cols = toColumns(fields);
  if (def) {
    const full = Object.fromEntries(
      FIELD_KEYS.filter((k) => k !== "label").map((k) => [k, cols[k] ?? null]),
    );
    const [row] = await tx
      .update(customerAddresses)
      .set(full)
      .where(eq(customerAddresses.id, def.id))
      .returning();
    await emitAddressEvent(tx, "customer_shipping_address_updated", row!, cust!.publicId);
  } else {
    const [row] = await tx
      .insert(customerAddresses)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        publicId: publicId("addr"),
        ...cols,
        isDefault: true,
      })
      .returning();
    await emitAddressEvent(tx, "customer_shipping_address_added", row!, cust!.publicId);
  }
  await syncShippingMirror(tx, input.customerId);
}

/**
 * Where a subscription ships: its own address-book row when set, else the customer's
 * default. An archived row still resolves — only a cancelled subscription can hold one.
 */
export async function resolveShipTo(
  tx: Tx,
  input: { customerId: string; shippingAddressId?: string | null },
): Promise<AddressRow | null> {
  if (input.shippingAddressId) {
    const [row] = await tx
      .select()
      .from(customerAddresses)
      .where(
        and(
          eq(customerAddresses.id, input.shippingAddressId),
          eq(customerAddresses.customerId, input.customerId),
        ),
      )
      .limit(1);
    if (row) return row;
  }
  const [def] = await tx
    .select()
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.customerId, input.customerId),
        eq(customerAddresses.isDefault, true),
        isNull(customerAddresses.archivedAt),
      ),
    )
    .limit(1);
  return def ?? null;
}

/** The invoice snapshot for a ship-to: the address object, or null. */
export async function shipToSnapshot(
  tx: Tx,
  input: { customerId: string; shippingAddressId?: string | null },
): Promise<Record<string, string | null> | null> {
  const row = await resolveShipTo(tx, input);
  return row ? addressObject(row) : null;
}

/**
 * Resolve a public `addr_…` id the caller wants a subscription to ship to. It must be
 * this customer's and not archived.
 */
export async function resolveAssignableAddress(
  tx: Tx,
  input: { businessId: string; customerId: string; addressPublicId: string },
): Promise<AddressRow> {
  const row = await findShippingAddress(
    tx,
    input.businessId,
    input.customerId,
    input.addressPublicId,
  );
  if (!row)
    throw new ShippingAddressError(
      `No such shipping address for this customer: ${input.addressPublicId}`,
    );
  if (row.archivedAt)
    throw new ShippingAddressError(`Shipping address ${input.addressPublicId} is archived`);
  return row;
}

/** GDPR: the book holds the same data subject's name, phone and addresses. */
export async function deleteShippingAddressesForPii(tx: Tx, customerId: string): Promise<void> {
  await tx.delete(customerAddresses).where(eq(customerAddresses.customerId, customerId));
}
