"use client";

// Shared client state for the subscription detail page's volatile strip (status, current
// term/next billing, next billing amount, scheduled changes, dunning/dues). One provider
// wraps the page's existing JSX unchanged (no DOM output of its own); a few small consumer
// components read it at the exact spots that used to read static `sub.*` values.
//
// One `refresh()` = one call to refreshSubscriptionVolatileAction, under useTransition —
// never router.refresh(), which would re-run the whole detail tree (invoices, transactions,
// entitlements, events…) for a status poll.

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import {
  refreshSubscriptionVolatileAction,
  type SubscriptionVolatileState,
} from "@/app/(dashboard)/businesses/[biz]/subscriptions/[sub]/refresh-action";

interface RefreshCtx {
  state: SubscriptionVolatileState;
  pending: boolean;
  error: string | null;
  refresh: () => void;
}

const Ctx = React.createContext<RefreshCtx | null>(null);

export function SubscriptionRefreshProvider({
  biz,
  subId,
  initial,
  children,
}: {
  biz: string;
  subId: string;
  initial: SubscriptionVolatileState;
  children: React.ReactNode;
}) {
  // Re-seeds when the server re-renders with new data (an action's refresh); a bare
  // useState kept the pre-action copy, so a cancelled subscription still read Active.
  const [state, setState] = useDefaultState(initial, (v) => JSON.stringify(v));
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const refresh = React.useCallback(() => {
    startTransition(async () => {
      const res = await refreshSubscriptionVolatileAction(biz, subId);
      if (res.ok) {
        setState(res.state);
        setError(null);
      } else {
        setError(res.error);
      }
    });
  }, [biz, subId, setState]);

  const value = React.useMemo(
    () => ({ state, pending, error, refresh }),
    [state, pending, error, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The same context, or null outside the provider. */
export function useOptionalSubscriptionRefresh(): RefreshCtx | null {
  return React.useContext(Ctx);
}

export function useSubscriptionRefresh(): RefreshCtx {
  const ctx = React.useContext(Ctx);
  if (!ctx)
    throw new Error("useSubscriptionRefresh must be used within SubscriptionRefreshProvider");
  return ctx;
}
