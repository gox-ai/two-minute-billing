/**
 * Embeddable usage widget (design G5 § 3.9): a short-lived, read-only bearer token bound to
 * one customer, the per-business origin allowlist, and the one read the widget makes.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { systemDb, withTenant } from "@/platform/db";
import { businessWallClock } from "@/platform/clock";
import {
  businesses,
  creditAutoTopups,
  customers,
  spendLimits,
  usageWidgetTokens,
} from "@db/schema";
import { liveBalance } from "@/modules/credits/balance";
import { measureRunway } from "./measure";
import {
  currentUsageForCustomer,
  serializeCurrentUsage,
} from "@/modules/subscriptions/current-usage";

/** 15 minutes, on the real clock: Time Travel never extends a credential. */
export const USAGE_WIDGET_TOKEN_TTL_MS = 15 * 60_000;
export const MAX_WIDGET_ORIGINS = 20;
const PREFIX = "uwt_";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export interface UsageWidgetContext {
  organizationId: string;
  businessId: string;
  customerId: string;
}

export async function mintUsageWidgetToken(input: {
  organizationId: string;
  businessId: string;
  customerId: string;
  createdBy: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = `${PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + USAGE_WIDGET_TOKEN_TTL_MS);
  await withTenant(input.organizationId, (tx) =>
    tx.insert(usageWidgetTokens).values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      customerId: input.customerId,
      tokenHash: hash(token),
      expiresAt,
      createdBy: input.createdBy,
    }),
  );
  return { token, expiresAt };
}

/** Before a tenant is known: the token names it. Null for an unknown or expired token. */
export async function resolveUsageWidgetToken(
  token: string,
): Promise<(UsageWidgetContext & { expiresAt: Date }) | null> {
  if (!token.startsWith(PREFIX)) return null;
  const [row] = await systemDb
    .select({
      id: usageWidgetTokens.id,
      organizationId: usageWidgetTokens.organizationId,
      businessId: usageWidgetTokens.businessId,
      customerId: usageWidgetTokens.customerId,
      expiresAt: usageWidgetTokens.expiresAt,
    })
    .from(usageWidgetTokens)
    .where(
      and(
        eq(usageWidgetTokens.tokenHash, hash(token)),
        gt(usageWidgetTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) return null;
  await systemDb
    .update(usageWidgetTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(usageWidgetTokens.id, row.id));
  return row;
}

/**
 * An allowed origin is scheme + host + port, compared exactly (as `platform/cors.ts`). https
 * only, except http on localhost for development. Returns the normalised origin or an error.
 */
export function normaliseWidgetOrigin(raw: string): { origin: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: `${raw} is not a URL. Enter an origin like https://app.example.com.` };
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:"))
    return { error: `${raw} must use https.` };
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    return { error: `${raw} must be an origin only, with no path.` };
  return { origin: url.origin };
}

export async function getUsageWidgetOrigins(
  organizationId: string,
  businessId: string,
): Promise<string[]> {
  return withTenant(organizationId, async (tx) => {
    const [b] = await tx
      .select({ origins: businesses.usageWidgetOrigins })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1);
    return b?.origins ?? [];
  });
}

export async function setUsageWidgetOrigins(
  organizationId: string,
  businessId: string,
  origins: string[],
): Promise<string[]> {
  const unique = [...new Set(origins)];
  await withTenant(organizationId, (tx) =>
    tx
      .update(businesses)
      .set({ usageWidgetOrigins: unique, updatedAt: new Date() })
      .where(eq(businesses.id, businessId)),
  );
  return unique;
}

/** Preflight carries no token: answer it for an origin some business lists. */
export async function isAnyWidgetOrigin(origin: string): Promise<boolean> {
  const r = await systemDb.execute(
    sql`select 1 from businesses where ${origin} = any(usage_widget_origins) limit 1`,
  );
  return (r as unknown as unknown[]).length > 0;
}

/** Everything the widget shows, for the token's customer only. */
export async function usageWidgetView(ctx: UsageWidgetContext) {
  const usage = await currentUsageForCustomer({
    organizationId: ctx.organizationId,
    businessId: ctx.businessId,
    customerId: ctx.customerId,
    includeProjection: true,
  });
  const now = await businessWallClock(ctx.businessId);
  return withTenant(ctx.organizationId, async (tx) => {
    const [row] = await tx
      .select({
        cfg: businesses.creditConfig,
        bizCurrency: businesses.defaultCurrency,
        custCurrency: customers.currency,
        settings: customers.creditSettings,
      })
      .from(customers)
      .innerJoin(businesses, eq(businesses.id, customers.businessId))
      .where(eq(customers.id, ctx.customerId))
      .limit(1);
    const currency = (row?.custCurrency ?? row?.bizCurrency ?? "USD").toUpperCase();
    const bal = await liveBalance(tx, {
      customerId: ctx.customerId,
      currency,
      now,
      businessConfig: row?.cfg ?? null,
      customerSettings: row?.settings ?? null,
    });
    const runway = await measureRunway(tx, {
      businessId: ctx.businessId,
      customerId: ctx.customerId,
      currency,
      now,
    });
    const limits = await tx
      .select()
      .from(spendLimits)
      .where(
        and(
          eq(spendLimits.customerId, ctx.customerId),
          eq(spendLimits.active, true),
          inArray(spendLimits.scope, ["customer", "property"]),
        ),
      );
    const [topup] = await tx
      .select()
      .from(creditAutoTopups)
      .where(
        and(
          eq(creditAutoTopups.customerId, ctx.customerId),
          eq(creditAutoTopups.currency, currency),
        ),
      )
      .limit(1);
    return {
      object: "usage_widget" as const,
      as_of: now.toISOString(),
      currency,
      usage: usage.data.map((v) => {
        const s = serializeCurrentUsage(v, { portal: true });
        return {
          currency: s.currency,
          window: s.window ? { start: s.window.start, end: s.window.end } : null,
          items: s.items.map((i) => ({
            name: i.name,
            quantity: i.quantity,
            amount_minor: i.amount_minor,
            projected_amount_minor: i.projected_amount_minor,
          })),
          subtotal_minor: s.subtotal_minor,
          projected_subtotal_minor: s.projection?.subtotal_minor ?? null,
        };
      }),
      totals: usage.totals.map((t) => ({
        currency: t.currency,
        total_minor: Number(t.totalMinor),
        projected_total_minor: t.projectedTotalMinor == null ? null : Number(t.projectedTotalMinor),
      })),
      balance: { currency, available_minor: Number(bal.availableMinor) },
      // An estimate. Null days = "Not enough usage to estimate".
      runway: {
        runway_days: runway.runwayDays,
        runs_out_at: runway.runsOutAt?.toISOString() ?? null,
      },
      limits: limits.map((l) => ({
        scope: l.scope,
        property_key: l.propertyKey,
        property_value: l.propertyValue,
        interval: l.interval,
        amount_minor: Number(l.amountMinor),
        currency: l.currency,
        mode: l.mode,
      })),
      auto_topup: topup
        ? {
            status: topup.status,
            trigger: topup.trigger,
            threshold_minor: topup.thresholdMinor == null ? null : Number(topup.thresholdMinor),
            method: topup.method,
            amount_minor: topup.amountMinor == null ? null : Number(topup.amountMinor),
            target_minor: topup.targetMinor == null ? null : Number(topup.targetMinor),
          }
        : null,
    };
  });
}
