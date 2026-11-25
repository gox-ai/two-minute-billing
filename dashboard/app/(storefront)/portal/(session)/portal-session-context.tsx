"use client";

import * as React from "react";

/**
 * The portal session this page shows (`?s=psess_…`). Every server action takes it, so a tab
 * keeps acting on its own account after another portal link opens in the same browser.
 */
const PortalSessionContext = React.createContext("");

export function PortalSessionProvider({
  session,
  children,
}: {
  session: string;
  children: React.ReactNode;
}) {
  return <PortalSessionContext.Provider value={session}>{children}</PortalSessionContext.Provider>;
}

export const usePortalSession = () => React.useContext(PortalSessionContext);
