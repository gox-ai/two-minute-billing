"use client";

import * as React from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { recordHref } from "@/lib/assistant";
import { cn } from "@/lib/utils";
import { isWideTable, parseAnswer, tableText, type Block } from "@/lib/assistant-reply";

/**
 * The assistant's answer as React nodes — never raw HTML. Blocks come from `parseAnswer`
 * (lib/assistant-reply.ts): headings, lists, tables, fenced code, quotes, paragraphs; inline
 * **bold**, `code` and links. Links render only to our own docs site and to dashboard screens
 * (same origin); a link anywhere else shows as text, so an answer steered by injected customer
 * text cannot send data out through a URL. Record ids become links to their pages and never
 * wrap. Figures the server could not find in the tool results carry a dotted warning underline.
 */

const DOCS_ORIGIN = "https://twominutebilling.com/";
const INLINE =
  /(\*\*[^*\n]+\*\*)|(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\b(?:cus|sub|inv|cn|txn|pi)_[A-Za-z0-9]{8,}\b)/g;

function markFigures(text: string, unverified: string[], key: string): React.ReactNode[] {
  if (!unverified.length) return [text];
  const re = new RegExp(
    // Whole figures only: a flagged "47" must not underline the 47 inside "$1,247.47".
    `(?<![\\d,.])(${unverified.map((u) => u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\d]|[,.]\\d)`,
    "g",
  );
  return text.split(re).map((part, i) =>
    unverified.includes(part) ? (
      <span
        key={`${key}-f${i}`}
        title="We could not find this figure in your data."
        className="underline decoration-warning decoration-dotted decoration-2 underline-offset-4"
      >
        {part}
      </span>
    ) : (
      part
    ),
  );
}

let badLinks: ReadonlySet<string> = new Set();

function inline(text: string, biz: string, unverified: string[], key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    const k = `${key}-${i++}`;
    if (m.index > last) out.push(...markFigures(text.slice(last, m.index), unverified, k));
    const [tok] = m;
    if (m[1]) out.push(<strong key={k}>{markFigures(tok.slice(2, -2), unverified, k)}</strong>);
    else if (m[2])
      out.push(
        <code key={k} className="rounded-md bg-muted px-1 font-mono text-xs wrap-anywhere">
          {tok.slice(1, -1)}
        </code>,
      );
    else if (m[3]) {
      const label = /^\[([^\]]+)\]/.exec(tok)![1]!;
      const url = /\(([^)\s]+)\)$/.exec(tok)![1]!;
      const internal = url.startsWith("/") && !url.startsWith("//");
      out.push(
        internal && !badLinks.has(url) ? (
          <Link key={k} href={url} className="text-primary hover:underline">
            {label}
          </Link>
        ) : url.startsWith(DOCS_ORIGIN) && !badLinks.has(url) ? (
          <a
            key={k}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            className="text-primary hover:underline"
          >
            {label}
          </a>
        ) : (
          <span key={k}>{label}</span>
        ),
      );
    } else {
      const href = recordHref(biz, tok);
      // An id is one word: it never breaks across lines.
      out.push(
        href ? (
          <Link
            key={k}
            href={href}
            className="font-mono text-xs whitespace-nowrap text-primary hover:underline"
          >
            {tok}
          </Link>
        ) : (
          <span key={k} className="font-mono text-xs whitespace-nowrap">
            {tok}
          </span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(...markFigures(text.slice(last), unverified, `${key}-end`));
  return out;
}

/** A small copy control for a code block or a wide table. */
export function CopyText({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success(`${what} copied.`);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error(`We could not copy the ${what.toLowerCase()}. Select the text and copy it.`);
        }
      }}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? (
        <Check className="size-3.5 text-success" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
      <span className="sr-only">Copy the {what.toLowerCase()}</span>
    </button>
  );
}

/**
 * A table in the `Table` look: a card, a soft head band, hairline rows, figures right-aligned.
 * Up to three columns it fits the panel and its cells wrap; from four it scrolls inside its
 * own box with the first column held, and gets a copy control.
 */
