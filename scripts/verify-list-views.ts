/**
 * Smoke-probe for saved list views + the widened filter operators, against the local DB.
 *
 * It asserts the two things that can only be checked by running
 * SQL: that 0219's constraints and uniqueness indexes actually hold, and that every new
 * operator in `filterSql` emits SQL Postgres accepts. A typecheck cannot see either, and
 * a wrong operator is the kind of bug that surfaces as a list quietly showing the wrong
 * rows rather than as an error.
 *
 * Run: `pnpm verify:list-views` (part of `verify:all`).
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { filterSql, OPS_BY_KIND, filterValueError, type FilterKind } from "@/platform/list-query";
import { createOrganization, createBusiness } from "@/modules/tenancy/service";
import {
  createCustomer,
  customerCustomFieldFilterSet,
  listCustomersPage,
} from "@/modules/customers/service";
import { parseListQuery } from "@/api/helpers";
import {
  createDefinition,
  customFieldFilterSpecs,
  filterDefinitions,
  customFieldFilterFields,
  type CustomFieldDefinitionRow,
} from "@/modules/custom-fields/service";
import {
  createListView,
  deleteListView,
  duplicateListView,
  getListView,
  listListViews,
  updateListView,
  ListViewError,
  ListViewNameTakenError,
} from "@/modules/list-views/service";

let failures = 0;
const ok = (name: string) => console.log(`ok   ${name}`);
const fail = (name: string, detail: unknown) => {
  failures++;
  console.log(`FAIL ${name}\n     ↳ ${detail instanceof Error ? detail.message : String(detail)}`);
};

/**
 * First row of a `db.execute` result.
 *
 * The `postgres-js` driver returns the rows as the result ITSELF, not wrapped in
 * `{ rows }` like `node-postgres` does. Reading `.rows[0]` threw
 * "Cannot read properties of undefined" on every assertion below and made nine real
 * checks look like nine failures — the probe was wrong, not the SQL.
 */
function firstRow<T>(res: unknown): T | undefined {
  const r = res as { rows?: T[] } | T[];
  return Array.isArray(r) ? r[0] : r.rows?.[0];
}

/** A value that satisfies each operator's arity, for the SQL round-trip. */
function sampleValue(kind: FilterKind, op: string): string {
  if (op === "is_present") return "true";
  if (op === "in_last" || op === "in_next") return "7";
  const one =
    kind === "number" ? "10" : kind === "bool" ? "true" : kind === "date" ? "2026-08-01" : "abc";
  const two = kind === "number" ? "20" : kind === "date" ? "2026-08-31" : "def";
  if (op === "between") return `${one},${two}`;
  if (op === "in" || op === "not_in") return `${one},${two}`;
  return one;
}

/**
 * Every operator, on a column of each kind, executed for real.
 *
 * The literal columns give Postgres a concrete type to resolve each cast and comparison
 * against, so a malformed operator fails here rather than in front of an operator.
 */
async function probeOperators() {
  const kinds: { kind: FilterKind; column: ReturnType<typeof sql> }[] = [
    { kind: "text", column: sql`t.txt` },
    { kind: "enum", column: sql`t.txt` },
    { kind: "number", column: sql`t.num` },
    { kind: "bool", column: sql`t.flag` },
    { kind: "date", column: sql`t.ts` },
  ];

  for (const { kind, column } of kinds) {
    for (const op of OPS_BY_KIND[kind]) {
      const value = sampleValue(kind, op);
      const problem = filterValueError(kind, op, value);
      if (problem) {
        fail(`${kind}[${op}] value validation`, `rejected its own sample value: ${problem}`);
        continue;
      }
      const cond = filterSql({ column, kind }, op, value, "Asia/Kolkata");
      if (!cond) {
        fail(`${kind}[${op}]`, "filterSql returned undefined for an operator its own table offers");
        continue;
      }
      try {
        // One row of literals, filtered by the generated condition. We do not care what
        // it matches — only that Postgres plans and runs it.
        await systemDb.execute(sql`
          SELECT count(*) FROM (
            SELECT 'abc'::text AS txt, 10::bigint AS num, true AS flag, now() AS ts
          ) t WHERE ${cond}`);
        ok(`${kind}[${op}]`);
      } catch (e) {
        fail(`${kind}[${op}]`, e);
      }
    }
  }
}

