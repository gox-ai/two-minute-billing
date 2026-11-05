import { describe, expect, it } from "vitest";
import { openapiDocument } from "@/api/openapi";
import { INVOICE_FILTER_OPS, INVOICE_SORT_FIELDS } from "@/modules/invoicing/service";
import { SUBSCRIPTION_FILTER_OPS, SUBSCRIPTION_SORT_FIELDS } from "@/modules/subscriptions/service";
import { TRANSACTION_FILTER_OPS, TRANSACTION_SORT_FIELDS } from "@/modules/transactions/service";
import { CREDIT_NOTE_FILTER_OPS, CREDIT_NOTE_SORT_FIELDS } from "@/modules/credit-notes/service";
import {
  WEBHOOK_DELIVERY_FILTER_OPS,
  WEBHOOK_DELIVERY_SORT_FIELDS,
} from "@/modules/webhooks/endpoints";

/**
 * The published document says filtering works one way; `parseListQuery` implements
 * another. These tests exist because BOTH halves of that gap shipped:
 *
 *  1. The document declared one query parameter named `filters`, which no route
 *     accepts — an unknown bare key is a 400 by design. Every client generated from
 *     the spec therefore offered an argument that could only ever fail, and it took
 *     running the spec against a live API to find out.
 *  2. The grammar was prose, and prose drifts: it named 13 of the invoice list's 33
 *     filterable fields, 4 of its 9 sort keys and 5 of the 9 text operators.
 *
 * `src/api/openapi.ts` is import-free on purpose (scripts and unit tests load it
 * without dragging in the DB layer), so its field tables are hand copies. The spec
 * cannot import the constants — a test can import both.
 */

type Param = {
  name: string;
  in: string;
  style?: string;
  explode?: boolean;
  schema?: { type?: string; enum?: string[]; properties?: Record<string, unknown> };
};
type Doc = {
  paths: Record<string, Record<string, { parameters?: Param[] }>>;
};
const doc = openapiDocument as unknown as Doc;

const listParamsOf = (path: string): Param[] => {
  const params = doc.paths[path]?.get?.parameters;
  expect(params, `no GET parameters documented for ${path}`).toBeTruthy();
  return params!;
};

/** The `field[op]` parameters of a list, as the `field → operators` map they describe. */
const documentedFilterOps = (path: string): Record<string, string[]> =>
  Object.fromEntries(
    listParamsOf(path)
      .filter((p) => p.in === "query" && p.style === "deepObject")
      .map((p) => [p.name, Object.keys(p.schema?.properties ?? {}).sort()]),
  );

const documentedSortFields = (path: string, dir: "asc" | "desc"): string[] =>
  listParamsOf(path)
    .find((p) => p.name === `sort_by[${dir}]`)
    ?.schema?.enum?.slice()
    .sort() ?? [];

const realOps = (m: Record<string, readonly string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(m).map(([f, ops]) => [f, [...ops].sort()]));

const LISTS: Array<{
  path: string;
  filterOps: Record<string, readonly string[]>;
  sortFields: readonly string[];
  /** Filters documented as a plain shorthand parameter of the same name instead. */
  shorthand?: string[];
}> = [
  {
    path: "/v1/businesses/{biz}/credit_notes",
    filterOps: CREDIT_NOTE_FILTER_OPS,
    sortFields: CREDIT_NOTE_SORT_FIELDS,
    shorthand: ["invoice"],
  },
  {
    path: "/v1/webhook_endpoints/{id}/deliveries",
    filterOps: WEBHOOK_DELIVERY_FILTER_OPS,
    sortFields: WEBHOOK_DELIVERY_SORT_FIELDS,
  },
  {
    path: "/v1/businesses/{biz}/invoices",
    filterOps: INVOICE_FILTER_OPS,
    sortFields: INVOICE_SORT_FIELDS,
  },
  {
    path: "/v1/businesses/{biz}/subscriptions",
    filterOps: SUBSCRIPTION_FILTER_OPS,
    sortFields: SUBSCRIPTION_SORT_FIELDS,
  },
  {
    path: "/v1/businesses/{biz}/transactions",
    filterOps: TRANSACTION_FILTER_OPS,
    sortFields: TRANSACTION_SORT_FIELDS,
  },
];

