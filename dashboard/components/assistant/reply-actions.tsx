"use client";

import * as React from "react";
import { toast } from "sonner";
import { Copy, RotateCcw, ThumbsDown, ThumbsUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { answerPlainText } from "@/lib/assistant-reply";
import type { FeedbackRating } from "@/lib/assistant";
import type { Msg } from "./chat-messages";

const BTN =
  "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-pressed:text-foreground";

/** Copy the answer as plain text: no marks, tables tab-separated. */
export function CopyAnswerButton({ content }: { content: string }) {
  return (
    <button
      type="button"
      className={BTN}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(answerPlainText(content));
          toast.success("Answer copied.");
        } catch {
          toast.error("We could not copy the answer. Select the text and copy it.");
        }
      }}
    >
      <Copy className="size-3.5" aria-hidden /> Copy
    </button>
  );
}

/**
 * Copy, helpful / not helpful and ask again under one answer. Earlier answers show them on
 * hover or focus; the latest answer, a touch screen and an open comment always show them.
 * Read only (a shared chat): Copy alone, as nothing else may write.
 */
export function ReplyActions({
  m,
  latest,
  readOnly,
  canAskAgain = false,
  onAskAgain,
  onRated,
}: {
  m: Msg;
  latest: boolean;
  readOnly?: boolean;
  canAskAgain?: boolean;
  onAskAgain?: () => void;
  onRated?: (r: FeedbackRating | null) => void;
}) {
  const [comment, setComment] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const rate = async (rating: FeedbackRating | null, text?: string) => {
    if (!m.id) return false;
    setSaving(true);
    try {
      const res = await fetch(`/api/assistant/messages/${encodeURIComponent(m.id)}/feedback`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rating, ...(text ? { comment: text } : {}) }),
      });
      if (!res.ok) {
        toast.error("We could not save your feedback. Try again.");
        return false;
      }
      onRated?.(rating);
      return true;
    } catch {
      toast.error("We could not save your feedback. Check your connection and try again.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const pinned = latest || comment !== null || !!m.feedback;
  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "flex flex-wrap items-center gap-0.5 transition-opacity duration-(--dur-fast)",
          !pinned &&
            "pointer-fine:opacity-0 pointer-fine:group-focus-within/reply:opacity-100 pointer-fine:group-hover/reply:opacity-100",
        )}
      >
        <CopyAnswerButton content={m.content} />
        {readOnly ? null : (
          <>
            <button
              type="button"
              className={BTN}
              disabled={!m.id || saving}
              aria-pressed={m.feedback === "up"}
              title="Helpful"
              onClick={() => {
                setComment(null);
                void rate(m.feedback === "up" ? null : "up");
              }}
            >
              <ThumbsUp
                className={cn("size-3.5", m.feedback === "up" && "fill-current")}
                aria-hidden
              />
              <span className="sr-only">Helpful</span>
            </button>
            <button
              type="button"
              className={BTN}
              disabled={!m.id || saving}
              aria-pressed={m.feedback === "down"}
              title="Not helpful"
              onClick={async () => {
                if (m.feedback === "down") {
                  setComment(null);
                  return void rate(null);
                }
                if (await rate("down")) setComment("");
              }}
            >
              <ThumbsDown
                className={cn("size-3.5", m.feedback === "down" && "fill-current")}
                aria-hidden
              />
              <span className="sr-only">Not helpful</span>
            </button>
            <button
              type="button"
              className={BTN}
              disabled={!canAskAgain}
              onClick={onAskAgain}
              title="Ask again"
            >
              <RotateCcw className="size-3.5" aria-hidden /> Ask again
            </button>
          </>
        )}
      </div>
      {comment !== null ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!comment.trim()) return setComment(null);
            if (await rate("down", comment.trim())) {
              setComment(null);
              toast.success("Feedback sent.");
            }
          }}
        >
          <label htmlFor={`fb-${m.id}`} className="text-xs text-muted-foreground">
            What was wrong? (optional)
          </label>
          <div className="flex items-center gap-2">
            <Input
              id={`fb-${m.id}`}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              maxLength={1000}
              autoFocus
              className="h-8 text-sm"
            />
            <Button type="submit" size="sm" variant="outline" disabled={saving}>
              Send
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setComment(null)}>
              Skip
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