/** The value validator must REJECT the shapes that used to reach SQL. */
function probeValueRejection() {
  const cases: { kind: FilterKind; op: string; value: string; why: string }[] = [
    { kind: "number", op: "between", value: "10", why: "one bound" },
    { kind: "number", op: "between", value: "10,20,30", why: "three bounds" },
    { kind: "text", op: "in", value: " , ", why: "no members" },
    { kind: "date", op: "on", value: "31/08/2026", why: "not ISO" },
    { kind: "bool", op: "is", value: "yes", why: "not a boolean" },
    { kind: "number", op: "gt", value: "abc", why: "not a number" },
    { kind: "date", op: "in_last", value: "0", why: "not positive" },
    { kind: "date", op: "in_last", value: "1.5", why: "not an integer" },
    { kind: "text", op: "is_present", value: "1", why: "not true/false" },
  ];
  for (const c of cases) {
    if (filterValueError(c.kind, c.op, c.value))
      ok(`rejects ${c.kind}[${c.op}]=${c.value} (${c.why})`);
    else fail(`rejects ${c.kind}[${c.op}]=${c.value}`, `accepted a value that is ${c.why}`);
  }
}

/** `between` and the relative windows must be INCLUSIVE at both edges. */
async function probeBoundaries() {
  const checks: {
    name: string;
    cond: ReturnType<typeof filterSql>;
    instant: string;
    expect: boolean;
  }[] = [];
  const push = (name: string, op: string, value: string, instant: string, expect: boolean) =>
    checks.push({
      name,
      cond: filterSql({ column: sql`t.ts`, kind: "date" }, op, value, "UTC"),
      instant,
      expect,
    });

  // Both ends of a date range, and the day after it.
  push(
    "between includes the first day",
    "between",
    "2026-08-01,2026-08-31",
    "2026-08-01T00:00:00Z",
    true,
  );
  push(
    "between includes the last day",
    "between",
    "2026-08-01,2026-08-31",
    "2026-08-31T23:59:59Z",
    true,
  );
  push(
    "between excludes the next day",
    "between",
    "2026-08-01,2026-08-31",
    "2026-09-01T00:00:00Z",
    false,
  );
  push(
    "on_or_after includes the named day",
    "on_or_after",
    "2026-08-01",
    "2026-08-01T00:00:00Z",
    true,
  );
  push("after excludes the named day", "after", "2026-08-01", "2026-08-01T12:00:00Z", false);
  push(
    "on_or_before includes the named day",
    "on_or_before",
    "2026-08-01",
    "2026-08-01T23:00:00Z",
    true,
  );
  push("before excludes the named day", "before", "2026-08-01", "2026-08-01T00:00:00Z", false);
  // in_last must include something from today; in_next must too.
  push("in_last includes today", "in_last", "7", new Date().toISOString(), true);
  push("in_next includes today", "in_next", "7", new Date().toISOString(), true);

  for (const c of checks) {
    if (!c.cond) {
      fail(c.name, "filterSql returned undefined");
      continue;
    }
    try {
      const res = await systemDb.execute(sql`
        SELECT count(*)::int AS n FROM (SELECT ${c.instant}::timestamptz AS ts) t WHERE ${c.cond}`);
      const n = Number(firstRow<{ n: number }>(res)?.n ?? 0);
      if (n > 0 === c.expect) ok(c.name);
      else fail(c.name, `matched=${n > 0}, expected=${c.expect}`);
    } catch (e) {
      fail(c.name, e);
    }
  }
}

/** Numeric `between` must not care which bound was typed first. */
async function probeReversedRange() {
  for (const value of ["10,20", "20,10"]) {
    const cond = filterSql({ column: sql`t.num`, kind: "number" }, "between", value, "UTC")!;
    const res = await systemDb.execute(
      sql`SELECT count(*)::int AS n FROM (SELECT 15::bigint AS num) t WHERE ${cond}`,
    );
    const n = Number(firstRow<{ n: number }>(res)?.n ?? 0);
    if (n === 1) ok(`between ${value} matches 15`);
    else fail(`between ${value} matches 15`, `matched ${n} rows`);
  }
}

/** Assert a promise rejects with a particular error class. */
async function rejects(
  name: string,
  cls: new (...a: never[]) => Error,
  fn: () => Promise<unknown>,
) {
  try {
    await fn();
    fail(name, "resolved — expected a rejection");
  } catch (e) {
    if (e instanceof cls) ok(name);
    else fail(name, `threw ${(e as Error).name}: ${(e as Error).message}`);
  }
}