describe("the documented list filters are the ones the routes accept", () => {
  it("no operation documents a parameter named `filters`", () => {
    // The regression guard for the original defect: `filters` is not a query key any
    // route takes, so documenting it hands every generated client a guaranteed 400.
    const offenders: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        for (const p of op?.parameters ?? []) {
          if (p.name === "filters" && p.in === "query") offenders.push(`${method} ${path}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  for (const { path, filterOps, sortFields, shorthand = [] } of LISTS) {
    it(`${path} documents exactly its filterable fields and operators`, () => {
      const real = realOps(filterOps);
      for (const s of shorthand) delete real[s];
      expect(documentedFilterOps(path)).toEqual(real);
    });

    it(`${path} documents offset paging and the value grammar`, () => {
      const params = listParamsOf(path);
      expect(params.some((p) => p.name === "offset" && p.in === "query")).toBe(true);
      const created = params.find((p) => p.name === "created_at")?.schema?.properties as
        | Record<string, { description?: string }>
        | undefined;
      expect(created?.on?.description).toContain("unix seconds");
      expect(created?.between?.description).toContain("JSON array");
    });

    it(`${path} documents exactly its sort keys`, () => {
      const expected = [...sortFields].sort();
      expect(documentedSortFields(path, "asc")).toEqual(expected);
      expect(documentedSortFields(path, "desc")).toEqual(expected);
    });

    it(`${path} filters serialise as field[op]=value`, () => {
      // `style: deepObject` + `explode: true` is what makes an object-valued parameter
      // named for the FIELD serialise as `created_at[after]=…` — the form the engine
      // parses. Without both, a generator emits `created_at=%7B...%7D` and 400s.
      for (const p of listParamsOf(path).filter((x) => x.style === "deepObject")) {
        expect(p.explode, `${p.name} must set explode: true`).toBe(true);
        expect(p.schema?.type, `${p.name} must be object-valued`).toBe("object");
      }
    });
  }

  /**
   * OpenAPI forbids a repeated (name, in) pair, and we had EIGHT of them: three list routes
   * declared a flat `?customer=` shorthand beside the `customer` filter of the same name.
   * Nothing complained — the generator silently kept the last declaration — until the SDK
   * emitter tried to write both into one type literal and produced a duplicate key.
   *
   * The shorthands are real and still work (`parseListQuery`'s `bareParams`); they live in
   * each endpoint's description now, because a name can only be declared once.
   */
  it("declares every parameter name at most once per operation", () => {
    const offenders: string[] = [];
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const params = (op as { parameters?: { name: string; in: string }[] }).parameters;
        if (!Array.isArray(params)) continue;
        const seen = new Set<string>();
        for (const p of params) {
          const k = `${p.in}:${p.name}`;
          if (seen.has(k)) offenders.push(`${method.toUpperCase()} ${route} → ${p.name}`);
          seen.add(k);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the flat shorthands documented after they stopped being parameters", () => {
    // Removing a duplicate parameter must not silently remove the only description of a
    // query string that still works.
    const shorthands: Record<string, string[]> = {
      "/v1/businesses/{biz}/subscriptions": ["customer"],
      "/v1/businesses/{biz}/invoices": ["customer", "subscription"],
      "/v1/businesses/{biz}/transactions": ["type", "status", "customer", "invoice", "gateway"],
      "/v1/businesses/{biz}/products": ["kind"],
      "/v1/businesses/{biz}/coupons": ["kind", "status"],
      "/v1/businesses/{biz}/coupon_codes": ["status", "coupon_set"],
      "/v1/businesses/{biz}/coupon_sets/{set}/codes": ["status"],
    };
    for (const [path, names] of Object.entries(shorthands)) {
      const desc =
        (doc.paths[path]?.get as unknown as { description?: string } | undefined)?.description ??
        "";
      for (const n of names) {
        expect(desc, `${path} no longer documents ?${n}=`).toContain(`\`?${n}=`);
      }
    }
  });
});
