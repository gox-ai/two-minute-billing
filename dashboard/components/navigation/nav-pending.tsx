"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

/**
 * Loading feedback for a page whose controls rewrite its own URL (period, currency, tab, filters).
 *
 * A navigation to the SAME route with new search params never shows `loading.tsx`: React keeps
 * the old screen until the new one is ready, so the figures sit there stale with no sign that
 * anything is happening. Controls navigate through `navigate` instead, inside one transition the
 * provider owns, and `PendingContent` swaps the body for a skeleton while it runs. The header and
 * its controls stay put, so the choice just made stays visible.
 *
 * `target` names the view being loaded (a tab id), so the skeleton has the destination's shape
 * rather than the current one's.
 */

type NavOpts = {
  /** The view being loaded, for a skeleton of its shape. */
  target?: string;
  /** Which control started it, so only that one shows a spinner. */
  source?: string;
  scroll?: boolean;
};

type NavPending = {
  pending: boolean;
  target: string | null;
  source: string | null;
  navigate: (href: string, opts?: NavOpts) => void;
  /** Pending, and started by this control. */
  pendingFrom: (source: string) => boolean;
};

const Ctx = React.createContext<NavPending | null>(null);

export function NavPendingProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [target, setTarget] = React.useState<string | null>(null);
  const [source, setSource] = React.useState<string | null>(null);
  const navigate = React.useCallback<NavPending["navigate"]>(
    (href, opts) => {
      setTarget(opts?.target ?? null);
      setSource(opts?.source ?? null);
      start(() => router.push(href, { scroll: opts?.scroll ?? false }));
    },
    [router],
  );
  const value = React.useMemo(
    () => ({
      pending,
      target,
      source,
      navigate,
      pendingFrom: (s: string) => pending && source === s,
    }),
    [pending, target, source, navigate],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * The provider's navigate, or a plain transition when a control is rendered outside one — the
 * control still works, it just has no page-level skeleton to drive.
 */
export function useNavPending(): NavPending {
  const ctx = React.useContext(Ctx);
  const router = useRouter();
  const [pending, start] = React.useTransition();
  if (ctx) return ctx;
  return {
    pending,
    target: null,
    source: null,
    navigate: (href, opts) => start(() => router.push(href, { scroll: opts?.scroll ?? false })),
    pendingFrom: () => pending,
  };
}

/**
 * The page body, or its skeleton while a navigation is pending.
 *
 * `skeleton` is one node, or one per view keyed by the `target` a control passes; `current` is the
 * view on screen, used when a control (the period picker) reloads the same view.
 */
export function PendingContent({
  skeleton,
  current,
  keepFor,
  children,
}: {
  skeleton: React.ReactNode | Record<string, React.ReactNode>;
  current?: string;
  /** Sources whose navigation cannot change this block (a period for a point-in-time zone). */
  keepFor?: string[];
  children: React.ReactNode;
}) {
  const ctx = React.useContext(Ctx);
  if (!ctx?.pending) return <>{children}</>;
  // A same-view reload started by one of these leaves the block standing.
  if (!ctx.target && ctx.source && keepFor?.includes(ctx.source)) return <>{children}</>;
  if (skeleton && typeof skeleton === "object" && !React.isValidElement(skeleton)) {
    const byView = skeleton as Record<string, React.ReactNode>;
    const view = ctx.target ?? current;
    return <>{(view && byView[view]) ?? Object.values(byView)[0]}</>;
  }
  return <>{skeleton}</>;
}
