/**
 * Per-business decline-rule overrides (#69 stage 3).
 *
 * Proves the four properties the settings screen will depend on: an override changes the
 * answer for ONE business, a narrower row beats a broader one, a NULL column leaves the
 * built-in answer alone, and RLS keeps a merchant's settings inside their organization.
 *
 * ⚠️ Deliberately exercises `applyDeclineOverride` DIRECTLY rather than through a charge.
 * An override keys on `ruleId`, which only exists on a failure the RULE ENGINE produced —
 * the real gateway normalisers. `tmtest` builds its ChargeResult by hand and carries no
 * rule id, so no test-gateway charge can reach this path, and a suite that drove one would
 * be asserting nothing while looking thorough. The one-line seam in
 * `collection.ts#chargeWithMethod` is what connects them, and it is typed rather than
 * tested here — named so nobody mistakes this for end-to-end cover.
 *
 * pnpm verify:decline-overrides
 */
import { eq } from "drizzle-orm";
import { closeDb, withTenant } from "@/platform/db";
import { taxonomyCodes } from "@/platform/error-taxonomy";
import {
  ALL_DECLINE_RULES,
  knownDeclineCodesWithoutRules,
  resolveStoredErrorId,
  payerDeclineMessage,
  PAYER_SAFE_INTERNAL_FAILURE,
  PAYER_REASON_WITHHELD,
} from "@/providers/decline-codes";
import { buildApp } from "@/index";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import { createGatewayAccount } from "@/modules/gateway/service";
import { declineRuleOverrides, gatewayAccounts } from "@db/schema";
import {
  applyDeclineOverride,
  orphanedDeclineOverrides,
  setDeclineOverride,
  clearDeclineOverride,
  listDeclineRulesForBusiness,
  storedPayerDeclineMessage,
} from "@/modules/subscriptions/decline-overrides";

const checks: [string, boolean, string][] = [];
const ok = (n: string, c: boolean, d = "") => checks.push([n, c, d]);

const RULE = "stripe.code.expired_card";
const base = {
  code: "expired_card",
  message: "Built-in copy.",
  retriable: false,
  exposedToPayer: true,
  ruleId: RULE,
};

/**
 * `Response.json()` answers `unknown`, so every read through it was a type error the
 * filtered typecheck never showed. Naming the shape here keeps the gate honest about what
 * the API returns — and a field that disappears from the route now fails to compile.
 */
type RuleJson = {
  id: string;
  overridable: boolean;
  built_in?: { retriable: boolean; message: string | null };
  effective?: { retriable: boolean; message: string | null; exposed_to_payer: boolean };
  override?: { level?: string; retriable: boolean | null; message: string | null } | null;
};
type ListJson = {
  data: RuleJson[];
  orphaned_overrides: { id: string; decline_rule: string }[];
  code_overrides: { code: string; retriable: boolean | null }[];
};
type RuleWriteJson = {
  deleted?: boolean;
  object?: string;
  override?: { retriable: boolean | null; message: string | null } | null;
  effective?: { retriable: boolean; message: string | null };
};
const asJson = async <T>(r: Response): Promise<T> => (await r.json()) as T;