function AnswerTable({
  b,
  biz,
  unverified,
  k,
}: {
  b: Extract<Block, { kind: "table" }>;
  biz: string;
  unverified: string[];
  k: string;
}) {
  const wide = isWideTable(b.head);
  const sticky = wide ? "sticky left-0 z-10 bg-card shadow-[inset_-1px_0_0_var(--border)]" : "";
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
      {wide ? (
        <div className="flex h-8 items-center justify-between border-b pr-1 pl-3 text-xs text-muted-foreground">
          <span>
            {b.rows.length} {b.rows.length === 1 ? "row" : "rows"}
          </span>
          <CopyText text={tableText(b.head, b.rows)} what="Table" />
        </div>
      ) : null}
      <div className={cn(wide && "overflow-x-auto")}>
        <table className={cn("w-full border-collapse text-sm tabular-nums", !wide && "table-auto")}>
          <thead className="bg-muted/40">
            <tr>
              {b.head.map((h, j) => (
                <th
                  key={j}
                  scope="col"
                  className={cn(
                    "px-3 py-1.5 text-xs font-medium text-muted-foreground",
                    b.align[j] === "right" ? "text-right" : "text-left",
                    wide && "whitespace-nowrap",
                    wide &&
                      j === 0 &&
                      "sticky left-0 z-10 bg-card bg-linear-to-r from-muted/40 to-muted/40 shadow-[inset_-1px_0_0_var(--border)]",
                  )}
                >
                  {inline(h, biz, unverified, `${k}-h${j}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, j) => (
              <tr key={j} className="border-t">
                {r.map((c, n) => (
                  <td
                    key={n}
                    className={cn(
                      "px-3 py-2 align-top",
                      b.align[n] === "right" ? "text-right" : "text-left",
                      wide || b.align[n] === "right" ? "whitespace-nowrap" : "wrap-break-word",
                      n === 0 && sticky,
                    )}
                  >
                    {inline(c, biz, unverified, `${k}-${j}-${n}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CodeBlock({ b }: { b: Extract<Block, { kind: "code" }> }) {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-muted/50">
      <div className="flex h-8 items-center justify-between border-b pr-1 pl-3 text-xs text-muted-foreground">
        <span>{b.lang ?? "Code"}</span>
        <CopyText text={b.text} what="Code" />
      </div>
      <pre className="m-0 overflow-x-auto p-3 font-mono text-xs leading-relaxed">
        <code>{b.text}</code>
      </pre>
    </div>
  );
}

export function AnswerMarkdown({
  text,
  biz,
  unverified = [],
}: {
  text: string;
  biz: string;
  unverified?: string[];
}) {
  const blocks = React.useMemo(() => parseAnswer(text), [text]);
  return (
    <div className="flex min-w-0 flex-col gap-2.5 text-sm leading-relaxed wrap-break-word">
      {blocks.map((b, n) => {
        const key = `b${n}`;
        switch (b.kind) {
          case "heading": {
            const H = b.level <= 2 ? "h3" : "h4";
            return (
              <H
                key={key}
                className={cn(
                  "m-0 font-semibold text-foreground",
                  b.level <= 2 ? "pt-1 text-base" : "text-sm",
                )}
              >
                {inline(b.text, biz, unverified, key)}
              </H>
            );
          }
          case "list": {
            const List = b.ordered ? "ol" : "ul";
            return (
              <List
                key={key}
                start={b.ordered && b.start !== 1 ? b.start : undefined}
                className={cn(
                  "m-0 flex flex-col gap-1 pl-5",
                  b.ordered ? "list-decimal" : "list-disc",
                )}
              >
                {b.items.map((it, j) => (
                  <li key={j} className="pl-0.5">
                    {inline(it, biz, unverified, `${key}-${j}`)}
                  </li>
                ))}
              </List>
            );
          }
          case "table":
            return <AnswerTable key={key} b={b} biz={biz} unverified={unverified} k={key} />;
          case "code":
            return <CodeBlock key={key} b={b} />;
          case "quote":
            return (
              <blockquote
                key={key}
                className="m-0 border-l-2 border-border pl-3 text-muted-foreground"
              >
                {inline(b.text, biz, unverified, key)}
              </blockquote>
            );
          case "para":
            return (
              <p key={key} className="m-0">
                {inline(b.text, biz, unverified, key)}
              </p>
            );
        }
      })}
    </div>
  );
}
