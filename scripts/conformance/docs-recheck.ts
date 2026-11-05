/**
 * Before a release: re-read every documented status list in the conformance fixtures from its
 * source URL. Fails when a status we map is no longer there, or an exact enum (an OpenAPI
 * `enum`) gained a value we do not map. Text pages also list new-looking codes, for review.
 * Needs the network, so it is not part of verify:all.
 *
 *   pnpm gateway-docs:recheck            every fixture module
 *   pnpm gateway-docs:recheck -- square  one gateway
 */
import type { DocSource, GatewayFixture } from "./types";

// The fixtures import engine modules, whose config wants these. Nothing here connects.
process.env.DATABASE_URL ??= "postgres://unused@localhost:5432/unused";
process.env.API_KEY_SECRET ??= "docs-recheck-placeholder-secret";
const { FIXTURES } = (await import("./registry")) as { FIXTURES: GatewayFixture[] };

const only = process.argv.slice(2).filter((a) => a !== "--");
const cache = new Map<string, Promise<string>>();
const fetchText = (url: string) => {
  if (!cache.has(url))
    cache.set(
      url,
      fetch(url, {
        signal: AbortSignal.timeout(60_000),
        headers: { "user-agent": "tmbilling-docs-recheck" },
      }).then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      }),
    );
  return cache.get(url)!;
};

/** Lower-case words, so `requires_payment_method`, `requires _ payment` and "Requires Payment" match. */
const norm = (s: string) =>
  ` ${s
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim()} `;
const pageText = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    // Markdown sources quote values: `open` in prose, "queued", in an embedded JSON enum,
    // **QUEUED** in bold.
    .replace(/[`",*]/g, " ");

function walk(json: unknown, path: string[]): unknown {
  return path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], json);
}

interface Finding {
  gateway: string;
  doc: string;
  missing: string[];
  added: string[];
  advisory: string[];
  error?: string;
}

async function check(f: GatewayFixture, doc: DocSource): Promise<Finding> {
  const known = f.statuses.filter((s) => s.doc === doc.id).map((s) => s.status);
  const out: Finding = {
    gateway: f.key,
    doc: `${doc.id} (${doc.url})`,
    missing: [],
    added: [],
    advisory: [],
  };
  let raw: string;
  try {
    raw = await fetchText(doc.url);
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  if (doc.check.kind === "page") {
    const text = norm(pageText(raw));
    out.missing = known.filter((s) => !text.includes(norm(s)));
    const codes = new Set(
      [...raw.matchAll(/<code[^>]*>\s*([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*<\/code>/g)].map(
        (m) => m[1]!,
      ),
    );
    out.advisory = [...codes].filter((c) => !known.includes(c)).sort();
    return out;
  }
  if (doc.check.kind === "xsd-enum") {
    const type = new RegExp(
      `<xs:simpleType name="${doc.check.type}">([\\s\\S]*?)</xs:simpleType>`,
    ).exec(raw);
    if (!type) return { ...out, error: `no simpleType ${doc.check.type}` };
    const listed = [...type[1]!.matchAll(/<xs:enumeration value="([^"]*)"/g)].map((m) => m[1]!);
    out.missing = known.filter((s) => !listed.includes(s));
    out.added = listed.filter((s) => !known.includes(s));
    return out;
  }
  let value: unknown;
  try {
    value = walk(JSON.parse(raw), doc.check.path);
  } catch (e) {
    return { ...out, error: `not JSON: ${(e as Error).message}` };
  }
  if (doc.check.kind === "openapi-enum") {
    if (!Array.isArray(value)) return { ...out, error: `no enum at ${doc.check.path.join(".")}` };
    const listed = value.map(String);
    out.missing = known.filter((s) => !listed.includes(s));
    out.added = listed.filter((s) => !known.includes(s));
    return out;
  }
  if (typeof value !== "string") return { ...out, error: `no text at ${doc.check.path.join(".")}` };
  const words = new Set([
    ...[...value.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((m) => m[1]!),
    ...(value.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*\b/g) ?? []).filter((w) => w.length > 2),
  ]);
  out.missing = known.filter((s) => !new RegExp(`\\b${s}\\b`).test(value as string));
  out.added = [...words].filter((w) => !known.includes(w)).sort();
  return out;
}

let failed = false;
for (const f of FIXTURES.filter((x) => only.length === 0 || only.includes(x.key))) {
  console.log(`\n── ${f.key}`);
  for (const doc of f.docs) {
    const r = await check(f, doc);
    const bad = !!r.error || r.missing.length > 0 || r.added.length > 0;
    if (bad) failed = true;
    console.log(`${bad ? "✗" : "✓"} ${r.doc} — read ${doc.read}`);
    if (r.error) console.log(`    could not check: ${r.error}`);
    if (r.missing.length) console.log(`    no longer documented: ${r.missing.join(", ")}`);
    if (r.added.length) console.log(`    new values to map: ${r.added.join(", ")}`);
    if (r.advisory.length)
      console.log(`    codes on the page we do not map (review): ${r.advisory.join(", ")}`);
  }
}
console.log(
  failed
    ? "\n❌ GATEWAY DOCS: a documented status list changed. Update the fixture (and its `read` date), then the adapter."
    : "\n✅ GATEWAY DOCS: every documented status list matches the fixtures",
);
process.exit(failed ? 1 : 0);
