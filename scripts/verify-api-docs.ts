/**
 * verify:api-docs — the generated API reference is complete and safe to publish.
 *
 * No database. Reads sdk/openapi.json and the pages scripts/gen-api-reference.ts
 * wrote (run `pnpm gen:api-reference` first). Fails when:
 *  - a documented parameter or request/response property has no description;
 *  - an endpoint whose spec documents a 2xx body has no 2xx example on its page,
 *    or the spec documents a 2xx with no body schema at all;
 *  - an example points at localhost, or a curl does not use $TMBILLING_URL;
 *  - an example body is `{}` where the body has required fields;
 *  - an internal code (work item, audit id, migration number) reaches a page;
 *  - a write whose route declares Idempotency-Key does not send one, or a GET does;
 *  - docs-site/data/api-stats.json disagrees with the spec.
 *
 *   pnpm verify:api-docs
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  collectOperations,
  deref,
  IDEMPOTENCY_HEADER,
  INTERNAL_CODE,
  loadSpec,
  OUT_DIR,
  STATS_PATH,
  type JsonSchema,
  type Operation,
} from "./gen-api-reference";

const EVENTS_PAGE = join(OUT_DIR, "..", "05.webhooks", "04.events.md");

let fail = 0;
function check(label: string, problems: string[], limit = 20) {
  if (problems.length) fail++;
  console.log(problems.length ? "✗" : "✓", label, problems.length ? `(${problems.length})` : "");
  for (const p of problems.slice(0, limit)) console.log(`    ${p}`);
  if (problems.length > limit) console.log(`    … and ${problems.length - limit} more`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
  });
}

const spec = loadSpec();
const ops = collectOperations();
if (!existsSync(OUT_DIR)) {
  console.log("✗ no generated reference — run pnpm gen:api-reference");
  console.log("❌ API-DOCS: FAIL");
  process.exit(1);
}

// ── Pages, keyed by the operation they render ────────────────────────────────
const files = walk(OUT_DIR);
const pages = new Map<string, { file: string; text: string }>();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const m = /^::api-operation\{method="(\w+)" path="([^"]+)"\}/m.exec(text);
  if (m) pages.set(`${m[1]} ${m[2]}`, { file: file.slice(OUT_DIR.length + 1), text });
}
const key = (op: Operation) => `${op.method} ${op.path}`;
const requestOf = (text: string) => /```bash \[Request\]\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "";

check("every operation in the spec has a page", ops.filter((op) => !pages.has(key(op))).map(key));

// ── 1. Descriptions ──────────────────────────────────────────────────────────
// Keyed by the component a property lives in, so a shared schema counts once.
const missing = new Set<string>();
function props(schema: JsonSchema | undefined, where: string, nestOnly?: string, depth = 0) {
  const s = deref(schema);
  if (!s?.properties) return;
  const owner = s["x-name"] ?? where;
  for (const [name, raw] of Object.entries(s.properties)) {
    const f = deref(raw);
    if (!f?.description?.trim() && !deref(raw)?.description) missing.add(`${owner}.${name}`);
    if (depth < 1 && (!nestOnly || nestOnly === name)) {
      const nested = f?.type === "array" ? f.items : raw;
      props(nested, `${owner}.${name}`, undefined, depth + 1);
    }
  }
}
for (const op of ops) {
  for (const p of op.params) {
    if (!p.description?.trim()) missing.add(`${key(op)} › ${p.in} ${p.name}`);
  }
  props(op.body, `${key(op)} › body`);
  for (const r of op.responses.filter((x) => x.status.startsWith("2"))) {
    const s = r.content?.["application/json"]?.schema;
    if (deref(s)?.["x-name"] !== "Error") props(s, `${key(op)} › ${r.status}`, "data");
  }
}
check("every documented parameter and property has a description", [...missing].sort());

// ── 2. Response examples ─────────────────────────────────────────────────────
const noExample: string[] = [];
const noSchema: string[] = [];
for (const op of ops) {
  const ok = op.responses.filter((r) => r.status.startsWith("2"));
  const hasJson = ok.some((r) => r.content?.["application/json"]?.schema);
  const hasOther = ok.some((r) => r.status === "204" || Object.keys(r.content ?? {}).length);
  const text = pages.get(key(op))?.text ?? "";
  const shown = /^```(?:json|text) \[2\d\d[^\]]*\]$/m.test(text);
  if ((hasJson || hasOther) && !shown) noExample.push(key(op));
  if (!hasJson && !hasOther) noSchema.push(`${key(op)} (${ok.map((r) => r.status).join(", ")})`);
}
check("every page with a documented 2xx body shows a 2xx example", noExample);
check("every 2xx response in the spec documents its body (src/api/openapi.ts)", noSchema);

// ── 3. Hosts ─────────────────────────────────────────────────────────────────
const generated = [...files, ...(existsSync(EVENTS_PAGE) ? [EVENTS_PAGE] : [])];
check(
  "no example points at localhost",
  generated.filter((f) => /localhost|127\.0\.0\.1/.test(readFileSync(f, "utf8"))),
);
check(
  "every curl reads its host from $TMBILLING_URL",
  [...pages.entries()]
    .filter(([, p]) => !/^curl (?:-X \w+ )?"\$TMBILLING_URL\//.test(requestOf(p.text)))
    .map(([k]) => k),
);

// ── 4. Bodies ────────────────────────────────────────────────────────────────
check(
  "no `{}` body where the body has required fields",
  ops
    .filter((op) => deref(op.body)?.required?.length)
    .filter((op) => /-d '\{\}'/.test(requestOf(pages.get(key(op))?.text ?? "")))
    .map(key),
);

// ── 5. Internal codes ────────────────────────────────────────────────────────
const leaks: string[] = [];
for (const f of generated) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(new RegExp(INTERNAL_CODE.source, "g"))) {
    leaks.push(`${f.slice(OUT_DIR.length - 40)}: ${m[0].trim()}`);
  }
}
check("no internal code (work item, audit id, migration number) on a page", leaks);

// ── 6. Idempotency ───────────────────────────────────────────────────────────
const header = `-H "${IDEMPOTENCY_HEADER}: $(uuidgen)"`;
check(
  "every write whose route declares Idempotency-Key sends one",
  ops
    .filter((op) => op.idempotent && !requestOf(pages.get(key(op))?.text ?? "").includes(header))
    .map(key),
);
check(
  "no GET sends Idempotency-Key",
  ops
    .filter(
      (op) =>
        op.method === "GET" &&
        requestOf(pages.get(key(op))?.text ?? "").includes(IDEMPOTENCY_HEADER),
    )
    .map(key),
);

// ── 7. Counts ────────────────────────────────────────────────────────────────
const stats = existsSync(STATS_PATH)
  ? (JSON.parse(readFileSync(STATS_PATH, "utf8")) as Record<string, number>)
  : {};
const tags = new Set(ops.map((op) => op.tag));
check(
  "api-stats.json matches the spec",
  [
    stats.endpoints === ops.length ? "" : `endpoints ${stats.endpoints} ≠ ${ops.length}`,
    stats.resources === tags.size ? "" : `resources ${stats.resources} ≠ ${tags.size}`,
    (stats.webhook_events ?? 0) > 0 ? "" : "webhook_events missing",
  ].filter(Boolean),
);

console.log(
  `\n${ops.length} operations · ${pages.size} pages · spec ${spec.info.version} · ${fail} check(s) failed`,
);
console.log(fail ? "❌ API-DOCS: FAIL" : "✅ API-DOCS: PASS");
process.exit(fail ? 1 : 0);
