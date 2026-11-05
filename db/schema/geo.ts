import {
  pgTable,
  text,
  boolean,
  integer,
  primaryKey,
  index,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * Country and subdivision reference data — the authority behind every address
 * form and every address the API accepts.
 *
 * WHY IT IS IN THE DATABASE. This was three hand-maintained copies: a country
 * code string plus postal regexes in `dashboard/lib/countries.ts`, a separate
 * IN/US subdivision list in `src/platform/subdivisions.ts`, and a third set of
 * labels inline in the business-profile settings page. They disagreed — the
 * dashboard shipped a strict state picker in front of an API that accepted any
 * string, and the business-profile screen asked for a 2-letter country code in a
 * free-text box. Reference data that both the engine and the dashboard must
 * agree on belongs in one place both of them read, and one an operator can
 * correct without a deploy when a country reorganises its states.
 *
 * PLATFORM-GLOBAL — no `organization_id` and NO RLS, like `ops_invariant_results`
 * and `clock_ticks`. The set of countries is not one tenant's business.
 *
 * Populated by `pnpm geo:seed` from `db/seed-data/geo.json`, which
 * `pnpm geo:generate` builds from three dev-only packages. See
 * `scripts/generate-geo-data.ts` for why India and the US are curated by hand.
 */
export const countries = pgTable("countries", {
  /** ISO 3166-1 alpha-2, upper case. What every `country` column stores. */
  code: text("code").primaryKey(),
  name: text("name").notNull(),

  /**
   * Calling code WITHOUT the leading `+` ("91", "1"). Nullable: a handful of ISO
   * regions have no telephone assignment (AQ, BV, HM…).
   */
  dialCode: text("dial_code"),
  /**
   * libphonenumber's national-number pattern, anchored at use. Together with
   * `phoneLengths` this is what makes a phone number strictly validated rather
   * than merely "has some digits".
   */
  phonePattern: text("phone_pattern"),
  /** Valid national-number lengths. A cheap pre-check and a good error message. */
  phoneLengths: integer("phone_lengths").array(),

  /** Local name for the region field — a US "State" is a CA "Province", a JP "Prefecture". */
  regionLabel: text("region_label").notNull().default("State / Province"),
  /** Local name for the postal field — "ZIP code", "PIN code", "Postcode", "Eircode". */
  postalLabel: text("postal_label").notNull().default("Postal code"),

  /**
   * False for the ~60 countries with no postal system at all (AE, HK, PA…), where
   * the field is hidden rather than left as an empty box the user wonders about.
   */
  hasPostalCode: boolean("has_postal_code").notNull().default(true),
  /** Postal format. Null means "we have no pattern" → any non-empty value passes. */
  postalRegex: text("postal_regex"),
  /** Characters stripped before matching (usually " -"), mirroring postal-codes-js. */
  postalRedundant: text("postal_redundant"),
  /** Human format hint: "NNNNN[-NNNN]", "A0A 0A0". Null when we'd only be repeating the country. */
  postalHint: text("postal_hint"),

  /**
   * True when the subdivision list is a CLOSED set: a non-empty `state_code`
   * outside it is a 400. False where ISO 3166-2 lists municipal units nobody
   * writes in an address (GB's 239 councils, FR's 96 departments) — there the
   * picker is a convenience and free text is still accepted, because rejecting an
   * address someone wrote correctly is worse than not validating it.
   */
  subdivisionStrict: boolean("subdivision_strict").notNull().default(false),

  /**
   * IANA zones the country spans, alphabetical as the source lists them. Null means
   * unknown (not yet seeded), never "no timezone".
   */
  timezones: text("timezones").array(),
});

/**
 * ISO 3166-2 subdivisions. `code` is the SUFFIX only ("TN", not "IN-TN") — that
 * is what `state_code` has always stored and what tax resolution matches on.
 */
export const countrySubdivisions = pgTable(
  "country_subdivisions",
  {
    countryCode: text("country_code")
      .notNull()
      .references(() => countries.code, { onDelete: "cascade" }),
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** ISO's own type name ("State", "Union territory", "Province"). */
    type: text("type"),
  },
  (t) => [
    primaryKey({ columns: [t.countryCode, t.code] }),
    index("country_subdivisions_country_idx").on(t.countryCode),
  ],
);

/**
 * Non-canonical subdivision codes we ACCEPT and fold to the canonical one.
 *
 * GST practice uses different codes from ISO for four Indian states
 * (CG→CT, OD→OR, TS→TG, UK→UT) and the importer copies `state_code` verbatim.
 * Without the fold an imported Odisha customer arrives as `OD`, matches no rate
 * configured through our picker, and is taxed at zero — a wrong number on a legal
 * document rather than an error. This was a constant in two source files; it is
 * data, and it belongs next to the codes it maps onto.
 */
export const countrySubdivisionAliases = pgTable(
  "country_subdivision_aliases",
  {
    countryCode: text("country_code")
      .notNull()
      .references(() => countries.code, { onDelete: "cascade" }),
    /** The code as received (e.g. `OD`). */
    alias: text("alias").notNull(),
    /** The canonical code it folds to (ISO's `OR`). */
    code: text("code").notNull(),
  },
  (t) => [primaryKey({ columns: [t.countryCode, t.alias] })],
);

/**
 * Which release of each external reference dataset is SEEDED, and the newest one
 * UPSTREAM — so a stale dataset is an ops alert (`geo_reference_outdated`), not a
 * surprise. Platform-global like `countries`: no tenant, no RLS.
 *
 * `seeded_*` is written by `pnpm geo:seed`; `upstream_*` and `checked_at` by the weekly
 * `geo_upstream_check` job. Nothing is fetched into the dataset automatically: a newer
 * release is regenerated and reviewed in a PR, and the deploy reseeds.
 */
export const referenceDataSources = pgTable("reference_data_sources", {
  /** `dr5hn` — the geo dataset behind `countries` / `country_subdivisions`. */
  source: text("source").primaryKey(),
  seededVersion: text("seeded_version"),
  seededAt: timestamp("seeded_at", { withTimezone: true }),
  upstreamVersion: text("upstream_version"),
  upstreamPublishedAt: timestamp("upstream_published_at", { withTimezone: true }),
  checkedAt: timestamp("checked_at", { withTimezone: true }),
  /** Why the last upstream check failed; null after a successful one. */
  checkError: text("check_error"),
  /** 0455 (`model_prices`): the last run that succeeded; a failed run leaves it. */
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  /** 0455 (`model_prices`): a suspicious batch held for staff release. NULL = none held. */
  heldBatch: jsonb("held_batch"),
});
