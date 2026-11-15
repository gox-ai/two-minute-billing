"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Link as LinkIcon,
  Link2Off,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Search,
  SearchX,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import { SegmentIndicator } from "@/components/ui/segment-indicator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState, ErrorState } from "@/components/states";
import { Chip } from "@/components/patterns/chip";
import { RowMenu, type RowMenuGroup } from "@/components/patterns/row-menu";
import { ASSISTANT_NAME } from "@/lib/assistant";
import {
  PAGE_SIZE,
  TITLE_MAX,
  chatTime,
  cleanTitle,
  groupChats,
  highlightParts,
  patchChat,
  removeChat,
  resultLabel,
  sharedChatUrl,
  toChat,
  toChatPage,
  upsertChat,
  type ChatPatch,
  type ChatSummary,
  type ChatView,
} from "@/lib/assistant-history";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { panelEl } from "./billy-morph";

/**
 * Billy's chat history: search, date groups, and the chat actions (rename, pin, share,
 * archive, delete). The row menu and the panel header share one set of actions.
 */

/** Sonner's action button on our toast tones: an outline in the toast's own colour. */
const UNDO_BUTTON =
  "rounded-md! border! border-current/30! bg-transparent! font-medium! text-current! hover:bg-current/10!";

type Loaded = { key: string; items: ChatSummary[]; hasMore: boolean; cursor: string | null };
type Renaming = { id: string; where: "row" | "header" };

