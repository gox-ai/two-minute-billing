import { eq, inArray } from "drizzle-orm";
import { withTenant, type Tx } from "@/platform/db";
import { paymentMethods, customers, gatewayAccounts } from "@db/schema";
import { gatewayDefinition } from "@/providers/gateway-catalog";

/** The gateway account that vaulted a method, resolved for display. */
export type PaymentMethodGatewayAccount = { publicId: string; label: string };

/**
 * Gateways that have **no customer object of their own**, so the composite
 * reference has only one half.
 *
 * PayPal charges a vaulted token directly and never mints a customer, so its
 * adapter stores OUR customer public id in `provider_customer_id`
 * (`providers/paypal.ts` → `ensureCustomer`). Emitting that half would put a
 * tmbilling id inside a field that claims to be a *gateway* reference — the exact
 * lie this field exists to stop. So PayPal gets the token alone, which is the
 * gateway's complete reference for the instrument.
 */

/**
 * The **gateway's** reference for this instrument — the `Reference ID`,
 * `<gateway customer id>/<gateway token id>`, e.g.
 * `cust_XXXXXXXXXXXX01/token_XXXXXXXXXXXX03`. Both halves come off the payment_methods
 * row itself, which is the
 * authoritative pair: `provider_customer_id` is the customer the token is actually
 * bound to (re-pointed on the stale-SetupIntent path, where it can differ from the
 * `provider_customers` mapping), and `provider_payment_method_id` is the token.
 *
 * It is **not** our `pm_…` id. Rendering `pm_…` under this label was a lie about
 * what the field means — the whole point of the value is that you can paste it into
 * the gateway's dashboard. The importer splits the imported value into exactly these
 * two columns, so imported rows round-trip byte-for-byte.
 *
 * Returns `null` when there is no gateway token to name; callers must render
 * nothing rather than substitute an internal id.
 */
export function gatewayReferenceId(pm: {
  providerKey: string;
  providerCustomerId: string | null;
  providerPaymentMethodId: string | null;
}): string | null {
  const token = pm.providerPaymentMethodId?.trim();
  if (!token) return null;
  const customer = pm.providerCustomerId?.trim();
  if (!customer || gatewayDefinition(pm.providerKey)?.noCustomerIds) return token;
  return `${customer}/${token}`;
}

export function serializePaymentMethod(
  pm: typeof paymentMethods.$inferSelect,
  gatewayAccount?: PaymentMethodGatewayAccount | null,
) {
  return {
    object: "payment_method",
    id: pm.publicId,
    provider: pm.providerKey,
    type: pm.type,
    brand: pm.brand,
    last4: pm.last4,
    exp_month: pm.expMonth,
    exp_year: pm.expYear,
    status: pm.status,
    role: pm.role,
    is_default: pm.role === "primary", // back-compat convenience
    // The gateway account that vaulted (and will charge) this method. Null for
    // legacy env-configured providers, which have no gateway_accounts row.
    gateway_account: gatewayAccount?.publicId ?? null,
    gateway_account_label: gatewayAccount?.label ?? null,
    reference_id: gatewayReferenceId(pm),
    // The mandate this instrument was registered under (0179), or null when it
    // rides no mandate rail. `max_amount_minor` is what the PROVIDER registered and
    // enforces per debit — a charge above it is refused before the gateway is
    // called, so an integrator can pre-empt the same failure we do. Null inside the
    // object means the provider did not report that field: unknown, not unlimited.
    mandate:
      pm.mandateRail || pm.mandateMaxAmountMinor != null || pm.mandateStatus
        ? {
            rail: pm.mandateRail,
            status: pm.mandateStatus,
            max_amount_minor:
              pm.mandateMaxAmountMinor != null ? Number(pm.mandateMaxAmountMinor) : null,
            currency: pm.mandateCurrency,
            expires_at: pm.mandateExpiresAt,
            reference: pm.mandateReference,
          }
        : null,
    // What the GATEWAY knows about the instrument itself (0250/0251): where it was
    // issued, who issued it, what it can do. Captured once, at vault time; rows
    // vaulted before then are backfilled by `scripts/repair-payment-method-details.ts`.
    // Null object = the gateway reported none of it, same shape as `mandate` below.
    //
    // ⚠️ A null `issuer_country` means UNKNOWN, never "not India". RBI's e-mandate and
    // AFA rules bind Indian-issued cards, and `debitNeedsBuyerAuthentication` only lets a
    // KNOWN foreign issuer suppress an AFA claim — a reader that treats null as foreign
    // inverts that.
    //
    // `supports_international` is a usage CAPABILITY, not an origin (RazorPay's
    // `card.international`); `issuer_country` is the origin. They answer different
    // questions and a caller must not substitute one for the other.
    instrument:
      pm.issuerCountry ||
      pm.issuerName ||
      pm.instrumentFunding ||
      pm.instrumentSubType ||
      pm.instrumentFingerprint ||
      pm.supportsInternational != null ||
      pm.supportsRecurring != null ||
      pm.threeDSecureSupported != null
        ? {
            funding: pm.instrumentFunding,
            sub_type: pm.instrumentSubType,
            issuer_country: pm.issuerCountry,
            issuer_name: pm.issuerName,
            fingerprint: pm.instrumentFingerprint,
            supports_international: pm.supportsInternational,
            supports_recurring: pm.supportsRecurring,
            three_d_secure_supported: pm.threeDSecureSupported,
          }
        : null,
    // What the gateway said about the address / CVC (0245), Stripe only. Null
    // means nothing was captured — not "unchecked", which is a real verdict a
    // gateway can send — same null-object shape as `mandate` above.
    avs_check:
      pm.avsLine1Check || pm.avsPostalCheck || pm.cvcCheck
        ? {
            line1: pm.avsLine1Check,
            postal_code: pm.avsPostalCheck,
            cvc: pm.cvcCheck,
            checked_at: pm.avsCheckedAt,
          }
        : null,
    created_at: pm.createdAt,
  };
}

