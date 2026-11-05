import { refId } from "@/api/limits";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate } from "@/platform/auth";
import { idempotency, idempotencyOnSend } from "@/platform/idempotency";
import { resolveBusiness, badRequest, notFound, requirePerm } from "./helpers";
import { withTenant } from "@/platform/db";
import { currentEventContext } from "@/platform/event-context";
import { resolveStoredErrorId } from "@/providers/decline-codes";
import { and, eq } from "drizzle-orm";
import { gatewayAccounts } from "@db/schema";
import {
  listDeclineRulesForBusiness,
  setDeclineOverride,
  clearDeclineOverride,
  orphanedDeclineOverrides,
  listDeclineCodeOverrides,
  UnknownDeclineRuleError,
  type EffectiveDeclineRule,
} from "@/modules/subscriptions/decline-overrides";
import { parseRequest } from "./strict-params";

/**
 * How a business sees and changes the way ONE gateway decline behaves (#69 stage 3).
 *
 * The rules themselves live in code and are the same for everyone; what a merchant owns is
 * an override on top. So there is no create-a-rule endpoint on purpose — the list is the
 * catalogue, and a PATCH attaches a preference to one entry in it.
 */
const serialize = (r: EffectiveDeclineRule) => {
  const taxonomy = resolveStoredErrorId(r.code);
  return {
    object: "decline_rule",
    id: r.id,
    /** False for a code we recognise but no rule names — see `EffectiveDeclineRule`. */
    overridable: r.overridable,
    gateway: r.gateway,
    matches: r.matches,
    code: r.code,
    /**
     * The canonical code's place in the taxonomy (stage 4). `code` stays the contract and
     * the stored value; this is the family axis beside it, so a migrating merchant
     * recognises the family their error history was already filed under.
     */
    error_id: taxonomy.id,
    family: taxonomy.family,
    built_in: {
      retriable: r.builtIn.retriable,
      message: r.builtIn.message,
      exposed_to_payer: r.builtIn.exposedToPayer,
    },
    // Null when untouched, so a client can render "changed" without comparing objects.
    override: r.override
      ? {
          retriable: r.override.retriable,
          message: r.override.message,
          exposed_to_payer: r.override.exposedToPayer,
          updated_by: r.override.updatedBy,
          updated_at: r.override.updatedAt,
          /** "code" means it was set on the canonical code, not on this rule. */
          level: r.override.level,
        }
      : null,
    effective: {
      retriable: r.effective.retriable,
      message: r.effective.message,
      exposed_to_payer: r.effective.exposedToPayer,
    },
  };
};

/**
 * `null` CLEARS one part of an override; an absent key leaves it as it is.
 *
 * `.nullable().optional()` rather than `.optional()` because those are different intents
 * and a screen needs both: "I did not touch the wording" and "put the wording back to
 * yours" cannot share a representation.
 */
const patchBody = z.object({
  retriable: z.boolean().nullable().optional(),
  message: z.string().max(500).nullable().optional(),
  exposed_to_payer: z.boolean().nullable().optional(),
  /**
   * Narrow the override to one gateway account. Omit for every account of the business.
   * `refId()` rather than a bare string: an unbounded field here is a free-form value the
   * caller controls, and `verify:input-bounds` holds that budget at zero.
   */
  gateway_account: refId().optional(),
});

/**
 * A gateway account's public id → its uuid, or `false` when the caller named one that does
 * not exist (the reply is already sent). Factored out of three copies: the third was about
 * to become a fifth, and a resolver that differs between endpoints is how one of them
 * silently starts writing business-wide rows.
 */
async function resolveAccountId(
  req: FastifyRequest,
  reply: FastifyReply,
  businessId: string,
  publicId: string | undefined,
): Promise<string | null | false> {
  if (!publicId) return null;
  const id = await withTenant(req.organization!.id, async (tx) => {
    const [row] = await tx
      .select({ id: gatewayAccounts.id })
      .from(gatewayAccounts)
      // The business in the path: a sibling business's account is not this one's.
      .where(
        and(eq(gatewayAccounts.publicId, publicId), eq(gatewayAccounts.businessId, businessId)),
      )
      .limit(1);
    return row?.id ?? null;
  });
  if (!id) {
    await notFound(reply, `No such gateway account: ${publicId}`);
    return false;
  }
  return id;
}

