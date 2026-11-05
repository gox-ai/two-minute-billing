"use client";

import * as React from "react";
import { Check, ChevronDown, Pencil, Star, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ListServerFilter } from "@/components/patterns/list-filters";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SavedView {
  id: string;
  entity: string;
  name: string;
  owner: string;
  /**
   * Whether the SIGNED-IN operator owns it — stated by the engine, not worked out here.
   * The browser has no reliable answer to "who am I": the actor is resolved from the
   * session server-side, so comparing an email the client happens to hold would be a
   * guess, and only the owner may rename, re-share, default or delete a view.
   */
  is_mine: boolean;
  visibility: "private" | "everyone";
  filters: ListServerFilter[];
  search: string | null;
  sort_field: string | null;
  sort_desc: boolean | null;
  hidden_columns: string[] | null;
  is_default: boolean;
}

/** The list state a view captures — what gets saved and what gets compared for dirtiness. */
export interface ViewState {
  filters: ListServerFilter[];
  search: string;
  sort: { field: string; desc: boolean } | null;
  /** Column ids currently hidden, or null when the list isn't tracking them. */
  hiddenColumns: string[] | null;
}

export interface ViewDraft {
  name: string;
  visibility: "private" | "everyone";
  is_default: boolean;
  /** Save the current column choice with the view, not just its filters. */
  include_columns: boolean;
}

/**
 * A stable string for one list state, so "has the operator changed anything since they
 * picked this view?" is a comparison and not a deep-equality walk.
 *
 * Filters are SORTED before hashing. Without that, adding then removing a condition
 * leaves the same set in a different order and the list reads as dirty forever — the
 * Save button never goes away and the operator learns to ignore it.
 */
export function viewStateKey(s: ViewState): string {
  return JSON.stringify({
    filters: [...s.filters].map((f) => `${f.field}:${f.op}:${f.value}`).sort(),
    search: s.search.trim(),
    sort: s.sort ? `${s.sort.desc ? "-" : ""}${s.sort.field}` : null,
    hidden: s.hiddenColumns ? [...s.hiddenColumns].sort() : null,
  });
}

/** The same key for a stored view, so the two are comparable. */
export function savedViewStateKey(v: SavedView, trackColumns: boolean): string {
  return viewStateKey({
    filters: v.filters,
    search: v.search ?? "",
    sort: v.sort_field ? { field: v.sort_field, desc: !!v.sort_desc } : null,
    // A view that saved no column choice must not read as dirty just because the list
    // is hiding its own defaults — "didn't capture columns" is not "captured empty".
    hiddenColumns: trackColumns ? (v.hidden_columns ?? null) : null,
  });
}

// ── Data hook ─────────────────────────────────────────────────────────────────

interface MutationResult {
  ok: boolean;
  error?: string;
}

async function send(
  url: string,
  method: string,
  body?: unknown,
): Promise<MutationResult & { view?: SavedView }> {
  const res = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.status === 204) return { ok: true };
  const json = (await res.json().catch(() => ({}))) as { error?: string } & SavedView;
  // The engine's own sentence is forwarded all the way here — "You already have a view
  // called 'Overdue' on this list" is fixable; "Could not save" is not.
  if (!res.ok) return { ok: false, error: json.error ?? `HTTP ${res.status}` };
  return { ok: true, view: json };
}

/**
 * Saved views for one list. Loads once on mount and after every mutation.
 *
 * Failure is surfaced, never swallowed: if views cannot load, the dropdown says so and
 * still offers the built-in segments — a silently empty Views menu would read as "you
 * have no saved views", which is a different and wrong statement.
 */
