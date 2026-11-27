import { z } from "zod";
import type { MigrationSource, SourceCatalog, SourceCustomer, SourceSubscription } from "./types";

/**
 * A migration source backed by a plain JSON export from your own system — the
 * turnkey path when subscriptions live in your app rather than in a billing platform.
 * Validate-then-normalize: amounts are integer minor units, dates are
 * ISO-8601 strings, and a customer may carry its existing provider card(s) so
 * the first renewal after cutover keeps charging.
 *
 * Schema (see scripts/migration-example.json):
 * {
 *   "plans":        [{ id, name, amountMinor, currency, interval, intervalCount? }],
 *   "customers":    [{ id, email?, name?, paymentMethod? }],
 *   "subscriptions":[{ id, customerId, planId, quantity?, status?, currency?,
 *                      currentTermEnd, currentTermStart?, trialEnd? }]
 * }
 *
 * Every entity also accepts `createdAt` / `updatedAt` (ISO-8601). Supply them and
 * the imported rows keep your system's history instead of all reading as created
 * at import time.
 */

const paymentMethodSchema = z.object({
  provider: z.string().min(1),
  providerCustomerId: z.string().min(1),
  providerPaymentMethodId: z.string().min(1),
  type: z.string().optional(),
  brand: z.string().optional(),
  last4: z.string().optional(),
  expMonth: z.number().int().optional(),
  expYear: z.number().int().optional(),
});

/** Source row timestamps, carried onto the imported row when present. */
const timestampsSchema = {
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
};

const planSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  amountMinor: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]),
  currency: z.string().length(3),
  interval: z.enum(["day", "week", "month", "year"]),
  intervalCount: z.number().int().positive().optional(),
  ...timestampsSchema,
});

const customerSchema = z.object({
  id: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  paymentMethod: paymentMethodSchema.optional(),
  ...timestampsSchema,
});

const subscriptionSchema = z.object({
  id: z.string().min(1),
  customerId: z.string().min(1),
  planId: z.string().min(1),
  quantity: z.number().int().positive().optional(),
  status: z.enum(["active", "trialing", "paused", "canceled", "non_renewing"]).optional(),
  currency: z.string().length(3).optional(),
  currentTermEnd: z.string().datetime(),
  currentTermStart: z.string().datetime().optional(),
  trialEnd: z.string().datetime().optional(),
  ...timestampsSchema,
});

export const migrationFileSchema = z.object({
  plans: z.array(planSchema),
  customers: z.array(customerSchema),
  subscriptions: z.array(subscriptionSchema),
});

export type MigrationFile = z.infer<typeof migrationFileSchema>;

/** ISO strings → Dates, dropping the keys the file didn't set. */
function stamps(row: { createdAt?: string; updatedAt?: string }): {
  createdAt?: Date;
  updatedAt?: Date;
} {
  return {
    ...(row.createdAt ? { createdAt: new Date(row.createdAt) } : {}),
    ...(row.updatedAt ? { updatedAt: new Date(row.updatedAt) } : {}),
  };
}

export class JsonFileSource implements MigrationSource {
  readonly name: string;
  private data: MigrationFile;

  /** `raw` is the parsed JSON object (validated here). `name` tags import_records. */
  constructor(raw: unknown, name = "json") {
    this.name = name;
    this.data = migrationFileSchema.parse(raw);
  }

  async listCatalog(): Promise<SourceCatalog> {
    return {
      groups: [],
      products: this.data.plans.map((p) => ({
        sourceId: p.id,
        kind: "plan" as const,
        name: p.name,
        ...stamps(p),
      })),
      prices: this.data.plans.map((p) => ({
        sourceId: p.id,
        productSourceId: p.id,
        model: "flat" as const,
        amountMinor: Number(p.amountMinor),
        currency: p.currency.toUpperCase(),
        interval: p.interval,
        intervalCount: p.intervalCount ?? 1,
        ...stamps(p),
      })),
      attachedAddons: [],
      differentialPrices: [],
    };
  }

  async listCustomers(): Promise<SourceCustomer[]> {
    return this.data.customers.map((c) => ({
      sourceId: c.id,
      email: c.email,
      name: c.name,
      paymentMethods: c.paymentMethod ? [{ ...c.paymentMethod, isPrimary: true }] : undefined,
      ...stamps(c),
    }));
  }

  async listSubscriptions(): Promise<SourceSubscription[]> {
    return this.data.subscriptions.map((s) => ({
      sourceId: s.id,
      customerSourceId: s.customerId,
      items: [{ priceSourceId: s.planId, kind: "plan" as const, quantity: s.quantity ?? 1 }],
      status: s.status ?? "active",
      currency: (s.currency ?? "USD").toUpperCase(),
      currentTermEnd: new Date(s.currentTermEnd),
      currentTermStart: s.currentTermStart ? new Date(s.currentTermStart) : undefined,
      trialEnd: s.trialEnd ? new Date(s.trialEnd) : undefined,
      ...stamps(s),
    }));
  }
}
