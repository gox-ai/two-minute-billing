"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/form/field";
import { Combobox } from "@/components/ui/combobox";
import { Button } from "@/components/ui/button";
import { PhoneField } from "@/components/ui/phone-field";
import { useSubdivisions } from "@/lib/use-subdivisions";
import { useDefaultState } from "@/lib/use-default-state";
import {
  isValidPostal,
  normalizeStateCode,
  postalHint,
  postalLabel,
  regionLabel,
  usesPostalCode,
  type Country,
} from "@/lib/countries";

/**
 * Loose billing-address shape shared by every surface (operator customer page +
 * buyer portal). Kept in snake_case to match both the operator `address` body
 * (addressBody in src/api/customer-routes.ts) and the portal `address` body
 * (portalMeBody in src/api/customer-portal-routes.ts).
 */
/** Per-field state from a business's checkout or portal matrix. */
export type AddressFieldState = "show" | "hide" | "mandatory" | "read_only";
export type AddressFieldKey =
  | "first_name"
  | "last_name"
  | "company"
  | "phone"
  | "line1"
  | "line2"
  | "line3"
  | "city"
  | "state"
  | "state_code"
  | "postal_code"
  | "country";

/** The region is one control that writes both columns, so it takes the stronger state. */
function regionStateOf(
  code: AddressFieldState | undefined,
  name: AddressFieldState | undefined,
): AddressFieldState | undefined {
  if (code === undefined && name === undefined) return undefined;
  if (code === "mandatory" || name === "mandatory") return "mandatory";
  if (code === "read_only" || name === "read_only") return "read_only";
  if ((code ?? "hide") === "hide" && (name ?? "hide") === "hide") return "hide";
  return "show";
}

export interface AddressValue {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  line3?: string | null;
  city?: string | null;
  state?: string | null;
  state_code?: string | null;
  postal_code?: string | null;
  country?: string | null;
}

/**
 * The one address input block, reused by the portal add-card gate, the operator
 * "edit billing address" drawer, the full edit-customer drawer, the shipping section
 * and the business-profile settings page, so they stay identical in fields, labels
 * and validation.
 *
 * `prefix` namespaces the field `name`s: operator forms post `addr_*` / `ship_*`,
 * the portal posts bare names. `requireCore` marks country and line1 required; `requireRest`
 * (defaults to `requireCore`) marks city, state, postal code and phone required. Both are
 * defaults only: a field with an entry in `fieldStates` follows that entry instead.
 *
 * State and postal are required only WHERE THEY EXIST: the region control is chosen by the
 * country's `has_subdivisions`, postal by `showPostal`, both from the engine's own country
 * reference — so a country with no subdivisions or no postal system never gets an
 * unsatisfiable required field.
 * City is shown for every country, so `requireRest` (or its state) alone gates it.
 * NB the update REPLACES the whole address, so every field renders always — an
 * omitted field clears its column.
 *
 * ── THE CONTACT BLOCK IS THE INVOICE IDENTITY ───────────────────────────────────
 * `first_name`/`last_name`/`company` here are the BILLING CONTACT — the name we print
 * on the document (`src/modules/customers/names.ts`). On the buyer surfaces it is
 * therefore the only name asked for at all, so those callers pass `requireContactName`
 * and their own
 * `contactHeading`. Both default to today's behaviour: the operator forms keep an
 * OPTIONAL contact, because an operator creating a customer from a spreadsheet has
 * the account-holder columns to fall back on and must not be blocked here.
 *
 * ── WHERE THE DATA COMES FROM ───────────────────────────────────────────────────
 * `countries` is fetched server-side from `GET /v1/countries` and passed in, so the
 * picker is correct on first paint. Subdivisions are fetched in the browser when the
 * country changes: they depend on a choice only the browser knows, and shipping all
 * 5042 of them up front to avoid the round trip would cost ~500KB for one dropdown.
 *
 * This used to be hardcoded here — four subdivision lists, fifteen postal regexes and
 * a hand-maintained set of countries with no postal code — while the engine held its
 * own differently-scoped copy. The picker could offer what the API rejected, and did.
 *
 * ── VALIDATION ──────────────────────────────────────────────────────────────────
 * Inline, immediate, and BLOCKING: a bad postal code sets a custom validity message,
 * so the form will not submit. It used to render an error and submit anyway, which
 * made the check decorative. The server re-validates regardless — the same rules run
 * there against the same rows, so this is a faster message, not the boundary.
 */
