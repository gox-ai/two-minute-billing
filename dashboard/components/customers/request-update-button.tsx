"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { SendEmailDialog } from "@/components/emails/send-email-dialog";
import { ADHOC_TYPES_FOR } from "@/lib/email-types";
import { sendAdhocEmailAction } from "@/app/(dashboard)/businesses/[biz]/emails/actions";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { useEmailLinkDays } from "@/components/link-days-context";

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
  const businessDays = useEmailLinkDays();
  const [days, setDays] = React.useState(String(businessDays));
  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 14;
  if (!email) return null;
  return (
    <SendEmailDialog
      onOpenChange={(open) => open && setDays(String(businessDays))}
      extraValid={daysOk}
      extra={
        <Field
          name="request-update-link-days"
          label="Days the link works"
          help="From 1 to 14 days."
          error={daysOk ? undefined : "Enter a number of days from 1 to 14."}
        >
          <Input
            type="number"
            min={1}
            max={14}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className="w-20 tabular-nums"
          />
        </Field>
      }
      types={ADHOC_TYPES_FOR.customer}
      defaultTo={email}
      recordLabel="Ask the customer to change their payment method"
      onSend={({ type, to, note }) =>
        sendAdhocEmailAction(biz, {
          type,
          customer,
          to,
          note: note || undefined,
          link_valid_days: n,
        })
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
