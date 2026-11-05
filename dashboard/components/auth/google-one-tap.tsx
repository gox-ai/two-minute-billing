"use client";

import { useEffect } from "react";
import { LANDING_PATH, safeRedirectTo } from "@/lib/redirect-to";

/**
 * Google One Tap on the sign-in screen.
 *
 * Renders NOTHING of our own. The card is Google's — under FedCM it is drawn by the
 * browser itself, outside our document — so there is no surface here for the design
 * system to own, and inventing a status line beside it would be a control that reports
 * on something we do not control. Failures land on the login page's existing `Alert`
 * via `?error=`, which is where every other sign-in failure already appears.
 *
 * Nothing signs anyone in on its own: `auto_select` is false, so the card appears and
 * the operator has to press Continue. That is deliberate — a session that materialises
 * from a page load is one nobody chose, and an operator who keeps a personal Google
 * account signed in would find themselves in the wrong one without touching anything.
 *
 * The credential goes to `/auth/google/one-tap` on THIS origin, never to the API
 * directly: the nonce it is checked against lives in an HttpOnly cookie here, and the
 * session token that comes back must become a cookie here too.
 */

const GSI_SRC = "https://accounts.google.com/gsi/client";

/**
 * Suppresses re-prompting after a refusal, for this tab only.
 *
 * Without it a rejected credential is a loop: we redirect to `/login?error=…`, the page
 * remounts this component, it prompts again, and the operator cannot read the message
 * they were just given. `sessionStorage` and not a cookie — it is a UI detail with no
 * security meaning, and it should die with the tab.
 */
const HALTED = "tmb_one_tap_halted";

interface CredentialResponse {
  credential?: string;
}

interface GsiClient {
  accounts: {
    id: {
      initialize: (config: Record<string, unknown>) => void;
      prompt: () => void;
      cancel: () => void;
    };
  };
}

export function GoogleOneTap({ clientId, redirectTo }: { clientId: string; redirectTo?: string }) {
  useEffect(() => {
    let cancelled = false;
    try {
      if (sessionStorage.getItem(HALTED)) return;
    } catch {
      // Private mode, or storage blocked. Prompting is still correct; only the
      // loop-guard is lost, and the guard is a convenience.
    }

    async function onCredential(res: CredentialResponse) {
      if (!res.credential) return;
      let message: string | null = null;
      let mfa = false;
      let signup = false;
      try {
        const r = await fetch("/auth/google/one-tap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: res.credential }),
        });
        if (r.ok) {
          const j = (await r.json().catch(() => null)) as {
            mfa?: boolean;
            signup?: boolean;
          } | null;
          mfa = j?.mfa === true;
          signup = j?.signup === true;
        } else {
          message =
            ((await r.json().catch(() => null)) as { error?: string } | null)?.error ??
            "We could not complete the Google sign-in. Try again.";
        }
      } catch {
        message = "We could not complete the Google sign-in. Try again.";
      }
      if (message) {
        try {
          sessionStorage.setItem(HALTED, "1");
        } catch {
          /* see above */
        }
        window.location.assign("/login?error=" + encodeURIComponent(message));
        return;
      }
      // No account yet: the Google identity is parked for the sign-up form.
      if (signup) {
        window.location.assign("/signup");
        return;
      }
      // 2FA is on: the challenge is parked in a cookie, so finish at the code step.
      if (mfa) {
        const q = new URLSearchParams({ mfa: "1" });
        const next = safeRedirectTo(redirectTo);
        if (next) q.set("redirectTo", next);
        window.location.assign(`/login?${q.toString()}`);
        return;
      }
      /*
       * A full navigation, not `router.push`. The session arrived as a `Set-Cookie` on a
       * fetch this page made, so every RSC payload the client router already holds was
       * rendered for a signed-OUT visitor. Only a document request re-runs the layout
       * that reads the cookie.
       */
      // Checked here too: this component must not trust its caller to have done it.
      window.location.assign(safeRedirectTo(redirectTo) ?? LANDING_PATH);
    }

    async function start() {
      // The nonce first: it has to reach Google WITH the request, so a card shown before
      // the cookie exists would produce a token we are bound to refuse.
      let nonce: string;
      try {
        const r = await fetch("/auth/google/one-tap", { cache: "no-store" });
        if (!r.ok) return;
        nonce = ((await r.json()) as { nonce: string }).nonce;
      } catch {
        return;
      }
      if (cancelled) return;

      await loadGsi();
      const gsi = (window as unknown as { google?: GsiClient }).google;
      if (cancelled || !gsi) return;

      gsi.accounts.id.initialize({
        client_id: clientId,
        callback: onCredential,
        nonce,
        // The operator presses Continue. See the header.
        auto_select: false,
        // A click elsewhere on the page must not dismiss the card — the sign-in form is
        // directly behind it, so the first click of a password is otherwise also the
        // click that throws the card away.
        cancel_on_tap_outside: false,
        // Required by current Chrome: the non-FedCM One Tap iframe is gone, and without
        // this the prompt silently never appears.
        use_fedcm_for_prompt: true,
        // Safari/ITP: lets GIS fall back to a first-party path for its own state.
        itp_support: true,
        context: "signin",
      });
      gsi.accounts.id.prompt();
    }

    void start();
    return () => {
      cancelled = true;
      (window as unknown as { google?: GsiClient }).google?.accounts.id.cancel();
    };
  }, [clientId, redirectTo]);

  return null;
}

/** Load GIS once per document, and resolve for every caller that asked meanwhile. */
function loadGsi(): Promise<void> {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
  if (existing) {
    return existing.dataset.loaded
      ? Promise.resolve()
      : new Promise((resolve) =>
          existing.addEventListener("load", () => resolve(), { once: true }),
        );
  }
  return new Promise((resolve) => {
    const el = document.createElement("script");
    el.src = GSI_SRC;
    el.async = true;
    el.addEventListener(
      "load",
      () => {
        el.dataset.loaded = "1";
        resolve();
      },
      { once: true },
    );
    // A blocked or failed script resolves too: the caller's `!gsi` check turns that into
    // "no One Tap", which is the correct outcome, rather than a promise nobody settles.
    el.addEventListener("error", () => resolve(), { once: true });
    document.head.append(el);
  });
}
