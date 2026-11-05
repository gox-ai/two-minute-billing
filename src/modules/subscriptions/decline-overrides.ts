import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/platform/db";
import { declineRuleOverrides } from "@db/schema";
import {
  declineRuleById,
  knownDeclineCodesWithoutRules,
  isTerminalDeclineCode,
  builtInDeclineAnswer,
  payerDeclineMessage,
  ALL_DECLINE_RULES,
  declineSets,
  type DeclineGatewayKey,
} from "@/providers/decline-codes";

/**
 * A MERCHANT'S OWN ANSWER, layered onto the answer normalisation gave (#69 stage 3).
 *
 * ── Why this is not in `providers/decline-codes.ts` ──────────────────────────────
 * Normalisation is pure, synchronous and gateway-shaped: it turns what a gateway said
 * into our vocabulary. It is also in `providers/`, which may not import from `modules/`
 * (see `providers/types.ts`), and an adapter has no tenant to look an override up for.
 * So the adapter reports WHICH RULE matched and this applies the business's preference
 * where the business is known. Keeping the split means a decline classifies identically
 * for every merchant until one of them deliberately says otherwise.
 *
 * ── Precedence ───────────────────────────────────────────────────────────────────
 * An account-specific row beats the business-wide one. That is the only reading that
 * makes the nullable column useful: a business sets a policy once, then narrows it for
 * the one gateway account that needs it.
 *
 * ── What NULL means, in three different places, deliberately ─────────────────────
 *   · `gateway_account_id` NULL  → applies to EVERY account of this business.
 *   · an override COLUMN NULL    → leave the rule's own answer alone. A merchant who
 *                                  changed only the hardness must not thereby freeze our
 *                                  copy as theirs at the moment they clicked.
 *   · no `ruleId` on the decline → the legacy table or the passthrough answered, so
 *                                  there is no rule to override and nothing to look up.
 */
export interface OverridableDecline {
  code: string;
  message?: string | null;
  retriable: boolean;
  exposedToPayer?: boolean;
  ruleId?: string;
}

/** Every canonical code any rule or table can produce — what a code-level override may name. */
function knownCanonicalCodes(): Set<string> {
  const out = new Set<string>();
  for (const r of ALL_DECLINE_RULES) out.add(r.code);
  for (const k of knownDeclineCodesWithoutRules()) out.add(k.code);
  return out;
}

/**
 * PRECEDENCE, in one place because SQL cannot express it and two readers would drift.
 *
 * Most specific first. A RULE beats a CODE because it names one matching rule rather than
 * every rule that means the same thing; an ACCOUNT beats "all accounts" for the same
 * reason. The screen resolves rows through this same ordering — if the two ever disagree,
 * the screen lies about what the engine will do, which is worse than having no screen.
 */
function rank(row: { gatewayAccountId: string | null; declineRuleId: string | null }): number {
  const byRule = row.declineRuleId != null ? 0 : 2;
  const byAccount = row.gatewayAccountId != null ? 0 : 1;
  return byRule + byAccount; // 0 rule+account · 1 rule+all · 2 code+account · 3 code+all
}

export async function applyDeclineOverride<T extends OverridableDecline>(
  tx: Tx,
  input: { businessId: string; gatewayAccountId?: string | null; decline: T },
): Promise<T> {
  const { decline } = input;
  // A code always exists; a rule id only when a RULE decided this. Both are consulted, so
  // a code-level override still applies to a decline the legacy table normalised.
  if (!decline.code && !decline.ruleId) return decline;

  const rows = await tx
    .select({
      gatewayAccountId: declineRuleOverrides.gatewayAccountId,
      declineRuleId: declineRuleOverrides.declineRuleId,
      retriable: declineRuleOverrides.retriable,
      message: declineRuleOverrides.message,
      exposedToPayer: declineRuleOverrides.exposedToPayer,
      updatedBy: declineRuleOverrides.updatedBy,
      updatedAt: declineRuleOverrides.updatedAt,
      declineCode: declineRuleOverrides.declineCode,
    })
    .from(declineRuleOverrides)
    .where(
      and(
        eq(declineRuleOverrides.businessId, input.businessId),
        decline.ruleId
          ? or(
              eq(declineRuleOverrides.declineRuleId, decline.ruleId),
              eq(declineRuleOverrides.declineCode, decline.code),
            )
          : eq(declineRuleOverrides.declineCode, decline.code),
        input.gatewayAccountId
          ? or(
              isNull(declineRuleOverrides.gatewayAccountId),
              eq(declineRuleOverrides.gatewayAccountId, input.gatewayAccountId),
            )
          : isNull(declineRuleOverrides.gatewayAccountId),
      ),
    );
  if (rows.length === 0) return decline;

  /**
   * ⚠ The winner takes the whole answer; the tiers do NOT merge field by field.
   *
   * Merging would let a code-level "never retry" survive underneath a rule-level row that
   * deliberately set retry back on, and a merchant who edited the narrower control would
   * watch it do nothing. One row answers, and the screen shows which.
   */
  const row = rows.slice().sort((a, b) => rank(a) - rank(b))[0]!;

  return {
    ...decline,
    ...(row.retriable != null ? { retriable: row.retriable } : {}),
    ...(row.message != null ? { message: row.message } : {}),
    ...(row.exposedToPayer != null ? { exposedToPayer: row.exposedToPayer } : {}),
  };
}

