"use client";

import * as React from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Chip } from "@/components/patterns/chip";
import { ReleaseNoteBody } from "@/components/release-note-body";
import { RELEASE_TYPES, type ReleaseNote, type ReleaseType } from "@/lib/release-note-types";
import { fmtDate } from "@/lib/format";

const ALL = "All";

/**
 * The notes, with a filter by change type.
 *
 * Client-side because the whole set is already on the page — a note is a few paragraphs and
 * there are tens of them, not thousands, so filtering in the browser is instant and needs no
 * round trip. If this ever grows past a few hundred notes, paginate on the server instead.
 *
 * Only types that actually OCCUR get a tab: a filter that always returns nothing is a control
 * that does nothing.
 */
export function ReleaseNotesList({ notes }: { notes: ReleaseNote[] }) {
  const [type, setType] = React.useState<string>(ALL);
  const counts = React.useMemo(() => {
    const m = new Map<ReleaseType, number>();
    for (const n of notes) m.set(n.type, (m.get(n.type) ?? 0) + 1);
    return m;
  }, [notes]);
  const present = RELEASE_TYPES.filter((t) => (counts.get(t) ?? 0) > 0);
  const shown = type === ALL ? notes : notes.filter((n) => n.type === type);

  return (
    <div className="space-y-6">
      <Tabs value={type} onValueChange={setType}>
        <TabsList>
          <TabsTrigger value={ALL}>
            All <span className="text-muted-foreground tabular-nums">{notes.length}</span>
          </TabsTrigger>
          {present.map((t) => (
            <TabsTrigger key={t} value={t}>
              {t} <span className="text-muted-foreground tabular-nums">{counts.get(t)}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_14rem]">
        {/* A reading measure, not the full table width — this page is prose. */}
        <div className="max-w-[760px] space-y-8">
          {shown.map((note) => (
            <article key={note.slug} id={note.slug} className="anim-rise scroll-mt-8 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <time dateTime={note.date} className="font-medium tabular-nums">
                  {fmtDate(note.date, "UTC")}
                </time>
                {/* The TYPE reads in a different register from the areas — uppercase and
                    tracked, not coloured. A changelog category is not a status, and the
                    semantic tones are reserved for states that need a human. */}
                <Chip className="font-semibold tracking-wide uppercase">{note.type}</Chip>
                {note.version ? <Chip>{note.version}</Chip> : null}
                {note.tags.map((tag) => (
                  <Chip key={tag}>{tag}</Chip>
                ))}
              </div>
              <Card className="hoverable">
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <h2 className="text-xl font-semibold tracking-[-0.01em]">{note.title}</h2>
                    {note.summary ? (
                      <p className="text-base text-muted-foreground">{note.summary}</p>
                    ) : null}
                  </div>
                  <ReleaseNoteBody blocks={note.blocks} />
                </CardContent>
              </Card>
            </article>
          ))}
        </div>

        {/* Anchor jumps, so a long history stays navigable. Plain `#` links: instant, and
            nothing here sets `scroll-behavior: smooth`. */}
        <nav aria-label="Releases" className="max-lg:hidden">
          <div className="sticky top-0 space-y-2">
            <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Releases
            </h2>
            <ul className="space-y-1.5 border-l border-border pl-3">
              {shown.map((note) => (
                <li key={note.slug}>
                  <a
                    href={`#${note.slug}`}
                    className="block text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <span className="block tabular-nums">{fmtDate(note.date, "UTC")}</span>
                    <span className="line-clamp-2 text-xs">{note.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
      </div>
    </div>
  );
}
