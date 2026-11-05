import { Sparkles } from "lucide-react";
import { requireUser } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/states";
import { ReleaseNotesList } from "@/components/release-notes-list";
import { listReleaseNotes } from "@/lib/release-notes";
import { markReleaseNotesSeenAction } from "@/app/auth-actions";

export const metadata = { title: "What's new · Two Minute Billing" };

/**
 * Product release notes, newest first. Content is `dashboard/content/releases/*.md` — see
 * `lib/release-notes.ts` for why it lives in the repo rather than in a table.
 *
 * No permission gate beyond a session: everyone who can sign in gets the same notes, and the
 * page reads no tenant data, so there is nothing here to scope to an organization.
 */
export default async function WhatsNewPage() {
  const user = await requireUser();
  const notes = listReleaseNotes();
  // Opening the page IS reading them, so the highwater moves here as well as on the dialog —
  // otherwise a badge would survive the visit that was meant to clear it. It SETS rather than
  // increments, so doing it on every visit costs one idempotent write and cannot drift.
  if (user.release_notes_seen_count !== notes.length) {
    await markReleaseNotesSeenAction(notes.length);
  }

  return (
    <>
      <PageHeader
        title="What's new"
        description="Product updates to Two Minute Billing, newest first."
      />
      {notes.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              icon={<Sparkles />}
              title="No release notes yet"
              description="Updates will appear here as they ship."
            />
          </CardContent>
        </Card>
      ) : (
        <ReleaseNotesList notes={notes} />
      )}
    </>
  );
}