/**
 * The payer's decline sentence for a failure read back from storage, where the matched rule
 * id is gone: only business-wide CODE-level overrides can apply. A live failure goes through
 * `applyDeclineOverride` at charge time and needs none of this.
 */
export async function storedPayerDeclineMessage(
  tx: Tx,
  input: { businessId: string; code: string | null; message: string | null },
  fallback: string,
): Promise<string> {
  const decline = input.code
    ? await applyDeclineOverride(tx, {
        businessId: input.businessId,
        decline: { code: input.code, message: input.message, retriable: true },
      })
    : { code: input.code, message: input.message };
  return payerDeclineMessage(decline, fallback);
}

/**
 * Overrides pointing at rules that no longer exist.
 *
 * An override outliving its rule is a REAL state, not corruption: rules live in code, so a
 * deploy that deletes one leaves rows behind, and the table has no foreign key precisely
 * so that deploy cannot fail a merchant's writes. `applyDeclineOverride` ignores them
 * silently, which is right at collection time and wrong on a settings screen — a merchant
 * looking at their overrides should be told which ones stopped applying rather than
 * wondering why a setting does nothing.
 */
export async function orphanedDeclineOverrides(
  tx: Tx,
  businessId: string,
): Promise<{ id: string; target: string }[]> {
  const rows = await tx
    .select({
      id: declineRuleOverrides.id,
      declineRuleId: declineRuleOverrides.declineRuleId,
      declineCode: declineRuleOverrides.declineCode,
    })
    .from(declineRuleOverrides)
    .where(eq(declineRuleOverrides.businessId, businessId));
  /**
   * A row targets EITHER a rule or a code, so each has to be checked against its own
   * catalogue. Checking only the rule id — which is what this did before codes existed —
   * reported every code-level setting as orphaned, because its `decline_rule_id` is null
   * and `declineRuleById(null)` finds nothing.
   */
  const codes = knownCanonicalCodes();
  return rows
    .filter((r) =>
      r.declineRuleId != null ? !declineRuleById(r.declineRuleId) : !codes.has(r.declineCode!),
    )
    .map((r) => ({ id: r.id, target: r.declineRuleId ?? r.declineCode! }));
}

/**
 * Every built-in rule with this business's answer resolved against it — what the settings
 * screen renders, and what a support engineer reads when asked "why did that decline
 * behave like that".
 *
 * Returns the BUILT-IN answer and the EFFECTIVE one side by side rather than only the
 * result. A merchant looking at a row needs to see that they changed something, and what
 * it was before, or the screen cannot honestly offer to reset it.
 *
 * `gatewayAccountId` narrows exactly as `applyDeclineOverride` does, so the screen can
 * show the answer for one account and the resolution cannot disagree with collection.
 */
export interface EffectiveDeclineRule {
  id: string;
  /**
   * Can a merchant change this one?
   *
   * False for a code the tables recognise but no rule names: an override keys on a rule
   * id and there is none, so the row is real, its answer is real, and a control offering
   * to change it would 404. Showing it read-only is the honest middle — the alternative
   * is a catalogue that quietly omits codes the engine handles, which is how somebody
   * concludes we do not support a decline we have handled correctly for a year.
   */
  overridable: boolean;
  gateway: DeclineGatewayKey;
  matches: { field: string; op: string; value: string };
  code: string;
  builtIn: { retriable: boolean; message: string | null; exposedToPayer: boolean };
  override: {
    retriable: boolean | null;
    message: string | null;
    exposedToPayer: boolean | null;
    /** Who changed it and when, so a surprising setting has a person to ask. */
    updatedBy: string | null;
    updatedAt: string | null;
    /** Which level answered: the rule itself, or the canonical code above it. */
    level: "rule" | "code";
  } | null;
  effective: { retriable: boolean; message: string | null; exposedToPayer: boolean };
}

