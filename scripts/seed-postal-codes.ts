/**
 * Load GeoNames postal codes into `postal_codes` (powers city + state autofill).
 *
 *   pnpm postal:seed                      # downloads allCountries.zip (~19 MB), loads every country
 *   pnpm postal:seed -- --countries IN,US # only these countries (others are left alone)
 *   pnpm postal:seed -- --file ./allCountries.zip   # a zip or .txt you already have
 *
 * Data: GeoNames postal codes, CC BY 4.0 (https://www.geonames.org), for places and regions.
 * For India the STATE comes from the dr5hn India Post pincode data (release `DR5HN_POSTCODES_TAG`,
 * `csv-postcodes.csv.gz`, ODbL; GeoNames has no Ladakh), falling back to GeoNames for a pincode
 * that data lacks. `--india-post <csv|csv.gz>` uses a local copy instead of downloading. NOT part of the default
 * seed: ~1.8 million rows. Idempotent: the selected countries are replaced in one transaction.
 * Needs `unzip` on the PATH. GeoNames' region is mapped to OUR subdivision codes
 * (`db/seed-data/geo.json`); a region that matches none keeps `state_code` null.
 */
import { spawn } from "node:child_process";
import { createReadStream, readFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { systemDb, closeDb } from "@/platform/db";
import { postalKey } from "@/platform/postal-lookup";
import { referenceDataSources } from "@db/schema";

const URL_ZIP = "https://download.geonames.org/export/zip/allCountries.zip";
/** Pinned like `DR5HN_TAG` in generate-geo-data.ts: the first release with India Post pincodes. */
const DR5HN_POSTCODES_TAG = "v5.2.0-export.1";
const URL_INDIA_POST = `https://github.com/dr5hn/countries-states-cities-database/releases/download/${DR5HN_POSTCODES_TAG}/csv-postcodes.csv.gz`;
const here = dirname(fileURLToPath(import.meta.url));
const geo: {
  subdivisions: Array<{ country: string; code: string; name: string }>;
  aliases: Array<{ country: string; from: string; to: string }>;
} = JSON.parse(readFileSync(resolve(here, "../db/seed-data/geo.json"), "utf8"));

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const only = opt("--countries")
  ?.split(",")
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean);
const fileArg = opt("--file");
const indiaPostArg = opt("--india-post");

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");

/** GeoNames region names that are the same place under another name. Checked by hand. */
const NAME_ALIASES: Record<string, Record<string, string>> = {
  IN: { pondicherry: "PY" }, // renamed Puducherry
};

// country → folded name → our code, and the set of our codes per country.
const byName = new Map<string, Map<string, string>>();
const codes = new Map<string, Set<string>>();
for (const s of geo.subdivisions) {
  if (!byName.has(s.country)) byName.set(s.country, new Map());
  byName.get(s.country)!.set(fold(s.name), s.code);
  if (!codes.has(s.country)) codes.set(s.country, new Set());
  codes.get(s.country)!.add(s.code);
}
const aliasTo = new Map(geo.aliases.map((a) => [`${a.country}:${a.from}`, a.to]));

function mapRegion(country: string, name: string, code: string): string | null {
  const byN = byName.get(country);
  const hit =
    byN?.get(fold(name)) ??
    NAME_ALIASES[country]?.[fold(name)] ??
    (code ? aliasTo.get(`${country}:${code}`) : undefined);
  if (hit) return hit;
  // Several countries (US, CA, AU…) use our own code as GeoNames' region code.
  return code && codes.get(country)?.has(code) ? code : null;
}