/** Resolve gateway_accounts.id → { publicId, label } for a batch of methods. */
async function gatewayAccountsById(
  tx: Tx,
  rows: Array<Pick<typeof paymentMethods.$inferSelect, "gatewayAccountId">>,
): Promise<Map<string, PaymentMethodGatewayAccount>> {
  const ids = [...new Set(rows.map((r) => r.gatewayAccountId).filter((v): v is string => !!v))];
  if (ids.length === 0) return new Map();
  const accs = await tx
    .select({
      id: gatewayAccounts.id,
      publicId: gatewayAccounts.publicId,
      label: gatewayAccounts.label,
    })
    .from(gatewayAccounts)
    .where(inArray(gatewayAccounts.id, ids));
  return new Map(accs.map((a) => [a.id, { publicId: a.publicId, label: a.label }]));
}

/**
 * Serialize payment methods **with** their gateway account resolved — one extra
 * query for the whole batch, not one per row. Use this on every API surface;
 * the bare `serializePaymentMethod` is for callers that already hold the account.
 */
export async function serializePaymentMethods(
  organizationId: string,
  rows: Array<typeof paymentMethods.$inferSelect>,
): Promise<Array<ReturnType<typeof serializePaymentMethod>>> {
  if (rows.length === 0) return [];
  const byId = await withTenant(organizationId, (tx) => gatewayAccountsById(tx, rows));
  return rows.map((r) =>
    serializePaymentMethod(r, r.gatewayAccountId ? byId.get(r.gatewayAccountId) : null),
  );
}

/** Single-row form of `serializePaymentMethods`. */
export async function serializePaymentMethodWithGateway(
  organizationId: string,
  pm: typeof paymentMethods.$inferSelect,
): Promise<ReturnType<typeof serializePaymentMethod>> {
  const [view] = await serializePaymentMethods(organizationId, [pm]);
  return view!;
}

/**
 * Resolve a customer's primary + backup payment-source public ids (CUST-1 / D2).
 * Moved here (from `./service`) so `customers/serialize.ts` (via
 * `loadCustomerSnapshot`, used by `events/content.ts`) can pull role info
 * without importing `payment-methods/service.ts` — that file imports
 * `emitEvent`, which would close the serialize → service → events/emit →
 * events/content → serialize cycle. Re-exported from `./service` for back-compat.
 */
export async function getPaymentRoleIds(
  organizationId: string,
  customerId: string,
  /**
   * The caller's transaction, when it holds one. A second transaction opened while the first
   * holds its connection needs a second connection: under load every connection ends up held
   * by a caller waiting for another, and the pool deadlocks (D4 load test, 20 of 20).
   */
  outer?: Tx,
): Promise<{ primary: string | null; backup: string | null }> {
  const read = async (tx: Tx) => {
    const rows = await tx
      .select({ publicId: paymentMethods.publicId, role: paymentMethods.role })
      .from(paymentMethods)
      .where(eq(paymentMethods.customerId, customerId));
    return {
      primary: rows.find((r) => r.role === "primary")?.publicId ?? null,
      backup: rows.find((r) => r.role === "backup")?.publicId ?? null,
    };
  };
  // A savepoint, so a failure here cannot abort the caller's transaction.
  return outer ? outer.transaction(read) : withTenant(organizationId, read);
}

/**
 * Full-snapshot loader for event content (BLUEPRINT §11 Part B). Loads a
 * payment method row by its public id and returns the serialized object, or
 * null if not found. `tx` must be the caller's RLS-scoped transaction.
 */
export async function loadPaymentMethodSnapshot(
  tx: Tx,
  pmPublicId: string,
): Promise<Record<string, unknown> | null> {
  const [pm] = await tx
    .select()
    .from(paymentMethods)
    .where(eq(paymentMethods.publicId, pmPublicId))
    .limit(1);
  if (!pm) return null;
  const byId = await gatewayAccountsById(tx, [pm]);
  return serializePaymentMethod(pm, pm.gatewayAccountId ? byId.get(pm.gatewayAccountId) : null);
}

/**
 * Resolve a payment method's owning customer's public id — used by
 * `events/content.ts` to enrich `payment_source` events with `{ customer }`
 * (the payment-method row only stores the customer's internal uuid).
 */
export async function loadPaymentMethodCustomerPublicId(
  tx: Tx,
  pmPublicId: string,
): Promise<string | null> {
  const [row] = await tx
    .select({ cusPid: customers.publicId })
    .from(paymentMethods)
    .innerJoin(customers, eq(paymentMethods.customerId, customers.id))
    .where(eq(paymentMethods.publicId, pmPublicId))
    .limit(1);
  return row?.cusPid ?? null;
}
