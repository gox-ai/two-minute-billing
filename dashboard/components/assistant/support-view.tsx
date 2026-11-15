"use client";

import * as React from "react";
import { ArrowLeft, ImageIcon, LifeBuoy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Chip } from "@/components/patterns/chip";
import { fmtDateTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import type { SupportMessage, SupportRequestView, SupportStatus } from "@/lib/assistant";
import { BillyMark } from "./billy-mark";
import { fmtSize } from "./composer";

/**
 * The member's support requests inside the panel. A reply from our team is shown as written,
 * signed "Two Minute Billing support", and never reaches the model.
 */

const STATUS: Record<SupportStatus, { label: string; tone: "tan" | "blue" | "gray" }> = {
  open: { label: "Open", tone: "tan" },
  waiting: { label: "Waiting for your reply", tone: "blue" },
  resolved: { label: "Resolved", tone: "gray" },
};

export function SupportStatusChip({ status }: { status: SupportStatus }) {
  const s = STATUS[status];
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

export function SupportList({
  items,
  onOpen,
  tz,
}: {
  items: SupportRequestView[] | null;
  onOpen: (id: string) => void;
  tz: string | null;
}) {
  if (!items)
    return (
      <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading your requests
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <p className="m-0 mb-2 text-xs font-medium text-muted-foreground">Your support requests</p>
      {items.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          You have no support requests. Ask a question. If a person on our team must help, the
          assistant offers to send them the details.
        </p>
      ) : (
        items.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onOpen(r.id)}
            className="flex flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-muted/60"
          >
            <span className="flex items-center gap-2 text-sm">
              {r.unread ? (
                <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="New reply" />
              ) : null}
              <span className={cn("min-w-0 flex-1 truncate", r.unread && "font-semibold")}>
                {r.subject}
              </span>
            </span>
            <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {r.reference} · {fmtDateTime(r.updated_at, tz)}
              <SupportStatusChip status={r.status} />
            </span>
          </button>
        ))
      )}
    </div>
  );
}

function Message({ m, tz }: { m: SupportMessage; tz: string | null }) {
  if (m.author === "system")
    return <p className="m-0 text-center text-xs text-muted-foreground">{m.body}</p>;
  const shots = m.attachments.length ? (
    <div className="flex flex-wrap gap-1">
      {m.attachments.map((a) => (
        <span
          key={a.id}
          className="inline-flex items-center gap-1 rounded-md border bg-card px-1.5 py-0.5 text-xs"
        >
          <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden />
          {a.name} · {fmtSize(a.size)}
        </span>
      ))}
    </div>
  ) : null;
  if (m.author === "member")
    return (
      <div className="flex max-w-[85%] flex-col items-end gap-1 self-end">
        {shots}
        <div className="rounded-md bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{m.body}</div>
        <span className="text-xs text-muted-foreground">{fmtDateTime(m.created_at, tz)}</span>
      </div>
    );
  // Our staff: a different mark and a border, so it never reads as the assistant.
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-info/30 bg-info-soft p-3"
      data-support-reply
    >
      <p className="m-0 flex items-center gap-1.5 text-xs font-medium text-info">
        <LifeBuoy className="size-3.5" aria-hidden />
        {m.author_name}
        <span className="font-normal text-muted-foreground">· {fmtDateTime(m.created_at, tz)}</span>
      </p>
      <div className="text-sm whitespace-pre-wrap text-foreground">{m.body}</div>
      {shots}
    </div>
  );
}

export function SupportThread({
  id,
  tz,
  onBack,
  onRead,
}: {
  id: string;
  tz: string | null;
  onBack: () => void;
  /** The thread was read: the caller refreshes the unread count. */
  onRead: () => void;
}) {
  const [r, setR] = React.useState<SupportRequestView | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [text, setText] = React.useState("");
  const [pending, setPending] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch(`/api/assistant/support/requests/${encodeURIComponent(id)}`);
        const body = (await res.json()) as SupportRequestView & { error?: { message?: string } };
        if (!live) return;
        if (!res.ok) return setError(body.error?.message ?? "We could not open this request.");
        setR(body);
        if (body.unread) {
          await fetch(`/api/assistant/support/requests/${encodeURIComponent(id)}/read`, {
            method: "POST",
          });
          onRead();
        }
      } catch {
        if (live) setError("We could not open this request. Check your connection and try again.");
      }
    })();
    return () => {
      live = false;
    };
  }, [id, onRead]);

  const reply = async () => {
    if (!text.trim()) return;
    setPending(true);
    try {
      const res = await fetch(
        `/api/assistant/support/requests/${encodeURIComponent(id)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: text }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as SupportRequestView & {
        error?: { message?: string };
      };
      if (!res.ok) {
        toast.error(body.error?.message ?? "We could not send the reply. Try again.");
        return;
      }
      setR(body);
      setText("");
      toast.success("Reply sent.");
    } catch {
      toast.error("We could not send the reply. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden /> Support requests
        </Button>
      </div>
      {error ? <Alert tone="error" title={error} /> : null}
      {!r && !error ? (
        <p className="m-0 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Opening the request
        </p>
      ) : null}
      {r ? (
        <>
          <div className="flex flex-col gap-1">
            <p className="m-0 text-base font-medium">{r.subject}</p>
            <p className="m-0 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {r.reference} · Sent {fmtDateTime(r.created_at, tz)}
              <SupportStatusChip status={r.status} />
            </p>
            {r.context.length ? (
              <p className="m-0 text-xs text-muted-foreground">
                Attached: {r.context.map((c) => c.label).join(" · ")}
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
            {(r.messages ?? []).map((m) => (
              <Message key={m.id} m={m} tz={tz} />
            ))}
          </div>
          {r.status !== "waiting" && !(r.messages ?? []).some((m) => m.author === "support") ? (
            <p className="m-0 flex items-start gap-1.5 text-xs text-muted-foreground">
              <BillyMark size={14} className="mt-0.5" />
              Our support team replies here and by email.
            </p>
          ) : null}
          <div className="flex flex-col gap-2 border-t pt-3">
            <label htmlFor={`sr-reply-${r.id}`} className="text-sm font-medium">
              Reply to support
            </label>
            <Textarea
              id={`sr-reply-${r.id}`}
              value={text}
              rows={3}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
            />
            {r.status === "resolved" ? (
              <p className="m-0 text-xs text-muted-foreground">
                This request is resolved. A reply opens it again.
              </p>
            ) : null}
            <div>
              <Button type="button" size="sm" disabled={pending || !text.trim()} onClick={reply}>
                {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Send reply
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
