import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openapiDocument } from "@/api/openapi";
import { emitSchemaDts } from "../../scripts/lib/emit-schema-dts";

const SCHEMA_PATH = join(import.meta.dirname, "..", "..", "sdk", "schema.d.ts");
const emit = (schemas: Record<string, Record<string, unknown>>) =>
  emitSchemaDts({ components: { schemas } });

/**
 * `sdk/schema.d.ts` is emitted here rather than by `openapi-typescript`, which cannot run
 * on this repo's compiler: its latest release peer-depends on `typescript@^5.x` and reads
 * `ts.factory` at import, and TypeScript 7's main entry exports only `version` and
 * `versionMajorMinor`.
 *
 * The replacement was proven equivalent to the old output by asserting mutual assignability
 * under `strict` for all **212 paths and 104 schemas** — 0 diagnostics. That proof is
 * repeatable: the reference output is in git history (`git show <rev>:sdk/schema.d.ts`). It
 * is not run here because it needs a whole-program tsc pass; what it TAUGHT is pinned below,
 * seven rules that are not obvious from the document and each of which produced a real
 * mismatch on the way to zero.
 */
describe("sdk schema emitter", () => {
  it("keeps sdk/schema.d.ts in step with the document", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(
      emitSchemaDts(openapiDocument as Parameters<typeof emitSchemaDts>[0]),
    );
  });

  it("emits every schema in the document", () => {
    const committed = readFileSync(SCHEMA_PATH, "utf8");
    const names = Object.keys(
      (openapiDocument as { components: { schemas: Record<string, unknown> } }).components.schemas,
    );
    expect(names.length).toBeGreaterThan(100);
    expect(names.filter((n) => !committed.includes(`        ${n}: `))).toEqual([]);
  });

  // ── The four rules the equivalence proof forced ───────────────────────────────

  it("marks a property with a default as always present", () => {
    // Not in `required`, but a default means a response always carries it.
    const out = emit({
      X: { type: "object", properties: { kind: { type: "string", default: "plan" } } },
    });
    expect(out).toContain("kind: string;");
    expect(out).not.toContain("kind?: string;");
  });

  it("carries readOnly through as a modifier, not as a type change", () => {
    const out = emit({
      X: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string", readOnly: true } },
      },
    });
    expect(out).toContain("readonly name: string;");
  });

  it("intersects an index signature with named properties", () => {
    // A bare index signature in the same literal would have to subsume every named
    // property's type, so the two halves are intersected instead.
    const out = emit({
      X: { type: "object", additionalProperties: true, properties: { id: { type: "string" } } },
    });
    expect(out).toContain("[key: string]: unknown;");
    expect(out).toMatch(/\} & \{/);
  });

  it("drops a sibling key next to $ref", () => {
    // `{ $ref, nullable }` does NOT produce a nullable type — the $ref wins and the sibling
    // is discarded. Several places in the document are written this way and have never
    // produced the optional-null they read as.
    const out = emit({
      X: {
        type: "object",
        properties: { addr: { $ref: "#/components/schemas/DocumentAddress", nullable: true } },
      },
    });
    expect(out).toContain('addr?: components["schemas"]["DocumentAddress"];');
    expect(out).not.toContain('["DocumentAddress"] | null');
  });

  it("nullifies through allOf, where the sibling sits next to allOf and not next to $ref", () => {
    const out = emit({
      X: {
        type: "object",
        properties: {
          o: { nullable: true, allOf: [{ $ref: "#/components/schemas/DeclineOverride" }] },
        },
      },
    });
    expect(out).toContain('o?: components["schemas"]["DeclineOverride"] | null;');
  });

  it("parenthesises a union inside an array", () => {
    const out = emit({
      X: {
        type: "object",
        properties: { xs: { type: "array", items: { type: "string", nullable: true } } },
      },
    });
    expect(out).toContain("xs?: (string | null)[];");
  });

  // ── Rules the restored `paths` block forced out ───────────────────────────────

  it("emits paths, because sdk/ ships to people who do not have this repo", () => {
    // An earlier cut dropped `paths` on the grounds that nothing HERE imports it. `sdk/**`
    // is on the OSS publish allowlist, and `paths` is what types a request by URL and
    // method in a generated client — the one thing an outside consumer needs it for.
    const out = emitSchemaDts(openapiDocument as Parameters<typeof emitSchemaDts>[0]);
    expect(out).toContain("export interface paths {");
    expect(out).toContain('"/v1/businesses/{biz}/customers": {');
  });

  it("keeps a defaulted property optional inside a request body", () => {
    // The mirror image of the response rule above: a default is the server's job precisely
    // because the caller may omit it.
    const doc = {
      paths: {
        "/x": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { scope: { type: "string", default: "write" } },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    };
    expect(emitSchemaDts(doc as Parameters<typeof emitSchemaDts>[0])).toContain("scope?: string;");
  });

  it("renders oneOf as a union", () => {
    const out = emit({
      X: { oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "string" }] },
    });
    expect(out).toMatch(/\} \| string;/);
  });

  it("keeps only the last of a repeated query parameter name", () => {
    // Three list routes declare both `?customer=` and `?customer[op]=` under one name.
    // OpenAPI forbids that; emitting both would be a duplicate key in a type literal.
    const doc = {
      paths: {
        "/x": {
          get: {
            parameters: [
              { name: "customer", in: "query", schema: { type: "string" } },
              {
                name: "customer",
                in: "query",
                style: "deepObject",
                schema: { type: "object", properties: { is: { type: "string" } } },
              },
            ],
            responses: {},
          },
        },
      },
    };
    const out = emitSchemaDts(doc as Parameters<typeof emitSchemaDts>[0]);
    expect(out).not.toContain("customer?: string;");
    expect(out).toContain("is?: string;");
  });
});
