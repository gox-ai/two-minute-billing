"use client";

import * as React from "react";
import { ImageIcon, LifeBuoy, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  openSupport,
  type AttachmentRef,
  type SupportDraft,
} from "@/lib/assistant";
import { useDefaultState } from "@/lib/use-default-state";
import { fmtSize, readBase64 } from "./composer";

/**
 * A support request Billy drafted. Nothing is sent until the member selects "Send to support".
 * The member can change the subject and the text, remove any attached item and attach a
 * screenshot. The server builds the request from the stored draft, less what was removed.
 */
export function SupportCard({
  draft,
  biz,
  conversation,
  onSent,
}: {
  draft: SupportDraft;
  biz: string;
  conversation: string | null;
  onSent: (sent: NonNullable<SupportDraft["sent"]>) => void;
}) {
  const [subject, setSubject] = useDefaultState(draft.subject);
  const [description, setDescription] = useDefaultState(draft.description);
  const [removed, setRemoved] = React.useState<string[]>([]);
  const [shots, setShots] = React.useState<AttachmentRef[]>([]);
  const [editing, setEditing] = React.useState(false);
  const [cancelled, setCancelled] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // One key per card: a second select of Send repeats the same request, never a new one.
  const [idemKey] = React.useState(() => `sr-${draft.id}-${crypto.randomUUID()}`);
  const fileRef = React.useRef<HTMLInputElement>(null);

  if (draft.sent) {
    return (
      <div className="flex flex-col gap-1.5 rounded-md border bg-card p-3 text-sm">
        <p className="m-0 font-medium">
          Request {draft.sent.reference} sent. We reply here and by email.
        </p>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => openSupport(draft.sent!.id)}
          >
            View request
          </Button>
        </div>
      </div>
    );
  }
  if (cancelled) {
    return (
      <p className="m-0 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        You did not send this request.
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => setCancelled(false)}
        >
          Show it again
        </button>
      </p>
    );
  }

  const items = draft.items.filter((i) => !removed.includes(i.key));

  const attach = async (file: File) => {
    setError(null);
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(file.type))
      return setError(
        "We could not attach this file. Only PNG, JPEG and WebP images can be attached.",
      );
    if (file.size > ATTACHMENT_MAX_BYTES)
      return setError(
        "We could not attach this file. It is larger than 10 MB. Attach a smaller image.",
      );
    setUploading(true);
    try {
      const res = await fetch("/api/assistant/attachments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          business: biz,
          name: file.name,
          content_type: file.type,
          data_base64: await readBase64(file),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Partial<AttachmentRef> & {
        error?: { message?: string };
      };
      if (!res.ok || !body.id)
        return setError(body.error?.message ?? "We could not attach this file. Try again.");
      setShots((s) => [
        ...s,
        {
          id: body.id!,
          name: body.name ?? file.name,
          size: body.size ?? file.size,
          content_type: body.content_type ?? file.type,
        },
      ]);
    } catch {
      setError("We could not attach this file. Check your connection and try again.");
    } finally {
      setUploading(false);
    }
  };

  const send = async () => {
    if (!conversation) return;
    if (!subject.trim() || !description.trim()) {
      setEditing(true);
      return setError("Write a subject and what happened.");
    }
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/assistant/support/requests", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idemKey },
        body: JSON.stringify({
          business: biz,
          conversation,
          draft: draft.id,
          subject,
          description,
          remove: removed,
          attachments: shots.map((s) => s.id),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        id?: string;
        reference?: string;
        created_at?: string;
        error?: { message?: string };
      };
      if (!res.ok || !body.id || !body.reference)
        return setError(body.error?.message ?? "We could not send the request. Try again.");
      onSent({
        id: body.id,
        reference: body.reference,
        at: body.created_at ?? new Date().toISOString(),
      });
    } catch {
      setError("We could not reach the server. The request is not sent. Try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-card p-3" data-support-card>
      <div className="flex items-start gap-2">
        <LifeBuoy className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <p className="m-0 flex-1 text-sm font-medium">Send this to our support team?</p>
      </div>
      {editing ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1">
            <label htmlFor={`sr-subject-${draft.id}`} className="text-sm font-medium">
              Subject
            </label>
            <Input
              id={`sr-subject-${draft.id}`}
              value={subject}
              maxLength={200}
              onChange={(e) => setSubject(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`sr-body-${draft.id}`} className="text-sm font-medium">
              What happened
            </label>
            <Textarea
              id={`sr-body-${draft.id}`}
              value={description}
              rows={5}
              maxLength={4000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
      ) : (
        <dl className="m-0 flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Subject</dt>
            <dd className="m-0 font-medium">{subject}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">What happened</dt>
            <dd className="m-0 whitespace-pre-wrap">{description}</dd>
          </div>
        </dl>
      )}
      <div className="flex flex-col gap-1.5">
        <p className="m-0 text-xs text-muted-foreground">
          Attached. Remove anything you do not want to send.
        </p>
        {items.length || shots.length ? (
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {items.map((i) => (
              <li
                key={i.key}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs"
              >
                <span className="truncate">{i.label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${i.label}`}
                  title="Remove"
                  onClick={() => setRemoved((r) => [...r, i.key])}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
            {shots.map((s) => (
              <li
                key={s.id}
                className="inline-flex max-w-full items-center gap-1 rounded-md border bg-muted/40 py-0.5 pr-0.5 pl-2 text-xs"
              >
                <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">
                  {s.name} · {fmtSize(s.size)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${s.name}`}
                  title="Remove"
                  onClick={() => setShots((x) => x.filter((y) => y.id !== s.id))}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-sm text-muted-foreground">Nothing is attached.</p>
        )}
        {shots.length < 3 ? (
          <div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={uploading || pending}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <ImageIcon className="size-4" aria-hidden />
              )}
              Attach a screenshot
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept={ATTACHMENT_TYPES.join(",")}
              className="hidden"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void attach(f);
              }}
            />
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || uploading || !conversation}
          onClick={send}
        >
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Send to support
        </Button>
        {editing ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => setCancelled(true)}
        >
          Cancel
        </Button>
      </div>
      {error ? <Alert tone="error" title={error} /> : null}
    </div>
  );
}
