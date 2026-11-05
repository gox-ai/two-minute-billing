import * as React from "react";
import Link from "next/link";
import type { Block, Span } from "@/lib/release-note-types";

/**
 * Renders the parsed blocks from `lib/release-notes.ts` as React elements.
 *
 * No `dangerouslySetInnerHTML` anywhere: an author writes markdown, the parser turns it into
 * data, and this file decides what tags exist. That is why the subset is worth having — the
 * page cannot render markup a note file asks for.
 */

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) => {
        switch (s.kind) {
          case "text":
            return <React.Fragment key={i}>{s.text}</React.Fragment>;
          case "code":
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
                {s.text}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-foreground">
                <Spans spans={s.spans} />
              </strong>
            );
          case "em":
            return (
              <em key={i}>
                <Spans spans={s.spans} />
              </em>
            );
          case "link": {
            // An in-app path gets client navigation; anything else opens away from the
            // dashboard, so it says so and drops the referrer.
            const internal = s.href.startsWith("/");
            const className = "text-primary underline-offset-4 hover:underline";
            return internal ? (
              <Link key={i} href={s.href} className={className}>
                <Spans spans={s.spans} />
              </Link>
            ) : (
              <a
                key={i}
                href={s.href}
                target="_blank"
                rel="noreferrer noopener"
                className={className}
              >
                <Spans spans={s.spans} />
              </a>
            );
          }
        }
      })}
    </>
  );
}

export function ReleaseNoteBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-3 text-base leading-relaxed text-foreground/80">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "p":
            return (
              <p key={i}>
                <Spans spans={b.spans} />
              </p>
            );
          case "h":
            return b.level === 2 ? (
              <h3 key={i} className="pt-2 text-lg font-semibold text-foreground">
                <Spans spans={b.spans} />
              </h3>
            ) : (
              <h4 key={i} className="pt-1 text-base font-semibold text-foreground">
                <Spans spans={b.spans} />
              </h4>
            );
          case "ul":
            return (
              <ul key={i} className="space-y-1.5 pl-1">
                {b.items.map((item, j) => (
                  <li key={j} className="flex gap-2.5">
                    <span
                      className="mt-2.5 size-1 shrink-0 rounded-full bg-muted-foreground/60"
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <Spans spans={item} />
                    </span>
                  </li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={i} className="list-decimal space-y-1.5 pl-5 marker:text-muted-foreground">
                {b.items.map((item, j) => (
                  <li key={j} className="pl-1">
                    <Spans spans={item} />
                  </li>
                ))}
              </ol>
            );
          case "pre":
            // A well, not a card: a code sample is derived detail sitting inside the
            // entry's card, and it must scroll rather than widen the reading measure.
            return (
              <pre
                key={i}
                className="overflow-x-auto rounded-lg bg-muted/60 p-3 font-mono text-sm text-foreground/90"
              >
                {b.text}
              </pre>
            );
        }
      })}
    </div>
  );
}
