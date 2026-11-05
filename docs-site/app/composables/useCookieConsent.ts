declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}

/** The cookie bar's state, shared by the bar and the footer's "Cookie settings" link. */
export function useCookieConsent() {
  const enabled = Boolean(useRuntimeConfig().public.gaId);
  const open = useState("cookie-bar-open", () => false);

  /**
   * Opens the bar on a first visit from a country that needs consent (see /api/region; an
   * unknown country asks). Storage can throw (private window, blocked site data).
   */
  async function init() {
    if (!enabled) return;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(COOKIE_CONSENT_KEY);
    } catch {}
    if (saved === "granted" || saved === "denied") return;
    const region = await $fetch<{ consent_required: boolean }>("/api/region").catch(() => null);
    open.value = region?.consent_required ?? true;
  }

  function choose(choice: CookieChoice) {
    try {
      localStorage.setItem(COOKIE_CONSENT_KEY, choice);
    } catch {}
    window.gtag?.("consent", "update", { analytics_storage: choice });
    shareConsent(choice);
    open.value = false;
  }

  return { enabled, open, init, choose, show: () => (open.value = true) };
}