/**
 * The service layer, against a real tenant.
 *
 * These are the rules that only exist in code + constraints and that no typecheck can
 * see: who may edit a view, who can see a private one, what happens on a duplicate name,
 * and whether "set as default" actually clears the previous one (the partial unique index
 * makes a missed clear an ERROR rather than a silent second default, so this is load
 * bearing both ways).
 */
async function probeService() {
  const org = await createOrganization({ name: "List Views Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "Views Co",
    defaultCurrency: "INR",
    livemode: "test",
  });

  const alice = "alice@example.test";
  const bob = "bob@example.test";
  const base = { organizationId: orgId, businessId: biz.id, entity: "subscriptions" as const };

  // ── Create, and read back ──
  const v1 = await createListView({
    ...base,
    name: "Renewing soon",
    owner: alice,
    filters: [{ field: "current_period_end", op: "in_next", value: "7" }],
  });
  if (v1.publicId.startsWith("view_")) ok("created view has a view_ public id");
  else fail("created view has a view_ public id", v1.publicId);

  const mine = await listListViews(orgId, biz.id, "subscriptions", alice);
  if (mine.length === 1) ok("owner sees their own private view");
  else fail("owner sees their own private view", `${mine.length} rows`);

  const bobSees = await listListViews(orgId, biz.id, "subscriptions", bob);
  if (bobSees.length === 0) ok("a private view is invisible to another operator");
  else fail("a private view is invisible to another operator", `${bobSees.length} rows`);

  // ── Empty views are refused (mirrors list_views_not_empty_check) ──
  await rejects("an empty view is refused", ListViewError, () =>
    createListView({ ...base, name: "Nothing", owner: alice }),
  );

  // ── A view cannot hold a filter the list would reject ──
  await rejects("unknown filter field is refused", ListViewError, () =>
    createListView({
      ...base,
      name: "Bad field",
      owner: alice,
      filters: [{ field: "nope", op: "is", value: "x" }],
    }),
  );
  await rejects("unsupported operator is refused", ListViewError, () =>
    createListView({
      ...base,
      name: "Bad op",
      owner: alice,
      filters: [{ field: "created_at", op: "contains", value: "x" }],
    }),
  );
  await rejects("malformed between is refused", ListViewError, () =>
    createListView({
      ...base,
      name: "Bad range",
      owner: alice,
      filters: [{ field: "mrr", op: "between", value: "10" }],
    }),
  );

  // ── Duplicate names, per owner and case-insensitively ──
  await rejects("a duplicate name is a typed conflict", ListViewNameTakenError, () =>
    createListView({
      ...base,
      name: "renewing SOON",
      owner: alice,
      filters: [{ field: "status", op: "is", value: "active" }],
    }),
  );
  const bobSameName = await createListView({
    ...base,
    name: "Renewing soon",
    owner: bob,
    filters: [{ field: "status", op: "is", value: "active" }],
  });
  if (bobSameName.publicId) ok("another operator may reuse the same view name");
  else fail("another operator may reuse the same view name", "no row");

  // ── Owner-only editing ──
  const notMine = await updateListView(orgId, v1.publicId, bob, { name: "Hijacked" });
  if (notMine === null) ok("another operator cannot edit a view they don't own");
  else fail("another operator cannot edit a view they don't own", "update succeeded");

  const notMineDelete = await deleteListView(orgId, v1.publicId, bob);
  if (notMineDelete === false) ok("another operator cannot delete a view they don't own");
  else fail("another operator cannot delete a view they don't own", "delete succeeded");

  // ── Partial patch must not blank what it does not mention ──
  const withSort = await createListView({
    ...base,
    name: "Sorted",
    owner: alice,
    filters: [{ field: "status", op: "in", value: "active,in_trial" }],
    sortField: "mrr",
    sortDesc: true,
    search: "acme",
  });
  const renamed = await updateListView(orgId, withSort.publicId, alice, {
    name: "Sorted, renamed",
  });
  if (renamed?.sortField === "mrr" && renamed.search === "acme")
    ok("a rename leaves sort and search intact");
  else
    fail(
      "a rename leaves sort and search intact",
      `sort=${renamed?.sortField} search=${renamed?.search}`,
    );
  const cleared = await updateListView(orgId, withSort.publicId, alice, { search: null });
  if (cleared?.search === null && cleared.sortField === "mrr")
    ok("an explicit null clears only that field");
  else
    fail(
      "an explicit null clears only that field",
      `sort=${cleared?.sortField} search=${cleared?.search}`,
    );

  // ── One default per owner per list. The second set must move the flag, not error. ──
  await updateListView(orgId, v1.publicId, alice, { isDefault: true });
  const second = await updateListView(orgId, withSort.publicId, alice, { isDefault: true });
  if (second?.isDefault) ok("setting a second default succeeds");
  else fail("setting a second default succeeds", "not flagged");
  const afterSwap = await listListViews(orgId, biz.id, "subscriptions", alice);
  const defaults = afterSwap.filter((v) => v.isDefault);
  if (defaults.length === 1 && defaults[0]!.publicId === withSort.publicId)
    ok("the previous default was cleared");
  else fail("the previous default was cleared", `${defaults.length} defaults`);

  // ── Sharing, and duplicating someone else's shared view ──
  const shared = await createListView({
    ...base,
    name: "Team overdue",
    owner: alice,
    visibility: "everyone",
    filters: [{ field: "status", op: "is", value: "active" }],
  });
  const bobNowSees = await listListViews(orgId, biz.id, "subscriptions", bob);
  if (bobNowSees.some((v) => v.publicId === shared.publicId))
    ok("a shared view is visible to the organization");
  else fail("a shared view is visible to the organization", "not listed");

  const copy = await duplicateListView(orgId, shared.publicId, bob);
  if (copy && copy.owner === bob && copy.visibility === "private")
    ok("a duplicate is private and owned by the copier");
  else
    fail(
      "a duplicate is private and owned by the copier",
      `owner=${copy?.owner} visibility=${copy?.visibility}`,
    );
  if (copy && JSON.stringify(copy.filters) === JSON.stringify(shared.filters))
    ok("a duplicate carries the filters");
  else fail("a duplicate carries the filters", "filters differ");

  const cannotSee = await duplicateListView(orgId, v1.publicId, bob);
  if (cannotSee === null) ok("a private view cannot be duplicated by someone else");
  else fail("a private view cannot be duplicated by someone else", "duplicate succeeded");

  // ── Org-level views (business_id NULL) are a separate scope, not a leak ──
  const orgLevel = await createListView({
    organizationId: orgId,
    businessId: null,
    entity: "org_audit_logs",
    name: "Recent activity",
    owner: alice,
    filters: [{ field: "created_at", op: "in_last", value: "7" }],
  });
  const orgViews = await listListViews(orgId, null, "org_audit_logs", alice);
  if (orgViews.length === 1 && orgViews[0]!.publicId === orgLevel.publicId)
    ok("an org-level view reads back on the null scope");
  else fail("an org-level view reads back on the null scope", `${orgViews.length} rows`);
  const bizViews = await listListViews(orgId, biz.id, "org_audit_logs", alice);
  if (bizViews.length === 0) ok("an org-level view does not appear under a business");
  else fail("an org-level view does not appear under a business", `${bizViews.length} rows`);

  // ── Visibility on the single-row read ──
  const hidden = await getListView(orgId, v1.publicId, bob);
  if (hidden === null) ok("getListView hides a private view from another operator");
  else fail("getListView hides a private view from another operator", "returned a row");

  // ── Delete really deletes ──
  if (await deleteListView(orgId, v1.publicId, alice)) ok("the owner can delete their own view");
  else fail("the owner can delete their own view", "delete returned false");
  if ((await getListView(orgId, v1.publicId, alice)) === null) ok("a deleted view is gone");
  else fail("a deleted view is gone", "still readable");
}

