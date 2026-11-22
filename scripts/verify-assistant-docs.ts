/**
 * The assistant's docs index and search.
 *
 *  - § A the index builds from the files on disk, once per content change, without MDC syntax
 *  - § B 40 how-to questions, worded as an operator or developer would ask them, each find
 *        their page in the top 3
 *  - § C the API reference tool returns exact operations
 *  - § D operator questions land on the right SECTION, not only the right page; API questions
 *        reach their reference page, which opens with the operation and its request fields
 *  - § E held-out questions in users' own words: a tracked score with floors that only go up
 *        (SHOW_MISSES=1 lists the questions whose page is not in the top 3)
 *  - § F product questions (where, take me to, how do I, a problem) find the screen and the
 *        code behind the control; scored on held-out questions
 *
 *   pnpm verify:assistant-docs
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { closeDb, systemDb } from "@/platform/db";
import { ensureDocsIndex, HELP_ORIGIN } from "@/modules/assistant-docs/index-docs";
import { apiOperation, findApiOperations, searchDocs } from "@/modules/assistant-docs/search";
import { ensureDocVectors, vectorsConfigured } from "@/modules/assistant-docs/vectors";

const checks: Array<[string, boolean]> = [];
const ok = (n: string, c: boolean) => checks.push([n, c]);

// ── § A · the index ──────────────────────────────────────────────────────────────
const first = await ensureDocsIndex();
const second = await ensureDocsIndex();
// Hybrid when the platform OpenAI key is set; keyword-only otherwise. Both modes are gated.
const HYBRID = vectorsConfigured();
if (HYBRID) await ensureDocVectors();
console.log(`  search mode: ${HYBRID ? "hybrid (keyword + embeddings)" : "keyword only"}`);
const [counts] = (await systemDb.execute(sql`
  select count(*)::int as n,
         count(*) filter (where source = 'help')::int as help,
         count(*) filter (where source = 'api')::int as api,
         count(*) filter (where source = 'engine')::int as engine,
         count(*) filter (where source = 'ui')::int as ui,
         count(*) filter (where source = 'code')::int as code,
         count(*) filter (where source = 'code' and path like 'src/modules/migration/%')::int as import_code,
         count(*) filter (where source in ('help', 'api') and (body like '%:::%' or body ~ '^::' or body ~ '(^|\n)#(docs|request|response)\s'))::int as mdc,
         count(*) filter (where source = 'api' and path not like '%/index.md'
           and length(regexp_replace(body, '\s', '', 'g')) < 20)::int as empty_api
  from assistant_doc_chunks
`)) as unknown as Array<{
  n: number;
  help: number;
  api: number;
  engine: number;
  ui: number;
  code: number;
  import_code: number;
  mdc: number;
  empty_api: number;
}>;
ok(
  `A1 the index holds help, API and engine sections (${counts?.n})`,
  !!counts && counts.help > 200 && counts.api > 500 && counts.engine > 100,
);
ok(
  "A2 an unchanged corpus is not rebuilt",
  second.rebuilt === false && second.chunks === first.chunks,
);
ok("A3 no MDC component syntax or slot marker reaches the index", counts?.mdc === 0);
ok(`A7 every API reference section has text (${counts?.empty_api} empty)`, counts?.empty_api === 0);
const [vectors] = (await systemDb.execute(sql`
  select count(*)::int as sections,
         count(*) filter (where v.hash is not null)::int as embedded,
         count(*) filter (where c.source in ('help', 'ui') and c.notes is not null)::int as noted,
         count(*) filter (where c.source in ('help', 'ui'))::int as help
  from assistant_doc_chunks c left join assistant_doc_vectors v on v.hash = c.embed_hash
`)) as unknown as Array<{ sections: number; embedded: number; noted: number; help: number }>;
ok(
  `A8 help and screen sections carry their search notes (${vectors?.noted}/${vectors?.help})`,
  !!vectors && vectors.noted >= vectors.help * 0.95,
);
if (HYBRID)
  ok(
    `A9 every section is embedded: help, API, screens, engine notes, code (${vectors?.embedded}/${vectors?.sections})`,
    !!vectors && vectors.embedded === vectors.sections,
  );
ok(
  `A4 the dashboard map is indexed, every screen in sections of its controls (${counts?.ui})`,
  (counts?.ui ?? 0) > 150,
);
ok(`A5 the published source is indexed (${counts?.code} sections)`, (counts?.code ?? 0) > 3000);
ok("A6 the import module's source is kept out", counts?.import_code === 0);

// ── § B · golden questions ───────────────────────────────────────────────────────
const H = (p: string) => `${HELP_ORIGIN}/help/${p}`;
/**
 * Who asks, as the app's model says it (`audience`): a question whose answer is a developer page
 * is a developer's; every other one an operator's. The wording of the question never decides.
 */
