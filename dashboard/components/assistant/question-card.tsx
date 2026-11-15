"use client";

import * as React from "react";
import { Check, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ASSISTANT_NAME, type AssistantQuestion } from "@/lib/assistant";

/** An answered question, folded to one line. */
export function AnsweredQuestion({ q, answer }: { q: AssistantQuestion; answer: string }) {
  return (
    <p className="m-0 flex items-start gap-1.5 text-xs text-muted-foreground">
      <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
      <span>
        {q.text} <span className="text-foreground">— {answer}</span>
      </span>
    </p>
  );
}

/**
 * One question from the assistant, with its options as buttons. An answer is sent as an
 * ordinary message. Keys 1–5 pick an option while focus is not in a text field.
 */
export function QuestionCard({
  q,
  disabled,
  onAnswer,
  onTypeOther,
}: {
  q: AssistantQuestion;
  disabled: boolean;
  onAnswer: (text: string) => void;
  onTypeOther: () => void;
}) {
  const options = q.options.slice(0, 5);
  const defaultIndex = options.findIndex((o) => o.default);
  const [amount, setAmount] = React.useState("");
  const defaultRef = React.useRef<HTMLButtonElement>(null);

  // The default is preselected: focus it so Enter answers with it.
  React.useEffect(() => {
    if (q.input !== "amount") defaultRef.current?.focus({ preventScroll: true });
  }, [q.id, q.input]);

  React.useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // Only while the panel holds focus, so the keys never act from the page behind.
      if (!t?.closest('[data-assistant-panel="true"]')) return;
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) {
        e.preventDefault();
        onAnswer(options[n - 1]!.label);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [disabled, onAnswer, options]);

  return (
    <div className="flex flex-col gap-2.5 rounded-md border bg-card p-3">
      <div className="flex items-start gap-2">
        <p className="m-0 flex-1 text-sm font-medium">{q.text}</p>
        {q.step ? (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {q.step.index} of {q.step.total}
          </span>
        ) : null}
      </div>
      {q.hint ? <p className="m-0 text-xs text-muted-foreground">{q.hint}</p> : null}

      {q.input === "amount" ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (amount.trim()) onAnswer(amount.trim());
          }}
        >
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoFocus
            maxLength={30}
            aria-label="Amount"
            placeholder="Amount"
            disabled={disabled}
            className="max-w-[180px] tabular-nums"
          />
          <Button type="submit" size="sm" disabled={disabled || !amount.trim()}>
            Send
          </Button>
        </form>
      ) : null}

      {options.length ? (
        <div className="flex flex-col gap-1.5" role="group" aria-label={q.text}>
          {options.map((o, i) => (
            <button
              key={o.label}
              ref={i === defaultIndex ? defaultRef : undefined}
              type="button"
              disabled={disabled}
              onClick={() => onAnswer(o.label)}
              className={cn(
                "flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted/60 disabled:pointer-events-none disabled:opacity-50",
                i === defaultIndex && "border-primary bg-muted/40",
              )}
            >
              <kbd className="flex size-5 shrink-0 items-center justify-center rounded-md border bg-muted text-xs text-muted-foreground">
                {i + 1}
              </kbd>
              <span className="flex min-w-0 flex-1 flex-col">
                <span>
                  {o.label}
                  {i === defaultIndex ? (
                    <span className="ml-2 text-xs whitespace-nowrap text-primary">
                      Your default
                    </span>
                  ) : null}
                </span>
                {/* A long detail (an email) goes under the label; a short one (an amount) stays right. */}
                {o.detail && o.detail.length > 14 ? (
                  <span className="truncate text-xs text-muted-foreground">{o.detail}</span>
                ) : null}
              </span>
              {o.detail && o.detail.length <= 14 ? (
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {o.detail}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      {q.allow_other ? (
        <button
          type="button"
          onClick={onTypeOther}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Pencil className="size-3.5" aria-hidden /> Type a different answer
        </button>
      ) : null}
      <span className="sr-only">{ASSISTANT_NAME} waits for your answer.</span>
    </div>
  );
}