/**
 * A definition, minus the columns the filter layer never reads.
 *
 * `customFieldFilterSpecs` only looks at `apiName`, `dataType` and `enumOptions`, so
 * fabricating those three is enough to exercise the SQL without a database round trip
 * per case — which is what lets this cover every data type AND every malformed-value
 * case cheaply.
 */
function def(apiName: string, dataType: string, enumOptions: string[] | null = null) {
  return { apiName, dataType, enumOptions } as unknown as CustomFieldDefinitionRow;
}

/**
 * Custom-field filters, executed against Postgres.
 *
 * The interesting half is the GUARDED CASTS. `->>` yields text, so a `number` custom
 * field has to be cast to compare — and a bare `::numeric` fails the WHOLE query on one
 * row whose stored value isn't numeric. That can happen for real: a definition's
 * `data_type` can be changed after values exist, and the importers write `custom_fields`
 * from foreign data. One bad row must narrow itself out, not 500 the list for the
 * business.
 */
async function probeCustomFieldSql() {
  const defs = [
    def("spend_cap", "number"),
    def("plan_tier", "enum", ["gold", "silver"]),
    def("renewed_on", "date"),
    def("account_manager", "string"),
    def("is_vip", "boolean"),
    def("contact", "email"),
    def("tier2", "number"), // a digit in the api_name — legal, and it used to 400
  ];
  const specs = customFieldFilterSpecs(defs, sql`t.cf`);

  /** One jsonb literal row, filtered by the generated condition. */
  const matches = async (spec: (typeof specs)[string], op: string, value: string, json: string) => {
    const cond = filterSql(spec, op, value, "UTC");
    if (!cond) throw new Error(`filterSql returned undefined for ${op}`);
    const res = await systemDb.execute(
      sql`SELECT count(*)::int AS n FROM (SELECT ${json}::jsonb AS cf) t WHERE ${cond}`,
    );
    return Number(firstRow<{ n: number }>(res)?.n ?? 0) > 0;
  };

  const good = `{"spend_cap": 500, "plan_tier": "gold", "renewed_on": "2026-08-01",
                "account_manager": "Dana Reyes", "is_vip": true,
                "contact": "ops@acme.test", "tier2": 7}`;

  const cases: [string, string, string, string, boolean][] = [
    // field, op, value, json, expected
    ["spend_cap", "gt", "100", good, true],
    ["spend_cap", "gt", "900", good, false],
    ["spend_cap", "between", "100,600", good, true],
    ["spend_cap", "between", "600,900", good, false],
    ["plan_tier", "is", "gold", good, true],
    ["plan_tier", "in", "gold,silver", good, true],
    ["plan_tier", "not_in", "gold,silver", good, false],
    ["renewed_on", "on", "2026-08-01", good, true],
    ["renewed_on", "before", "2026-09-01", good, true],
    ["renewed_on", "in_last", "36500", good, true],
    ["account_manager", "contains", "reyes", good, true],
    ["account_manager", "ends_with", "Reyes", good, true],
    ["is_vip", "is", "true", good, true],
    ["is_vip", "is", "false", good, false],
    ["contact", "ends_with", "@acme.test", good, true],
    ["tier2", "gte", "7", good, true],
    // An absent key is "not present", and the negations must admit it.
    ["spend_cap", "is_present", "false", `{"plan_tier": "gold"}`, true],
    ["spend_cap", "is_present", "true", `{"plan_tier": "gold"}`, false],
    ["plan_tier", "not_in", "gold", `{}`, true],
  ];

  for (const [field, op, value, json, expected] of cases) {
    const spec = specs[`cf_${field}`];
    if (!spec) {
      fail(`cf_${field} has a spec`, "missing");
      continue;
    }
    try {
      const hit = await matches(spec, op, value, json);
      if (hit === expected) ok(`cf_${field}[${op}]=${value} → ${expected}`);
      else fail(`cf_${field}[${op}]=${value}`, `got ${hit}, expected ${expected}`);
    } catch (e) {
      fail(`cf_${field}[${op}]=${value}`, e);
    }
  }

  // ── The guards. A malformed stored value must narrow itself out, not throw. ──
  const junk: [string, string, string, string][] = [
    ["spend_cap", "gt", "100", `{"spend_cap": "n/a"}`],
    ["spend_cap", "between", "1,2", `{"spend_cap": "twelve"}`],
    ["renewed_on", "before", "2026-09-01", `{"renewed_on": "31/08/2026"}`],
    ["renewed_on", "on", "2026-08-01", `{"renewed_on": ""}`],
    ["is_vip", "is", "true", `{"is_vip": "yes"}`],
    // A jsonb ARRAY or OBJECT where a scalar was expected — `->>` yields its text form.
    ["spend_cap", "gt", "0", `{"spend_cap": [1,2,3]}`],
  ];
  for (const [field, op, value, json] of junk) {
    const spec = specs[`cf_${field}`]!;
    try {
      const hit = await matches(spec, op, value, json);
      if (hit) fail(`junk cf_${field} (${json}) is excluded`, "it MATCHED");
      else ok(`junk cf_${field} (${json}) excluded without erroring`);
    } catch (e) {
      fail(`junk cf_${field} (${json}) does not throw`, e);
    }
  }
}