async function source(): Promise<{ path: string; entry?: string; cleanup: () => Promise<void> }> {
  if (fileArg) {
    return {
      path: resolve(fileArg),
      entry: fileArg.endsWith(".zip") ? "allCountries.txt" : undefined,
      cleanup: async () => {},
    };
  }
  const dir = await mkdtemp(join(tmpdir(), "geonames-"));
  console.log(`downloading ${URL_ZIP}`);
  const res = await fetch(URL_ZIP);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const zip = join(dir, "allCountries.zip");
  await writeFile(zip, Buffer.from(await res.arrayBuffer()));
  return {
    path: zip,
    entry: "allCountries.txt",
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/** One CSV line to fields (quoted fields may hold commas). */
function csvFields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') ((cur += '"'), i++);
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") (out.push(cur), (cur = ""));
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** pincode → our state code, from the dr5hn India Post rows. */
async function loadIndiaPost(): Promise<Map<string, string>> {
  let path = indiaPostArg ? resolve(indiaPostArg) : "";
  let dir: string | undefined;
  if (!path) {
    dir = await mkdtemp(join(tmpdir(), "dr5hn-postcodes-"));
    console.log(`downloading ${URL_INDIA_POST}`);
    const res = await fetch(URL_INDIA_POST, { redirect: "follow" });
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    path = join(dir, "csv-postcodes.csv.gz");
    await writeFile(path, Buffer.from(await res.arrayBuffer()));
  }
  const input = path.endsWith(".gz")
    ? createReadStream(path).pipe(createGunzip())
    : createReadStream(path);
  const map = new Map<string, string>();
  for await (const line of createInterface({ input })) {
    if (!line.includes(",IN,")) continue;
    const f = csvFields(line);
    if (f[3] !== "IN" || f[11] !== "india-post" || !f[1] || !f[5]) continue;
    const code = aliasTo.get(`IN:${f[5]}`) ?? f[5];
    if (codes.get("IN")?.has(code)) map.set(postalKey(f[1]), code);
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  return map;
}
const indiaPost = !only || only.includes("IN") ? await loadIndiaPost() : new Map<string, string>();
if (indiaPost.size) console.log(`India Post: ${indiaPost.size} pincodes`);
const stateChanges = new Map<string, number>();
const changedPins = new Set<string>();
const notInIndiaPost = new Set<string>();

const t0 = Date.now();
const src = await source();
const lines = src.entry
  ? (() => {
      const p = spawn("unzip", ["-p", src.path, src.entry], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      return createInterface({ input: p.stdout });
    })()
  : createInterface({ input: createReadStream(src.path) });

type Row = [string, string, string, string | null, string | null];
const rows = new Map<string, Row>();
const stats = new Map<string, { total: number; matched: number; unmatched: Map<string, number> }>();
for await (const line of lines) {
  const f = line.split("\t");
  const country = f[0];
  if (!country || !f[1] || (only && !only.includes(country))) continue;
  const key = postalKey(f[1]);
  // India's place column lists localities (Flower Bazaar); the district reads as the city.
  const place = ((country === "IN" ? f[5] || f[2] : f[2]) ?? "").trim();
  if (!key || !place) continue;
  const id = `${country}|${key}|${place}`;
  if (rows.has(id)) continue;
  const admin1 = (f[3] ?? "").trim();
  let state = admin1 ? mapRegion(country, admin1, (f[4] ?? "").trim()) : null;
  if (country === "IN" && indiaPost.size) {
    const post = indiaPost.get(key);
    if (post) {
      if (post !== state) {
        const pair = `${state ?? "none"}->${post}`;
        if (!changedPins.has(key)) stateChanges.set(pair, (stateChanges.get(pair) ?? 0) + 1);
        changedPins.add(key);
      }
      state = post;
    } else notInIndiaPost.add(key);
  }
  rows.set(id, [country, key, place, admin1 || null, state]);
  const st = stats.get(country) ?? { total: 0, matched: 0, unmatched: new Map() };
  st.total++;
  if (state) st.matched++;
  else if (admin1) st.unmatched.set(admin1, (st.unmatched.get(admin1) ?? 0) + 1);
  stats.set(country, st);
}
await src.cleanup();
console.log(`parsed ${rows.size} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const t1 = Date.now();
const all = [...rows.values()];
const selected = [...stats.keys()];
await systemDb.transaction(async (tx) => {
  await tx.execute(
    sql`DELETE FROM postal_codes WHERE country IN (${sql.join(
      selected.map((c) => sql`${c}`),
      sql`, `,
    )})`,
  );
  const CHUNK = 5000;
  for (let i = 0; i < all.length; i += CHUNK) {
    // One JSON parameter per batch: a JS array would expand into one bind per element.
    const json = JSON.stringify(
      all.slice(i, i + CHUNK).map((r) => ({ c: r[0], p: r[1], n: r[2], a: r[3], s: r[4] })),
    );
    await tx.execute(sql`
      INSERT INTO postal_codes (country, postal_code, place_name, admin1_name, state_code)
      SELECT c, p, n, a, s
      FROM json_to_recordset(${json}::json)
        AS x(c text, p text, n text, a text, s text)
      ON CONFLICT DO NOTHING
    `);
  }
});
console.log(`loaded in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

for (const c of ["IN", "US"]) {
  const st = stats.get(c);
  if (!st) continue;
  const miss = [...st.unmatched.entries()].map(([n, k]) => `${n} (${k})`).join(", ");
  console.log(
    `${c}: ${st.matched}/${st.total} rows matched a subdivision (${((100 * st.matched) / st.total).toFixed(2)}%)${miss ? `; unmatched regions: ${miss}` : ""}`,
  );
}
if (indiaPost.size) {
  const pairs = [...stateChanges.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`);
  console.log(
    `IN state changed vs GeoNames for ${changedPins.size} pincodes: ${pairs.join(", ") || "none"}`,
  );
  console.log(`IN pincodes in GeoNames but not in India Post: ${notInIndiaPost.size}`);
}
let m = 0;
let t = 0;
for (const st of stats.values()) {
  m += st.matched;
  t += st.total;
}
console.log(`all ${stats.size} countries: ${m}/${t} rows matched (${((100 * m) / t).toFixed(1)}%)`);

if (!only) {
  const version = new Date().toISOString().slice(0, 10);
  await systemDb
    .insert(referenceDataSources)
    .values({ source: "geonames_postal", seededVersion: version, seededAt: new Date() })
    .onConflictDoUpdate({
      target: referenceDataSources.source,
      set: { seededVersion: version, seededAt: new Date() },
    });
}
await closeDb();
process.exit(0);