export async function listDeclineRulesForBusiness(
  tx: Tx,
  input: { businessId: string; gatewayAccountId?: string | null },
): Promise<EffectiveDeclineRule[]> {
  const rows = await tx
    .select()
    .from(declineRuleOverrides)
    .where(eq(declineRuleOverrides.businessId, input.businessId));

  /**
   * The SAME four-tier precedence `applyDeclineOverride` applies, through the same `rank`
   * function rather than a second copy of the rule. A screen that resolved overrides
   * differently from the engine would show a merchant one answer and give them another,
   * which is the specific way a settings page becomes worse than none.
   */
  const forRule = (id: string, code: string) => {
    const candidates = rows.filter(
      (r) =>
        (r.declineRuleId === id || (r.declineCode != null && r.declineCode === code)) &&
        (r.gatewayAccountId == null ||
          (input.gatewayAccountId != null && r.gatewayAccountId === input.gatewayAccountId)),
    );
    return candidates.slice().sort((a, b) => rank(a) - rank(b))[0] ?? null;
  };

  const out: EffectiveDeclineRule[] = [];
  for (const [gateway, { rules }] of declineSets()) {
    for (const r of rules) {
      const o = forRule(r.id, r.code);
      /**
       * The engine's own function, not a copy of its logic. The copy said `retriable ?? true`
       * and disagreed with it for four rules under TERMINAL codes: the page showed "retries"
       * where collection would not retry, and offered to reset to an answer never in force.
       */
      const builtIn = builtInDeclineAnswer(r);
      out.push({
        id: r.id,
        overridable: true,
        gateway,
        matches: { field: r.field, op: r.op, value: r.value },
        code: r.code,
        builtIn,
        override: o
          ? {
              retriable: o.retriable,
              message: o.message,
              exposedToPayer: o.exposedToPayer,
              updatedBy: o.updatedBy ?? null,
              updatedAt: o.updatedAt ? o.updatedAt.toISOString() : null,
              level: o.declineRuleId != null ? ("rule" as const) : ("code" as const),
            }
          : null,
        effective: {
          retriable: o?.retriable ?? builtIn.retriable,
          message: o?.message ?? builtIn.message,
          exposedToPayer: o?.exposedToPayer ?? builtIn.exposedToPayer,
        },
      });
    }
  }
  /**
   * The rest of what we recognise, read-only. Appended after the rules so the configurable
   * half of the catalogue reads first — a merchant scanning for something they can change
   * should not have to wade through what they cannot.
   */
  for (const k of knownDeclineCodesWithoutRules()) {
    const builtIn = {
      retriable: !isTerminalDeclineCode(k.code),
      message: null,
      exposedToPayer: false,
    };
    /**
     * These have no rule, but they DO have a canonical code — and the engine's override
     * query matches on the code arm whether or not a rule id came with the decline. So a
     * code-level row governs them for real, and the screen has to say so. Reporting them
     * as unchangeable while `applyDeclineOverride` was already honouring a code row would
     * be the screen lying in the direction that matters.
     */
    const o = forRule(`${k.gateway}.table.${k.value.toLowerCase()}`, k.code);
    out.push({
      // Shaped like a rule id and deliberately NOT one: `declineRuleById` will not resolve
      // it, so a PATCH aimed here answers 404 rather than writing a row nothing reads.
      id: `${k.gateway}.table.${k.value.toLowerCase()}`,
      // No RULE-level control exists; the code-level one above the group is its lever.
      overridable: false,
      gateway: k.gateway,
      matches: { field: "code", op: "eq", value: k.value },
      code: k.code,
      builtIn,
      override: o
        ? {
            retriable: o.retriable,
            message: o.message,
            exposedToPayer: o.exposedToPayer,
            updatedBy: o.updatedBy ?? null,
            updatedAt: o.updatedAt ? o.updatedAt.toISOString() : null,
            level: "code" as const,
          }
        : null,
      effective: {
        retriable: o?.retriable ?? builtIn.retriable,
        message: o?.message ?? builtIn.message,
        exposedToPayer: o?.exposedToPayer ?? builtIn.exposedToPayer,
      },
    });
  }

  return out;
}