const audienceFor = (want: string[]) =>
  want.some((w) => w.includes("/help/developers/"))
    ? ("developer" as const)
    : ("operator" as const);
const GOLDEN: Array<[string, string[]]> = [
  [
    "How do I retry a declined card automatically?",
    [H("guides/recover-failed-payments"), H("developers/recipes/failed-payments")],
  ],
  ["How do I connect Stripe?", [H("guides/connect-a-payment-gateway/stripe")]],
  ["Set up Razorpay to collect INR", [H("guides/connect-a-payment-gateway/razorpay")]],
  ["How do I charge VAT to customers in Europe?", [H("guides/vat-for-saas-in-europe")]],
  ["Where do I configure sales tax rates?", [H("guides/set-up-tax"), H("developers/concepts/tax")]],
  // payment-methods answers it too ("save a payment method … in the portal").
  [
    "Can customers update their own card?",
    [
      H("guides/hosted-checkout-and-portal"),
      H("developers/recipes/checkout-and-portal"),
      H("guides/payment-methods"),
    ],
  ],
  ["Which payment methods can my customers pay with?", [H("guides/payment-methods")]],
  ["How do I put my logo on invoice emails?", [H("guides/emails-and-branding")]],
  ["What do I do when a customer files a chargeback?", [H("guides/handle-disputes")]],
  [
    "How can I test a renewal that happens next month?",
    [H("guides/test-with-time-travel"), H("developers/getting-started/test-and-live")],
  ],
  [
    "What does MRR mean on the home page?",
    [H("guides/read-your-numbers"), H("developers/concepts/analytics")],
  ],
  ["How do I invite a teammate and give them a role?", [H("guides/your-team")]],
  ["Sync customers to HubSpot", [H("guides/connect-integrations")]],
  [
    "How do I charge for API calls by usage?",
    [
      H("guides/usage-and-ai-billing/usage-pricing"),
      H("developers/recipes/usage-based-billing"),
      H("guides/usage-and-ai-billing/meters-and-rate-cards"),
    ],
  ],
  [
    "How do I sell prepaid credits?",
    [H("guides/usage-and-ai-billing/prepaid-credits"), H("developers/recipes/prepaid-ai-credits")],
  ],
  [
    "Stop a customer from spending more than a limit",
    [
      H("guides/usage-and-ai-billing/spend-limits-and-auto-top-up"),
      H("developers/recipes/spend-limits-and-auto-top-up"),
    ],
  ],
  [
    "Bill customers for the AI tokens they use",
    [H("developers/recipes/bill-ai-tokens"), H("guides/usage-and-ai-billing/model-price-list")],
  ],
  [
    "How do I issue a credit note for a refund?",
    [H("guides/invoices-and-credit-notes"), H("developers/concepts/invoices")],
  ],
  ["What do I need to do before taking real payments?", [H("getting-started/go-live")]],
  [
    "Create my first product and price",
    [H("getting-started/build-your-catalogue"), H("developers/concepts/catalog")],
  ],
  ["How do I authenticate API requests?", [H("developers/api-essentials/authentication")]],
  [
    "How do I avoid charging twice when a request is retried?",
    [H("developers/api-essentials/idempotency")],
  ],
  [
    "How do I page through a long list of customers with the API?",
    [H("developers/api-essentials/pagination-and-filtering")],
  ],
  ["What happens when I send too many API requests?", [H("developers/api-essentials/rate-limits")]],
  ["Are amounts in cents or decimals?", [H("developers/api-essentials/money")]],
  ["How do I check a webhook signature?", [H("developers/webhooks/signatures")]],
  ["Are webhooks retried when my endpoint is down?", [H("developers/webhooks/delivery")]],
  ["Which webhook events can I receive?", [H("developers/webhooks/events")]],
  [
    "Can I run it on my own server with Docker?",
    [H("developers/getting-started/self-host-docker")],
  ],
  [
    "What is the difference between test mode and live mode?",
    [H("developers/getting-started/test-and-live")],
  ],
  ["How do I offer a 14-day free trial?", [H("developers/recipes/trials")]],
  [
    "Upgrade a customer in the middle of the month with proration",
    [H("developers/recipes/plan-changes")],
  ],
  ["How do I create a coupon for 20% off?", [H("developers/recipes/coupons")]],
  ["Sell a one-off product with a payment link", [H("developers/recipes/one-time-purchases")]],
  ["Generate GST invoices for customers in India", [H("developers/recipes/india-gst-invoices")]],
  ["UPI autopay for recurring payments in India", [H("developers/recipes/india-mandates")]],
  ["Send usage events from my app", [H("developers/recipes/meter-usage-events")]],
  ["Connect Claude to my billing data", [H("developers/getting-started/connect-ai-assistants")]],
  ["Limit features per plan, like seats", [H("developers/concepts/entitlements")]],
  [
    "How do organizations, businesses and customers relate?",
    [H("developers/concepts/account-hierarchy")],
  ],
];
let hits = 0;
for (const [q, want] of GOLDEN) {
  const top = (
    await searchDocs(q, { sources: ["help", "api"], limit: 3, audience: audienceFor(want) })
  ).map((h) => (h.url ?? "").split("#")[0] ?? "");
  const found = top.some((u) => want.includes(u));
  if (found) hits++;
  else console.log(`    miss: "${q}"\n      got: ${top.join(" | ")}`);
}
ok(
  `B1 golden questions find their page in the top 3 (${hits}/${GOLDEN.length})`,
  hits === GOLDEN.length,
);
const odd = await searchDocs("xqzv blorptastic", { limit: 3 });
ok("B2 nonsense finds nothing", odd.length === 0);
const hit = (await searchDocs("verify webhook signature", { limit: 1 }))[0];
ok(
  "B3 a hit carries a section URL and an excerpt",
  !!hit?.url?.startsWith(HELP_ORIGIN) && (hit?.excerpt ?? "").length > 20,
);