export async function registerDeclineRuleRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses/:biz/decline_rules",
    { preHandler: [authenticate, requirePerm("settings:view")] },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const q = req.query as {
        gateway?: string;
        overridden?: string;
        gateway_account?: string;
      };

      const accountId = await resolveAccountId(req, reply, business.id, q.gateway_account);
      if (accountId === false) return;

      const [rules, orphans, codeOverrides] = await withTenant(
        req.organization!.id,
        async (tx) =>
          [
            await listDeclineRulesForBusiness(tx, {
              businessId: business.id,
              gatewayAccountId: accountId,
            }),
            await orphanedDeclineOverrides(tx, business.id),
            await listDeclineCodeOverrides(tx, {
              businessId: business.id,
              gatewayAccountId: accountId,
            }),
          ] as const,
      );

      const filtered = rules
        .filter((r) => !q.gateway || r.gateway === q.gateway)
        .filter((r) => q.overridden !== "true" || r.override != null);

      return {
        object: "list",
        data: filtered.map(serialize),
        /**
         * Overrides whose rule no longer exists. Surfaced rather than hidden: a merchant
         * whose setting silently stopped applying after a deploy has no way to discover
         * that, and the alternative is them believing a preference is in force when it is
         * not. Empty for everyone who has never lost a rule.
         */
        orphaned_overrides: orphans.map((o) => ({ id: o.id, decline_rule: o.target })),
        /**
         * The code-level settings, listed separately because one can be invisible in `data`:
         * when every rule under a code also has its own row, the narrower rows win and the
         * code setting shows nowhere — leaving the merchant no way to see or remove it.
         */
        code_overrides: codeOverrides.map((c) => ({
          object: "decline_code_override" as const,
          code: c.code,
          retriable: c.retriable,
          message: c.message,
          exposed_to_payer: c.exposedToPayer,
          updated_by: c.updatedBy,
          updated_at: c.updatedAt,
        })),
      };
    },
  );

  app.patch(
    "/v1/businesses/:biz/decline_rules/:rule",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(patchBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const ruleId = (req.params as { rule: string }).rule;

      const accountId = await resolveAccountId(
        req,
        reply,
        business.id,
        parsed.data.gateway_account,
      );
      if (accountId === false) return;

      try {
        await withTenant(req.organization!.id, (tx) =>
          setDeclineOverride(tx, {
            organizationId: req.organization!.id,
            businessId: business.id,
            gatewayAccountId: accountId,
            ruleId,
            retriable: parsed.data.retriable,
            message: parsed.data.message,
            exposedToPayer: parsed.data.exposed_to_payer,
            // The signed-in operator, not the org — a setting that surprised someone needs
            // a person to ask (0150/0151). `req.actor` never existed; the request's actor
            // is on the event context, already resolved to an email for a session.
            updatedBy: currentEventContext()?.actor ?? null,
          }),
        );
      } catch (e) {
        if (e instanceof UnknownDeclineRuleError) return notFound(reply, e.message);
        throw e;
      }

      const rules = await withTenant(req.organization!.id, (tx) =>
        listDeclineRulesForBusiness(tx, { businessId: business.id, gatewayAccountId: accountId }),
      );
      const row = rules.find((r) => r.id === ruleId);
      return row ? serialize(row) : notFound(reply, `No such decline rule: ${ruleId}`);
    },
  );

  /**
   * The SECOND level: a setting on the canonical CODE, covering every rule that produces
   * it.
   *
   * Separate paths rather than one endpoint with a `level` field, because a rule id and a
   * canonical code are different namespaces and collapsing them would make a typo in one
   * silently address the other.
   */
  app.patch(
    "/v1/businesses/:biz/decline_codes/:code",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const parsed = parseRequest(patchBody, req.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const code = (req.params as { code: string }).code;

      const accountId = await resolveAccountId(
        req,
        reply,
        business.id,
        parsed.data.gateway_account,
      );
      if (accountId === false) return;

      try {
        await withTenant(req.organization!.id, (tx) =>
          setDeclineOverride(tx, {
            organizationId: req.organization!.id,
            businessId: business.id,
            gatewayAccountId: accountId,
            code,
            retriable: parsed.data.retriable,
            message: parsed.data.message,
            exposedToPayer: parsed.data.exposed_to_payer,
            updatedBy: currentEventContext()?.actor ?? null,
          }),
        );
      } catch (e) {
        if (e instanceof UnknownDeclineRuleError) return notFound(reply, e.message);
        throw e;
      }

      const rules = await withTenant(req.organization!.id, (tx) =>
        listDeclineRulesForBusiness(tx, { businessId: business.id, gatewayAccountId: accountId }),
      );
      return {
        object: "decline_code",
        code,
        // Every rule this now covers, so a caller sees the reach of what they just set.
        rules: rules.filter((r) => r.code === code).map(serialize),
      };
    },
  );

  app.delete(
    "/v1/businesses/:biz/decline_codes/:code",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const code = (req.params as { code: string }).code;
      const accountId = await resolveAccountId(
        req,
        reply,
        business.id,
        (req.query as { gateway_account?: string }).gateway_account,
      );
      if (accountId === false) return;
      const removed = await withTenant(req.organization!.id, (tx) =>
        clearDeclineOverride(tx, { businessId: business.id, gatewayAccountId: accountId, code }),
      );
      return { object: "decline_code", code, deleted: removed > 0 };
    },
  );

  app.delete(
    "/v1/businesses/:biz/decline_rules/:rule",
    {
      preHandler: [authenticate, requirePerm("settings:manage"), idempotency],
      onSend: idempotencyOnSend,
    },
    async (req, reply) => {
      const business = await resolveBusiness(req, reply);
      if (!business) return;
      const ruleId = (req.params as { rule: string }).rule;
      const q = req.query as { gateway_account?: string };

      // An unknown account is a 404, never null: null would clear the business-wide override.
      const accountId = await resolveAccountId(req, reply, business.id, q.gateway_account);
      if (accountId === false) return;

      const removed = await withTenant(req.organization!.id, (tx) =>
        clearDeclineOverride(tx, {
          businessId: business.id,
          gatewayAccountId: accountId,
          ruleId,
        }),
      );
      // 200 either way: "there is no override on this rule" is the state the caller asked
      // for, and a 404 would make a reset control fail the second time someone clicks it.
      return { object: "decline_rule", id: ruleId, deleted: removed > 0 };
    },
  );
}