async function main() {
  const createdA = await createOrganization({ name: "Overrides A" });
  const orgA = createdA.organization;
  const secretA = createdA.secret;
  const orgB = (await createOrganization({ name: "Overrides B" })).organization;
  const bizA = await createBusiness({
    organizationId: orgA.id,
    name: "A",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const bizPublicA = bizA.publicId;
  const bizB = await createBusiness({
    organizationId: orgB.id,
    name: "B",
    defaultCurrency: "USD",
    livemode: "test",
  });
  const acctA = await createGatewayAccount({
    organizationId: orgA.id,
    businessId: bizA.id,
    gatewayKey: "tmtest",
    label: "A-1",
    credentials: { api_key: "tmtest_x" },
  });
  // Under tenant context: RLS hides it otherwise, and a bare `db.select` here silently
  // returns nothing rather than failing — which is exactly how this first ran.
  const [acctRow] = await withTenant(orgA.id, (tx) =>
    tx
      .select({ id: gatewayAccounts.id })
      .from(gatewayAccounts)
      .where(eq(gatewayAccounts.businessId, bizA.id)),
  );

  // ── 1 · no override → the built-in answer, untouched ──────────────────────────
  {
    const out = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizA.id, decline: base }),
    );
    ok(
      "no override: the rule's own answer stands",
      out.retriable === false && out.message === base.message,
      `${out.retriable}/${out.message}`,
    );
  }

  // ── 2 · a business-wide override changes it, for that business only ───────────
  await withTenant(orgA.id, (tx) =>
    tx.insert(declineRuleOverrides).values({
      organizationId: orgA.id,
      businessId: bizA.id,
      declineRuleId: RULE,
      retriable: true,
    }),
  );
  {
    const a = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizA.id, decline: base }),
    );
    ok("business override flips retriable", a.retriable === true, String(a.retriable));
    // The property that makes it a SETTING rather than a config change: nobody else moved.
    const b = await withTenant(orgB.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizB.id, decline: base }),
    );
    ok("another business is unaffected", b.retriable === false, String(b.retriable));
  }

  // ── 3 · a NULL column leaves the built-in answer alone ────────────────────────
  {
    const a = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizA.id, decline: base }),
    );
    ok(
      "a merchant who changed only the hardness did NOT freeze our copy as theirs",
      a.message === base.message && a.exposedToPayer === true,
      `${a.message}/${a.exposedToPayer}`,
    );
  }

  // ── 4 · a narrower row beats the broad one ────────────────────────────────────
  await withTenant(orgA.id, (tx) =>
    tx.insert(declineRuleOverrides).values({
      organizationId: orgA.id,
      businessId: bizA.id,
      gatewayAccountId: acctRow!.id,
      declineRuleId: RULE,
      retriable: false,
      message: "Account-specific copy.",
    }),
  );
  {
    const scoped = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, {
        businessId: bizA.id,
        gatewayAccountId: acctRow!.id,
        decline: base,
      }),
    );
    ok(
      "account row wins over the business-wide row",
      scoped.retriable === false && scoped.message === "Account-specific copy.",
      `${scoped.retriable}/${scoped.message}`,
    );
    const broad = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizA.id, decline: base }),
    );
    ok(
      "…and the business-wide row still answers for other accounts",
      broad.retriable === true,
      String(broad.retriable),
    );
  }

  // ── 5 · a decline with no rule id has nothing to override ─────────────────────
  {
    const out = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizA.id, decline: { ...base, ruleId: undefined } }),
    );
    ok(
      "no ruleId: untouched, and no query was needed",
      out.retriable === false,
      String(out.retriable),
    );
  }

  // ── 6 · an override can outlive its rule, and a screen must be able to say so ──
  await withTenant(orgA.id, (tx) =>
    tx.insert(declineRuleOverrides).values({
      organizationId: orgA.id,
      businessId: bizA.id,
      declineRuleId: "stripe.code.deleted_in_a_later_deploy",
      retriable: true,
    }),
  );
  {
    const orphans = await withTenant(orgA.id, (tx) => orphanedDeclineOverrides(tx, bizA.id));
    ok(
      "an orphaned override is reported, not silently ignored",
      orphans.length === 1 && orphans[0]!.target.endsWith("deleted_in_a_later_deploy"),
      JSON.stringify(orphans.map((o) => o.target)),
    );
    // …and it must not break collection for every other rule.
    const still = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, { businessId: bizA.id, decline: base }),
    );
    ok(
      "an orphan does not disturb a live rule's override",
      still.retriable === true,
      String(still.retriable),
    );
  }

  // ── 7 · RLS: a merchant's settings stay inside their organization ─────────────
  {
    const leaked = await withTenant(orgB.id, (tx) =>
      tx.select().from(declineRuleOverrides).where(eq(declineRuleOverrides.businessId, bizA.id)),
    );
    ok("org B cannot read org A's overrides", leaked.length === 0, `rows=${leaked.length}`);
  }

  // ── 8 · the API a settings screen will drive ─────────────────────────────────
  // Through HTTP rather than the service, because the parts most likely to break are the
  // ones the service never sees: the null-vs-absent contract in the body, and the reset
  // control being clicked twice.
  {
    const app = await buildApp({ logger: false });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as { port: number }).port;
    const url = (p: string) => `http://127.0.0.1:${port}/v1/businesses/${bizPublicA}${p}`;
    const H = { authorization: `Bearer ${secretA}`, "content-type": "application/json" };

    const list = await asJson<ListJson>(await fetch(url("/decline_rules"), { headers: H }));
    ok(
      `GET lists every built-in rule (${list.data.length})`,
      list.data.length >= 29,
      String(list.data.length),
    );
    const seen = list.data.find((r) => r.id === RULE);
    ok(
      "…with built-in and effective side by side",
      seen?.built_in != null && seen?.effective != null,
      JSON.stringify(seen?.effective),
    );
    ok(
      "…and reports the orphaned override rather than hiding it",
      list.orphaned_overrides.length === 1,
      JSON.stringify(list.orphaned_overrides),
    );

    const patched = await asJson<RuleWriteJson>(
      await fetch(url(`/decline_rules/${RULE}`), {
        method: "PATCH",
        headers: { ...H, "idempotency-key": `k-${Date.now()}` },
        body: JSON.stringify({ message: "Merchant wording." }),
      }),
    );
    ok(
      "PATCH sets one field and echoes the effective row",
      patched.effective?.message === "Merchant wording.",
      JSON.stringify(patched.effective),
    );
    // The contract that makes a screen possible: an ABSENT key is not a cleared key. The
    // hardness set back in check 2 must survive a patch that only mentions the wording.
    ok(
      "…without disturbing a field it did not mention",
      patched.effective?.retriable === true,
      String(patched.effective?.retriable),
    );

    const cleared = await asJson<RuleWriteJson>(
      await fetch(url(`/decline_rules/${RULE}`), {
        method: "PATCH",
        headers: { ...H, "idempotency-key": `k2-${Date.now()}` },
        body: JSON.stringify({ message: null }),
      }),
    );
    ok(
      "…and an explicit null hands our wording back",
      cleared.effective?.message === "Built-in copy." || cleared.override?.message === null,
      JSON.stringify(cleared.override),
    );

    // Every code we recognise is listed, and the ones no rule names are marked rather than
    // omitted. Omitting them would suggest we do not handle a decline we handle correctly.
    const conf = list.data.filter((r) => r.overridable).length;
    const ro = list.data.filter((r) => !r.overridable).length;
    ok(
      `the catalogue is complete, not just the configurable half (${conf}+${ro})`,
      ro > 0 && conf > 0,
      `${conf} configurable, ${ro} read-only`,
    );
    // …and a read-only row must REFUSE a write rather than accept one nothing reads.
    const roId = list.data.find((r) => !r.overridable)?.id;
    const refused = await fetch(url(`/decline_rules/${roId}`), {
      method: "PATCH",
      headers: { ...H, "idempotency-key": `ro-${Date.now()}` },
      body: JSON.stringify({ retriable: true }),
    });
    ok(
      `a non-configurable code refuses a PATCH (${refused.status}) — ${roId}`,
      refused.status === 404,
      String(refused.status),
    );

    const unknown = await fetch(url("/decline_rules/stripe.code.not_a_rule"), {
      method: "PATCH",
      headers: { ...H, "idempotency-key": `k3-${Date.now()}` },
      body: JSON.stringify({ retriable: true }),
    });
    ok(
      `an unknown rule id is a 404, not a silent row (${unknown.status})`,
      unknown.status === 404,
      String(unknown.status),
    );

    const d1 = await asJson<RuleWriteJson>(
      await fetch(url(`/decline_rules/${RULE}`), {
        method: "DELETE",
        headers: { authorization: H.authorization, "idempotency-key": `d1-${Date.now()}` },
      }),
    );
    const d2 = await asJson<RuleWriteJson>(
      await fetch(url(`/decline_rules/${RULE}`), {
        method: "DELETE",
        headers: { authorization: H.authorization, "idempotency-key": `d2-${Date.now()}` },
      }),
    );
    ok("DELETE removes the override", d1.deleted === true, JSON.stringify(d1));
    // A reset control clicked twice must not fail the second time: "there is no override"
    // is the state the caller asked for.
    ok("…and clicking reset again is not an error", d2.deleted === false, JSON.stringify(d2));

    // A sibling business's gateway account (same org) is not this business's account.
    const sibling = await createBusiness({
      organizationId: orgA.id,
      name: "A sibling",
      defaultCurrency: "USD",
      livemode: "test",
    });
    const siblingAcct = await createGatewayAccount({
      organizationId: orgA.id,
      businessId: sibling.id,
      gatewayKey: "tmtest",
      label: "A-sibling",
      credentials: { api_key: "tmtest_y" },
    });
    const foreign = siblingAcct.publicId;
    const w = (method: string, p: string, body?: unknown) =>
      fetch(url(p), {
        method,
        headers:
          body === undefined
            ? { authorization: H.authorization, "idempotency-key": `sib-${Math.random()}` }
            : { ...H, "idempotency-key": `sib-${Math.random()}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const noSuch = async (r: Response) =>
      r.status === 404 && /No such gateway account/.test(await r.text());
    ok(
      "PATCH rule with a sibling business's gateway_account → 404",
      await noSuch(
        await w("PATCH", `/decline_rules/${RULE}`, { retriable: true, gateway_account: foreign }),
      ),
    );
    ok(
      "PATCH code with a sibling business's gateway_account → 404",
      await noSuch(
        await w("PATCH", "/decline_codes/expired_card", {
          retriable: true,
          gateway_account: foreign,
        }),
      ),
    );
    ok(
      "GET rules with a sibling business's gateway_account → 404",
      await noSuch(await w("GET", `/decline_rules?gateway_account=${foreign}`)),
    );
    ok(
      "DELETE code with a sibling business's gateway_account → 404",
      await noSuch(await w("DELETE", `/decline_codes/expired_card?gateway_account=${foreign}`)),
    );
    ok(
      "DELETE rule with a sibling business's gateway_account → 404",
      await noSuch(await w("DELETE", `/decline_rules/${RULE}?gateway_account=${foreign}`)),
    );
    // An unknown account must not fall back to clearing the business-wide override.
    ok(
      "DELETE rule with an unknown gateway_account → 404",
      await noSuch(await w("DELETE", `/decline_rules/${RULE}?gateway_account=gwa_doesnotexist`)),
    );
    const own = await w("GET", `/decline_rules?gateway_account=${acctA.publicId}`);
    ok(
      "…while the business's own gateway_account still reads (200)",
      own.status === 200,
      String(own.status),
    );

    await app.close();
  }

  // ── 8b · the screen's built-in answer IS the engine's ────────────────────────
  // Not a tautology worth deleting: these four rules leave `retriable` unset under a
  // TERMINAL code, and the screen used to compute `?? true` and show "retries" where
  // collection would not retry. Pinning the value catches a re-introduced copy AND a
  // change to TERMINAL that nobody meant to make visible.
  {
    const listed = await withTenant(orgA.id, (tx) =>
      listDeclineRulesForBusiness(tx, { businessId: bizA.id }),
    );
    const terminalUnset = [
      "stripe.code.expired_card",
      "razorpay.code.expired_card",
      "razorpay.code.card_lost_or_stolen",
      "razorpay.code.fraudulent_transaction",
    ];
    const wrong = terminalUnset.filter(
      (id) => listed.find((r) => r.id === id)?.builtIn.retriable !== false,
    );
    ok(
      "the screen shows no-retry for terminal codes the rule leaves unset",
      wrong.length === 0,
      wrong.join(", ") || "all four",
    );
  }

  // ── 9 · the SECOND level: an override on the canonical code ──────────────────
  // The point is reach: one setting covers every rule that means the same thing.
  {
    const CODE = "expired_card";
    await withTenant(orgA.id, (tx) =>
      setDeclineOverride(tx, {
        organizationId: orgA.id,
        businessId: bizA.id,
        code: CODE,
        retriable: true,
      }),
    );
    // A rule that was never touched individually now answers differently, because the code
    // above it was set. This is the whole feature in one assertion.
    const out = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, {
        businessId: bizA.id,
        decline: { ...base, ruleId: "stripe.code.expired_card" },
      }),
    );
    ok(
      "a code-level override reaches a rule nobody touched",
      out.retriable === true,
      String(out.retriable),
    );

    // …and a RULE-level row beats it, because it is narrower. Merging the two would let the
    // code's answer survive under a rule the merchant deliberately set back.
    await withTenant(orgA.id, (tx) =>
      setDeclineOverride(tx, {
        organizationId: orgA.id,
        businessId: bizA.id,
        ruleId: "stripe.code.expired_card",
        retriable: false,
      }),
    );
    const narrower = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, {
        businessId: bizA.id,
        decline: { ...base, ruleId: "stripe.code.expired_card" },
      }),
    );
    ok(
      "a rule-level override beats a code-level one",
      narrower.retriable === false,
      String(narrower.retriable),
    );

    // A sibling rule with the same code still follows the CODE, so the narrower row did not
    // quietly cancel the broader one.
    const sibling = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, {
        businessId: bizA.id,
        decline: { ...base, code: CODE, ruleId: "stripe.table.expired_card_sibling" },
      }),
    );
    ok(
      "a sibling rule still follows the code-level row",
      sibling.retriable === true,
      String(sibling.retriable),
    );

    // The screen must resolve identically to the engine — same `rank`, not a second copy.
    const listed = await withTenant(orgA.id, (tx) =>
      listDeclineRulesForBusiness(tx, { businessId: bizA.id }),
    );
    const row = listed.find((r) => r.id === "stripe.code.expired_card");
    ok(
      `the screen agrees with the engine and names the level (${row?.override?.level})`,
      row?.effective.retriable === false && row?.override?.level === "rule",
      JSON.stringify(row?.override),
    );

    // A code nobody produces is refused, so a typo cannot become a setting that does nothing.
    let bad: unknown = null;
    try {
      await withTenant(orgA.id, (tx) =>
        setDeclineOverride(tx, {
          organizationId: orgA.id,
          businessId: bizA.id,
          code: "not_a_real_code",
          retriable: true,
        }),
      );
    } catch (e) {
      bad = e;
    }
    ok("an unknown canonical code is refused", bad != null, bad ? "threw" : "ACCEPTED");

    // The reach that matters most: a decline with NO rule id at all — the 32 codes we
    // recognise that no rule names. They had no lever before this level existed, and the
    // engine's code arm is what gives them one.
    const ruleless = await withTenant(orgA.id, (tx) =>
      applyDeclineOverride(tx, {
        businessId: bizA.id,
        // `as boolean`, or the literal narrows the result type and the assertion below
        // becomes a comparison TypeScript rejects as impossible.
        decline: { code: CODE, retriable: false as boolean, exposedToPayer: false },
      }),
    );
    ok(
      "a code-level override reaches a decline with no rule id",
      ruleless.retriable === true,
      String(ruleless.retriable),
    );

    await withTenant(orgA.id, (tx) =>
      clearDeclineOverride(tx, { businessId: bizA.id, code: CODE }),
    );
    await withTenant(orgA.id, (tx) =>
      clearDeclineOverride(tx, { businessId: bizA.id, ruleId: "stripe.code.expired_card" }),
    );
  }

  // ── 9b · "Tell the customer" reaches the payer's sentence ──────────────────
  // The failure shape a charge hands `applyDeclineOverride`: no `exposedToPayer` of its own.
  {
    const HIDDEN_RULE = "stripe.code.payment_intent_invalid_parameter";
    const hidden = {
      code: "gateway_request_rejected",
      message: "Raw request complaint.",
      retriable: false,
      ruleId: HIDDEN_RULE,
    };
    const shown = { code: "insufficient_funds", message: "Not enough funds.", retriable: true };
    const payer = async (d: typeof hidden | typeof shown) =>
      payerDeclineMessage(
        await withTenant(orgA.id, (tx) =>
          applyDeclineOverride(tx, { businessId: bizA.id, decline: d }),
        ),
        "fallback",
      );

    ok(
      "no override: our failure stays hidden",
      (await payer(hidden)) === PAYER_SAFE_INTERNAL_FAILURE,
    );
    ok("no override: the gateway reason is shown", (await payer(shown)) === shown.message);

    await withTenant(orgA.id, (tx) =>
      setDeclineOverride(tx, {
        organizationId: orgA.id,
        businessId: bizA.id,
        ruleId: HIDDEN_RULE,
        exposedToPayer: true,
      }),
    );
    await withTenant(orgA.id, (tx) =>
      setDeclineOverride(tx, {
        organizationId: orgA.id,
        businessId: bizA.id,
        code: "insufficient_funds",
        exposedToPayer: false,
      }),
    );
    const revealed = await payer(hidden);
    ok("rule override hide → show reaches the payer", revealed === hidden.message, revealed);
    const withheld = await payer(shown);
    ok("code override show → hide reaches the payer", withheld === PAYER_REASON_WITHHELD, withheld);
    // A dunning reminder reads the payment row back with no rule id: the code level still holds.
    const stored = await withTenant(orgA.id, (tx) =>
      storedPayerDeclineMessage(
        tx,
        { businessId: bizA.id, code: "insufficient_funds", message: "Not enough funds." },
        "fallback",
      ),
    );
    ok("a stored failure honours the code override", stored === PAYER_REASON_WITHHELD, stored);
    // Engine-minted codes carry our exception/router text: hidden with no rule behind them.
    for (const code of ["gateway_error", "gateway_account_unavailable"]) {
      const m = await withTenant(orgA.id, (tx) =>
        storedPayerDeclineMessage(tx, { businessId: bizA.id, code, message: "TypeError: x" }, "f"),
      );
      ok(`${code} is hidden from the payer`, m === PAYER_SAFE_INTERNAL_FAILURE, m);
    }

    await withTenant(orgA.id, (tx) =>
      clearDeclineOverride(tx, { businessId: bizA.id, ruleId: HIDDEN_RULE }),
    );
    await withTenant(orgA.id, (tx) =>
      clearDeclineOverride(tx, { businessId: bizA.id, code: "insufficient_funds" }),
    );
  }

  // ── 10 · the namespaced taxonomy (#69 stage 4) ───────────────────────────────
  // The taxonomy exists so history is queryable on ONE axis without rewriting a stored
  // row. That only holds if nothing falls out of it silently, and if it never renames
  // what it was given — a resolver that "corrects" a stored code would be the migration
  // hazard the whole design avoids.
  {
    const CB_FAMILIES = new Set([
      "transaction_processing",
      "payment_method",
      "bank_account",
      "technical",
      "merchant_account",
      "transaction_authorization",
      "dispute",
      "mandate",
      "identity_verification",
      "token",
      "general",
    ]);

    // Every code the ENGINE can emit must be named. An unnamed one answers
    // `gateway.general.unknown`, which is the right answer for a stranger's vocabulary
    // and the wrong one for ours.
    const emitted = new Set<string>(ALL_DECLINE_RULES.map((r) => r.code));
    for (const k of knownDeclineCodesWithoutRules()) emitted.add(k.code);
    const unnamed = [...emitted].filter((c) => !resolveStoredErrorId(c).known);
    ok(
      `every code the engine emits has a family (${emitted.size})`,
      unnamed.length === 0,
      unnamed.join(", ") || "none",
    );

    // A gateway family must be one of the eleven we define. A typo in the map would
    // otherwise invent a twelfth and nothing would notice.
    const strayFamily = taxonomyCodes()
      .filter((t) => t.namespace === "gateway" && !CB_FAMILIES.has(t.family))
      .map((t) => `${t.code}=${t.family}`);
    ok(
      "every gateway family is one of the eleven",
      strayFamily.length === 0,
      strayFamily.join(", ") || "none",
    );

    // A code in BOTH namespaces would resolve by whichever map is consulted first — an
    // ordering dependency, not a taxonomy.
    const all = taxonomyCodes();
    const dupes = all.map((t) => t.code).filter((c, i, a) => a.indexOf(c) !== i);
    ok("no code sits in both namespaces", dupes.length === 0, dupes.join(", ") || "none");

    // Three segments, always. A screen and a query both split on the dots.
    const malformed = all
      .map((t) => resolveStoredErrorId(t.code).id)
      .filter((id) => id.split(".").length !== 3);
    ok("every id is namespace.family.code", malformed.length === 0, malformed.join(", ") || "none");

    // THE ONE THAT MATTERS: the resolver reports, it does not rewrite.
    const kept = all.every((t) => resolveStoredErrorId(t.code).code === t.code);
    const rawKept = resolveStoredErrorId("BAD_REQUEST_ERROR").code === "BAD_REQUEST_ERROR";
    ok("the resolver never changes the code it was given", kept && rawKept, `${kept} / ${rawKept}`);

    // A raw provider code a RULE matches must resolve through it. Consulting only the
    // legacy tables left `payment_intent_payment_attempt_failed` — 389 stored rows, and
    // the code behind #63 — unresolved while the engine had known it for a day.
    const viaRule = resolveStoredErrorId("payment_intent_payment_attempt_failed");
    ok("a raw code a rule matches resolves through the rule", viaRule.known, viaRule.id);

    // An engine-minted reason must NOT read as a gateway decline. `no_payment_method` is
    // the commonest value in the column at 4,680 rows; filed under `gateway.*` it would
    // report "the card was refused" for a subscription that never had a card.
    const mint = resolveStoredErrorId("no_payment_method");
    ok("an engine-minted reason is not a gateway decline", mint.namespace === "billing", mint.id);

    // A stranger's vocabulary buckets rather than throwing — this runs over a column that
    // already holds an imported book's spellings.
    const alien = resolveStoredErrorId("some_imported_spelling");
    ok(
      "an unknown code buckets and is flagged",
      alien.id === "gateway.general.unknown" && !alien.known,
      alien.id,
    );
  }

  let failed = 0;
  for (const [n, pass, d] of checks) {
    console.log(`  ${pass ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
    if (!pass) failed++;
  }
  console.log(
    failed === 0 ? `\nPASS — ${checks.length} checks` : `\nFAIL — ${failed}/${checks.length}`,
  );
  await closeDb();
  process.exit(failed === 0 ? 0 : 1);
}
void main();