// ── § B2 · where-do-I questions find their screen ────────────────────────────────
const SCREENS: Array<[string, string[]]> = [
  ["create an API key", ["/developer"]],
  ["change the dunning retry schedule", ["/businesses/{business}/settings/dunning"]],
  ["write off an invoice as bad debt", ["/businesses/{business}/invoices/{inv}"]],
  ["use our own OpenAI key for the assistant", ["/settings/assistant"]],
  ["invite a teammate", ["/team"]],
  ["disconnect an AI app", ["/developer/connected-apps"]],
  [
    "create a coupon",
    ["/businesses/{business}/catalog/coupons/new", "/businesses/{business}/catalog/coupons"],
  ],
  ["record an offline payment on an invoice", ["/businesses/{business}/invoices/{inv}"]],
];
let screenHits = 0;
for (const [q, want] of SCREENS) {
  const top = (await searchDocs(q, { sources: ["ui"], limit: 3 })).map((h) => h.url ?? "");
  if (top.some((u) => want.includes(u))) screenHits++;
  else console.log(`    screen miss: "${q}"\n      got: ${top.join(" | ")}`);
}
ok(
  `B4 where-do-I questions find their screen in the top 3 (${screenHits}/${SCREENS.length})`,
  screenHits >= SCREENS.length - 1,
);
const code = await searchDocs("proration credit on a downgrade", { sources: ["code"], limit: 5 });
// The decision lives in the subscription billing rules (downgrade credit) and the estimate.
ok(
  "B5 the source search finds the subscription engine's downgrade-credit code",
  code.some((h) => h.path.startsWith("src/modules/subscriptions/")),
);

