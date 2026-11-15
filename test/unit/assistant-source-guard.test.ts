import { describe, expect, it } from "vitest";
import { redactSourceLeaks } from "@/modules/assistant/leaks";
import { chunkSource, isIndexedSource, splitIdentifier } from "@/modules/assistant-docs/code";
import { screenChunks } from "@/modules/assistant-docs/index-docs";

const SOURCE = `export function computeProrationCredit(item: Item, at: Date) {
  const unused = item.periodEnd.getTime() - at.getTime();
  return Math.round((item.amountMinor * unused) / item.periodLength);
}`;

describe("redactSourceLeaks", () => {
  it("removes a fenced block copied from source, keeps the plain explanation", () => {
    const answer =
      "The credit is the unused part of the period.\n\n```ts\nconst unused = item.periodEnd.getTime() - at.getTime();\n```\n\nIt is rounded to the cent.";
    const r = redactSourceLeaks(answer, [SOURCE]);
    expect(r.text).not.toContain("periodEnd");
    expect(r.text).toContain("unused part of the period");
    expect(r.removed).toBe(1);
  });

  it("removes a line copied verbatim, a file path and a function name", () => {
    const answer =
      "return Math.round((item.amountMinor * unused) / item.periodLength);\nSee src/modules/subscriptions/proration.ts and `computeProrationCredit`.";
    const r = redactSourceLeaks(answer, [SOURCE]);
    expect(r.text).not.toMatch(/Math\.round|src\/modules|computeProrationCredit/);
    expect(r.removed).toBe(3);
  });

  it("keeps API examples from the docs and documented snake_case fields", () => {
    const answer =
      'Send it like this:\n\n```sh\ncurl https://your-api-host/v1/businesses -H "Authorization: Bearer sk_test_…"\n```\n\nRead `amount_due_minor`.';
    const r = redactSourceLeaks(answer, [SOURCE]);
    expect(r.text).toBe(answer);
    expect(r.removed).toBe(0);
  });

  it("still strips repository paths when no source was read", () => {
    expect(
      redactSourceLeaks("It is in dashboard/app/(dashboard)/layout.tsx.", []).text,
    ).not.toContain("layout.tsx");
  });
});

describe("source chunks", () => {
  it("splits identifiers into words", () => {
    expect(splitIdentifier("createApiKey")).toBe("create api key");
    expect(splitIdentifier("amount_due_minor")).toBe("amount due minor");
    expect(splitIdentifier("HTTPServerError")).toBe("http server error");
  });

  it("splits a file at declarations and routes, with searchable terms", () => {
    const text = `${SOURCE}\n\nexport async function registerX(app) {\n  app.get("/v1/things", async () => ({ label: "Create thing" }));\n}\n`;
    const c = chunkSource("src/modules/x/service.ts", text);
    expect(c.every((x) => x.source === "code" && x.title === "src/modules/x/service.ts")).toBe(
      true,
    );
    expect(c.map((x) => x.terms).join(" ")).toContain("compute proration credit");
    expect(c.map((x) => x.terms).join(" ")).toContain("Create thing");
  });

  it("indexes published source only: no tests, generated files or the import module", () => {
    expect(isIndexedSource("src/modules/invoicing/service.ts")).toBe(true);
    expect(isIndexedSource("dashboard/components/assistant/assistant-dock.tsx")).toBe(true);
    expect(isIndexedSource("test/unit/x.test.ts")).toBe(false);
    expect(isIndexedSource("dashboard/lib/permissions.generated.ts")).toBe(false);
    expect(isIndexedSource("src/modules/migration/source.ts")).toBe(false);
    expect(isIndexedSource("scripts/seed.ts")).toBe(false);
  });
});

describe("screenChunks", () => {
  it("makes one section per screen with its path and controls", () => {
    const [c] = screenChunks(
      JSON.stringify([
        {
          route: "/developer",
          scope: "org",
          label: "API keys",
          section: "Developers",
          controls: ["Create API key", "Revoke"],
        },
      ]),
    );
    expect(c!.title).toBe("Developers › API keys");
    expect(c!.url).toBe("/developer");
    expect(c!.body).toContain("On this screen: Create API key · Revoke");
  });
});
