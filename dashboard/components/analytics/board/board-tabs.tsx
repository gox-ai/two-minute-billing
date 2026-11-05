"use client";

import * as React from "react";
import Link from "next/link";
import {
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { useNavPending } from "@/components/navigation/nav-pending";
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
import { cn } from "@/lib/utils";
import { SEGMENT_TRACK, segmentItem } from "@/components/ui/segmented";
import type { DashboardVisibility, ReportDashboard } from "@/lib/dashboards-api";

/**
 * The open dashboard, as a strip of tabs: built-in | mine | shared. Each tab is a link to
 * `?dash=`, so the choice is shareable and Back steps through it. The strip never scrolls:
 * what does not fit folds into a searchable More menu. New dashboard and Manage sit at its
 * right from lg.
 */

export interface DashboardMutationResult {
  ok: boolean;
  error?: string;
}

const VISIBILITY_OPTIONS = [
  { value: "private", label: "Only me" },
  { value: "everyone", label: "Everyone in the organization" },
];

/**
 * A built-in dashboard, by the shape of its id. The engine synthesises presets rather than
 * storing them, so the id prefix is the contract (`presetPublicId` in the dashboards module).
 */
const isPresetDashboard = (d: { id: string }) => d.id.startsWith("dash_preset_");

/** Tab gap (`gap-1`), a group divider, and the track's padding + border, in px — the
 *  arithmetic the measured fit uses. */
const GAP = 4;
// 1px rule plus its `mx-1` either side.
const DIVIDER = 9;
const TRACK = 10;

type Group = "builtin" | "mine" | "shared";

const GROUP_LABEL: Record<Group, string> = {
  builtin: "Built-in",
  mine: "Mine",
  shared: "Shared with you",
};

interface Entry {
  d: ReportDashboard;
  group: Group;
}

/**
 * Which tabs fit: in order, as many as the width allows, with room kept for More when any
 * fold. The open dashboard always keeps a tab — it replaces the last one that fits.
 */
function fitTabs(
  entries: Entry[],
  widths: Map<string, number>,
  moreWidth: number,
  available: number,
  selectedId: string | null,
): Set<string> {
  const cost = (list: Entry[], withMore: boolean) => {
    let total = 0;
    list.forEach((e, i) => {
      if (i > 0) total += GAP + (e.group !== list[i - 1]!.group ? DIVIDER + GAP : 0);
      total += widths.get(e.d.id) ?? 0;
    });
    return total + (withMore ? (list.length > 0 ? GAP : 0) + moreWidth : 0);
  };
  if (cost(entries, false) <= available) return new Set(entries.map((e) => e.d.id));

  const shown: Entry[] = [];
  for (const e of entries) {
    if (cost([...shown, e], true) > available) break;
    shown.push(e);
  }
  const open = entries.find((e) => e.d.id === selectedId);
  if (open && !shown.includes(open)) {
    const ordered = () => entries.filter((e) => e === open || shown.includes(e));
    while (shown.length > 0 && cost(ordered(), true) > available) shown.pop();
    shown.push(open);
  }
  return new Set(shown.map((e) => e.d.id));
}

export function BoardTabs({
  dashboards,
  selectedId,
  basePath,
  onCreate,
  onRename,
  onVisibility,
  onDefault,
  onDelete,
}: {
  dashboards: ReportDashboard[];
  selectedId: string | null;
  basePath: string;
  onCreate: (draft: {
    name: string;
    visibility: DashboardVisibility;
    is_default: boolean;
  }) => Promise<DashboardMutationResult & { id?: string }>;
  onRename: (id: string, name: string) => Promise<DashboardMutationResult>;
  onVisibility: (id: string, visibility: DashboardVisibility) => Promise<DashboardMutationResult>;
  onDefault: (id: string, isDefault: boolean) => Promise<DashboardMutationResult>;
  onDelete: (id: string) => Promise<DashboardMutationResult>;
}) {
  const { navigate, pendingFrom, target } = useNavPending();
  const pending = pendingFrom("dashboard");
  const hrefOf = (id: string) => `${basePath}?dash=${encodeURIComponent(id)}`;
  const onSelect = React.useCallback(
    (id: string) =>
      navigate(`${basePath}?dash=${encodeURIComponent(id)}`, { target: id, source: "dashboard" }),
    [navigate, basePath],
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [manageOpen, setManageOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);

  // Built-in first: presets have no owner, so they are not "shared" by anyone.
  const entries = React.useMemo<Entry[]>(
    () => [
      ...dashboards.filter(isPresetDashboard).map((d) => ({ d, group: "builtin" as const })),
      ...dashboards.filter((d) => d.is_mine).map((d) => ({ d, group: "mine" as const })),
      ...dashboards
        .filter((d) => !d.is_mine && !isPresetDashboard(d))
        .map((d) => ({ d, group: "shared" as const })),
    ],
    [dashboards],
  );
  const hasMine = entries.some((e) => e.group === "mine");

  // Measured from an invisible copy of every tab; null until the first measurement, when
  // every tab renders and the strip clips rather than scrolls.
  // The row is what is measured: the strip sizes to its tabs, so measuring the strip itself
  // would fold a tab, shrink, and never unfold it.
  const stripRef = React.useRef<HTMLDivElement>(null);
  const actionsRef = React.useRef<HTMLDivElement>(null);
  const measureRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState<Set<string> | null>(null);
  const [wrapActions, setWrapActions] = React.useState(false);

  React.useLayoutEffect(() => {
    const strip = stripRef.current;
    const measure = measureRef.current;
    if (!strip || !measure) return;
    const recompute = () => {
      const widths = new Map<string, number>();
      for (const el of measure.querySelectorAll<HTMLElement>("[data-tab-id]"))
        widths.set(el.dataset.tabId!, el.offsetWidth);
      const more = measure.querySelector<HTMLElement>("[data-more]")?.offsetWidth ?? 0;
      // The actions share the row while the open tab and More still fit beside them; past that
      // (a phone, or a narrow card beside the rail) they wrap under the strip.
      // offsetWidth rounds sub-pixel text widths, so keep a little slack.
      const slack = 8;
      const full = strip.clientWidth - TRACK - slack;
      const openWidth = (selectedId && widths.get(selectedId)) || 0;
      const besideRoom = full - (actionsRef.current?.offsetWidth ?? 0) - GAP * 2;
      const nextWrap = openWidth + GAP + more > besideRoom;
      setWrapActions(nextWrap);
      const next = fitTabs(entries, widths, more, nextWrap ? full : besideRoom, selectedId);
      setVisible((prev) =>
        prev && prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next,
      );
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [entries, selectedId]);

  const shown = visible ? entries.filter((e) => visible.has(e.d.id)) : entries;
  const folded = visible ? entries.filter((e) => !visible.has(e.d.id)) : [];

  const marks = (d: ReportDashboard) =>
    d.is_mine && (d.is_default || d.visibility === "everyone") ? (
      <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
        {d.is_default ? (
          <span
            className="rounded-md border px-1.5 text-xs leading-5 font-normal"
            title="My default"
          >
            Default
          </span>
        ) : null}
        {d.visibility === "everyone" ? <Users className="size-3.5" aria-label="Shared" /> : null}
      </span>
    ) : null;

  // A segment of the track; the open one may shrink (its name truncates), the rest keep size.
  const tabClass = (on: boolean) => segmentItem(on, on ? "min-w-0 shrink" : undefined);

  const titleOf = (e: Entry) =>
    e.group === "builtin"
      ? "Built-in dashboard"
      : e.group === "shared" && e.d.owner
        ? `Shared by ${e.d.owner}`
        : undefined;

  const tab = (e: Entry) => {
    const on = e.d.id === selectedId;
    return (
      <Link
        key={e.d.id}
        href={hrefOf(e.d.id)}
        aria-current={on ? "page" : undefined}
        title={titleOf(e)}
        onClick={(ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
          ev.preventDefault();
          onSelect(e.d.id);
        }}
        className={tabClass(on)}
      >
        <span className="truncate">{e.d.name}</span>
        {marks(e.d)}
        {pending && target === e.d.id ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
      </Link>
    );
  };

  const withDividers = (list: Entry[], render: (e: Entry) => React.ReactNode) =>
    list.map((e, i) => (
      <React.Fragment key={e.d.id}>
        {i > 0 && list[i - 1]!.group !== e.group ? (
          <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-input" />
        ) : null}
        {render(e)}
      </React.Fragment>
    ));

  // A modified click opens the link in a new tab; cmdk's select must not also navigate here.
  const modified = React.useRef(false);
  const groups = (["builtin", "mine", "shared"] as const)
    .map((g) => ({ g, items: entries.filter((e) => e.group === g) }))
    .filter((x) => x.items.length > 0);

  return (
    // The strip, then Manage and Create beside it; what does not fit folds into More.
    <div
      ref={stripRef}
      className={cn("mb-5 flex min-w-0 items-center gap-2", wrapActions && "flex-wrap")}
    >
      <div className="relative flex min-w-0 flex-[0_1_auto] items-center">
        <nav
          aria-label="Dashboards"
          className={cn(SEGMENT_TRACK, "min-w-0 flex-nowrap overflow-hidden")}
        >
          {withDividers(shown, tab)}
          {folded.length > 0 ? (
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="shrink-0 px-2 text-muted-foreground">
                  More ({folded.length})
                  <ChevronDown className="size-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                collisionPadding={16}
                className="w-80 max-w-[calc(100vw-2rem)] p-0"
              >
                {/* Substring on name + owner only: cmdk's default fuzzy match also scores the
                    id, so "probe" matched dash_preset_overview. */}
                <Command
                  filter={(_value, search, keywords) =>
                    (keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase())
                      ? 1
                      : 0
                  }
                >
                  <CommandInput placeholder="Find a dashboard" aria-label="Find a dashboard" />
                  <CommandList>
                    <CommandEmpty>No dashboard matches.</CommandEmpty>
                    {groups.map(({ g, items }) => (
                      <CommandGroup key={g} heading={GROUP_LABEL[g]}>
                        {items.map((e) => {
                          const on = e.d.id === selectedId;
                          return (
                            <CommandItem
                              key={e.d.id}
                              asChild
                              value={e.d.id}
                              keywords={[e.d.name, e.d.owner ?? ""]}
                              onSelect={() => {
                                setMoreOpen(false);
                                if (modified.current) modified.current = false;
                                else onSelect(e.d.id);
                              }}
                            >
                              <Link
                                href={hrefOf(e.d.id)}
                                aria-current={on ? "page" : undefined}
                                onClick={(ev) => {
                                  modified.current =
                                    ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey;
                                  if (!modified.current) ev.preventDefault();
                                }}
                                className={cn("min-h-8", on && "font-semibold")}
                              >
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate">{e.d.name}</span>
                                  {e.group === "shared" && e.d.owner ? (
                                    <span className="block text-xs wrap-break-word text-muted-foreground">
                                      {e.d.owner}
                                    </span>
                                  ) : null}
                                </span>
                                {marks(e.d)}
                                {on ? <Check className="size-3.5 text-foreground" /> : null}
                              </Link>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          ) : null}
          {dashboards.length === 0 ? (
            <span className="inline-flex h-8 items-center px-3 text-sm text-muted-foreground">
              No saved dashboards yet.
            </span>
          ) : null}
        </nav>

        {/* The measuring copy: every tab at its natural width, plus a More at its widest. */}
        <div aria-hidden className="pointer-events-none invisible absolute size-0 overflow-hidden">
          <div ref={measureRef} className="flex w-max items-center gap-1">
            {entries.map((e) => (
              <span key={e.d.id} data-tab-id={e.d.id} className={tabClass(false)}>
                <span className="font-semibold">{e.d.name}</span>
                {marks(e.d)}
              </span>
            ))}
            <span
              data-more
              // Matches the real trigger: Button `sm` keeps `has-[>svg]:px-2.5` over a `px-2`.
              className="inline-flex h-8 items-center gap-1.5 px-2.5 text-sm font-medium"
            >
              More ({entries.length})
              <ChevronDown className="size-3.5" />
            </span>
          </div>
        </div>
      </div>

      <div ref={actionsRef} className="flex shrink-0 items-center gap-2">
        {hasMine ? (
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Manage"
            title="Manage"
            onClick={() => setManageOpen(true)}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="size-3.5" />
          Create dashboard
        </Button>
      </div>

      <CreateDashboardDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={onCreate}
        onCreated={onSelect}
      />
      <ManageDashboardsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        dashboards={dashboards}
        onRename={onRename}
        onVisibility={onVisibility}
        onDefault={onDefault}
        onDelete={onDelete}
      />
    </div>
  );
}

function CreateDashboardDialog({
  open,
  onOpenChange,
  onCreate,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (draft: {
    name: string;
    visibility: DashboardVisibility;
    is_default: boolean;
  }) => Promise<DashboardMutationResult & { id?: string }>;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = React.useState("");
  const [visibility, setVisibility] = React.useState<DashboardVisibility>("private");
  const [isDefault, setIsDefault] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Reset on each open: a failed save's message and a half-typed name must not come back.
  React.useEffect(() => {
    if (!open) return;
    setName("");
    setVisibility("private");
    setIsDefault(false);
    setError(null);
  }, [open]);

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await onCreate({ name: name.trim(), visibility, is_default: isDefault });
    setSaving(false);
    if (!res.ok) {
      setError(res.error ?? "We could not save this dashboard");
      return;
    }
    onOpenChange(false);
    if (res.id) onCreated(res.id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Create dashboard</DialogTitle>
          <DialogDescription>
            A dashboard is a named arrangement of reports. Add reports to it after you create it.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="dashboard-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="dashboard-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void submit()}
              placeholder="Monday morning"
              maxLength={60}
              autoFocus
            />
          </div>

          {/* Not a <label>: the trigger is a button, and a label wrapping one swallows the
              click. A visible span plus aria-label on the control. */}
          <div className="space-y-1.5">
            <span className="text-sm font-medium">Who can see it</span>
            <SelectField
              ariaLabel="Who can see it"
              value={visibility}
              onValueChange={(v) => setVisibility(v as DashboardVisibility)}
              options={VISIBILITY_OPTIONS}
            />
            <p className="text-xs text-muted-foreground">
              Anyone in the organization can open a shared dashboard. Only you can change it.
            </p>
          </div>

          <CheckboxField
            label="Open this dashboard by default"
            hint="This affects only you."
            checked={isDefault}
            onCheckedChange={setIsDefault}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Create dashboard"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Rename, share, default and delete — for the operator's OWN dashboards only.
 *
 * A colleague's shared dashboard is listed read-only: `is_mine` is the engine's verdict on
 * who may change it, and a layout a team has come to rely on must not be redefined by
 * whoever opened it last. There is no Duplicate here, unlike saved views: the engine has no
 * duplicate endpoint for dashboards, and a button that cannot reach a field is worse than
 * none.
 */
function ManageDashboardsDialog({
  open,
  onOpenChange,
  dashboards,
  onRename,
  onVisibility,
  onDefault,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dashboards: ReportDashboard[];
  onRename: (id: string, name: string) => Promise<DashboardMutationResult>;
  onVisibility: (id: string, visibility: DashboardVisibility) => Promise<DashboardMutationResult>;
  onDefault: (id: string, isDefault: boolean) => Promise<DashboardMutationResult>;
  onDelete: (id: string) => Promise<DashboardMutationResult>;
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

  const run = async (id: string, fn: () => Promise<DashboardMutationResult>) => {
    setBusy(id);
    setError(null);
    const res = await fn();
    setBusy(null);
    if (!res.ok) setError(res.error ?? "We could not save that change");
    return res.ok;
  };

  const mine = dashboards.filter((d) => d.is_mine);
  // Presets are excluded: there is nothing to rename, re-share or delete, so listing them
  // here would offer controls that cannot work.
  const shared = dashboards.filter((d) => !d.is_mine && !isPresetDashboard(d));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Manage dashboards</DialogTitle>
          <DialogDescription>
            Rename, share or delete the dashboards saved for this business.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <div className="space-y-4">
          <section className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              My dashboards
            </h3>
            {mine.length === 0 ? (
              <p className="text-sm text-muted-foreground">You have not saved one yet.</p>
            ) : (
              <ul className="divide-y rounded-lg border">
                {mine.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 p-2.5">
                    {editing === d.id ? (
                      <>
                        <Input
                          value={draftName}
                          onChange={(e) => setDraftName(e.target.value)}
                          maxLength={60}
                          className="h-8 w-56"
                          aria-label="Dashboard name"
                          autoFocus
                        />
                        <Button
                          size="sm"
                          disabled={!draftName.trim() || busy === d.id}
                          onClick={async () => {
                            if (await run(d.id, () => onRename(d.id, draftName.trim())))
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
                        <span className="flex-1 truncate text-sm font-medium">{d.name}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {d.tile_count} {d.tile_count === 1 ? "report" : "reports"}
                        </span>
                        <SelectField
                          ariaLabel={`Who can see ${d.name}`}
                          size="sm"
                          className="w-auto"
                          value={d.visibility}
                          onValueChange={(next) =>
                            void run(d.id, () => onVisibility(d.id, next as DashboardVisibility))
                          }
                          options={VISIBILITY_OPTIONS}
                        />
                        <Button
                          variant={d.is_default ? "secondary" : "ghost"}
                          size="sm"
                          disabled={busy === d.id}
                          title={
                            d.is_default
                              ? "This dashboard opens by default"
                              : "Open this dashboard by default"
                          }
                          onClick={() => void run(d.id, () => onDefault(d.id, !d.is_default))}
                        >
                          <Star className="size-3.5" />
                          {d.is_default ? "Default" : "Set default"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDraftName(d.name);
                            setEditing(d.id);
                          }}
                        >
                          <Pencil className="size-3.5" /> Rename
                        </Button>
                        {/* Two-step delete in place: a second dialog over this one is worse
                            than a row that asks. */}
                        {confirmDelete === d.id ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              disabled={busy === d.id}
                              onClick={() => void run(d.id, () => onDelete(d.id))}
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
                            aria-label={`Delete ${d.name}`}
                            onClick={() => setConfirmDelete(d.id)}
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
                {shared.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 p-2.5">
                    <span className="flex-1 truncate text-sm font-medium">{d.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{d.owner}</span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                Only the person who created a shared dashboard can change it.
              </p>
            </section>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
