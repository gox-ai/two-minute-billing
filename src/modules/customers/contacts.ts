import { and, asc, eq } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { publicId } from "@/platform/ids";
import { emitEvent } from "@/modules/events/emit";
import { buildEventData, type EventType } from "@/modules/events/registry";
import { contacts, customers } from "@db/schema";

export class ContactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContactError";
  }
}

/** GDPR: once a customer's data is cleared, their contacts can't hold PII either. */
async function assertNotPiiCleared(tx: Tx, customerId: string): Promise<void> {
  const [cust] = await tx
    .select({ piiCleared: customers.piiCleared })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (cust?.piiCleared === "cleared")
    throw new ContactError(
      "You cannot set contact personal data on a customer whose data is cleared (GDPR)",
    );
}

const CONTACT_PII_FIELDS = ["firstName", "lastName", "email", "phone"] as const;

/** Contact events nest under the owning customer; the contact rides in `extra`. */
async function emitContactEvent(
  tx: Tx,
  type: EventType,
  contact: typeof contacts.$inferSelect,
): Promise<void> {
  const [cust] = await tx
    .select({ publicId: customers.publicId })
    .from(customers)
    .where(eq(customers.id, contact.customerId))
    .limit(1);
  await emitEvent(tx, {
    organizationId: contact.organizationId,
    businessId: contact.businessId,
    type,
    data: buildEventData(type, { id: cust?.publicId ?? contact.customerId }, null, {
      contact: { id: contact.publicId, email: contact.email, label: contact.label },
    }),
  });
}

interface ContactFields {
  firstName?: string | null;
  lastName?: string | null;
  email?: string;
  phone?: string | null;
  label?: string | null;
  enabled?: boolean;
  sendAccountEmail?: boolean;
  sendBillingEmail?: boolean;
}

export async function listContacts(
  organizationId: string,
  customerId: string,
): Promise<Array<typeof contacts.$inferSelect>> {
  return withTenant(organizationId, async (tx) =>
    tx
      .select()
      .from(contacts)
      .where(eq(contacts.customerId, customerId))
      .orderBy(asc(contacts.createdAt)),
  );
}

export async function createContact(
  input: { organizationId: string; businessId: string; customerId: string } & ContactFields,
): Promise<typeof contacts.$inferSelect> {
  return withTenant(input.organizationId, async (tx) => {
    await assertNotPiiCleared(tx, input.customerId);
    const [c] = await tx
      .insert(contacts)
      .values({
        organizationId: input.organizationId,
        businessId: input.businessId,
        customerId: input.customerId,
        publicId: publicId("con"),
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        email: input.email!,
        phone: input.phone ?? null,
        label: input.label ?? null,
        enabled: input.enabled ?? true,
        sendAccountEmail: input.sendAccountEmail ?? false,
        sendBillingEmail: input.sendBillingEmail ?? false,
      })
      .returning();
    await emitContactEvent(tx, "customer_contact_added", c!);
    return c!;
  });
}

export async function updateContact(
  input: {
    organizationId: string;
    businessId: string;
    customerId: string;
    contactPublicId: string;
  } & ContactFields,
): Promise<typeof contacts.$inferSelect | null> {
  const set: Partial<typeof contacts.$inferInsert> = {};
  if (input.firstName !== undefined) set.firstName = input.firstName;
  if (input.lastName !== undefined) set.lastName = input.lastName;
  if (input.email !== undefined) set.email = input.email;
  if (input.phone !== undefined) set.phone = input.phone;
  if (input.label !== undefined) set.label = input.label;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.sendAccountEmail !== undefined) set.sendAccountEmail = input.sendAccountEmail;
  if (input.sendBillingEmail !== undefined) set.sendBillingEmail = input.sendBillingEmail;
  return withTenant(input.organizationId, async (tx) => {
    // GDPR: block re-populating PII on a cleared customer (a non-PII edit is fine).
    if (CONTACT_PII_FIELDS.some((k) => set[k] !== undefined))
      await assertNotPiiCleared(tx, input.customerId);
    // Scope to the owning customer — a contact PATCH must not touch another
    // customer's contact (review fix: the id was previously business-only scoped).
    const where = and(
      eq(contacts.businessId, input.businessId),
      eq(contacts.customerId, input.customerId),
      eq(contacts.publicId, input.contactPublicId),
    );
    if (Object.keys(set).length === 0) {
      const [c] = await tx.select().from(contacts).where(where).limit(1);
      return c ?? null;
    }
    const [c] = await tx.update(contacts).set(set).where(where).returning();
    if (c) await emitContactEvent(tx, "customer_contact_updated", c);
    return c ?? null;
  });
}

export async function deleteContact(
  organizationId: string,
  businessId: string,
  customerId: string,
  contactPublicId: string,
): Promise<boolean> {
  return withTenant(organizationId, async (tx) => {
    const rows = await tx
      .delete(contacts)
      // Scope to the owning customer (review fix).
      .where(
        and(
          eq(contacts.businessId, businessId),
          eq(contacts.customerId, customerId),
          eq(contacts.publicId, contactPublicId),
        ),
      )
      .returning();
    if (rows[0]) await emitContactEvent(tx, "customer_contact_removed", rows[0]);
    return rows.length > 0;
  });
}
