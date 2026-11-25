"use client";

import * as React from "react";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import type { NewLinkResult } from "./actions";

/** "Email me a new link" on an expired link's card. One press; the answer replaces the button. */
export function NewLinkButton({ request }: { request: () => Promise<NewLinkResult> }) {
  const [pending, start] = React.useTransition();
  const [result, setResult] = React.useState<NewLinkResult | null>(null);
  if (result?.ok)
    return (
      <Alert tone="success" className="mt-4">
        {result.message}
      </Alert>
    );
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Button
        type="button"
        className="w-full"
        disabled={pending}
        onClick={() => start(async () => setResult(await request()))}
      >
        <Mail aria-hidden />
        {pending ? "Sending…" : "Email me a new link"}
      </Button>
      {result && !result.ok ? <Alert tone="error">{result.message}</Alert> : null}
    </div>
  );
}
