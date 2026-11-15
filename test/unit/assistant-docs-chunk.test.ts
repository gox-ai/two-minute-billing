import { describe, expect, it } from "vitest";
import {
  chunkMarkdown,
  contentPathToUrl,
  headingAnchor,
  readableMarkdown,
} from "@/modules/assistant-docs/chunk";
import { screenChunks, sectionKeys } from "@/modules/assistant-docs/index-docs";
import { buildDocsMap } from "@/modules/assistant-docs/map";
import {
  isDeveloperPage,
  keyStems,
  meaningScore,
  orQuery,
  rescore,
} from "@/modules/assistant-docs/search";
import { embedBatches, embedHash, embedText } from "@/modules/assistant-docs/vectors";

describe("contentPathToUrl", () => {
  it("drops order prefixes and index pages", () => {
    expect(contentPathToUrl("help/02.guides/03.recover-failed-payments.md")).toBe(
      "/help/guides/recover-failed-payments",
    );
    expect(contentPathToUrl("help/40.developers/05.webhooks/index.md")).toBe(
      "/help/developers/webhooks",
    );
  });
});

describe("readableMarkdown", () => {
  it("drops MDC component lines and inline component syntax", () => {
    const md = "Before\n::callout{icon=x}\nInside\n::\nA :badge{label=New} word";
    expect(readableMarkdown(md)).toBe("Before\nInside\nA  word");
  });
});

describe("chunkMarkdown", () => {
  it("splits at ## and ### headings, anchors each section, and ignores headings in code", () => {
    const md =
      "---\ntitle: Webhooks\ndescription: Get events.\n---\nIntro.\n## Verify signatures\nUse the secret.\n```sh\n## not a heading\n```\n### Retries\nWe retry.";
    const c = chunkMarkdown(md, {
      source: "help",
      path: "p",
      url: "https://x/help/w",
      fallbackTitle: "f",
    });
    expect(c.map((x) => [x.heading, x.url])).toEqual([
      [null, "https://x/help/w"],
      ["Verify signatures", "https://x/help/w#verify-signatures"],
      ["Retries", "https://x/help/w#retries"],
    ]);
    expect(c[0]!.body).toContain("Get events.");
    expect(c[1]!.body).toContain("## not a heading");
    expect(c.every((x) => x.title === "Webhooks")).toBe(true);
  });

  it("splits a long section at paragraphs", () => {
    const long = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} ${"word ".repeat(60)}`).join(
      "\n\n",
    );
    const c = chunkMarkdown(`## Big\n${long}`, {
      source: "help",
      path: "p",
      url: null,
      fallbackTitle: "T",
    });
    expect(c.length).toBeGreaterThan(1);
    expect(c.every((x) => x.body.length <= 3200)).toBe(true);
  });
});

describe("headingAnchor / orQuery", () => {
  it("anchors like the docs site", () => {
    expect(headingAnchor("Verify `signatures` (HMAC)")).toBe("verify-signatures-hmac");
  });
  it("ORs the question's own words; keyword-only adds the docs' term for a synonym", () => {
    expect(orQuery("What about a chargeback?")).toBe("what | about | chargeback");
    expect(orQuery("What about a chargeback?", true)).toBe("what | about | chargeback | (dispute)");
    expect(orQuery("   ")).toBeNull();
  });
});

