"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshButton } from "@/components/refresh-button";

/** Refresh for a server-rendered record page: re-runs the route's fetches in place. */
export function PageRefresh() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <RefreshButton
      variant="outline"
      pending={pending}
      onRefresh={() => start(() => router.refresh())}
    />
  );
}