export interface DeclineCodeOverride {
  code: string;
  retriable: boolean | null;
  message: string | null;
  exposedToPayer: boolean | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

/**
 * The code-level settings themselves, separate from the rules they reach.
 *
 * Needed because a code row can be INVISIBLE in the rule list: if every rule under that
 * code also has its own row, the narrower one wins every time and the screen would show
 * no code-level setting while one exists — and then offer no way to remove it.
 */
export async function listDeclineCodeOverrides(
  tx: Tx,
  input: { businessId: string; gatewayAccountId?: string | null },
): Promise<DeclineCodeOverride[]> {
  const rows = await tx
    .select()
    .from(declineRuleOverrides)
    .where(
      and(
        eq(declineRuleOverrides.businessId, input.businessId),
        isNotNull(declineRuleOverrides.declineCode),
      ),
    );
  return (
    rows
      .filter(
        (r) =>
          r.gatewayAccountId == null ||
          (input.gatewayAccountId != null && r.gatewayAccountId === input.gatewayAccountId),
      )
      // An account-scoped row beats the business-wide one, same as everywhere else.
      .sort((a, b) => rank(a) - rank(b))
      .filter((r, i, all) => all.findIndex((x) => x.declineCode === r.declineCode) === i)
      .map((r) => ({
        code: r.declineCode!,
        retriable: r.retriable,
        message: r.message,
        exposedToPayer: r.exposedToPayer,
        updatedBy: r.updatedBy ?? null,
        updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
      }))
  );
}

/**
 * Set (or update) one override. A field left `undefined` is not written; a field set to
 * `null` CLEARS that part of the override and hands the rule's own answer back.
 *
 * The distinction is the whole contract of the screen's reset control: "leave this alone"
 * and "put it back" are different intents and a single optional field cannot express both.
 */
export async function setDeclineOverride(
  tx: Tx,
  input: {
    organizationId: string;
    businessId: string;
    gatewayAccountId?: string | null;
    /** Exactly one of these. A rule names one matcher; a code covers every rule meaning it. */
    ruleId?: string;
    code?: string;
    retriable?: boolean | null;
    message?: string | null;
    exposedToPayer?: boolean | null;
    updatedBy?: string | null;
  },
): Promise<void> {
  if ((input.ruleId == null) === (input.code == null))
    throw new UnknownDeclineRuleError("exactly one of ruleId or code is required");
  if (input.ruleId && !declineRuleById(input.ruleId))
    throw new UnknownDeclineRuleError(input.ruleId);
  /**
   * A code must be one we actually produce. Without this a typo becomes a row that matches
   * nothing, applies nothing, and shows up on the screen as a setting that does not work —
   * the orphan problem, invited rather than inherited.
   */
  if (input.code && !knownCanonicalCodes().has(input.code))
    throw new UnknownDeclineRuleError(input.code);

  const patch = {
    ...(input.retriable !== undefined ? { retriable: input.retriable } : {}),
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.exposedToPayer !== undefined ? { exposedToPayer: input.exposedToPayer } : {}),
    updatedBy: input.updatedBy ?? null,
    updatedAt: new Date(),
  };
  const byCode = input.code != null;
  const scoped = input.gatewayAccountId != null;

  await tx
    .insert(declineRuleOverrides)
    .values({
      organizationId: input.organizationId,
      businessId: input.businessId,
      gatewayAccountId: input.gatewayAccountId ?? null,
      declineRuleId: input.ruleId ?? null,
      declineCode: input.code ?? null,
      ...patch,
    })
    .onConflictDoUpdate({
      // One target per PARTIAL index (0233 and 0234) — four shapes, and the `targetWhere`
      // must match the index's own predicate or Postgres will not use it.
      target: byCode
        ? scoped
          ? [
              declineRuleOverrides.businessId,
              declineRuleOverrides.gatewayAccountId,
              declineRuleOverrides.declineCode,
            ]
          : [declineRuleOverrides.businessId, declineRuleOverrides.declineCode]
        : scoped
          ? [
              declineRuleOverrides.businessId,
              declineRuleOverrides.gatewayAccountId,
              declineRuleOverrides.declineRuleId,
            ]
          : [declineRuleOverrides.businessId, declineRuleOverrides.declineRuleId],
      targetWhere: byCode
        ? scoped
          ? sql`decline_code IS NOT NULL AND gateway_account_id IS NOT NULL`
          : sql`decline_code IS NOT NULL AND gateway_account_id IS NULL`
        : scoped
          ? sql`gateway_account_id IS NOT NULL`
          : sql`gateway_account_id IS NULL`,
      set: patch,
    });
}

/** Remove an override entirely, restoring the built-in answer. */
export async function clearDeclineOverride(
  tx: Tx,
  input: {
    businessId: string;
    gatewayAccountId?: string | null;
    ruleId?: string;
    code?: string;
  },
): Promise<number> {
  if ((input.ruleId == null) === (input.code == null))
    throw new UnknownDeclineRuleError("exactly one of ruleId or code is required");
  const res = await tx
    .delete(declineRuleOverrides)
    .where(
      and(
        eq(declineRuleOverrides.businessId, input.businessId),
        input.ruleId
          ? eq(declineRuleOverrides.declineRuleId, input.ruleId)
          : eq(declineRuleOverrides.declineCode, input.code!),
        input.gatewayAccountId
          ? eq(declineRuleOverrides.gatewayAccountId, input.gatewayAccountId)
          : isNull(declineRuleOverrides.gatewayAccountId),
      ),
    )
    .returning({ id: declineRuleOverrides.id });
  return res.length;
}

/** A rule id that resolves to nothing — a typo, or a rule removed by a later deploy. */
export class UnknownDeclineRuleError extends Error {
  constructor(id: string) {
    super(`We could not find the decline rule ${id}.`);
    this.name = "UnknownDeclineRuleError";
  }
}