/**
 * `parseListQuery` must accept a custom field whose `api_name` contains a DIGIT.
 *
 * `api_name` is validated as `/^[a-z][a-z0-9_]*$/`, but the query-key pattern was
 * `[a-z_]+` — so `cf_tier2[is]=gold` was rejected as an "Unknown query parameter", one
 * step before the allow-list could say whether the field existed. Tested here rather
 * than through HTTP because the regex is the whole bug and a fake request reaches it.
 */
function probeFieldKeyPattern() {
  const attempt = (query: Record<string, string>, filterOps: Record<string, readonly string[]>) => {
    let rejection: unknown = null;
    const reply = {
      code: () => ({ send: (body: unknown) => (rejection = body) }),
      header: () => reply,
    };
    const parsed = parseListQuery({ query } as never, reply as never, {
      filterOps,
      sortFields: [],
    });
    return { parsed, rejection };
  };

  const allow = {
    cf_tier2: ["is"] as readonly string[],
    cf_plan_tier: ["is"] as readonly string[],
  };

  const digits = attempt({ "cf_tier2[is]": "gold" }, allow);
  if (digits.parsed?.filters.length === 1 && digits.parsed.filters[0]!.field === "cf_tier2") {
    ok("a cf field with a digit in its name parses");
  } else {
    fail("a cf field with a digit in its name parses", JSON.stringify(digits.rejection));
  }

  const plain = attempt({ "cf_plan_tier[is]": "gold" }, allow);
  if (plain.parsed?.filters.length === 1) ok("a plain cf field parses");
  else fail("a plain cf field parses", JSON.stringify(plain.rejection));

  // A field NOT in the allow-list is still refused — widening the pattern must not have
  // widened what is accepted, only where the refusal comes from.
  const unknown = attempt({ "cf_nope[is]": "x" }, allow);
  if (unknown.parsed === null && unknown.rejection) ok("an unknown cf field is still refused");
  else fail("an unknown cf field is still refused", "it was accepted");

  // An operator with a digit is still not a thing.
  const badOp = attempt({ "cf_tier2[is2]": "x" }, allow);
  if (badOp.parsed === null && badOp.rejection) ok("a digit in the OPERATOR is still refused");
  else fail("a digit in the OPERATOR is still refused", "it was accepted");
}

