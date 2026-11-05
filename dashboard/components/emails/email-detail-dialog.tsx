"use client";

import { SafeHtml } from "@/components/safe-html";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Chip } from "@/components/patterns/chip";
import { EditDrawer } from "@/components/edit-drawer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/format";
import { type EmailTransport, isRealDelivery, transportLabel } from "@/lib/email-types";
import type { EmailMessage } from "@/lib/api/emails";
import { resendEmailAction } from "@/app/(dashboard)/businesses/[biz]/emails/actions";
import { useBusinessTz } from "@/components/business-tz";

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="col-span-2 break-all">{children}</dd>
    </div>
  );
}

/**
 * `sent` reads green only when a real relay carried it. The console dev sink accepts a
 * message, logs it, and the outbox marks the row sent — so a green SENT chip on a
 * console row is the log vouching for mail that never left the building. Neutral instead,
 * with the Transport column saying why.
 */
export function emailStatusTone(
  status: string,
  transport: EmailTransport,
): "green" | "tan" | "red" | "gray" {
  if (status === "sent") return isRealDelivery(status, transport) ? "green" : "gray";
  // `bounced` reads red like `failed` — both mean the customer got nothing — but stays a
  // separate STATUS, because the action differs: a bounce means fix the address, a failure
  // means check the relay. Same tone, different word.
  if (status === "failed" || status === "bounced") return "red";
  if (status === "skipped") return "gray";
  return "tan"; // pending
}

/**
 * One billing email: delivery facts, the rendered body, and Resend. Shared by the Emails
 * log and the customer/subscription History tab. Callers must be `ops`-gated pages —
 * `resendEmailAction` requires it.
 */
export function EmailDetailDialog({
  biz,
  email,
  onClose,
}: {
  biz: string;
  email: EmailMessage | null;
  onClose: () => void;
}) {
  const tz = useBusinessTz();
  const router = useRouter();
  const [resending, setResending] = React.useState(false);

  async function onResend() {
    if (!email) return;
    setResending(true);
    try {
      await resendEmailAction(biz, email.id);
      onClose();
      // The action revalidates the Emails log only; a History tab needs its own refresh.
      router.refresh();
    } finally {
      setResending(false);
    }
  }

  return (
    <EditDrawer
      open={!!email}
      onOpenChange={(o) => !o && onClose()}
      title={email?.subject ?? "Email"}
    >
      {email && (
        <div className="space-y-4">
          <dl>
            <DetailRow label="Type">{email.type}</DetailRow>
            <DetailRow label="To">{email.to}</DetailRow>
            {email.cc?.length ? (
              <DetailRow label="Cc (contacts)">{email.cc.join(", ")}</DetailRow>
            ) : null}
            <DetailRow label="Status">
              <Chip
                tone={emailStatusTone(email.status, email.transport)}
                className="text-xs uppercase"
              >
                {email.status}
              </Chip>
            </DetailRow>
            <DetailRow label="Transport">{transportLabel(email.transport)}</DetailRow>
            {/* Feedback that arrived AFTER the send, over SNS: `transient` is a full mailbox
                and the address is fine, `permanent` means the customer record needs fixing. */}
            {email.bounce_type && (
              <DetailRow label="Provider feedback">
                <span className={email.bounce_type === "transient" ? "" : "text-destructive"}>
                  {email.bounce_type === "permanent"
                    ? "Permanent. The address does not accept email."
                    : email.bounce_type === "transient"
                      ? "Temporary, for example a full mailbox. The address is still valid."
                      : email.bounce_type === "complaint"
                        ? "The recipient marked it as spam"
                        : "Unknown"}
                </span>
              </DetailRow>
            )}
            <DetailRow label="Attempts">{email.attempts}</DetailRow>
            {email.last_error && (
              <DetailRow label="Last error">
                <span className="text-destructive">{email.last_error}</span>
              </DetailRow>
            )}
            <DetailRow label="Created">{fmtDateTime(email.created_at, tz)}</DetailRow>
            {email.sent_at && <DetailRow label="Sent">{fmtDateTime(email.sent_at, tz)}</DetailRow>}
          </dl>
          {email.body_removed_at ? (
            // The retention sweep deleted the body: no preview, and nothing left to resend.
            <Alert>
              We deleted the content of this email on {fmtDateTime(email.body_removed_at, tz)},
              after the retention period. You cannot send it again.
            </Alert>
          ) : (
            <>
              <div className="rounded-md border p-3">
                <div className="mb-2 text-xs font-medium text-muted-foreground">
                  Rendered preview
                </div>
                {/* An email is a light document with its own colours: show it as the inbox does,
                    on white in both themes. */}
                <SafeHtml
                  className="force-light prose prose-sm max-w-none rounded-md bg-card p-4 text-foreground"
                  html={email.body_html}
                />
              </div>
              <Button onClick={onResend} disabled={resending}>
                {resending ? "Re-queuing…" : "Resend"}
              </Button>
            </>
          )}
        </div>
      )}
    </EditDrawer>
  );
}