export function AddressFields({
  countries,
  value,
  prefix = "",
  includeContact = true,
  requireCore = true,
  requireRest = requireCore,
  requireContactName = false,
  contactHeading = "Contact (shown on invoices)",
  fieldStates,
}: {
  countries: Country[];
  value?: AddressValue | null;
  prefix?: string;
  includeContact?: boolean;
  requireCore?: boolean;
  /**
   * City, state, postal code and phone. Split from `requireCore` so an operator can edit a
   * customer whose stored address lacks them without being forced to invent values.
   */
  requireRest?: boolean;
  /**
   * Make `first_name` mandatory. Opt-in, and it must stay opt-in: the operator forms
   * share this component and gained no new required field.
   */
  requireContactName?: boolean;
  /** Heading over the contact block. Buyer surfaces retitle it — see above. */
  contactHeading?: string;
  /**
   * Per-field state from the business's matrix; a field with no entry keeps the defaults
   * above. The save replaces the whole address, so `hide` and `read_only` both post the
   * stored value in a hidden input; `read_only` also shows it, disabled. Country ignores
   * `hide`. Region and postal code are required only where the country uses them.
   */
  fieldStates?: Partial<Record<AddressFieldKey, AddressFieldState>>;
}) {
  const a = value ?? {};
  const n = (k: string) => `${prefix}${k}`;
  const st = (k: AddressFieldKey) => fieldStates?.[k];
  /** The field's own state decides; with none, the caller's default does. */
  const req = (k: AddressFieldKey, fallback: boolean) => {
    const s = st(k);
    return s === undefined || s === "hide" ? fallback : s === "mandatory";
  };
  const keep = (k: AddressFieldKey) => <input type="hidden" name={n(k)} value={a[k] ?? ""} />;
  /** A disabled copy for the eye, and hidden inputs that post the stored values. */
  const readOnly = (k: AddressFieldKey, label: string, shown: string, posts: AddressFieldKey[]) => (
    <>
      <Field name={n(k)} label={label}>
        <Input value={shown} placeholder="Not set" readOnly disabled />
      </Field>
      {posts.map((p) => (
        <input key={p} type="hidden" name={n(p)} value={a[p] ?? ""} />
      ))}
    </>
  );
  /** A plain text field under its state. */
  const text = (
    k: "first_name" | "last_name" | "company" | "line1" | "line2" | "city",
    label: string,
    fallback: boolean,
    input: React.ComponentProps<typeof Input>,
  ) => {
    if (st(k) === "hide") return keep(k);
    if (st(k) === "read_only") return readOnly(k, label, a[k] ?? "", [k]);
    const required = req(k, fallback);
    return (
      <Field name={n(k)} label={label} required={required}>
        <Input name={n(k)} defaultValue={a[k] ?? ""} required={required} {...input} />
      </Field>
    );
  };

  // Re-seeded from the saved address after an in-place save (see use-default-state).
  const [countryCode, setCountryCode] = useDefaultState((a.country ?? "").toUpperCase());
  const [postal, setPostal] = useDefaultState(a.postal_code ?? "");
  const [showLine3, setShowLine3] = React.useState(Boolean(a.line3) || st("line3") === "mandatory");
  // A hidden region or postal code is kept only for the stored country; it is wrong for another.
  const countryKept = countryCode === (a.country ?? "").toUpperCase();

  const country = React.useMemo(
    () => countries.find((c) => c.code === countryCode) ?? null,
    [countries, countryCode],
  );

  // ── Region (state / province) ──────────────────────────────────────────────
  //
  // WHICH CONTROL RENDERS IS DECIDED BY THE COUNTRY, NOT BY THE FETCH. `has_subdivisions`
  // ships on the country record from `GET /v1/countries` (`serializeCountry`,
  // src/api/geo-routes.ts), so it is known on first paint, before any request. The
  // subdivision list only fills the options in.
  //
  // This is the fix for the `state_code` wipe (docs/PROGRESS.md § Open bugs, 2026-08-22).
  // The old rule was `subs.length > 0`, which made three different situations look
  // identical — "this country has no subdivisions", "the list has not arrived yet" and
  // "the request failed" — and in the last two it rendered a free-text `state` box and NO
  // `state_code` field at all. Since a save REPLACES the whole address, every save in that
  // window nulled the column, permanently so after a failed fetch. `state_code` is what
  // picks CGST+SGST over IGST, so an Indian customer's tax changed with no visible cause.
  const {
    subs,
    aliases,
    loading: loadingSubs,
    failed: subsFailed,
    reload: reloadSubs,
  } = useSubdivisions(countryCode);
  const hasSubdivisions = Boolean(country?.has_subdivisions);
  const regionState = regionStateOf(st("state_code"), st("state"));
  const regionRequired =
    regionState === undefined || regionState === "hide" ? requireRest : regionState === "mandatory";

  // The stored code, folded through the aliases the API sent — an imported customer
  // may hold `OD` where our canonical code is `OR`, and without the fold the picker
  // would render blank for a value that is correct.
  const [regionCode, setRegionCode] = useDefaultState((a.state_code ?? "").toUpperCase());
  React.useEffect(() => {
    setRegionCode((prev) => normalizeStateCode(prev, aliases));
  }, [aliases, setRegionCode]);

  /**
   * The PRINTED region name, and it must not be blanked while the list is still loading.
   * `subs` is empty until the fetch lands, so deriving the name from it alone would post
   * `state: ''` alongside a perfectly good `state_code` — clearing the stored name on any
   * save made during that window. Same family of silent clear as the bug above, one column
   * over. So: derive from the list when it is there, otherwise keep the stored name — but
   * only while the held code is still the stored one.
   */
  const storedCode = normalizeStateCode((a.state_code ?? "").toUpperCase(), aliases);
  const regionName =
    subs.find((s) => s.code === regionCode)?.name ??
    (regionCode && regionCode === storedCode ? (a.state ?? "") : "");

  /**
   * The free-text region, for countries with no subdivisions. Controlled rather than
   * uncontrolled because it has to CLEAR on a country change: switching India → Gibraltar
   * remounts this input with `defaultValue={a.state}`, which left "Tamil Nadu" sitting in
   * Gibraltar's region box ready to be saved. Measured over CDP, not reasoned about.
   */
  const [stateText, setStateText] = useDefaultState(a.state ?? "");

  /**
   * Options for the picker, with the held code guaranteed to be among them.
   *
   * While the list is in flight — and forever, if it failed — `subs` is empty, and a
   * Combobox with no matching option would show its placeholder over a value that IS
   * still set and IS still going to be posted. A trigger reading "Select a state…" above
   * a hidden input holding `KA` is precisely the lie that made the old bug invisible, so
   * the held code is synthesized as its own option until the real row arrives.
   */
  const regionOptions = React.useMemo(() => {
    const opts = subs.map((s) => ({ value: s.code, label: s.name, keywords: s.code }));
    if (regionCode && !opts.some((o) => o.value === regionCode))
      opts.unshift({ value: regionCode, label: regionCode, keywords: regionCode });
    return opts;
  }, [subs, regionCode]);

  // ── Postal ─────────────────────────────────────────────────────────────────
  const hint = postalHint(country);
  const showPostal = usesPostalCode(country);
  const postalError =
    postal.trim() && !isValidPostal(country, postal)
      ? `This does not look like a ${postalLabel(country).toLowerCase()}.${hint ? ` Expected format: ${hint}.` : ""}`
      : undefined;

  /**
   * Blocking, not advisory. Without `setCustomValidity` the browser happily submits a
   * value we have already told the user is wrong, and the only thing stopping it
   * reaching the database is the server check — so the inline error was theatre.
   */
  const postalRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    postalRef.current?.setCustomValidity(postalError ?? "");
  }, [postalError]);

  return (
    <div className="flex flex-col gap-6">
      {includeContact ? (
        <section className="flex flex-col gap-4">
          <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            {contactHeading}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Only FIRST name is ever required. Last name stays optional even under
                `requireContactName`: mononyms are common in India, our largest launch
                market, and a form that refuses one is a form that loses the sale. */}
            {text("first_name", "First name", requireContactName, {
              maxLength: 100,
              autoComplete: "billing given-name",
            })}
            {text("last_name", "Last name", false, {
              maxLength: 100,
              autoComplete: "billing family-name",
            })}
            {text("company", "Company", false, {
              maxLength: 200,
              autoComplete: "billing organization",
            })}
            {st("phone") === "hide" ? (
              keep("phone")
            ) : st("phone") === "read_only" ? (
              readOnly("phone", "Phone", a.phone ?? "", ["phone"])
            ) : (
              <PhoneField
                name={n("phone")}
                countries={countries}
                defaultValue={a.phone}
                countryCode={countryCode}
                required={req("phone", requireRest)}
                help="We store it as an international number."
              />
            )}
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
          Address
        </h3>

        {/* Country leads: it decides the region control, the postal label and its
            format, so asking for it first means the rest of the form is already
            correct by the time it is filled in. */}
        {st("country") === "read_only" ? (
          readOnly("country", "Country", country?.name ?? a.country ?? "", ["country"])
        ) : (
          <Field name={n("country")} label="Country" required={req("country", requireCore)}>
            <Combobox
              name={n("country")}
              value={countryCode}
              onValueChange={(v: string) => {
                // Clear the held subdivision HERE, not once the new country's list arrives.
                // Deferring it leaves a window in which the form would post the PREVIOUS
                // country's code against the new country — which the API rejects for a
                // strict country and, worse, silently accepts for a lax one.
                setCountryCode(v.toUpperCase());
                setRegionCode("");
                setStateText("");
              }}
              required={req("country", requireCore)}
              ariaLabel="Country"
              placeholder="Select a country…"
              searchPlaceholder="Search country or code…"
              emptyMessage="No matching country."
              className="sm:max-w-sm"
              // The ISO code is a search term, not a label: an operator who knows `SG`
              // should not have to remember whether we print "Singapore" or "Singapore,
              // Republic of". It stays out of the trigger text, which is the country name.
              options={countries.map((c) => ({ value: c.code, label: c.name, keywords: c.code }))}
            />
          </Field>
        )}

        {text("line1", "Address line 1", requireCore, {
          maxLength: 200,
          autoComplete: "billing address-line1",
          placeholder: "Street address",
        })}

        {text("line2", "Address line 2", false, {
          maxLength: 200,
          autoComplete: "billing address-line2",
          placeholder: "Apartment, suite, unit",
        })}

        {/* Line 3 is real (the engine stores it) but rarely used, so it starts
            collapsed rather than sitting empty on every form. It always renders
            once it has a value, because saving REPLACES the address. */}
        {st("line3") === "hide" || (st("line3") === "read_only" && !a.line3) ? (
          keep("line3")
        ) : st("line3") === "read_only" ? (
          readOnly("line3", "Address line 3", a.line3 ?? "", ["line3"])
        ) : showLine3 ? (
          <Field name={n("line3")} label="Address line 3" required={req("line3", false)}>
            <Input
              name={n("line3")}
              defaultValue={a.line3 ?? ""}
              required={req("line3", false)}
              maxLength={200}
            />
          </Field>
        ) : (
          <div>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => setShowLine3(true)}
            >
              + Add address line 3
            </Button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          {text("city", "City", requireRest, {
            maxLength: 100,
            autoComplete: "billing address-level2",
          })}

          {!countryCode ? (
            /* No country chosen: no region control — a "State" box above an unknown
               country cannot be validated or labelled correctly. The
               stored values still ride along, because a save REPLACES the address and the
               `requireCore={false}` surfaces (shipping, business profile) can submit
               without a country. */
            <>
              <input type="hidden" name={n("state_code")} value={regionCode} />
              <input type="hidden" name={n("state")} value={stateText} />
            </>
          ) : regionState === "hide" ? (
            <>
              <input
                type="hidden"
                name={n("state_code")}
                value={countryKept && hasSubdivisions ? (a.state_code ?? "") : ""}
              />
              <input type="hidden" name={n("state")} value={countryKept ? (a.state ?? "") : ""} />
            </>
          ) : regionState === "read_only" ? (
            readOnly("state_code", regionLabel(country), regionName || a.state || "", [
              "state_code",
              "state",
            ])
          ) : hasSubdivisions ? (
            /* The hidden input is a SIBLING of <Field>, not a second child of it.
               Field clones its child to inject `id` / `aria-invalid`, and a Fragment
               swallows both — the label's htmlFor then points at nothing and React
               warns about an `id` prop on React.Fragment. */
            <div className="space-y-1.5">
              <Field
                name={n("state_code")}
                label={regionLabel(country)}
                required={regionRequired}
                error={
                  subsFailed
                    ? `We could not load the ${regionLabel(country).toLowerCase()} list.${regionCode ? " We keep the saved value." : ""}`
                    : undefined
                }
                help={
                  loadingSubs
                    ? "Loading…"
                    : country?.subdivision_strict
                      ? "We use it to calculate tax."
                      : "We use it to calculate tax. Select the closest match."
                }
              >
                <Combobox
                  name={n("state_code")}
                  value={regionCode}
                  onValueChange={setRegionCode}
                  // Passed to the CONTROL, not just to <Field>. The label drew a required
                  // asterisk while the posted input was a plain hidden one, which the HTML
                  // spec bars from constraint validation — so "State *" was submittable
                  // empty on the very form whose value decides GST. Pre-existing; the old
                  // SelectField was not given `required` here either.
                  required={regionRequired}
                  ariaLabel={regionLabel(country)}
                  placeholder={`Select a ${regionLabel(country).toLowerCase()}…`}
                  searchPlaceholder={`Search ${regionLabel(country).toLowerCase()} or code…`}
                  emptyMessage={
                    loadingSubs ? "Loading…" : `No matching ${regionLabel(country).toLowerCase()}.`
                  }
                  options={regionOptions}
                />
              </Field>
              {/* The picker sets both columns, so the two can no longer disagree. */}
              <input type="hidden" name={n("state")} value={regionName} />
              {subsFailed ? (
                /* The only way forward when the list never arrived and nothing is stored.
                   Falling back to free text here is what nulled `state_code`; letting the
                   operator type a code by hand is worse, because a wrong one resolves no
                   place of supply and taxes the line at zero without erroring. */
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0"
                  onClick={reloadSubs}
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : (
            /* This country genuinely has no subdivisions — the ONLY case that gets free
               text. `state_code` is cleared deliberately rather than omitted: the save
               replaces the address, so an absent field and an empty one mean the same
               thing to the API, and being explicit is what makes that reviewable. */
            <div className="space-y-1.5">
              <Field name={n("state")} label={regionLabel(country)}>
                <Input
                  name={n("state")}
                  value={stateText}
                  onChange={(e) => setStateText(e.target.value)}
                  maxLength={100}
                  autoComplete="billing address-level1"
                />
              </Field>
              <input type="hidden" name={n("state_code")} value="" />
            </div>
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {showPostal && st("postal_code") === "hide" ? (
            <input
              type="hidden"
              name={n("postal_code")}
              value={countryKept ? (a.postal_code ?? "") : ""}
            />
          ) : showPostal && st("postal_code") === "read_only" ? (
            readOnly("postal_code", postalLabel(country), a.postal_code ?? "", ["postal_code"])
          ) : showPostal ? (
            <Field
              name={n("postal_code")}
              label={postalLabel(country)}
              required={req("postal_code", requireRest)}
              error={postalError}
              help={hint ? `Format: ${hint}` : undefined}
            >
              <Input
                ref={postalRef}
                name={n("postal_code")}
                value={postal}
                onChange={(e) => setPostal(e.target.value)}
                maxLength={20}
                required={req("postal_code", requireRest)}
                autoComplete="billing postal-code"
              />
            </Field>
          ) : (
            // Hidden, not omitted: saving replaces the address, so leaving the field
            // out entirely would silently clear a stored value. This country has no
            // postal system, so the stored value must go — post empty deliberately.
            <input type="hidden" name={n("postal_code")} value="" />
          )}
        </div>
      </section>
    </div>
  );
}
