"use client";

import * as React from "react";

/** The business's email link lifetime in days, published by the `[biz]` layout. */
const LinkDaysContext = React.createContext<number>(5);

export function LinkDaysProvider({ days, children }: { days: number; children: React.ReactNode }) {
  return <LinkDaysContext.Provider value={days}>{children}</LinkDaysContext.Provider>;
}

export const useEmailLinkDays = () => React.useContext(LinkDaysContext);
