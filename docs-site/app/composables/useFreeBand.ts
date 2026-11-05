/**
 * The Free plan's monthly billing band in the visitor's currency ("$1,000"), from the plan
 * catalogue. Copy never types the figure, so one catalogue change plus a rebuild updates every
 * page. No band is an error, not a fallback, so a stale figure cannot ship: a prerendered page
 * fails the build (Nuxt prerenders with `failOnError`), a server-rendered one answers 503.
 */
export async function useFreeBand(
  // A server-rendered page passes "plans-visitor": "plans" is also in every prerendered
  // page's payload, fetched at build time with no visitor country, and would be reused.
  key: "plans" | "plans-visitor" = "plans",
): Promise<ComputedRef<string>> {
  // oxlint-disable-next-line react-hooks/rules-of-hooks -- a Nuxt composable, not a React hook
  const { data } = await useFetch("/api/plans", { key });
  const band = computed(() => {
    const f = data.value?.free.find((p) => p.currency === data.value?.preferred);
    if (f?.bandMinor == null) return undefined;
    return new Intl.NumberFormat(f.currency === "INR" ? "en-IN" : "en", {
      style: "currency",
      currency: f.currency,
      maximumFractionDigits: 0,
    }).format(f.bandMinor / 100);
  });
  if (band.value == null) {
    throw createError({
      statusCode: 503,
      statusMessage: "The plan catalogue has no Free band.",
      fatal: true,
    });
  }
  return band as ComputedRef<string>;
}

/** Static copy (utils/compare.ts) carries this token where the band goes. */
export const FREE_BAND_TOKEN = "{freeBand}";

/** `value` with every `{freeBand}` filled in, through nested objects and arrays. */
export function fillFreeBand<T>(value: T, band: string): T {
  if (typeof value === "string") return value.replaceAll(FREE_BAND_TOKEN, band) as T;
  if (Array.isArray(value)) return value.map((v) => fillFreeBand(v, band)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, fillFreeBand(v, band)]),
    ) as T;
  }
  return value;
}
