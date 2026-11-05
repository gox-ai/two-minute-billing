import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");

describe("the published OpenAPI document", () => {
  it("every schema $ref names a defined schema", () => {
    const text = readFileSync(join(ROOT, "sdk/openapi.json"), "utf8");
    const defined = new Set(
      Object.keys(
        (JSON.parse(text) as { components: { schemas: Record<string, unknown> } }).components
          .schemas,
      ),
    );
    const refs = new Set(
      [...text.matchAll(/#\/components\/schemas\/([A-Za-z0-9_]+)/g)].map((m) => m[1]!),
    );
    expect([...refs].filter((r) => !defined.has(r))).toEqual([]);
  });
});
