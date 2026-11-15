"use client";

import * as React from "react";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { decideConnectionAction } from "@/app/(dashboard)/oauth/actions";
import type { ActionResult } from "@/lib/action-result";

/** Approve (with a business) or deny; either way the browser returns to the application. */
export function ConsentForm({
  requestId,
  businesses,
}: {
  requestId: string;
  businesses: Array<{ id: string; name: string; livemode: "test" | "live" }>;
}) {
  const back = (r: ActionResult) => {
    if (r.redirectTo) window.location.assign(r.redirectTo);
  };
  const denyRef = React.useRef<HTMLFormElement>(null);
  // Preselect only when there is one real answer; otherwise the member selects.
  const only = businesses.length === 1 ? businesses[0]!.id : undefined;
  return (
    <div className="flex flex-col gap-4">
      <ActionForm action={decideConnectionAction} onSuccess={back} className="flex flex-col gap-4">
        <input type="hidden" name="request" value={requestId} />
        <input type="hidden" name="decision" value="approve" />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id="business-label">
            Business
          </span>
          <SelectField
            name="business"
            ariaLabel="Business"
            aria-describedby="business-help"
            required
            defaultValue={only}
            placeholder="Select a business"
            options={businesses.map((b) => ({
              value: b.id,
              label: `${b.name} (${b.livemode === "live" ? "Live" : "Test"})`,
            }))}
          />
          <span id="business-help" className="text-xs text-muted-foreground">
            The application reads this business only, in its mode.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <SubmitButton>Connect</SubmitButton>
          <Button type="button" variant="outline" onClick={() => denyRef.current?.requestSubmit()}>
            Deny
          </Button>
        </div>
      </ActionForm>
      <ActionForm
        action={decideConnectionAction}
        onSuccess={back}
        formRef={denyRef}
        className="hidden"
      >
        <input type="hidden" name="request" value={requestId} />
        <input type="hidden" name="decision" value="deny" />
      </ActionForm>
    </div>
  );
}
