"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { SendEmailDialog } from "@/components/emails/send-email-dialog";
import { ADHOC_TYPES_FOR } from "@/lib/email-types";
import { sendAdhocEmailAction } from "@/app/(dashboard)/businesses/[biz]/emails/actions";

/**
 * "Request update": emails the customer the payment-method request, which carries
 * their portal link. Operators never add a card — the cardholder does, in the portal.
 * Renders nothing for a customer with no email address: there is no one to ask.
 */
export function RequestUpdateButton({
  biz,
  customer,
  email,
  label = "Request update",
  variant = "outline",
}: {
  biz: string;
  customer: string;
  email: string | null | undefined;
  label?: string;
  variant?: "outline" | "link";
}) {
  if (!email) return null;
  return (
    <SendEmailDialog
      types={ADHOC_TYPES_FOR.customer}
      defaultTo={email}
      recordLabel="Ask the customer to change their payment method"
      onSend={({ type, to, note }) =>
        sendAdhocEmailAction(biz, { type, customer, to, note: note || undefined })
      }
      trigger={
        variant === "link" ? (
          <button type="button" className="text-sm text-primary hover:underline">
            {label}
          </button>
        ) : (
          <Button type="button" variant="outline" size="sm">
            {label}
          </Button>
        )
      }
    />
  );
}