/**
 * A saved view must be able to HOLD a `cf_*` filter.
 *
 * The view validator checks filters against a static per-module map, and a custom field
 * is created at runtime — so without the per-business half, "customers where
 * cf_plan_tier is enterprise" would be built, applied, and then refused at Save, which
 * is where the operator gives up on the feature.
 */
async function probeCustomFieldViews() {
  const org = await createOrganization({ name: "CF Views Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "CF Co",
    defaultCurrency: "INR",
    livemode: "test",
  });
  const owner = "cf@example.test";

  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "plan_tier",
    label: "Plan Tier",
    dataType: "enum",
    enumOptions: ["gold", "silver"],
  });
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "subscription",
    apiName: "seat_cap",
    label: "Seat Cap",
    dataType: "number",
  });

  // The definition's own metadata is what a client renders the filter row from.
  const defs = await filterDefinitions(orgId, biz.id, "customer");
  const described = customFieldFilterFields(defs).find((f) => f.id === "cf_plan_tier");
  if (described?.kind === "enum" && described.options?.includes("gold")) {
    ok("an enum definition describes itself with its own options");
  } else {
    fail("an enum definition describes itself with its own options", JSON.stringify(described));
  }
  if (described && !described.ops.includes("starts_with") && described.ops.includes("in")) {
    ok("an enum field offers the closed-set operators, not the text ones");
  } else {
    fail("an enum field offers the closed-set operators", JSON.stringify(described?.ops));
  }

  const saved = await createListView({
    organizationId: orgId,
    businessId: biz.id,
    entity: "customers",
    name: "Gold tier",
    owner,
    filters: [{ field: "cf_plan_tier", op: "is", value: "gold" }],
  });
  if (saved.publicId) ok("a view holding a cf_ filter saves");
  else fail("a view holding a cf_ filter saves", "no row");

  const subView = await createListView({
    organizationId: orgId,
    businessId: biz.id,
    entity: "subscriptions",
    name: "Big seats",
    owner,
    filters: [{ field: "cf_seat_cap", op: "gte", value: "50" }],
  });
  if (subView.publicId) ok("a subscription view holding a cf_ filter saves");
  else fail("a subscription view holding a cf_ filter saves", "no row");

  await rejects("a cf field that does not exist is refused", ListViewError, () =>
    createListView({
      organizationId: orgId,
      businessId: biz.id,
      entity: "customers",
      name: "Bogus",
      owner,
      filters: [{ field: "cf_not_a_field", op: "is", value: "x" }],
    }),
  );

  await rejects("an operator the cf kind does not support is refused", ListViewError, () =>
    createListView({
      organizationId: orgId,
      businessId: biz.id,
      entity: "customers",
      name: "Bad op",
      owner,
      // `starts_with` is a TEXT operator; plan_tier is an enum.
      filters: [{ field: "cf_plan_tier", op: "starts_with", value: "go" }],
    }),
  );

  // A customer field must not be filterable on the SUBSCRIPTIONS list, and vice versa —
  // the definitions are per entity_type, and crossing them would save a view that can
  // never match.
  await rejects("a customer cf field is not valid on the subscriptions list", ListViewError, () =>
    createListView({
      organizationId: orgId,
      businessId: biz.id,
      entity: "subscriptions",
      name: "Crossed",
      owner,
      filters: [{ field: "cf_plan_tier", op: "is", value: "gold" }],
    }),
  );

  // Updating into a cf filter goes through the same per-business allow-list.
  const patched = await updateListView(orgId, saved.publicId, owner, {
    filters: [{ field: "cf_plan_tier", op: "in", value: "gold,silver" }],
  });
  if (patched?.filters?.[0]?.op === "in") ok("patching a view into a cf_ set filter works");
  else fail("patching a view into a cf_ set filter works", JSON.stringify(patched?.filters));
}

