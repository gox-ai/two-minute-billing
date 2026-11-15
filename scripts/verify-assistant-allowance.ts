/**
 * The assistant's monthly allowance per plan (Cloud), end to end over real HTTP, with a
 * scripted model. Account billing writes the allowance to the organization row; this suite
 * writes it the same way.
 *
 *  - § A the allowance is read from the organization and replaces the token cap
 *  - § B record mode: measured and shown, never stops a question
 *  - § C enforce mode: a note at 80%, one email a month to owners and admins, a stop at 100%
 *    with the next steps; an own key is never stopped
 *  - § D no allowance written yet: the token cap applies
 *  - § E self-hosted: no allowance, whatever is set
 *
 *   pnpm verify:assistant-allowance
 */
export {};
process.env.ASSISTANT_ALLOWANCE_MODE = "record";
// The token cap, for when no allowance is known: far above anything this suite spends.
process.env.ASSISTANT_ORG_MONTHLY_TOKENS = "10000000";

const { randomBytes } = await import("node:crypto");
const { MockLanguageModelV3, convertArrayToReadableStream } = await import("ai/test");
const { buildApp } = await import("@/index");
const { config } = await import("@/platform/config");
const { closeDb, systemDb } = await import("@/platform/db");
const { eq } = await import("drizzle-orm");
const { organizations } = await import("@db/schema");
const { setMailer } = await import("@/providers/mailer");
const { signup } = await import("@/modules/auth/service");
const { createBusiness } = await import("@/modules/tenancy/service");
const { setLlmForTests } = await import("@/modules/assistant/llm");
const { recordUsage, monthUsage, setMemberLimitsForTests } =
  await import("@/modules/assistant/service");
const { setKeyTesterForTests } = await import("@/api/assistant-routes");
const { pinMfaMandateOff } = await import("./lib/mfa-policy");

pinMfaMandateOff();
setMemberLimitsForTests({ burst: 1000, daily: 1000 });
const cfg = config as { TMBILLING_EDITION: string; ASSISTANT_ALLOWANCE_MODE: string };
const sent: Array<{ to: string; subject: string; text: string }> = [];
setMailer({
  kind: "smtp",
  target: null,
  async send(msg) {
    sent.push({ to: msg.to, subject: msg.subject, text: msg.text ?? "" });
    return { providerMessageId: `p-${sent.length}`, status: "sent" };
  },
});

const app = await buildApp({ logger: false });
const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);
const uniq = randomBytes(4).toString("hex");
const PW = "Heron-Lattice-50217";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};
const model = new MockLanguageModelV3({
  provider: "mock",
  modelId: "mock-model",
  doStream: async () => ({
    stream: convertArrayToReadableStream([
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "Hello." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: undefined }, usage },
    ] as never[]),
  }),
});
setLlmForTests((billedTo) => ({ model, provider: "openai", modelId: "mock-model", billedTo }));
setKeyTesterForTests(async () => {});

// Signed up as self-hosted; Cloud from here on (edition is read per call).
const owner = await signup({
  email: `allow-${uniq}@example.com`,
  password: PW,
  organizationName: `Allowance ${uniq}`,
});
const orgId = owner.user.organizationId;
const cookie = `tmb_session=${owner.token}`;
const biz = await createBusiness({
  organizationId: orgId,
  name: `Allowance Biz ${uniq}`,
  defaultCurrency: "USD",
  livemode: "test",
});
cfg.TMBILLING_EDITION = "cloud";
const setAllowance = (cents: number | null) =>
  systemDb
    .update(organizations)
    .set({ assistantAllowanceUsdCents: cents })
    .where(eq(organizations.id, orgId));
// Free: 10 cents. The mock model has no price, so a token counts at $1 per million:
// 100,000 tokens = 10 cents = 100%.
await setAllowance(10);

type Ev = Record<string, any>;
async function ask(content = "hello"): Promise<Ev[]> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/assistant/messages",
    headers: { cookie, "content-type": "application/json" },
    payload: { business: biz.publicId, content },
  });
  if (r.statusCode !== 200) return [{ type: "http", status: r.statusCode, body: r.body }];
  return r.body
    .split("\n\n")
    .filter((b) => b.startsWith("data: "))
    .map((b) => JSON.parse(b.slice(6)));
}
const of = (evs: Ev[], type: string) => evs.filter((e) => e.type === type);
const spend = (tokens: number) =>
  recordUsage({
    organizationId: orgId,
    userId: owner.user.userId,
    conversationId: null,
    provider: "openai",
    model: "mock-model",
    billedTo: "platform",
    inputTokens: tokens,
    outputTokens: 0,
  });
const status = async () =>
  (await app.inject({ method: "GET", url: "/auth/assistant/status", headers: { cookie } })).json();
const settings = async () =>
  (
    await app.inject({ method: "GET", url: "/auth/assistant/settings", headers: { cookie } })
  ).json();