// ── § C · API reference ──────────────────────────────────────────────────────────
const op = apiOperation("GET", "/v1/businesses/:biz/invoices/:inv/explanation");
ok(
  "C1 an operation is returned with its documented responses",
  !!op && !!(op.responses as Record<string, unknown>)?.["200"],
);
ok("C2 a missing operation is null", apiOperation("GET", "/v1/nope") === null);
const found = findApiOperations("cancel subscription");
ok(
  "C3 operations are found by words",
  found.some((o) => o.method === "POST" && o.path.includes("/subscriptions/{sub}/cancel")),
);

// ── § D · the right section ──────────────────────────────────────────────────────
const S = (p: string) => `${HELP_ORIGIN}/help/${p}`;
const SECTIONS: Array<[string, string[]]> = [
  [
    "how do I pause dunning on an invoice",
    [
      S("guides/recover-failed-payments#retry-pause-or-stop-dunning"),
      S("developers/recipes/failed-payments#pause-the-schedule"),
    ],
  ],
  [
    "how do I exclude a customer from dunning",
    [S("guides/recover-failed-payments#leave-a-customer-out-of-dunning")],
  ],
  [
    "change the retry schedule for failed payments",
    [S("guides/recover-failed-payments#set-the-retry-schedule")],
  ],
  [
    "how do I skip a renewal for one month",
    [S("guides/customers-and-subscriptions#skip-a-renewal")],
  ],
  [
    "how do I pause a subscription",
    [S("guides/customers-and-subscriptions#pause-cancel-and-reactivate")],
  ],
  [
    "add a one-time charge to a customer",
    [S("guides/customers-and-subscriptions#charge-something-one-off")],
  ],
  [
    "should I void an invoice or issue a credit note",
    [S("guides/invoices-and-credit-notes#void-versus-credit-note")],
  ],
  ["how do I refund a customer", [S("guides/invoices-and-credit-notes#refund-or-give-money-back")]],
  [
    "collect payment for several invoices at once",
    [S("guides/invoices-and-credit-notes#collect-several-invoices-at-once")],
  ],
  ["make my prices include tax", [S("guides/set-up-tax#decide-whether-prices-include-tax")]],
  ["a customer is tax exempt", [S("guides/set-up-tax#handle-exemptions")]],
  [
    "how do I check an EU VAT number",
    [S("guides/vat-for-saas-in-europe#how-do-i-check-an-eu-vat-number")],
  ],
  ["change the wording of the invoice email", [S("guides/emails-and-branding#edit-the-wording")]],
  ["create a custom role", [S("guides/your-team#create-a-custom-role")]],
  ["where is the audit log", [S("guides/your-team#the-audit-log")]],
  ["use my own OpenAI key for Billy", [S("guides/ask-billy#included-use-and-your-own-key")]],
];
let sectionFirst = 0;
let inTop3 = 0;
for (const [q, want] of SECTIONS) {
  const urls = (
    await searchDocs(q, { sources: ["help", "api"], limit: 3, audience: audienceFor(want) })
  ).map((h) => h.url ?? "");
  if (want.includes(urls[0] ?? "")) sectionFirst++;
  else console.log(`    section: "${q}"\n      got: ${urls.join(" | ")}`);
  if (urls.some((u) => want.includes(u))) inTop3++;
}
ok(
  `D1 the right section is in the top 3 (${inTop3}/${SECTIONS.length})`,
  inTop3 === SECTIONS.length,
);
ok(`D2 …and first (${sectionFirst}/${SECTIONS.length})`, sectionFirst >= SECTIONS.length - 1);
const API_REF = (p: string) => S(`developers/api-reference/${p}`);
const APIQ: Array<[string, string, string]> = [
  [
    "what fields does the pause dunning request take",
    API_REF("invoices/pause-dunning-until-a-given-time"),
    "`until`",
  ],
  ["void an invoice with the API", API_REF("invoices/void-an-open-invoice"), "/void"],
  ["API to cancel a subscription", API_REF("subscriptions/cancel-a-subscription"), "/cancel"],
];
let apiOk = 0;
for (const [q, page, text] of APIQ) {
  const h = (
    await searchDocs(q, { sources: ["help", "api"], limit: 3, audience: "developer" })
  ).find((x) => (x.url ?? "").split("#")[0] === page);
  if (h?.body.includes(text)) apiOk++;
  else
    console.log(
      `    api: "${q}" → ${h ? JSON.stringify(h.body.slice(0, 80)) : "page not in the top 3"}`,
    );
}
ok(
  `D3 API questions reach their reference page, with the operation in the text (${apiOk}/${APIQ.length})`,
  apiOk === APIQ.length,
);

