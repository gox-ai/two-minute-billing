/**
 * Credit reports (step 7): the deferred revenue roll-forward, one grant's activity and refused
 * demand. Runway in units is `GET …/customers/{cus}/credit_runway?unit=` (usage controls).
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { withTenant } from "@/platform/db";
import { stampNow } from "@/platform/clock";
import { customerByPublicId, CreditNotFoundError } from "@/modules/credits/service";
import { businessTimeZone } from "@/modules/usage-controls/measure";
import {
  deferredRevenueRollForward,
  grantActivity,
  grantOfCustomer,
  monthsBetween,
  paidCreditLedgerBalance,
  refusedDemand,
  serializeRollRow,
} from "@/modules/credits/reports";
import { badRequest, notFound, requirePerm, resolveBusiness } from "./helpers";
import { parseRequest } from "./strict-params";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 36;
const MAX_REFUSED_DAYS = 92;
const DAY_MS = 86_400_000;

const rollQuery = z.object({
  from: z.string().regex(MONTH, "Use YYYY-MM.").optional(),
  to: z.string().regex(MONTH, "Use YYYY-MM.").optional(),
  currency: z.string().length(3).optional(),
  unit: z.string().min(1).max(100).optional(),
});
const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  starting_after: z.string().max(100).optional(),
});
const refusedQuery = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  group_by: z.enum(["meter", "day", "customer"]).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/** "YYYY-MM" of an instant in a time zone. */
function monthIn(at: Date, tz: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit" })
    .formatToParts(at)
    .reduce<Record<string, string>>((o, x) => ({ ...o, [x.type]: x.value }), {});
  return `${p.year}-${p.month}`;
}

function minusMonths(ym: string, k: number): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) - k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

const params = (req: FastifyRequest) => req.params as { cus?: string; grant?: string };

export async function registerCreditReportRoutes(app: FastifyInstance) {
  const read = { preHandler: [authenticate, requirePerm("credits:view")] };

  app.get("/v1/businesses/:biz/reports/credit_deferred_revenue", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(rollQuery, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const orgId = req.organization!.id;
    return withTenant(orgId, async (tx) => {
      const tz = await businessTimeZone(tx, business.id);
      const to = q.data.to ?? monthIn(stampNow(business.id), tz);
      const from = q.data.from ?? minusMonths(to, 11);
      if (from > to) return badRequest(reply, "from must not be after to.");
      if (monthsBetween(from, to).length > MAX_MONTHS)
        return badRequest(
          reply,
          `The range can be at most ${MAX_MONTHS} months. Make the range shorter.`,
        );
      const rows = await deferredRevenueRollForward(tx, {
        businessId: business.id,
        timeZone: tz,
        fromMonth: from,
        toMonth: to,
        currency: q.data.currency,
        unitKey: q.data.unit,
      });
      // The ledger account at the end of the range: Σ closing per currency, all units.
      const [y, m] = to.split("-").map(Number) as [number, number];
      const endLocal = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
      const [endRow] = (await tx.execute(
        sql`select (${endLocal}::timestamp at time zone ${tz}) as at`,
      )) as unknown as Array<{ at: string | Date }>;
      const ledger = await paidCreditLedgerBalance(tx, {
        businessId: business.id,
        before: new Date(endRow!.at),
      });
      return {
        object: "credit_deferred_revenue",
        time_zone: tz,
        from,
        to,
        data: rows.map(serializeRollRow),
        ledger_closing: [...ledger]
          .filter(([c]) => !q.data.currency || c === q.data.currency.toUpperCase())
          .map(([currency, v]) => ({ currency, credit_grants_paid_minor: Number(v) })),
      };
    });
  });

  app.get(
    "/v1/businesses/:biz/customers/:cus/credit_grants/:grant/activity",
    read,
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = parseRequest(activityQuery, req.query ?? {});
      if (!q.success) return badRequest(reply, q.error);
      const p = params(req);
      try {
        return await withTenant(req.organization!.id, async (tx) => {
          const c = await customerByPublicId(tx, business.id, p.cus!);
          const found = await grantOfCustomer(tx, {
            businessId: business.id,
            customerId: c.id,
            grantPublicId: p.grant!,
          });
          if (!found) throw new CreditNotFoundError(`No such credit grant: ${p.grant}`);
          const a = await grantActivity(tx, {
            ...found,
            limit: q.data.limit ?? 100,
            startingAfter: q.data.starting_after,
          });
          return {
            object: "credit_grant_activity",
            grant: found.grant.publicId,
            customer: c.publicId,
            unit: found.unit?.key ?? null,
            currency: found.grant.currency,
            category: found.grant.category,
            ...a.summary,
            data: a.data,
            has_more: a.hasMore,
            next_cursor: a.hasMore ? a.data.at(-1)!.id : null,
          };
        });
      } catch (e) {
        if (e instanceof CreditNotFoundError) return notFound(reply, e.message);
        throw e;
      }
    },
  );

  app.get("/v1/businesses/:biz/reports/credit_refused_demand", read, async (req, reply) => {
    const business = await resolveBusiness(req, reply);
    if (!business) return;
    const q = parseRequest(refusedQuery, req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const from = new Date(q.data.from);
    const to = new Date(q.data.to);
    if (to <= from) return badRequest(reply, "to must be after from.");
    if (to.getTime() - from.getTime() > MAX_REFUSED_DAYS * DAY_MS)
      return badRequest(
        reply,
        `The range can be at most ${MAX_REFUSED_DAYS} days. Make the range shorter.`,
      );
    const groupBy = q.data.group_by ?? "meter";
    return withTenant(req.organization!.id, async (tx) => {
      const tz = await businessTimeZone(tx, business.id);
      const r = await refusedDemand(tx, {
        businessId: business.id,
        timeZone: tz,
        from,
        to,
        groupBy,
        limit: q.data.limit ?? 500,
      });
      return {
        object: "credit_refused_demand",
        group_by: groupBy,
        time_zone: tz,
        data: r.data,
        has_more: r.hasMore,
      };
    });
  });
}