/**
 * A `cf_*` filter must narrow the PAGE and the TOTAL together.
 *
 * Both list services build one `conds` array that the first-page `count(*)` and the page
 * query share, so this holds by construction — but "by construction" is exactly what was
 * true of several filters in this repo that turned out to narrow only one of the two.
 * The failure is quiet and awful: the footer says 40 while three rows are on screen, so
 * the operator concludes the list is broken rather than filtered. Asserted here so the
 * next person to touch either query cannot break it silently.
 */
async function probeCustomFieldNarrowing() {
  const org = await createOrganization({ name: "CF Narrowing Org" });
  const orgId = org.organization.id;
  const biz = await createBusiness({
    organizationId: orgId,
    name: "CF Narrow Co",
    defaultCurrency: "INR",
    livemode: "test",
  });

  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "tier",
    label: "Tier",
    dataType: "enum",
    enumOptions: ["gold", "silver", "bronze"],
  });
  await createDefinition({
    organizationId: orgId,
    businessId: biz.id,
    entityType: "customer",
    apiName: "seats",
    label: "Seats",
    dataType: "number",
  });

  const make = (email: string, cf: Record<string, unknown>) =>
    createCustomer({
      organizationId: orgId,
      businessId: biz.id,
      email,
      customFields: cf,
    });

  await make("gold1@cf.test", { tier: "gold", seats: 50 });
  await make("gold2@cf.test", { tier: "gold", seats: 5 });
  await make("silver@cf.test", { tier: "silver", seats: 200 });
  await make("nofields@cf.test", {});

  const defs = await filterDefinitions(orgId, biz.id, "customer");
  const cf = customerCustomFieldFilterSet(defs);

  const page = (filters: { field: string; op: string; value: string }[]) =>
    listCustomersPage(orgId, biz.id, { filters, customFieldDefs: defs, limit: 50 });

  const cases: [string, { field: string; op: string; value: string }[], number][] = [
    ["cf_tier is gold", [{ field: "cf_tier", op: "is", value: "gold" }], 2],
    ["cf_tier in gold,silver", [{ field: "cf_tier", op: "in", value: "gold,silver" }], 3],
    ["cf_seats gt 10", [{ field: "cf_seats", op: "gt", value: "10" }], 2],
    ["cf_seats between 10,100", [{ field: "cf_seats", op: "between", value: "10,100" }], 1],
    // The customer with `{}` has no key at all, so it is the only absent one.
    ["cf_tier is_present false", [{ field: "cf_tier", op: "is_present", value: "false" }], 1],
    [
      "cf_tier is gold AND cf_seats gt 10",
      [
        { field: "cf_tier", op: "is", value: "gold" },
        { field: "cf_seats", op: "gt", value: "10" },
      ],
      1,
    ],
    ["no filters", [], 4],
  ];

  for (const [name, filters, expected] of cases) {
    try {
      const res = await page(filters);
      const rows = res.data.length;
      const total = res.total;
      if (rows !== expected) fail(`${name} → ${expected} rows`, `got ${rows}`);
      else if (total !== expected)
        fail(`${name} → total ${expected}`, `page had ${rows} but total said ${total}`);
      else ok(`${name} → ${rows} rows, total ${total}`);
    } catch (e) {
      fail(name, e);
    }
  }

  // The set the route would have accepted must be exactly the set the service can apply —
  // if these ever diverge, a field 400s or is silently dropped.
  const offered = Object.keys(cf.ops).sort().join(",");
  const appliable = Object.keys(cf.specs).sort().join(",");
  if (offered === appliable && offered === "cf_seats,cf_tier") {
    ok("the operator allow-list and the SQL specs cover the same fields");
  } else {
    fail(
      "the allow-list and the specs cover the same fields",
      `ops=[${offered}] specs=[${appliable}]`,
    );
  }
}

