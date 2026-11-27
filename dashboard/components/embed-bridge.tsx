"use client";

/**
 * The storefront inside a business's own page (embedded checkout). Talks to the loader
 * (`/js/v1/embed.js`) in the parent window: messages go to the session's `embed_origin` only,
 * never "*", and carry ids, never amounts or personal data. Outside a frame this is inert.
 */
import * as React from "react";
import { observeSettledResize } from "@/lib/settled-resize";

export type EmbedEvent =
  | "loaded"
  | "resize"
  | "step"
  | "success"
  | "close"
  | "error"
  | "subscription_changed"
  | "payment_method_changed"
  | "invoice_paid";
type EmbedMode = "overlay" | "inline";

interface Embed {
  /** The website this page is framed by, or null when it is a hosted page. */
  origin: string | null;
  /** How the loader shows the frame; null until mounted (it reads the frame's name). */
  mode: EmbedMode | null;
  post: (type: EmbedEvent, detail?: Record<string, unknown>) => void;
}

const EmbedContext = React.createContext<Embed>({ origin: null, mode: null, post: () => {} });

export const useEmbed = () => React.useContext(EmbedContext);

/** The mounted bridge's post, for code outside React's tree of hooks (a confirmation handler). */
let notify: Embed["post"] | null = null;
/** Tell the page that framed us what changed. Does nothing on a hosted page. */
export const embedNotify: Embed["post"] = (type, detail) => notify?.(type, detail);

const noSubscribe = () => () => {};
const frameMode = (): EmbedMode | null =>
  window.name.endsWith("-inline") ? "inline" : window.name.endsWith("-overlay") ? "overlay" : null;

export function EmbedRoot({
  origin,
  children,
  error,
}: {
  origin: string;
  children?: React.ReactNode;
  /** Posted once on mount instead of `loaded` (the page could not open the session). */
  error?: "cookies_blocked";
}) {
  // The loader names the frame `tmb-checkout-overlay` or `tmb-checkout-inline`; null on the server.
  const mode = React.useSyncExternalStore(noSubscribe, frameMode, () => null);
  // Once per page load, even when React runs the effect twice (dev) or re-renders.
  const announced = React.useRef(false);
  const lastStep = React.useRef<unknown>(undefined);
  const post = React.useCallback(
    (type: EmbedEvent, detail?: Record<string, unknown>) => {
      if (window.parent === window) return;
      // Events say what changed: a step the page already reported is not sent again.
      if (type === "step") {
        if (detail?.step === lastStep.current) return;
        lastStep.current = detail?.step;
      }
      window.parent.postMessage(
        { source: "tmb-embed", type, ...(type === "error" ? detail : { detail }) },
        origin,
      );
    },
    [origin],
  );
  // A layout effect, so `loaded` goes out before any child's effect posts a `step`.
  React.useLayoutEffect(() => {
    if (announced.current) return;
    announced.current = true;
    post(error ? "error" : "loaded", error ? { code: error } : undefined);
  }, [post, error]);
  React.useEffect(() => {
    if (error) return;
    const main = document.querySelector("main");
    if (!main) return;
    const report = () => post("resize", { height: main.getBoundingClientRect().height });
    report();
    return observeSettledResize(main, report);
  }, [post, error]);
  React.useEffect(() => {
    if (mode !== "overlay") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") post("close", { reason: "user" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mode, post]);
  React.useEffect(() => {
    notify = post;
    return () => {
      if (notify === post) notify = null;
    };
  }, [post]);
  const value = React.useMemo(() => ({ origin, mode, post }), [origin, mode, post]);
  return (
    <EmbedContext.Provider value={value}>
      <div data-embed-root data-embed-mode={mode ?? undefined} className="contents">
        {children}
      </div>
    </EmbedContext.Provider>
  );
}
