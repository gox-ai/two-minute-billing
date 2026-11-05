/**
 * Country reference data, read-only.
 *
 * The dashboard used to ship its own copy of all this — a country-code string, four
 * subdivision lists, fifteen postal regexes and a hand-maintained set of countries
 * with no postal code — in `dashboard/lib/countries.ts`. It drifted from the
 * engine's copy by construction, and `verify:tax-subdivisions` existed only to
 * notice. These endpoints replace it: one source, read over HTTP, so the picker can
 * never offer a value the API rejects.
 *
 * PUBLIC, like `/openapi.json` and `/docs`. Two reasons. The rows carry nothing
 * tenant-specific — there is no `organization_id` on these tables and every caller
 * gets identical bytes, which are the published ISO 3166 lists. And the buyer-facing
 * surfaces need them: the hosted checkout and the customer portal render the same
 * address form while authenticated by a short-lived buyer TOKEN, not an org API key,
 * so gating this on `authenticate` would leave those two forms unable to populate a
 * country picker at all.
 *
 * Cacheable: this data changes when a country reorganises its states, which is to
 * say almost never. A long max-age keeps the address form from re-fetching 249
 * countries on every render.
 */
import type { FastifyInstance } from "fastify";
import { aliasesFor, allCountries, countryFor, subdivisionsFor } from "@/platform/geo";

/** A day: long enough to be worth caching, short enough that a correction lands. */
const CACHE_CONTROL = "public, max-age=86400";

function serializeCountry(c: ReturnType<typeof allCountries>[number]) {
  return {
    object: "country",
    code: c.code,
    name: c.name,
    dial_code: c.dialCode,
    /** National-number pattern, anchored by the client as `^(?:…)$`; null means none. */
    phone_pattern: c.phonePattern,
    /** Allowed national-number lengths; null means any. */
    phone_lengths: c.phoneLengths,
    /** Local name for the region field — "State", "Province", "Prefecture". */
    region_label: c.regionLabel,
    /** Local name for the postal field — "ZIP code", "PIN code", "Postcode". */
    postal_label: c.postalLabel,
    /** False for the ~60 countries with no postal system — hide the field entirely. */
    has_postal_code: c.hasPostalCode,
    /** Anchored by the client as `^(?:…)$`; null means no format to check. */
    postal_regex: c.postalRegex,
    /** Characters to strip before matching (usually " -"). */
    postal_redundant: c.postalRedundant,
    postal_hint: c.postalHint,
    /** True when a non-empty subdivision outside the list is rejected. */
    subdivision_strict: c.subdivisionStrict,
    /** Whether a subdivision list exists at all — 50 territories have none. */
    has_subdivisions: (subdivisionsFor(c.code)?.length ?? 0) > 0,
  };
}

export async function registerGeoRoutes(app: FastifyInstance) {
  app.get("/v1/countries", async (_req, reply) => {
    reply.header("cache-control", CACHE_CONTROL);
    return { object: "list", data: allCountries().map(serializeCountry) };
  });

  app.get<{ Params: { code: string } }>("/v1/countries/:code", async (req, reply) => {
    const country = countryFor(req.params.code);
    if (!country) {
      return reply
        .code(404)
        .send({ error: { type: "not_found", message: `No such country: ${req.params.code}` } });
    }
    reply.header("cache-control", CACHE_CONTROL);
    return serializeCountry(country);
  });

  app.get<{ Params: { code: string } }>("/v1/countries/:code/subdivisions", async (req, reply) => {
    const country = countryFor(req.params.code);
    if (!country) {
      return reply
        .code(404)
        .send({ error: { type: "not_found", message: `No such country: ${req.params.code}` } });
    }
    reply.header("cache-control", CACHE_CONTROL);
    // `code` is the ISO 3166-2 SUFFIX ("TN", not "IN-TN") — what `state_code` stores.
    return {
      object: "list",
      data: (subdivisionsFor(country.code) ?? []).map((s) => ({
        object: "subdivision",
        code: s.value,
        name: s.label,
      })),
      /**
       * Non-canonical codes we accept, as `{ alias: canonical }`. The picker needs
       * them to render an imported value (`OD`) against our canonical
       * code (`OR`) — without the fold the field shows blank for a correct value
       * and the next save silently clears it.
       */
      aliases: aliasesFor(country.code),
      // Carried here so a control that only knows the country CODE (the tax
      // place-of-supply picker) can label itself without also fetching /v1/countries.
      region_label: country.regionLabel,
      subdivision_strict: country.subdivisionStrict,
    };
  });
}
