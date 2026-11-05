"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/states";

/**
 * The dashboard's error boundary. There were NONE in this app, so any throw from a server
 * component landed on Next's own error page.
 *
 * It exists mainly for `SessionUnavailableError`: `requireUser()` used to read an unreachable
 * engine as "not signed in" and redirect to `/login`, which signed operators out of valid
 * sessions during exactly the incidents they were trying to diagnose. Now it throws, and this
 * says so — with the session intact and a retry that re-runs the render rather than a login
 * form that discards it.
 *
 * ⚠ This does NOT catch a throw from `(dashboard)/layout.tsx`: an error boundary wraps its
 * segment's CHILDREN, and each route group here owns its own `<html>`, so there is no root
 * layout above to host one. The layout handles its own lookup inline for that reason.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const sessionBlip = error.name === "SessionUnavailableError";
  return (
    <div className="mx-auto max-w-xl py-16">
      <ErrorState
        title={sessionBlip ? "We could not connect to the billing API" : "Something went wrong"}
        description={
          <>
            {sessionBlip ? (
              <>
                You are still signed in. This page could not confirm your session. Try again. If
                that does not work, the API is not available.
              </>
            ) : (
              <>We could not show this page. It is safe to try again.</>
            )}
            {error.digest ? (
              <>
                <br />
                <span className="font-mono text-xs">ref {error.digest}</span>
              </>
            ) : null}
          </>
        }
      />
      <div className="mt-4 flex justify-center">
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
