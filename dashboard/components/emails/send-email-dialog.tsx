"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field } from "@/components/form/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/ui/select-field";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";

/**
 * Operator-initiated billing email — the per-record `Email` action, as a modal.
 *
 * TYPE-ONLY import, and it must stay that way. `@/lib/api/emails` is a server module (its
 * fetchers reach `next/headers` for the session cookie); a value import from a 'use client'
 * file pulls that chain into the browser bundle and the route 500s with an empty body —
 * already hit once on this branch. The actual send therefore arrives as the `onSend` prop,
 * a server action the page supplies, exactly as TemplateEditor takes its save/reset actions.
 */
import { type AdhocEmailType } from "@/lib/api/emails";
// Client-safe, and the single source of these names — its whole purpose is stopping two
// screens from calling the same email different things. Settings → Email notifications
// already lists these four under "Sent by you"; a local label map here would drift from it.
import { EMAIL_TYPES, emailTypeLabel } from "@/lib/email-types";

/** What the send returned. Mirrors AdhocEmailResult in lib/api/emails.ts. */
export interface SendEmailResult {
  ok: boolean;
  error?: string | null;
  /** `console` means the dev sink accepted the message and delivered nothing. */
  transport?: string | null;
}

const describe = (key: string) => EMAIL_TYPES.find((t) => t.key === key)?.description ?? "";

// `ADHOC_TYPES_FOR` (which types each record supports) deliberately does NOT live here: the
// pages that pass it are server components, and a value exported from a 'use client' module
// reaches them as a client reference rather than the array. It is in lib/email-types.ts.

export interface SendEmailDialogProps {
  /** Types to offer. Use ADHOC_TYPES_FOR[record] unless you have a reason not to. */
  types: AdhocEmailType[];
  /** Pre-selected type. Defaults to the first offered. */
  defaultType?: AdhocEmailType;
  /**
   * Pre-filled recipient — the customer's billing email. Editable, because mailing an
   * invoice to a buyer's accounts inbox is the common case; changing it here does not
   * rewrite what is stored on the customer.
   */
  defaultTo: string;
  /** What is being emailed, e.g. "Invoice INV-42". Shown so the operator can see they picked the right row. */
  recordLabel?: string;
  /** Server action that performs the send. Receives the chosen type, recipient and note. */
  onSend: (input: { type: AdhocEmailType; to: string; note: string }) => Promise<SendEmailResult>;
  /** Renders a trigger and manages its own open state. Omit and pass `open`/`onOpenChange` to drive it from a menu. */
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function SendEmailDialog({
  types,
  defaultType,
  defaultTo,
  recordLabel,
  onSend,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: SendEmailDialogProps) {
  const [internalOpen, setInternalOpen] = React.useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };

  const first = defaultType ?? types[0] ?? "invoice_sent";
  const [type, setType] = React.useState<AdhocEmailType>(first);
  const [to, setTo] = React.useState(defaultTo);
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sent, setSent] = React.useState<SendEmailResult | null>(null);

  // Reopening must not show the previous send's outcome, or an operator reads a stale
  // "sent" for a message this visit never sent.
  React.useEffect(() => {
    if (!open) return;
    setType(first);
    setTo(defaultTo);
    setNote("");
    setError(null);
    setSent(null);
  }, [open, first, defaultTo]);

  async function handleSend() {
    setPending(true);
    setError(null);
    try {
      const result = await onSend({ type, to: to.trim(), note: note.trim() });
      if (result.ok) setSent(result);
      else setError(result.error || "We could not send the email. The relay gave no reason.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }

  const canSend = !!to.trim() && !pending;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Send email</DialogTitle>
          <DialogDescription>
            {recordLabel
              ? `Sends now, from this business's configured sender, about ${recordLabel}.`
              : "Sends now, from this business's configured sender."}
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <>
            {/* `ok` alone is not a delivery claim: the console sink accepts a message,
                logs it, and delivers nothing. Saying so is the difference between an
                operator believing the customer was emailed and knowing they were not. */}
            <Alert tone={sent.transport === "console" ? "warning" : "success"}>
              {sent.transport === "console"
                ? "Recorded in the email log. But this business has no email relay configured, so we did not deliver the email. Configure SMTP in email settings."
                : `Sent to ${to.trim()}.`}
            </Alert>
            <DialogFooter>
              <Button onClick={() => setOpen(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="space-y-5">
              {error ? <Alert tone="error">{error}</Alert> : null}

              {/* One option is not a choice. A disabled select implies alternatives exist,
                  so a single-type record gets a read-only field instead (ui skill §7). */}
              {types.length > 1 ? (
                <Field name="email-type" label="Email" help={describe(type)}>
                  <SelectField
                    value={type}
                    onValueChange={(v) => setType(v as AdhocEmailType)}
                    ariaLabel="Email"
                    options={types.map((t) => ({ value: t, label: emailTypeLabel(t) }))}
                  />
                </Field>
              ) : (
                <Field name="email-type" label="Email" help={describe(type)}>
                  <Input value={emailTypeLabel(type)} readOnly className="text-muted-foreground" />
                </Field>
              )}

              <Field
                name="email-to"
                label="To"
                required
                help="The default is the billing email of the customer. Their contacts marked for billing or account emails also get a copy. If you send it to a different address, only that address gets it. A change here does not change the customer."
              >
                <Input
                  type="email"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  maxLength={320}
                  placeholder="name@example.com"
                  required
                />
              </Field>

              <Field
                name="email-note"
                label="Note"
                help="Optional. Appears above the email's standard text."
              >
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="Add a covering message…"
                />
              </Field>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={handleSend} disabled={!canSend}>
                {pending ? "Sending…" : "Send"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
