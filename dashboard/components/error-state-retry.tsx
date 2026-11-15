"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

/** "Try again" for a server-rendered error panel: re-runs the route's fetches in place. */
export function RetryButton() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => start(() => router.refresh())}
    >
      Try again
    </Button>
  );
}
