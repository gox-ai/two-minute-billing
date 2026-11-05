/**
 * `cta_click` for every link to sign-up, sign-in, pricing or contact, from one listener so no
 * button is missed. `location` comes from the nearest `data-cta-location`, else the header,
 * footer or hero the link sits in.
 */
export default defineNuxtPlugin(() => {
  if (!useRuntimeConfig().public.gaId) return;
  const { signIn, signUp } = useAppLinks();

  const kindOf = (url: URL): string | undefined => {
    const href = url.href.split(/[?#]/)[0];
    if (href === signUp) return "sign_up";
    if (href === signIn) return "sign_in";
    if (url.origin !== location.origin) return undefined;
    if (url.pathname === "/pricing") return "pricing";
    if (url.pathname === "/contact") return "contact";
    return undefined;
  };

  const locationOf = (el: Element): string => {
    const tagged = el.closest<HTMLElement>("[data-cta-location]");
    if (tagged) return tagged.dataset.ctaLocation!;
    if (el.closest("header")) return "header";
    if (el.closest("footer")) return "footer";
    if (el.closest(".mk-hero, .hp-hero")) return "hero";
    return "body";
  };

  document.addEventListener(
    "click",
    (e) => {
      const a = (e.target as Element | null)?.closest?.<HTMLAnchorElement>("a[href]");
      if (!a) return;
      const kind = kindOf(new URL(a.href, location.href));
      if (!kind) return;
      track("cta_click", {
        cta: kind,
        label: a.textContent?.trim().slice(0, 60),
        location: locationOf(a),
        link_url: a.href,
      });
    },
    { capture: true },
  );
});