/** 0219's constraints and uniqueness indexes, as the database actually enforces them. */
async function probeSchema() {
  const expectations: { name: string; query: ReturnType<typeof sql> }[] = [
    {
      name: "list_views table exists",
      query: sql`SELECT to_regclass('list_views') IS NOT NULL AS present`,
    },
    {
      name: "RLS enabled on list_views",
      query: sql`SELECT relrowsecurity AS present FROM pg_class WHERE relname = 'list_views'`,
    },
    {
      name: "org_isolation policy on list_views",
      query: sql`SELECT count(*) > 0 AS present FROM pg_policies WHERE tablename = 'list_views' AND policyname = 'org_isolation'`,
    },
    {
      name: "visibility check constraint",
      query: sql`SELECT count(*) > 0 AS present FROM pg_constraint WHERE conname = 'list_views_visibility_check'`,
    },
    {
      name: "not-empty check constraint",
      query: sql`SELECT count(*) > 0 AS present FROM pg_constraint WHERE conname = 'list_views_not_empty_check'`,
    },
    {
      name: "name uniqueness index (coalesced business_id)",
      query: sql`SELECT count(*) > 0 AS present FROM pg_indexes WHERE indexname = 'list_views_name_uq'`,
    },
    {
      name: "one-default partial unique index",
      query: sql`SELECT count(*) > 0 AS present FROM pg_indexes WHERE indexname = 'list_views_default_uq' AND indexdef ILIKE '%WHERE is_default%'`,
    },
    {
      name: "bump_row_version trigger",
      query: sql`SELECT count(*) > 0 AS present FROM pg_trigger WHERE tgrelid = 'list_views'::regclass AND NOT tgisinternal`,
    },
  ];

  for (const e of expectations) {
    try {
      const res = await systemDb.execute(e.query);
      const present = firstRow<{ present: boolean }>(res)?.present;
      if (present) ok(e.name);
      else fail(e.name, "not present");
    } catch (err) {
      fail(e.name, err);
    }
  }
}

async function main() {
  console.log("── schema (migration 0219) ──");
  await probeSchema();
  console.log("\n── every operator, executed ──");
  await probeOperators();
  console.log("\n── value validation rejects what used to reach SQL ──");
  probeValueRejection();
  console.log("\n── boundary semantics ──");
  await probeBoundaries();
  await probeReversedRange();
  console.log("\n── saved views, against a real tenant ──");
  await probeService();
  console.log("\n── custom fields as filters ──");
  probeFieldKeyPattern();
  await probeCustomFieldSql();
  await probeCustomFieldViews();
  await probeCustomFieldNarrowing();

  console.log(failures === 0 ? "\nlist-views: ok" : `\nlist-views: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