const errorText = async (res: Response) =>
  ((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error
    ?.message ?? null;

export interface ChatHistoryApi {
  biz: string | null;
  view: ChatView;
  setView: (v: ChatView) => void;
  query: string;
  setQuery: (q: string) => void;
  /** The query the shown results belong to. */
  searched: string;
  items: ChatSummary[] | null;
  hasMore: boolean;
  failed: string | null;
  loadingMore: boolean;
  loadMore: () => void;
  reload: () => void;
  /** A chat changed outside the list (a new turn): put it in its place. */
  put: (c: ChatSummary) => void;
  renaming: Renaming | null;
  setRenaming: (r: Renaming | null) => void;
  rename: (c: ChatSummary, title: string) => void;
  setPinned: (c: ChatSummary, on: boolean) => void;
  share: (c: ChatSummary) => void;
  stopSharing: (c: ChatSummary) => void;
  copyLink: (c: ChatSummary) => void;
  archive: (c: ChatSummary) => void;
  restore: (c: ChatSummary) => void;
  askDelete: (c: ChatSummary) => void;
  /** The delete confirmation and the share dialog; render once. */
  dialogs: React.ReactNode;
}

export function useChatHistory({
  biz,
  active,
  onChanged,
  onGone,
}: {
  biz: string | null;
  /** The list is on screen: load it, and look again each time it comes back. */
  active: boolean;
  /** A chat changed (optimistically, then as saved, or rolled back). */
  onChanged: (c: ChatSummary) => void;
  /** A chat was archived or deleted. */
  onGone: (id: string) => void;
}): ChatHistoryApi {
  const [view, setViewState] = React.useState<ChatView>("active");
  const [query, setQuery] = React.useState("");
  const [searched, setSearched] = React.useState("");
  const [page, setPage] = React.useState<Loaded | null>(null);
  const [error, setError] = React.useState<{ key: string; message: string } | null>(null);
  const [tick, setTick] = React.useState(0);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [renaming, setRenaming] = React.useState<Renaming | null>(null);
  const [deleting, setDeleting] = React.useState<ChatSummary | null>(null);
  const [sharing, setSharing] = React.useState<ChatSummary | null>(null);
  const key = `${biz}|${view}|${searched}`;
  // The latest view and callbacks, for the answers that land after an await.
  const now = React.useRef({ key, view, searched });
  const cb = React.useRef({ onChanged, onGone });
  React.useLayoutEffect(() => {
    now.current = { key, view, searched };
    cb.current = { onChanged, onGone };
  });

  // Another business: its own list, from the top.
  const lastBiz = React.useRef(biz);
  React.useEffect(() => {
    // An organization page (no business) keeps the list, like the dock keeps the chat.
    if (!biz || lastBiz.current === biz) return;
    lastBiz.current = biz;
    setQuery("");
    setSearched("");
    setViewState("active");
    setRenaming(null);
  }, [biz]);

  React.useEffect(() => {
    const q = query.trim();
    if (q === searched) return;
    const t = window.setTimeout(() => setSearched(q), q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [query, searched]);

  // Results are keyed by business, view and query, so an older answer is never shown.
  React.useEffect(() => {
    if (!active || !biz) return;
    const ctrl = new AbortController();
    const qs = new URLSearchParams({
      business: biz,
      archived: String(view === "archived"),
      limit: String(PAGE_SIZE),
    });
    if (searched) qs.set("q", searched);
    void (async () => {
      try {
        const res = await fetch(`/api/assistant/conversations?${qs}`, { signal: ctrl.signal });
        if (!res.ok) {
          const message =
            (await errorText(res)) ?? `The billing API answered with error ${res.status}.`;
          if (!ctrl.signal.aborted) setError({ key, message });
          return;
        }
        const p = toChatPage(await res.json());
        if (ctrl.signal.aborted) return;
        setPage({ key, items: p.data, hasMore: p.has_more, cursor: p.next_cursor });
        setError(null);
      } catch {
        if (!ctrl.signal.aborted) setError({ key, message: "The billing API did not answer." });
      }
    })();
    return () => ctrl.abort();
  }, [active, biz, view, searched, key, tick]);

  const current = page?.key === key ? page : null;

  const loadMore = async () => {
    const p = current;
    if (!p?.hasMore || !p.cursor || loadingMore || !biz) return;
    setLoadingMore(true);
    const qs = new URLSearchParams({
      business: biz,
      archived: String(view === "archived"),
      limit: String(PAGE_SIZE),
      starting_after: p.cursor,
    });
    if (searched) qs.set("q", searched);
    try {
      const res = await fetch(`/api/assistant/conversations?${qs}`);
      if (!res.ok) throw new Error((await errorText(res)) ?? "");
      const next = toChatPage(await res.json());
      setPage((cur) => {
        if (!cur || cur.key !== p.key) return cur;
        const seen = new Set(cur.items.map((c) => c.id));
        return {
          ...cur,
          items: [...cur.items, ...next.data.filter((c) => !seen.has(c.id))],
          hasMore: next.has_more,
          cursor: next.next_cursor,
        };
      });
    } catch (e) {
      toast.error("We could not load more chats.", {
        description: (e as Error).message || "Check your connection and try again.",
      });
    } finally {
      setLoadingMore(false);
    }
  };

  /** Shows `c` in the list (when it belongs there) and wherever else it is open. */
  const apply = React.useCallback((c: ChatSummary, insert?: boolean) => {
    const { key: k, view: v, searched: s } = now.current;
    setPage((p) =>
      p && p.key === k ? { ...p, items: upsertChat(p.items, c, v, insert ?? !s) } : p,
    );
    cb.current.onChanged(c);
  }, []);
  const inList = (id: string) => !!current?.items.some((c) => c.id === id);

  const save = async (c: ChatSummary, patch: ChatPatch, failed: string) => {
    const had = inList(c.id);
    const shown = patchChat(c, patch, new Date().toISOString());
    apply(shown);
    try {
      const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(c.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error((await errorText(res)) ?? "");
      const saved = toChat(await res.json()) ?? shown;
      const next = { ...saved, snippet: saved.snippet ?? c.snippet };
      apply(next);
      return next;
    } catch (e) {
      apply(c, had);
      toast.error(failed, { description: (e as Error).message || "Try again." });
      return null;
    }
  };

  const restore = async (c: ChatSummary, quiet = false) => {
    const s = await save(c, { archived: false }, "We could not restore the chat.");
    if (s && !quiet) toast.success("Chat restored.");
  };

  const linkOf = (c: ChatSummary) =>
    sharedChatUrl(window.location.origin, c.business ?? biz ?? "", c.id);

  const copy = async (c: ChatSummary) => {
    try {
      await navigator.clipboard.writeText(linkOf(c));
      toast.success("Link copied.");
    } catch {
      setSharing(c);
      toast.error("We could not copy the link.", { description: "Select the link and copy it." });
    }
  };

  const stopSharing = async (c: ChatSummary) => {
    setSharing((cur) => (cur?.id === c.id ? null : cur));
    const s = await save(c, { shared: false }, "We could not stop sharing the chat.");
    if (s) toast.success("Sharing stopped.");
  };

  const confirmDelete = async () => {
    const c = deleting;
    if (!c) return;
    const had = inList(c.id);
    setPage((p) => (p ? { ...p, items: removeChat(p.items, c.id) } : p));
    try {
      const res = await fetch(`/api/assistant/conversations/${encodeURIComponent(c.id)}`, {
        method: "DELETE",
      });
      // Already gone is what the member asked for.
      if (!res.ok && res.status !== 404) throw new Error((await errorText(res)) ?? "");
      cb.current.onGone(c.id);
      toast.success("Chat deleted.");
    } catch (e) {
      if (had) apply(c, true);
      toast.error("We could not delete the chat.", {
        description: (e as Error).message || "Try again.",
      });
    }
  };

  const sharedLink = sharing ? linkOf(sharing) : "";
  const dialogs = (
    <>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this chat?"
        description="This deletes the chat and all its messages. You cannot undo this."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
      />
      <Dialog open={!!sharing} onOpenChange={(o) => !o && setSharing(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Share this chat</DialogTitle>
            <DialogDescription>
              Members of your organization who can see this business can read this chat. They cannot
              reply.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input
              readOnly
              value={sharedLink}
              aria-label="Link to the chat"
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1"
            />
            <Button type="button" onClick={() => sharing && void copy(sharing)}>
              <Copy aria-hidden /> Copy link
            </Button>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => sharing && void stopSharing(sharing)}
            >
              <Link2Off aria-hidden /> Stop sharing
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  // A dialog opened from a menu item waits for the menu to close first.
  const later = (f: () => void) => window.setTimeout(f, 0);

  return {
    biz,
    view,
    setView: (v) => {
      setViewState(v);
      setRenaming(null);
    },
    query,
    setQuery,
    searched,
    items: current?.items ?? null,
    hasMore: current?.hasMore ?? false,
    failed: !current && error?.key === key ? error.message : null,
    loadingMore,
    loadMore: () => void loadMore(),
    reload: () => {
      setError(null);
      setTick((t) => t + 1);
    },
    put: (c) => apply(c),
    renaming,
    setRenaming,
    rename: (c, raw) => {
      setRenaming(null);
      const title = cleanTitle(raw);
      if (!title || title === c.title) return;
      void save(c, { title }, "We could not rename the chat.").then(
        (s) => s && toast.success("Chat renamed."),
      );
    },
    setPinned: (c, on) =>
      void save(
        c,
        { pinned: on },
        on ? "We could not pin the chat." : "We could not unpin the chat.",
      ).then((s) => s && toast.success(on ? "Chat pinned." : "Chat unpinned.")),
    share: (c) => {
      later(() => setSharing(patchChat(c, { shared: true }, new Date().toISOString())));
      void save(c, { shared: true }, "We could not share the chat.").then((s) =>
        setSharing((cur) => (cur?.id !== c.id ? cur : s)),
      );
    },
    stopSharing: (c) => void stopSharing(c),
    copyLink: (c) => void copy(c),
    archive: (c) =>
      void save(c, { archived: true }, "We could not archive the chat.").then((s) => {
        if (!s) return;
        cb.current.onGone(c.id);
        toast.success("Chat archived.", {
          action: { label: "Undo", onClick: () => void restore(s, true) },
          classNames: { actionButton: UNDO_BUTTON },
        });
      }),
    restore: (c) => void restore(c),
    askDelete: (c) => later(() => setDeleting(c)),
    dialogs,
  };
}

/** The ⋯ menu for one chat, in a history row and in the panel header. */
export function chatMenuGroups(
  c: ChatSummary,
  api: ChatHistoryApi,
  onRename: () => void,
): RowMenuGroup[] {
  if (c.archived_at)
    return [
      {
        items: [
          {
            label: "Restore",
            icon: <ArchiveRestore className="size-4" />,
            onSelect: () => api.restore(c),
          },
        ],
      },
      {
        items: [
          {
            label: "Delete",
            icon: <Trash2 className="size-4" />,
            onSelect: () => api.askDelete(c),
          },
        ],
      },
    ];
  return [
    {
      items: [
        { label: "Rename", icon: <Pencil className="size-4" />, onSelect: onRename },
        c.pinned_at
          ? {
              label: "Unpin",
              icon: <PinOff className="size-4" />,
              onSelect: () => api.setPinned(c, false),
            }
          : {
              label: "Pin",
              icon: <Pin className="size-4" />,
              onSelect: () => api.setPinned(c, true),
            },
        c.shared_at
          ? {
              label: "Stop sharing",
              icon: <Link2Off className="size-4" />,
              onSelect: () => api.stopSharing(c),
            }
          : { label: "Share", icon: <Share2 className="size-4" />, onSelect: () => api.share(c) },
        c.shared_at
          ? {
              label: "Copy link",
              icon: <LinkIcon className="size-4" />,
              onSelect: () => api.copyLink(c),
            }
          : null,
      ],
    },
    {
      items: [
        { label: "Archive", icon: <Archive className="size-4" />, onSelect: () => api.archive(c) },
        { label: "Delete", icon: <Trash2 className="size-4" />, onSelect: () => api.askDelete(c) },
      ],
    },
  ];
}

/**
 * A title edited in place: Enter or leaving the field saves, Escape cancels, an empty title
 * is refused.
 */
export function InlineTitle({
  value,
  onSave,
  onCancel,
  className,
}: {
  value: string;
  onSave: (title: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [text, setText] = useDefaultState(value);
  const [invalid, setInvalid] = React.useState(false);
  const ref = React.useRef<HTMLInputElement>(null);
  const done = React.useRef(false);
  const born = React.useRef(0);
  React.useEffect(() => {
    born.current = performance.now();
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    const t = cleanTitle(text);
    done.current = true;
    if (save && t) onSave(t);
    else onCancel();
  };
  return (
    <Input
      ref={ref}
      value={text}
      maxLength={TITLE_MAX}
      aria-label="Chat title"
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setText(e.target.value);
        setInvalid(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (!cleanTitle(text)) {
            setInvalid(true);
            toast.error("We could not rename the chat.", {
              description: "The title is empty. Enter a title.",
            });
            return;
          }
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => {
        // A menu that opened this field gives focus back to its trigger as it closes.
        if (performance.now() - born.current < 500) {
          window.setTimeout(() => ref.current?.focus(), 0);
          return;
        }
        finish(true);
      }}
      className={cn("h-8 min-w-0 flex-1 px-2 text-sm md:text-sm", className)}
    />
  );
}

function Highlighted({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  return (
    <>
      {highlightParts(text, q).map((p, i) =>
        p.match ? (
          <mark key={i} className="bg-transparent font-medium text-inherit">
            {p.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{p.text}</React.Fragment>
        ),
      )}
    </>
  );
}

function openRowMenu(row: HTMLElement) {
  const trigger = row
    .closest("[data-history-item]")
    ?.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]');
  if (!trigger) return;
  trigger.focus();
  trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function ChatRow({
  c,
  api,
  tz,
  current,
  onOpen,
}: {
  c: ChatSummary;
  api: ChatHistoryApi;
  tz: string;
  current: boolean;
  onOpen: (c: ChatSummary) => void;
}) {
  const renaming = api.renaming?.id === c.id && api.renaming.where === "row";
  const snippet = api.searched && c.snippet ? c.snippet : null;
  return (
    <li
      data-history-item
      className={cn(
        "group flex min-h-9 items-center gap-0.5 rounded-md pr-0.5 pointer-coarse:min-h-11",
        current ? "bg-muted" : "hover:bg-muted/60",
      )}
    >
      {renaming ? (
        <div className="flex min-w-0 flex-1 px-1 py-0.5">
          <InlineTitle
            value={c.title}
            onSave={(t) => api.rename(c, t)}
            onCancel={() => api.setRenaming(null)}
          />
        </div>
      ) : (
        <>
          <button
            type="button"
            data-history-row
            aria-current={current ? "true" : undefined}
            title={c.title}
            onClick={() => onOpen(c)}
            className="flex min-w-0 flex-1 flex-col gap-0.5 self-stretch rounded-md px-2 py-1.5 text-left"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {c.pinned_at ? (
                <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />
              ) : null}
              <span className={cn("min-w-0 flex-1 truncate text-sm", current && "font-medium")}>
                <Highlighted text={c.title} q={api.searched} />
              </span>
              {c.shared_at ? <Chip>Shared</Chip> : null}
              <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {chatTime(c.updated_at, tz)}
              </span>
            </span>
            {snippet ? (
              <span className="line-clamp-2 text-xs text-muted-foreground">
                <Highlighted text={snippet} q={api.searched} />
              </span>
            ) : null}
          </button>
          <span className="shrink-0 pointer-fine:opacity-0 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 pointer-fine:has-data-[state=open]:opacity-100">
            <RowMenu
              label={c.title}
              groups={chatMenuGroups(c, api, () => api.setRenaming({ id: c.id, where: "row" }))}
            />
          </span>
        </>
      )}
    </li>
  );
}

function RowsLoading() {
  const widths = ["72%", "54%", "64%", "46%", "68%", "58%"];
  return (
    <div className="flex flex-col gap-0.5" aria-busy="true" aria-label="Loading chats">
      <Skeleton className="mx-2 mt-2 mb-1.5 h-3 w-16" />
      {widths.map((w) => (
        <div key={w} className="flex h-9 items-center gap-3 px-2 pointer-coarse:h-11">
          <Skeleton className="h-3.5" style={{ width: w }} />
          <Skeleton className="ml-auto h-3 w-10" />
        </div>
      ))}
    </div>
  );
}

/**
 * The history view: a search field, Chats / Archived, then the chats grouped by date in the
 * business time zone. `/` focuses the search; Escape clears it, then goes back to the chat.
 */
export function ChatHistory({
  api,
  tz,
  current,
  onOpen,
  onExit,
  focusKey,
}: {
  api: ChatHistoryApi;
  tz: string;
  current: string | null;
  onOpen: (c: ChatSummary) => void;
  /** Back to the chat. */
  onExit: () => void;
  /** Focus the search each time this changes (the view opened). */
  focusKey: number;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const listId = React.useId();

  React.useEffect(() => {
    if (focusKey) inputRef.current?.focus();
  }, [focusKey]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]")) return;
      if (!panelEl()?.contains(t)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const rows = () => [
    ...(rootRef.current?.querySelectorAll<HTMLElement>("[data-history-row]") ?? []),
  ];
  const onListKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement;
    // A menu or dialog portalled out of the list keeps its own keys.
    if (!e.currentTarget.contains(t) || t.tagName === "INPUT" || e.defaultPrevented) return;
    const list = rows();
    const at = list.indexOf(t);
    const go = (i: number) => {
      e.preventDefault();
      if (i < 0) inputRef.current?.focus();
      else list[Math.min(i, list.length - 1)]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (at >= 0 && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      e.preventDefault();
      openRowMenu(t);
    }
  };
  // Escape anywhere in the view goes back to the chat (the search field clears first).
  const onRootKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.defaultPrevented) return;
    if (!e.currentTarget.contains(e.target as Node)) return;
    e.preventDefault();
    onExit();
  };

  const groups = api.items ? groupChats(api.items, tz) : [];
  const archived = api.view === "archived";
  let body: React.ReactNode;
  if (api.failed && !api.items)
    body = (
      <ErrorState
        className="mx-1 mt-2"
        title="We could not load your chats."
        description={`${api.failed} Try again.`}
        action={
          <Button type="button" size="sm" variant="outline" onClick={api.reload}>
            Try again
          </Button>
        }
      />
    );
  else if (!api.items) body = <RowsLoading />;
  else if (!api.items.length)
    body = api.searched ? (
      <EmptyState
        compact
        icon={<SearchX />}
        title="No chats match your search."
        action={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              api.setQuery("");
              inputRef.current?.focus();
            }}
          >
            Clear search
          </Button>
        }
      />
    ) : archived ? (
      <EmptyState
        compact
        title="No archived chats."
        description="Chats that you archive show here. You can restore them."
      />
    ) : (
      <EmptyState
        compact
        title="No chats yet."
        description={`Ask ${ASSISTANT_NAME} a question to start a chat.`}
      />
    );
  else
    body = (
      // One block: the list fades in as a whole when its results change.
      <div key={`${api.view}|${api.searched}`} className="anim-fade flex flex-col">
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label} className="flex flex-col">
            <h3 className="m-0 px-2 pt-3 pb-1 text-xs font-normal text-muted-foreground first:pt-1">
              {g.label}
            </h3>
            <ul role="list" className="m-0 flex list-none flex-col gap-px p-0">
              {g.items.map((c) => (
                <ChatRow
                  key={c.id}
                  c={c}
                  api={api}
                  tz={tz}
                  current={c.id === current}
                  onOpen={onOpen}
                />
              ))}
            </ul>
          </section>
        ))}
        {api.hasMore ? (
          <div className="flex justify-center pt-2 pb-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={api.loadingMore}
              onClick={api.loadMore}
            >
              {api.loadingMore ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Load more
            </Button>
          </div>
        ) : null}
      </div>
    );

  return (
    <div ref={rootRef} onKeyDown={onRootKey} className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b px-3 py-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            value={api.query}
            onChange={(e) => api.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                if (api.query) api.setQuery("");
                else onExit();
              } else if (e.key === "ArrowDown") {
                const first = rows()[0];
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            placeholder="Search chats"
            aria-label="Search chats"
            aria-controls={listId}
            className="peer h-8 px-8 md:text-sm"
          />
          {api.query ? (
            <button
              type="button"
              onClick={() => {
                api.setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute top-1 right-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Clear search"
              title="Clear search"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : (
            <Kbd
              aria-hidden
              className="pointer-events-none absolute top-1 right-1 peer-focus:hidden pointer-coarse:hidden"
            >
              /
            </Kbd>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div role="group" aria-label="Chat list" className={cn(SEGMENT_TRACK, "p-0.5")}>
            <SegmentIndicator />
            {(
              [
                ["active", "Chats"],
                ["archived", "Archived"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={api.view === v}
                onClick={() => api.setView(v)}
                className={segmentItem(api.view === v, "h-7 px-3")}
              >
                {label}
              </button>
            ))}
          </div>
          <span aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
            {api.searched && api.items ? resultLabel(api.items.length, api.hasMore) : null}
          </span>
        </div>
      </div>
      <div id={listId} onKeyDown={onListKey} className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {body}
      </div>
    </div>
  );
}

/** The open chat's title over the conversation: select it to rename; the ⋯ has the rest. */
export function ChatTitleBar({ chat, api }: { chat: ChatSummary; api: ChatHistoryApi }) {
  const renaming = api.renaming?.id === chat.id && api.renaming.where === "header";
  const startRename = () => api.setRenaming({ id: chat.id, where: "header" });
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b pr-2 pl-2">
      {renaming ? (
        <InlineTitle
          value={chat.title}
          onSave={(t) => api.rename(chat, t)}
          onCancel={() => api.setRenaming(null)}
        />
      ) : (
        <button
          type="button"
          onClick={startRename}
          title={chat.title}
          aria-label={`Rename chat: ${chat.title}`}
          className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm font-medium hover:bg-muted/60"
        >
          {chat.title}
        </button>
      )}
      {chat.pinned_at ? (
        <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pinned" />
      ) : null}
      {chat.shared_at ? <Chip>Shared</Chip> : null}
      {renaming ? null : (
        <RowMenu label={chat.title} groups={chatMenuGroups(chat, api, startRename)} />
      )}
    </div>
  );
}
