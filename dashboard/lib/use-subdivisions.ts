"use client";

import * as React from "react";
import type { Subdivision } from "@/lib/api/geo";

/**
 * Subdivisions for a country, loaded in the browser.
 *
 * They cannot be server-rendered with the rest of the form: which list is needed
 * depends on a country the user picks after the page has loaded, and shipping all
 * 5042 of them up front to avoid the round trip would cost ~500KB to render one
 * dropdown. Shared by the address form and the tax place-of-supply picker so both
 * agree on the codes, the aliases and the local label for the field.
 *
 * ⚠️ A FAILED FETCH IS NOT AN EMPTY LIST, and conflating the two was a live bug
 * (docs/PROGRESS.md § Open bugs, 2026-08-22). Both callers used to degrade a failure to a
 * free-text region field — the same control a country with genuinely no subdivisions gets —
 * so on the failure path every save posted `state` with NO `state_code`, and because the
 * update REPLACES the address that set the column to null. For an Indian customer
 * `state_code` is what selects CGST+SGST over IGST, so the tax on the next invoice moved
 * with no user-visible cause. `failed` exists so a caller can hold the stored code and say
 * so, instead of silently discarding it. The API re-validates either way.
 */
export interface SubdivisionState {
  subs: Subdivision[];
  /** Non-canonical codes we accept, `{ alias: canonical }` — e.g. Indian state codes. */
  aliases: Record<string, string>;
  /** Local name for the field: "State", "Province", "Prefecture". */
  regionLabel: string;
  /** True when the API rejects a value outside the list. */
  strict: boolean;
  loading: boolean;
  /**
   * The request did not deliver a list. Distinct from `subs.length === 0`, which is the
   * honest answer for a country that has no subdivisions — see the warning above.
   */
  failed: boolean;
  /**
   * Refetch after a failure. The picker cannot fall back to free text on a failed load
   * (that was the bug), and it cannot let the operator invent a code that decides their
   * tax — so when there is no stored value to keep, retrying is the only way forward and
   * the form needs a control for it.
   */
  reload: () => void;
}

/** What the hook tracks internally — everything but the caller-facing `reload`. */
type SubdivisionData = Omit<SubdivisionState, "reload">;

const EMPTY: SubdivisionData = {
  subs: [],
  aliases: {},
  regionLabel: "State / Province",
  strict: false,
  loading: false,
  failed: false,
};

/**
 * Module-level so switching back to a country already seen does not refetch. Only ever
 * holds a SUCCESSFUL response — caching a failure would poison the country for the rest
 * of the session, which is the opposite of what `reload` is for.
 */
const cache = new Map<
  string,
  Pick<SubdivisionData, "subs" | "aliases" | "regionLabel" | "strict">
>();

export function useSubdivisions(country: string | null | undefined): SubdivisionState {
  const code = (country ?? "").trim().toUpperCase();
  // Bumped by `reload`; part of the effect's deps so a retry re-runs it for the same
  // country. A failure is never cached, so there is no cache entry to clear.
  const [attempt, setAttempt] = React.useState(0);
  const [state, setState] = React.useState<SubdivisionData>(() =>
    code && cache.has(code) ? { ...cache.get(code)!, loading: false, failed: false } : EMPTY,
  );

  React.useEffect(() => {
    if (!code) {
      setState(EMPTY);
      return;
    }
    const hit = cache.get(code);
    if (hit) {
      setState({ ...hit, loading: false, failed: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    fetch(`/api/geo/${code}/subdivisions`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (
          body: {
            data?: Subdivision[];
            aliases?: Record<string, string>;
            region_label?: string;
            subdivision_strict?: boolean;
          } | null,
        ) => {
          if (cancelled) return;
          // A non-ok response resolves to `null` above. That is a FAILURE, not "this country
          // has none" — it must not be cached, or one flaky request poisons the country for
          // the rest of the session.
          if (!body) {
            setState({ ...EMPTY, failed: true, loading: false });
            return;
          }
          const next = {
            subs: body.data ?? [],
            aliases: body.aliases ?? {},
            regionLabel: body.region_label ?? EMPTY.regionLabel,
            strict: body.subdivision_strict ?? false,
          };
          cache.set(code, next);
          setState({ ...next, loading: false, failed: false });
        },
      )
      .catch(() => {
        if (!cancelled) setState({ ...EMPTY, failed: true, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [code, attempt]);

  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
