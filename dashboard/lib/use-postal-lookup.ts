"use client";

import * as React from "react";
import type { PostalLookup } from "@/lib/api/geo";

/**
 * City and state for a postal code, from our own API (`/api/geo/<country>/postal/<code>`).
 * Debounced, cached per code, and silent on any failure: no result means no autofill.
 * Pass `enabled: false` until the code is complete and valid for its country.
 */
const cache = new Map<string, PostalLookup>();

export function usePostalLookup(
  country: string | null | undefined,
  postal: string,
  enabled: boolean,
): PostalLookup | null {
  const code = (country ?? "").trim().toUpperCase();
  const key = `${code}|${postal.replace(/[\s-]/g, "").toUpperCase()}`;
  const [hit, setHit] = React.useState<{ key: string; value: PostalLookup | null } | null>(null);

  React.useEffect(() => {
    if (!enabled || !code || !postal.trim()) return;
    const cached = cache.get(key);
    if (cached) {
      setHit({ key, value: cached });
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/geo/${code}/postal/${encodeURIComponent(postal.trim())}`)
        .then((r) => (r.ok ? (r.json() as Promise<PostalLookup>) : null))
        .catch(() => null)
        .then((value) => {
          // A miss is not cached: the data may be loaded later.
          if (value) cache.set(key, value);
          if (!cancelled) setHit({ key, value });
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [code, postal, key, enabled]);

  return enabled && hit?.key === key ? hit.value : null;
}
