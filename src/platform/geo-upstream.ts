/**
 * Is the geo reference data (`countries`, `country_subdivisions`) behind upstream?
 *
 * The weekly `geo_upstream_check` job asks GitHub for dr5hn's latest release and records
 * it next to the release `geo:seed` loaded. The `geo_reference_outdated` ops alert reads
 * both. Nothing here changes the dataset: a newer release is regenerated
 * (`pnpm geo:generate`), reviewed in a PR, and reseeded by the deploy.
 */
import { eq } from "drizzle-orm";
import { systemDb } from "@/platform/db";
import { referenceDataSources } from "@db/schema";

export const GEO_SOURCE = "dr5hn";
export const DR5HN_LATEST_RELEASE_URL =
  "https://api.github.com/repos/dr5hn/countries-states-cities-database/releases/latest";

export interface GeoReferenceSource {
  seededVersion: string | null;
  upstreamVersion: string | null;
  upstreamPublishedAt: Date | null;
  checkedAt: Date | null;
  checkError: string | null;
}

/**
 * Is `upstream` a later dr5hn release than `seeded`? Tags read `v5.1.0` or `v5.1.0-export.1`;
 * an export build ranks above its plain tag. GitHub's "latest" can lag behind the seeded tag
 * (it points at the newest export build), so a mismatch alone is not "newer". Unparseable
 * tags fall back to any mismatch.
 */
export function isNewerGeoRelease(upstream: string, seeded: string): boolean {
  const parse = (t: string) => {
    const m = /^v?(\d+(?:\.\d+)*)(?:-export\.(\d+))?$/.exec(t);
    return m ? { base: m[1]!.split(".").map(Number), exp: Number(m[2] ?? 0) } : null;
  };
  const u = parse(upstream);
  const s = parse(seeded);
  if (!u || !s) return upstream !== seeded;
  for (let i = 0; i < Math.max(u.base.length, s.base.length); i++) {
    const d = (u.base[i] ?? 0) - (s.base[i] ?? 0);
    if (d) return d > 0;
  }
  return u.exp > s.exp;
}

/** Fetch dr5hn's latest release and record it. Never throws: a failure is stored. */
export async function checkGeoUpstream(
  opts: { now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<{ upstreamVersion: string | null; error: string | null }> {
  const now = opts.now ?? new Date();
  let upstreamVersion: string | null = null;
  let publishedAt: Date | null = null;
  let error: string | null = null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(DR5HN_LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json", "user-agent": "tmbilling-geo-check" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown; published_at?: unknown };
    if (typeof body.tag_name !== "string" || !body.tag_name)
      throw new Error("release has no tag_name");
    upstreamVersion = body.tag_name;
    publishedAt = typeof body.published_at === "string" ? new Date(body.published_at) : null;
  } catch (e) {
    error = (e as Error).message;
  }

  // A failed check keeps the last known upstream version; only the error and time move.
  const set = error
    ? { checkedAt: now, checkError: error }
    : { upstreamVersion, upstreamPublishedAt: publishedAt, checkedAt: now, checkError: null };
  await systemDb
    .insert(referenceDataSources)
    .values({ source: GEO_SOURCE, ...set })
    .onConflictDoUpdate({ target: referenceDataSources.source, set });
  return { upstreamVersion, error };
}

export async function readGeoReferenceSource(): Promise<GeoReferenceSource> {
  const [row] = await systemDb
    .select()
    .from(referenceDataSources)
    .where(eq(referenceDataSources.source, GEO_SOURCE))
    .limit(1);
  return {
    seededVersion: row?.seededVersion ?? null,
    upstreamVersion: row?.upstreamVersion ?? null,
    upstreamPublishedAt: row?.upstreamPublishedAt ?? null,
    checkedAt: row?.checkedAt ?? null,
    checkError: row?.checkError ?? null,
  };
}