export function useSavedViews(entity: string, biz?: string) {
  const [views, setViews] = React.useState<SavedView[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const url = React.useMemo(() => {
    const qs = new URLSearchParams({ entity });
    if (biz) qs.set("business", biz);
    return `/api/list-views?${qs.toString()}`;
  }, [entity, biz]);

  const reload = React.useCallback(async () => {
    // An empty entity means this list has no saved views. `ListPage` calls the hook
    // unconditionally (React requires it) and passes '' in that case, so the no-op has
    // to live here rather than as a conditional hook at the call site.
    if (!entity) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(url);
      const json = (await res.json().catch(() => ({}))) as { data?: SavedView[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setViews(json.data ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [url, entity]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const create = React.useCallback(
    async (state: ViewState, draft: ViewDraft) => {
      const res = await send("/api/list-views", "POST", {
        entity,
        ...(biz ? { business: biz } : {}),
        name: draft.name,
        visibility: draft.visibility,
        is_default: draft.is_default,
        filters: state.filters,
        search: state.search.trim() || null,
        sort_field: state.sort?.field ?? null,
        sort_desc: state.sort?.desc ?? null,
        hidden_columns: draft.include_columns ? (state.hiddenColumns ?? []) : null,
      });
      if (res.ok) await reload();
      return res;
    },
    [entity, biz, reload],
  );

  /** Overwrite a view with the state on screen ("Update view"). */
  const saveOver = React.useCallback(
    async (id: string, state: ViewState, includeColumns: boolean) => {
      const res = await send(`/api/list-views/${id}`, "PATCH", {
        filters: state.filters,
        search: state.search.trim() || null,
        sort_field: state.sort?.field ?? null,
        sort_desc: state.sort?.desc ?? null,
        hidden_columns: includeColumns ? (state.hiddenColumns ?? []) : null,
      });
      if (res.ok) await reload();
      return res;
    },
    [reload],
  );

  const patch = React.useCallback(
    async (id: string, body: Partial<Pick<SavedView, "name" | "visibility" | "is_default">>) => {
      const res = await send(`/api/list-views/${id}`, "PATCH", body);
      if (res.ok) await reload();
      return res;
    },
    [reload],
  );

  const duplicate = React.useCallback(
    async (id: string) => {
      const res = await send(`/api/list-views/${id}`, "POST", {});
      if (res.ok) await reload();
      return res;
    },
    [reload],
  );

  const remove = React.useCallback(
    async (id: string) => {
      const res = await send(`/api/list-views/${id}`, "DELETE");
      if (res.ok) await reload();
      return res;
    },
    [reload],
  );

  return { views, loading, error, reload, create, saveOver, patch, duplicate, remove };
}

// ── The Views dropdown ────────────────────────────────────────────────────────

export interface SystemSegment {
  id: string;
  label: string;
}

/**
 * The `All Subscriptions ▾` menu: the list's built-in segments, then the operator's own
 * saved views, then the organization's shared ones.
 *
 * Selection only. Renaming, sharing, defaulting and deleting live in the Manage dialog
 * rather than as controls inside each row: a Radix menu item that contains its own
 * buttons swallows or double-fires the pointer events (see the `ui` skill's notes on
 * Radix pointerdown traps), and an editable list is a better shape for those actions
 * anyway.
 */
export function ViewsMenu({
  label,
  systemSegments,
  views,
  selectedId,
  loading,
  error,
  onSelect,
  onManage,
}: {
  label: string;
  systemSegments: SystemSegment[];
  views: SavedView[];
  selectedId: string;
  loading: boolean;
  error: string | null;
  onSelect: (id: string) => void;
  onManage: () => void;
}) {
  const mine = views.filter((v) => v.is_mine);
  const shared = views.filter((v) => !v.is_mine);

  const row = (id: string, text: React.ReactNode, trailing?: React.ReactNode) => (
    <DropdownMenuItem key={id} onSelect={() => onSelect(id)}>
      <span className="flex-1 truncate">{text}</span>
      {trailing}
      {id === selectedId ? <Check className="size-3.5" /> : null}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72 overflow-y-auto">
        {systemSegments.length > 0 ? (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Views
            </DropdownMenuLabel>
            {systemSegments.map((s) => row(s.id, s.label))}
          </>
        ) : null}

        {mine.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              My views
            </DropdownMenuLabel>
            {mine.map((v) =>
              row(
                v.id,
                v.name,
                <span className="flex items-center gap-1 text-muted-foreground">
                  {v.is_default ? <Star className="size-3" aria-label="My default" /> : null}
                  {v.visibility === "everyone" ? (
                    <Users className="size-3" aria-label="Shared" />
                  ) : null}
                </span>,
              ),
            )}
          </>
        ) : null}

        {shared.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Shared with the organization
            </DropdownMenuLabel>
            {shared.map((v) =>
              row(
                v.id,
                v.name,
                <span className="truncate text-xs text-muted-foreground">{v.owner}</span>,
              ),
            )}
          </>
        ) : null}

        {/* A load failure must not read as "no saved views" — that is a different claim. */}
        {error ? (
          <p className="px-2 py-1.5 text-xs text-destructive">
            We could not load the saved views: {error}
          </p>
        ) : loading && views.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading saved views…</p>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onManage}>
          <Pencil className="size-3.5" />
          Manage views…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ── Save dialog ───────────────────────────────────────────────────────────────

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Only me" },
  { value: "everyone", label: "Everyone in the organization" },
];

export function SaveViewDialog({
  open,
  onOpenChange,
  entityPlural,
  trackColumns,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityPlural: string;
  /** Whether the list can capture a column choice — hides the checkbox when it cannot. */
  trackColumns: boolean;
  onSave: (draft: ViewDraft) => Promise<MutationResult>;
}) {
  const [name, setName] = React.useState("");
  const [visibility, setVisibility] = React.useState<"private" | "everyone">("private");
  const [isDefault, setIsDefault] = React.useState(false);
  const [includeColumns, setIncludeColumns] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset on each open, so a failed save's message and a half-typed name don't come back
  // the next time the dialog is used.
  React.useEffect(() => {
    if (!open) return;
    setName("");
    setVisibility("private");
    setIsDefault(false);
    setIncludeColumns(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await onSave({
      name: name.trim(),
      visibility,
      is_default: isDefault,
      include_columns: trackColumns && includeColumns,
    });
    setSaving(false);
    if (res.ok) onOpenChange(false);
    else setError(res.error ?? "We could not save this view.");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Save view</DialogTitle>
          <DialogDescription>
            Saves the filters, search and sort on screen as a named view of{" "}
            {entityPlural.toLowerCase()}.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="view-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="view-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Overdue over ₹50k"
              maxLength={60}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-sm font-medium">Who can see it</span>
            <SelectField
              ariaLabel="Who can see it"
              value={visibility}
              onValueChange={(v) => setVisibility(v as "private" | "everyone")}
              options={VISIBILITY_OPTIONS}
            />
            <p className="text-xs text-muted-foreground">
              A shared view can be opened and duplicated by anyone, but only you can change it.
            </p>
          </div>

          <CheckboxField
            label="Open this view by default"
            hint="This affects only you."
            checked={isDefault}
            onCheckedChange={setIsDefault}
          />

          {trackColumns ? (
            <CheckboxField
              label="Remember the visible columns too"
              checked={includeColumns}
              onCheckedChange={setIncludeColumns}
            />
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save view"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Manage dialog ─────────────────────────────────────────────────────────────

/**
 * Rename, share, default, duplicate and delete — for the operator's OWN views.
 *
 * A colleague's shared view is listed read-only with a Duplicate button, because the
 * engine only lets its owner change it (`is_mine` on each row is the engine's own
 * verdict on that): a segment a finance team has come to rely on
 * must not be silently redefined by whoever opened it last, and "this view but with INR
 * too" is a view of your own.
 */
export function ManageViewsDialog({
  open,
  onOpenChange,
  views,
  onRename,
  onVisibility,
  onDefault,
  onDuplicate,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  views: SavedView[];
  onRename: (id: string, name: string) => Promise<MutationResult>;
  onVisibility: (id: string, visibility: "private" | "everyone") => Promise<MutationResult>;
  onDefault: (id: string, isDefault: boolean) => Promise<MutationResult>;
  onDuplicate: (id: string) => Promise<MutationResult>;
  onDelete: (id: string) => Promise<MutationResult>;
}) {
  const [editing, setEditing] = React.useState<string | null>(null);
  const [draftName, setDraftName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setEditing(null);
    setError(null);
    setConfirmDelete(null);
  }, [open]);

  const run = async (id: string, fn: () => Promise<MutationResult>) => {
    setBusy(id);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) setError(res.error ?? "We could not save that change.");
    return res.ok;
  };

  const mine = views.filter((v) => v.is_mine);
  const shared = views.filter((v) => !v.is_mine);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Manage views</DialogTitle>
          <DialogDescription>
            Rename, share or delete the views saved on this list.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              My views
            </h3>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                You have not saved a view here yet. Filter the list, then select Save view.
              </p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {mine.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 p-2.5">
                    {editing === v.id ? (
                      <>
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          maxLength={60}
                          className="h-8 w-56"
                          aria-label="View name"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          disabled={!draftName.trim() || busy === v.id}
                          onClick={async () => {
                            if (await run(v.id, () => onRename(v.id, draftName.trim())))
                              setEditing(null);
                          }}
                        >
                          Save
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <span className="flex-1 truncate text-sm font-medium">{v.name}</span>
                        <SelectField
                          ariaLabel={`Who can see ${v.name}`}
                          size="sm"
                          className="w-auto"
                          value={v.visibility}
                          onValueChange={(next) =>
                            void run(v.id, () => onVisibility(v.id, next as "private" | "everyone"))
                          }
                          options={VISIBILITY_OPTIONS}
                        />
                        <Button
                          variant={v.is_default ? "secondary" : "ghost"}
                          size="sm"
                          disabled={busy === v.id}
                          title={
                            v.is_default
                              ? "This view opens by default"
                              : "Open this view by default"
                          }
                          onClick={() => void run(v.id, () => onDefault(v.id, !v.is_default))}
                        >
                          <Star className="size-3.5" />
                          {v.is_default ? "Default" : "Set default"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDraftName(v.name);
                            setEditing(v.id);
                          }}
                        >
                          <Pencil className="size-3.5" /> Rename
                        </Button>
                        {/* Two-step delete, in place: a view is cheap to lose and cheap to
                            confirm, and a second dialog over this one is worse UX than a
                            row that asks. */}
                        {confirmDelete === v.id ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy === v.id}
                              onClick={() => void run(v.id, () => onDelete(v.id))}
                            >
                              Delete
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmDelete(null)}
                            >
                              Keep
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground"
                            aria-label={`Delete ${v.name}`}
                            onClick={() => setConfirmDelete(v.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        )}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {shared.length > 0 ? (
            <section className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                Shared with the organization
              </h3>
              <ul className="divide-y rounded-lg border">
                {shared.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 p-2.5">
                    <span className="flex-1 truncate text-sm font-medium">{v.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{v.owner}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-primary"
                      disabled={busy === v.id}
                      onClick={() => void run(v.id, () => onDuplicate(v.id))}
                    >
                      Duplicate
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Only the person who created a shared view can change it. Duplicate it to get an
                editable copy.
              </p>
            </section>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
