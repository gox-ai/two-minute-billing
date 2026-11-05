import { addCommentAction, deleteCommentAction } from "@/app/actions";
import { businessTz } from "@/lib/business-tz-server";
import { listComments, type CommentResourceType } from "@/lib/api/comments";
import { SectionCard } from "@/components/patterns/section-card";
import { EmptyState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { fmtDateTime } from "@/lib/api";
import { Paged, PagedFooter, PagedItems } from "@/components/patterns/pager";
import { ActionForm } from "@/components/form/action-form";
import { ActionButton } from "@/components/action-button";

/**
 * Operator notes on a record — invoices, credit notes, customers and
 * subscriptions. One component for all of them, matching the polymorphic
 * `comments` table behind it.
 *
 * A server component; its forms post through <ActionForm>, so the page stays put
 * and the list re-renders from the source of truth rather than an optimistic guess.
 */
export async function CommentsCard({
  biz,
  resourceType,
  resourceId,
  backPath,
  layout = "section",
}: {
  biz: string;
  resourceType: CommentResourceType;
  resourceId: string;
  /** Where to revalidate + return after posting (the page showing this card). */
  backPath: string;
  layout?: "section" | "card";
}) {
  // Server component, so it reads the zone rather than the `useBusinessTz()` context —
  // and it is only ever rendered inside `/businesses/[biz]`, so a business zone is the
  // right one. Without it a comment posted at 01:00 IST showed the previous day.
  const tz = await businessTz(biz);
  let comments;
  try {
    comments = await listComments(biz, resourceType, resourceId);
  } catch {
    // A notes box must never take the page down with it.
    return null;
  }

  return (
    <SectionCard id="comments" title="Comments" layout={layout}>
      <div className="space-y-4">
        <ActionForm action={addCommentAction} resetOnSuccess className="space-y-2">
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="resource_type" value={resourceType} />
          <input type="hidden" name="resource_id" value={resourceId} />
          <input type="hidden" name="back" value={backPath} />
          <Textarea
            name="body"
            required
            rows={2}
            placeholder="Add a note for your team…"
            aria-label="Comment"
          />
          <div className="flex justify-end">
            <Button type="submit" variant="outline" size="sm">
              Comment
            </Button>
          </div>
        </ActionForm>

        {comments.data.length === 0 ? (
          <EmptyState
            title="No comments yet"
            description="Notes you add here are visible to your team only."
          />
        ) : (
          <Paged
            size={5}
            // Newest first, so page 1 is always the latest note. The API lists oldest
            // first and that order is public, so the card sorts, not the route.
            items={[...comments.data]
              .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
              .map((c) => (
                <li key={c.id} className="flex gap-3">
                  <Avatar className="size-7 shrink-0">
                    <AvatarFallback className="text-xs uppercase">
                      {c.author.slice(0, 2)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium">{c.author}</span>
                      <span className="text-xs text-muted-foreground">
                        {fmtDateTime(c.created_at, tz)}
                      </span>
                      {c.updated_at !== c.created_at ? (
                        <span className="text-xs text-muted-foreground">(edited)</span>
                      ) : null}
                    </div>
                    <p className="text-sm wrap-break-word whitespace-pre-wrap">{c.body}</p>
                  </div>
                  <ActionButton
                    resultAction={deleteCommentAction}
                    fields={{ biz, id: c.id, back: backPath }}
                    label="Delete"
                    variant="ghost"
                    size="sm"
                    className="h-auto p-1 text-xs text-muted-foreground hover:text-destructive"
                  />
                </li>
              ))}
          >
            <ul className="space-y-3 border-t pt-4">
              <PagedItems />
            </ul>
            <PagedFooter className="mt-3 px-0" />
          </Paged>
        )}
      </div>
    </SectionCard>
  );
}