const settle = async () => {
  for (let i = 0; i < 40 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
};

// ── § A · the allowance ─────────────────────────────────────────────────────────
const u0 = await monthUsage(orgId);
ok("A1 the allowance is read from the organization", u0.allowance?.usd_cents === 10);
ok("A2 it replaces the token cap (10M without it)", u0.cap_tokens === null);
const s0 = await settings();
ok(
  "A4 Settings → Billy gets the allowance, in credits too (10 cents = 50 credits)",
  s0.usage?.allowance?.usd_cents === 10 &&
    s0.usage.allowance.used_percent === 0 &&
    s0.usage.allowance.credits === 50,
);

// ── § B · record mode ───────────────────────────────────────────────────────────
await spend(85_000);
const b1 = await ask();
ok("B1 record mode: no 80% note", of(b1, "allowance").length === 0 && of(b1, "done").length === 1);
await spend(30_000);
const b2 = await ask();
const sb = await status();
const ub = await monthUsage(orgId);
ok(
  "B2 record mode: over 100% the question is still answered",
  of(b2, "done").length === 1 && of(b2, "error").length === 0,
);
ok("B3 record mode: the status does not say the allowance is used", sb.cap_reached === false);
ok(
  "B4 record mode: the use is measured",
  ub.allowance!.used_up && ub.allowance!.used_percent >= 115,
);
await new Promise((r) => setTimeout(r, 100));
ok("B5 record mode: no email", sent.length === 0);

// ── § C · enforce mode ──────────────────────────────────────────────────────────
cfg.ASSISTANT_ALLOWANCE_MODE = "enforce";
const c1 = await ask();
const stop = of(c1, "error")[0];
ok(
  "C1 enforce: at 100% the question stops",
  stop?.code === "cap_reached" && !of(c1, "done").length,
);
ok(
  "C2 enforce: the stop offers Upgrade plan and Add your own key",
  JSON.stringify(stop?.actions) ===
    JSON.stringify([
      { label: "Upgrade plan", href: "/settings/billing" },
      { label: "Add your own key", href: "/settings/assistant" },
    ]),
);
ok("C3 enforce: the status says the allowance is used", (await status()).cap_reached === true);

// A paid plan with a larger allowance: back under it, at 80% or more.
await setAllowance(14);
const c4 = await ask();
const note = of(c4, "allowance")[0];
ok(
  "C4 enforce: at 80% or more the answer carries a note",
  of(c4, "done").length === 1 && !!note && note.used_percent >= 80 && note.used_percent < 100,
);
await settle();
ok(
  "C5 enforce: owners get one email",
  sent.length === 1 &&
    sent[0]!.to === `allow-${uniq}@example.com` &&
    /Billy use/.test(sent[0]!.subject),
);
await ask();
await new Promise((r) => setTimeout(r, 300));
ok("C6 enforce: no second email in the same month", sent.length === 1);

// An own key: never stopped, never counted.
const put = await app.inject({
  method: "PUT",
  url: "/auth/assistant/settings",
  headers: { cookie, "content-type": "application/json" },
  payload: { own_key: { provider: "openai", model: null, api_key: "sk-own-0123456789abcd" } },
});
await spend(100_000);
const c7 = await ask();
const u7 = await monthUsage(orgId);
ok(
  "C7 an own key is answered past the allowance",
  put.statusCode === 200 && of(c7, "done").length === 1 && of(c7, "error").length === 0,
);
ok("C8 an own key's tokens do not count", u7.own_key_tokens > 0);
await app.inject({
  method: "PUT",
  url: "/auth/assistant/settings",
  headers: { cookie, "content-type": "application/json" },
  payload: { own_key: null },
});

// ── § D · no allowance written yet ──────────────────────────────────────────────
await setAllowance(null);
const d1 = await monthUsage(orgId);
ok(
  "D1 no allowance yet: the token cap applies and the question is answered",
  d1.allowance === null && d1.cap_tokens === 10_000_000 && of(await ask(), "done").length === 1,
);
await setAllowance(14);

// ── § F · embeddings never count ────────────────────────────────────────────────
{
  const { assistantEmbeddingUsage } = await import("@db/schema");
  const { recordEmbeddingUsage } = await import("@/modules/assistant-docs/vectors");
  const f0 = await monthUsage(orgId);
  // $10 of embeddings on the organization, and a recorded search query.
  await systemDb.insert(assistantEmbeddingUsage).values({
    organizationId: orgId,
    kind: "query",
    provider: "openai",
    model: "text-embedding-3-small",
    inputs: 1,
    inputTokens: 5_000_000,
    costFixed12: String(1000n * 10n ** 12n),
  });
  await recordEmbeddingUsage({ kind: "query", organizationId: orgId, inputs: 1, tokens: 12 });
  const rows = await systemDb
    .select()
    .from(assistantEmbeddingUsage)
    .where(eq(assistantEmbeddingUsage.organizationId, orgId));
  const f1 = await monthUsage(orgId);
  ok(
    "F1 a search query's embedding is recorded for the organization",
    rows.some((r) => r.inputTokens === 12 && r.kind === "query"),
  );
  ok(
    "F2 embeddings do not count toward the allowance, tokens or questions",
    f1.allowance?.used_usd_cents === f0.allowance?.used_usd_cents &&
      f1.platform_tokens === f0.platform_tokens &&
      f1.turns === f0.turns &&
      f1.cost_fixed12 === f0.cost_fixed12,
  );
  // An organization that does not exist breaks the insert: logged, never thrown.
  let threw = false;
  await recordEmbeddingUsage({
    kind: "query",
    organizationId: "00000000-0000-7000-8000-000000000000",
    inputs: 1,
    tokens: 1,
  }).catch(() => (threw = true));
  ok("F3 a failed usage record never throws", !threw);
}

// ── § E · self-hosted ───────────────────────────────────────────────────────────
cfg.TMBILLING_EDITION = "self_hosted";
const e1 = await monthUsage(orgId);
ok("E1 self-hosted: no allowance, whatever is set", e1.allowance === null);
cfg.TMBILLING_EDITION = "cloud";

await app.close();
let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);
