"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/patterns/chip";
import { markReleaseNotesSeenAction } from "@/app/auth-actions";
import { fmtDate } from "@/lib/format";
import type { ReleaseNote } from "@/lib/release-note-types";

/** Enough to show what shipped without becoming a wall. The rest is one click away. */
const MAX_LISTED = 5;

/**
 * Announces unread release notes ONCE, then gets out of the way.
 *
 * "Once" is enforced by the server, not by this component: dismissing moves the highwater on
 * the user row, so the next render has nothing unread and the dialog does not mount. That is
 * why it survives a reload, another tab, and a different machine — a `localStorage` flag would
 * announce the same release again on every device the person signs in on.
 *
 * It never opens on `/whats-new` itself. Arriving at the page IS reading them, and the page
 * marks them read on its own; a dialog over the thing it is advertising is pure noise.
 */
export function WhatsNewDialog({
  unread,
  total,
}: {
  unread: ReleaseNote[];
  /** Notes in existence — the value the highwater moves to. */
  total: number;
}) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = React.useState(true);
  const suppressed = path === "/whats-new";

  const acknowledge = React.useCallback(() => {
    setOpen(false);
    // Fire and forget, then refresh so the sidebar badge clears in the same beat. The action
    // is a SET, so a double-click cannot double-count.
    void markReleaseNotesSeenAction(total).then(() => router.refresh());
  }, [total, router]);

  if (suppressed || unread.length === 0) return null;

  const listed = unread.slice(0, MAX_LISTED);
  const rest = unread.length - listed.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing by any route — the ×, Escape, the overlay — counts as having seen them.
        // A dialog that reappears because it was dismissed the "wrong" way is a trap.
        if (!next) acknowledge();
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            What&apos;s new
          </DialogTitle>
          <DialogDescription>
            {unread.length === 1
              ? "One update since you were last here."
              : `${unread.length} updates since you were last here.`}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {listed.map((note) => (
            <li key={note.slug} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <time dateTime={note.date} className="tabular-nums">
                  {fmtDate(note.date, "UTC")}
                </time>
                <Chip className="font-semibold tracking-wide uppercase">{note.type}</Chip>
              </div>
              <Link
                href={`/whats-new#${note.slug}`}
                onClick={acknowledge}
                className="block text-sm font-medium hover:underline"
              >
                {note.title}
              </Link>
              {note.summary ? (
                <p className="text-sm text-muted-foreground">{note.summary}</p>
              ) : null}
            </li>
          ))}
        </ul>
        {rest > 0 ? (
          <p className="text-sm text-muted-foreground">
            and {rest} more {rest === 1 ? "update" : "updates"}.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={acknowledge}>
            Close
          </Button>
          <Button asChild>
            <Link href="/whats-new" onClick={acknowledge}>
              View all
            </Link>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