// ── § E · own words ──────────────────────────────────────────────────────────────
// Held-out questions in users' own words (scripts/fixtures/assistant-docs-golden.json), written
// without seeing the search notes. A tracked score: the floors only ever go up.
const GOLD = JSON.parse(
  readFileSync(new URL("./fixtures/assistant-docs-golden.json", import.meta.url), "utf8"),
) as Array<{ q: string; want: string[]; set: "held-out" | "own"; model: string }>;
const FLOOR = HYBRID ? { first: 40, top3: 60, page3: 80 } : { first: 19, top3: 28, page3: 52 };
const key = (u: string) => u.replace(/^https?:\/\/[^/]+\/help\/?/, "");
const strip = (w: string) => w.replace(/~\d+$/, "");
let gFirst = 0;
let gTop3 = 0;
let gPage3 = 0;
let rr = 0;
const heldOut = { n: 0, first: 0, page3: 0 };
// Per billing model, so one-time, usage and AI questions are not hidden by the rest.
const byModel = new Map<string, { n: number; page3: number }>();
for (const { q, want, set, model } of GOLD) {
  const m = byModel.get(model) ?? { n: 0, page3: 0 };
  byModel.set(model, m);
  m.n++;
  const urls = (
    await searchDocs(q, {
      sources: ["help", "api"],
      limit: 5,
      audience: audienceFor(want.map((w) => (w.startsWith("http") ? w : H(w)))),
    })
  ).map((h) => key(h.url ?? ""));
  const isHit = (u: string) =>
    want.some((w) => (w.includes("#") ? u === strip(w) : u.split("#")[0] === strip(w)));
  const at = urls.findIndex(isHit);
  if (set === "held-out") heldOut.n++;
  if (at === 0) gFirst++;
  if (at === 0 && set === "held-out") heldOut.first++;
  if (at >= 0 && at < 3) gTop3++;
  if (at >= 0) rr += 1 / (at + 1);
  if (urls.slice(0, 3).some((u) => want.some((w) => u.split("#")[0] === strip(w).split("#")[0]))) {
    gPage3++;
    m.page3++;
    if (set === "held-out") heldOut.page3++;
  } else if (process.env.SHOW_MISSES)
    console.log(`    own words: "${q}"\n      got: ${urls.slice(0, 3).join(" | ")}`);
}
const pct = (n: number) => Math.round((100 * n) / GOLD.length);
console.log(
  `    own words (${GOLD.length}): section first ${pct(gFirst)}% · section top 3 ${pct(gTop3)}% · page top 3 ${pct(gPage3)}% · MRR@5 ${(rr / GOLD.length).toFixed(3)}`,
);
console.log(
  `    of which held out (${heldOut.n}): section first ${heldOut.first} · page top 3 ${heldOut.page3}`,
);
console.log(
  `    page top 3 by model: ${[...byModel].map(([k, m]) => `${k} ${m.page3}/${m.n}`).join(" · ")}`,
);
ok(
  `E1 own-words questions keep their score (first ${pct(gFirst)}% ≥ ${FLOOR.first}, top 3 ${pct(gTop3)}% ≥ ${FLOOR.top3}, page top 3 ${pct(gPage3)}% ≥ ${FLOOR.page3})`,
  pct(gFirst) >= FLOOR.first && pct(gTop3) >= FLOOR.top3 && pct(gPage3) >= FLOOR.page3,
);

