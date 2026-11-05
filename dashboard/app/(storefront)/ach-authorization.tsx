"use client";

import * as React from "react";
import { CheckboxField } from "@/components/ui/checkbox";
import type { AchAuthorizationText } from "@/lib/checkout-api";

/**
 * The payer's bank debit authorization, shown before a bank account is saved on a gateway
 * that leaves it to the merchant (Authorize.net eCheck). One component for the checkout and
 * the portal. The words come from the engine, which stores the same version with the method.
 * NACHA wants it on the page that collects the account, so it sits above the save button.
 */
export function AchAuthorization({
  text,
  accepted,
  onAcceptedChange,
}: {
  text: AchAuthorizationText;
  accepted: boolean;
  onAcceptedChange: (accepted: boolean) => void;
}) {
  return (
    <section
      aria-label={text.title}
      className="flex flex-col gap-3 rounded-md border bg-card px-3.5 py-3"
    >
      <h3 className="text-sm font-medium">{text.title}</h3>
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto text-sm text-muted-foreground">
        {text.paragraphs.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      <CheckboxField label={text.agreement} checked={accepted} onCheckedChange={onAcceptedChange} />
    </section>
  );
}