describe("API reference pages", () => {
  const page = [
    "---",
    'title: "Pause dunning until a given time"',
    "seo:",
    '  title: "Pause dunning API"',
    '  description: "POST /v1/x/pause_dunning: pause dunning. Requires until."',
    "---",
    "",
    '::api-operation{method="POST" path="/v1/x/pause_dunning"}',
    "#docs",
    "## Body",
    "",
    "| Field | Type |",
    "|---|---|",
    "| `until` | `string` |",
    "",
    "## Response",
    "",
    "| Field | Type |",
    "",
    "#request",
    "```bash [Request]",
    "curl -X POST ...",
    "```",
    "",
    "#response",
    "```json [200 OK]",
    '{ "object": "invoice" }',
    "```",
    "::",
  ].join("\n");
  const c = chunkMarkdown(page, { source: "api", path: "p", url: "u", fallbackTitle: "T" });

  it("opens with the operation, its summary and the request fields, not a slot marker", () => {
    expect(c[0]!.heading).toBeNull();
    expect(c[0]!.body).toContain("POST /v1/x/pause_dunning");
    expect(c[0]!.body).toContain("Requires until.");
    expect(c[0]!.body).toContain("`until`");
  });
  it("keeps no slot markers and no sample responses", () => {
    expect(c.some((x) => /^#(docs|request|response)\b/m.test(x.body))).toBe(false);
    expect(c.some((x) => x.body.includes('"object": "invoice"'))).toBe(false);
  });
});

describe("rescore", () => {
  const hit = (heading: string | null, url: string, sqlRank: number) => ({
    source: "help" as const,
    title: "Recover failed payments",
    heading,
    url,
    path: url.split("#")[0]!,
    excerpt: "",
    body: "",
    rank: sqlRank,
    sqlRank,
  });
  it("a heading that names the question beats body text that only contains its words", () => {
    const [a, b] = rescore("how do I pause dunning on an invoice", [
      hit("Recover it with a new card", "/help/guides/x#recover", 0.55),
      hit("Retry, pause or stop dunning", "/help/guides/x#retry", 0.45),
    ]);
    expect(b!.rank).toBeGreaterThan(a!.rank);
  });
  it("a heading with only generic words earns little", () => {
    expect(keyStems("refund a customer")).toEqual(["refun", "custo"]);
    const [generic, exact] = rescore("refund a customer", [
      hit("Raise limits as customers pay", "/help/guides/y#raise", 0.5),
      hit("Refund or give money back", "/help/guides/z#refund", 0.5),
    ]);
    expect(exact!.rank - generic!.rank).toBeGreaterThan(0.15);
  });
  it("a short heading word does not name a longer question word", () => {
    const [a] = rescore("what happens when I send too many requests", [
      hit("Go to the list", "/help/guides/q#go", 0.5),
    ]);
    expect(a!.rank).toBeCloseTo(0.5, 5);
  });
  it("developer pages yield to guides for an operator and lead for a developer", () => {
    const rows = [
      hit("Pause", "/help/developers/recipes/x#pause", 0.5),
      hit("Pause", "/help/guides/x#pause", 0.5),
    ];
    // The words do not decide: the same question ranks by who asks.
    const [dev, guide] = rescore("how do I delete fields with the API", rows, false, "operator");
    expect(guide!.rank).toBeGreaterThan(dev!.rank);
    const [dev2, guide2] = rescore("pause dunning", rows, false, "developer");
    expect(dev2!.rank).toBeGreaterThan(guide2!.rank);
    const [dev3, guide3] = rescore("pause dunning", rows);
    expect(dev3!.rank).toBe(guide3!.rank);
  });
  it("a developer concept page yields to the guide for an operator", () => {
    const [concept, guide] = rescore(
      "refund a customer",
      [
        hit("Refund", "/help/developers/concepts/payments#refund", 0.5),
        hit("Refund", "/help/guides/invoices#refund", 0.5),
      ],
      true,
      "operator",
    );
    expect(guide!.rank).toBeGreaterThan(concept!.rank);
  });
});

describe("meaningScore", () => {
  it("weighs a source above the unrelated floor only, as the keyword list does", () => {
    // An API page a little closer than a guide ranks below it; a much closer one still leads.
    expect(meaningScore(0.666, "api")).toBeLessThan(meaningScore(0.629, "help"));
    expect(meaningScore(0.7, "api")).toBeGreaterThan(meaningScore(0.42, "help"));
    expect(meaningScore(0.3, "api")).toBeCloseTo(0.3, 9);
    expect(meaningScore(0.55, "help")).toBe(0.55);
  });
  it("keeps the order within one source", () => {
    expect(meaningScore(0.5, "code")).toBeGreaterThan(meaningScore(0.49, "code"));
  });
});

describe("search notes", () => {
  const hit = (heading: string, notes: string | null, sqlRank: number) => ({
    source: "help" as const,
    title: "Emails and branding",
    heading,
    url: `/help/guides/emails#${heading.toLowerCase().replace(/\s+/g, "-")}`,
    path: "/help/guides/emails",
    excerpt: "",
    body: "",
    rank: sqlRank,
    sqlRank,
    notes,
  });
  it("a note phrase in the member's words lifts its section in hybrid search, not keyword-only", () => {
    const rows = [
      hit("See what was delivered", null, 0.5),
      hit("Suppressed addresses", "Context.\nemails to one customer keep bouncing", 0.4),
    ];
    const [plainSeen, plainSup] = rescore("emails to a customer keep bouncing", rows);
    expect(plainSeen!.rank).toBeGreaterThan(plainSup!.rank);
    const [seen, sup] = rescore("emails to a customer keep bouncing", rows, true);
    expect(sup!.rank).toBeGreaterThan(seen!.rank);
  });
  it("a heading that names the question wins a tie with another section's note phrase", () => {
    const [log, audit] = rescore(
      "where is the audit log",
      [
        hit("Logs inside a business", "Context.\naudit log versus request log", 0.5),
        hit("The audit log", null, 0.5),
      ],
      true,
    );
    expect(audit!.rank).toBeGreaterThan(log!.rank);
  });
  it("sections sharing a URL get distinct keys", () => {
    const c = (heading: string, url: string | null, source: "help" | "api" = "help") => ({
      source,
      path: "p",
      url,
      title: "T",
      heading,
      body: "b",
    });
    expect(
      sectionKeys([
        c("A", "https://twominutebilling.com/help/guides/x#a"),
        c("A", "https://twominutebilling.com/help/guides/x#a"),
        c("B", "https://twominutebilling.com/help/guides/x"),
        c("Op", "https://twominutebilling.com/help/developers/api-reference/x", "api"),
      ]),
    ).toEqual(["guides/x#a", "guides/x#a~2", "guides/x", null]);
  });
  it("every section is embedded, keyed by model, length and text", () => {
    const c = {
      source: "help" as const,
      path: "p",
      url: null,
      title: "T",
      heading: "H",
      body: "b",
    };
    expect(embedHash(c)).toMatch(/^[0-9a-f]{32}$/);
    expect(embedHash({ ...c, notes: "context\nask" })).not.toBe(embedHash(c));
    expect(embedHash({ ...c, source: "engine" })).toBe(embedHash(c));
    // Code is embedded at a shorter length, so the same text has another key.
    expect(embedHash({ ...c, source: "code" })).not.toBe(embedHash(c));
    expect(embedText({ ...c, notes: "context\nask" })).toBe("T — H\ncontext\nask\nb");
  });
});

describe("screens and code", () => {
  it("a mixed run embeds every section: code and the rest in their own batches", () => {
    // 7 code + 3 screens once skipped the screens: the loop stepped past a short last slice.
    const rows = [
      ...Array.from({ length: 7 }, (_, i) => ({ source: "code", i })),
      ...Array.from({ length: 3 }, (_, i) => ({ source: "ui", i })),
    ];
    const batches = embedBatches(rows);
    expect(batches.map((b) => [b.dims, b.rows.length])).toEqual([
      [256, 7],
      [1536, 3],
    ]);
    expect(embedBatches(rows, 4).flatMap((b) => b.rows)).toHaveLength(10);
  });
  const screen = (controls: string[]) =>
    JSON.stringify([
      {
        route: "/businesses/{business}/subscriptions/{sub}",
        scope: "biz",
        label: "Subscription",
        section: "Billing",
        controls,
      },
    ]);
  it("a screen splits by card: small cards share a section, a big one splits, each keyed", () => {
    const n = (k: number, p: string) => Array.from({ length: k }, (_, i) => `${p} ${i}`);
    const groups = [
      { title: "Subscription configurations", controls: n(12, "Config") },
      { title: "Comments", controls: n(3, "Comment") },
      { title: "History", controls: n(45, "History") },
    ];
    const parts = screenChunks(
      JSON.stringify([
        {
          route: "/businesses/{business}/subscriptions/{sub}",
          scope: "biz",
          label: "Subscription",
          section: "Billing",
          controls: groups.flatMap((g) => g.controls),
          groups,
        },
      ]),
    );
    expect(parts.map((p) => p.heading)).toEqual([
      "Subscription › Subscription configurations",
      "Subscription › History",
      "Subscription › History",
    ]);
    expect(parts[0]!.body).toContain("Cards: Subscription configurations · Comments\n");
    expect(parts.every((p) => p.url === "/businesses/{business}/subscriptions/{sub}")).toBe(true);
    expect(sectionKeys(parts)).toEqual([
      "screen:/businesses/{business}/subscriptions/{sub}",
      "screen:/businesses/{business}/subscriptions/{sub}~2",
      "screen:/businesses/{business}/subscriptions/{sub}~3",
    ]);
    expect(screenChunks(screen([]))[0]!.body).toContain("(no labelled controls)");
  });
  const row = (source: "code" | "ui", heading: string, body: string, sqlRank: number) => ({
    source,
    title: "t",
    heading,
    url: source === "ui" ? `/s/${heading}` : null,
    path: `${source}/${heading}`,
    excerpt: "",
    body,
    rank: sqlRank,
    sqlRank,
  });
  it("code ranks by the share of the question it covers, not by how many words a registry repeats", () => {
    const [registry, setting] = rescore("stop excess payments auto applying", [
      row(
        "code",
        "EVENT_TYPES",
        "payment excess payments applied stop stop payment invoice auto",
        0.9,
      ),
      row(
        "code",
        "setSubscriptionCreditUsageAction",
        'maxExcessPaymentUsage "Never auto-apply here" stop',
        0.2,
      ),
    ]);
    expect(setting!.rank).toBeGreaterThan(registry!.rank);
  });
  it("a screen whose one control names the question beats a screen that has the words scattered", () => {
    const [scattered, named] = rescore("excess payments auto-apply", [
      row(
        "ui",
        "Invoices",
        "On this screen: Excess · Payments list · Auto collection · Apply filter",
        0.5,
      ),
      row("ui", "Subscription", "On this screen: Edit · Excess payments auto-apply · Save", 0.4),
    ]);
    expect(named!.rank).toBeGreaterThan(scattered!.rank);
  });
});

describe("docs map", () => {
  it("lists help pages by title, folds the gateway guides into one line and skips the API reference", () => {
    const map = buildDocsMap();
    expect(map).toContain("- Recover failed payments: ");
    expect(
      map.match(/^- Connect a payment gateway: one setup guide each for .*Stripe/m),
    ).toBeTruthy();
    expect(map).not.toContain("api-reference");
    expect(map).not.toMatch(/https?:\/\//);
  });
});

describe("developer pages", () => {
  it("the API reference and the help's developer section are developer pages; guides are not", () => {
    const at = (source: "help" | "api", url: string) => ({ source, url });
    expect(
      isDeveloperPage(at("api", "https://twominutebilling.com/help/developers/api-reference/x")),
    ).toBe(true);
    expect(
      isDeveloperPage(at("help", "https://twominutebilling.com/help/developers/concepts/credits")),
    ).toBe(true);
    expect(
      isDeveloperPage(
        at("help", "https://twominutebilling.com/help/guides/invoices-and-credit-notes"),
      ),
    ).toBe(false);
  });
});