// ── § F · product questions find the control ─────────────────────────────────────
// Questions whose answer is a control on a screen, whether or not the help mentions it, in
// every form people use: "where is", "take me to", "how do I", a problem, a few keywords
// (scripts/fixtures/assistant-capability-golden.json). The screen map must name the screen
// in the top 3, and the source search must reach the code that renders the control. Tune
// only against the "own" third; report the held-out two thirds.
const CAP = JSON.parse(
  readFileSync(new URL("./fixtures/assistant-capability-golden.json", import.meta.url), "utf8"),
) as Array<{
  q: string;
  label: string;
  screens: string[];
  model: string;
  form: string;
  set: "own" | "held-out";
}>;
const route = (u: string | null) => (u ?? "").replace("/businesses/{business}", "") || "/";
type Tally = { n: number; screen: number; code: number };
const tally = new Map<string, Tally>();
const add = (key: string, onScreen: boolean, inCode: boolean) => {
  const t = tally.get(key) ?? { n: 0, screen: 0, code: 0 };
  tally.set(key, t);
  t.n++;
  if (onScreen) t.screen++;
  if (inCode) t.code++;
};
for (const { q, label, screens, model, form, set } of CAP) {
  const ui = (await searchDocs(q, { sources: ["ui"], limit: 3 })).map((h) => route(h.url));
  const src = await searchDocs(q, { sources: ["code"], limit: 5 });
  const onScreen = ui.some((r) => screens.includes(r));
  const inCode = src.some((h) => h.body.includes(label));
  for (const key of ["all", set, `model ${model}`, `form ${form}`]) add(key, onScreen, inCode);
  if ((!onScreen || !inCode) && process.env.SHOW_MISSES)
    console.log(
      `    control: "${q}"\n      screens: ${ui.join(" | ")}${inCode ? "" : `\n      code misses "${label}"`}`,
    );
}
const line = (keys: string[]) =>
  keys
    .filter((k) => tally.has(k))
    .map(
      (k) =>
        `${k.replace(/^(model|form) /, "")} ${tally.get(k)!.screen}/${tally.get(k)!.code}/${tally.get(k)!.n}`,
    )
    .join(" · ");
const all = tally.get("all")!;
const held = tally.get("held-out")!;
const capPct = (t: Tally, k: "screen" | "code") => Math.round((100 * t[k]) / t.n);
console.log(
  `    product questions (${all.n}): screen top 3 ${capPct(all, "screen")}% · control in code top 5 ${capPct(all, "code")}%; held out (${held.n}): ${capPct(held, "screen")}% · ${capPct(held, "code")}%`,
);
console.log(
  `      screen/code/n by model: ${line([...tally.keys()].filter((k) => k.startsWith("model ")))}`,
);
console.log(`      by form: ${line([...tally.keys()].filter((k) => k.startsWith("form ")))}`);
const CAP_FLOOR = HYBRID ? { screen: 52, code: 14 } : { screen: 36, code: 9 };
ok(
  `F1 product questions keep their score (screen ${capPct(all, "screen")}% ≥ ${CAP_FLOOR.screen}, code ${capPct(all, "code")}% ≥ ${CAP_FLOOR.code})`,
  capPct(all, "screen") >= CAP_FLOOR.screen && capPct(all, "code") >= CAP_FLOOR.code,
);

let failed = 0;
for (const [n, c] of checks) {
  console.log(`  ${c ? "✓" : "✗"} ${n}`);
  if (!c) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
await closeDb();
process.exit(failed ? 1 : 0);
