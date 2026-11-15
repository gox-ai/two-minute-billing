"use client";

import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Search } from "lucide-react";
import type { PlanRequest, TransferItem, TransferRun } from "@/lib/api/transfer";
import type { RunResult } from "@/app/(dashboard)/businesses/[biz]/transfer/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { Chip } from "@/components/patterns/chip";
import { MoreMenu } from "@/components/patterns/more-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDebounced } from "@/lib/use-debounced";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/labels";
import { filterCount, resultCounts, withoutPinned, type ResultFilter } from "@/lib/transfer-items";
import { SECTIONS, SECTION_LABEL, fieldLabel } from "./sections";
import { KIND_LABEL, KIND_TONE, canLeaveOut, flatDiff, kindOf, show } from "./classify";
import { requestOf } from "./seed";
import { ConfirmCopyDialog } from "./ConfirmCopyDialog";
import { ActionBar } from "./RouteBand";
import { useItemPages, type InitialPage, type ListItemsAction } from "./use-item-pages";
import { PLAN_BLOCKED_QUERY } from "./plan-queries";

/** How many warnings the alert lists before "and N more". */
const LIST_MAX = 8;

function MessageList({ entries }: { entries: Array<{ key: string; message: string }> }) {
  const shown = entries.slice(0, LIST_MAX);
  return (
    <ul className="list-inside list-disc space-y-1">
      {shown.map((e, i) => (
        <li key={`${e.key}:${i}`}>{e.message}</li>
      ))}
      {entries.length > LIST_MAX && <li>And {entries.length - LIST_MAX} more.</li>}
    </ul>
  );
}

const SECTION_ORDER: string[] = [...SECTIONS.map((s) => s.id), "numbering"];
const sectionName = (s: string) => SECTION_LABEL[s] ?? s;
/** `product_group` → "Product group". */
const kindName = (k: string) => fieldLabel(k);

/** The first pages the server loaded: the default list and the blocked items. */
export interface PlanInitial {
  list: InitialPage | null;
  blocked: InitialPage | null;
}

type Tab = Exclude<ResultFilter, "new" | "updated" | "deleted">;

/** The stored plan: outcome tabs, sections, the paged items with leave-out, then the apply. */
export function PlanReview({
  biz,
  run,
  names,
  canOverride,
  initial,
  planAction,
  setItemsAction,
  applyAction,
  listItems,
  excludedKeys,
  onRun,
  onChangeOptions,
}: {
  biz: string;
  run: TransferRun;
  names: (id: string, bare?: boolean) => string;
  canOverride: boolean;
  initial?: PlanInitial | null;
  planAction: (biz: string, body: PlanRequest) => Promise<RunResult>;
  setItemsAction: (
    biz: string,
    run: string,
    change: { exclude?: string[]; include?: string[] },
  ) => Promise<RunResult>;
  applyAction: (biz: string, run: string, confirm?: string) => Promise<RunResult>;
  listItems: ListItemsAction;
  excludedKeys: (biz: string, run: string) => Promise<string[] | null>;
  onRun: (run: TransferRun) => void;
  onChangeOptions: (exclude: string[]) => void;
}) {
  const [busy, setBusy] = React.useState<"check" | "items" | "apply" | "options" | null>(null);
  const [section, setSection] = React.useState("all");
  const [result, setResult] = React.useState<Tab>("changes");
  const [search, setSearch] = React.useState("");
  const q = useDebounced(search.trim(), 250);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const summary = run.summary;
  const errors = run.validation?.errors ?? [];
  const warnings = run.validation?.warnings ?? [];
  const destName = names(run.destination_business, true);
  // With its mode: a test twin shares its live business's name.
  const destLabel = names(run.destination_business);
  const srcName = names(run.source_business, true);
  const twin = summary.sections.some((s) => s.pair === "twin");
  const totals = summary.results;
  const counts = resultCounts(summary, section);
  const writes = filterCount(totals, "changes");
  const blockedCount = totals.blocked;
  const blockedKeys = (summary.blocked ?? []).map((b) => b.key);
  const sectionIds = [...new Set(summary.sections.map((s) => s.section))].sort(
    (a, b) => (SECTION_ORDER.indexOf(a) + 1 || 99) - (SECTION_ORDER.indexOf(b) + 1 || 99),
  );
  // A refresh of the lists after any change to the plan.
  const token = `${run.updated_at}:${run.status}`;

  const query = {
    ...(section !== "all" ? { section } : {}),
    ...(result !== "all" ? { result } : {}),
    ...(q ? { q } : {}),
  };
  const list = useItemPages({
    biz,
    run: run.id,
    query,
    token,
    listItems,
    initial: initial?.list,
  });
  const pinnedOn = blockedCount > 0 && (result === "changes" || result === "all");
  const pinnedPages = useItemPages({
    biz,
    run: run.id,
    query: PLAN_BLOCKED_QUERY,
    token,
    listItems,
    initial: initial?.blocked,
    enabled: pinnedOn,
  });
  const pinned = pinnedOn ? pinnedPages.items : [];
  const shown = withoutPinned(list.items, pinned);
  // Counted from the summary; a search narrows the list below what the counts know.
  const total = filterCount(counts, result);

  async function keysLeftOut(): Promise<string[] | null> {
    if (totals.left_out === 0) return [];
    const keys = await excludedKeys(biz, run.id);
    if (!keys) toast.error("We could not read the items that are left out. Try again.");
    return keys;
  }

  async function recheck(exclude?: string[]) {
    setBusy("check");
    try {
      const keys = exclude ?? (await keysLeftOut());
      if (!keys) return;
      const r = await planAction(biz, requestOf(run, keys));
      if (r.ok) onRun(r.run);
      else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  }

  async function changeOptions() {
    setBusy("options");
    try {
      const keys = await keysLeftOut();
      if (keys) onChangeOptions(keys);
    } finally {
      setBusy(null);
    }
  }

  async function change(c: { exclude?: string[]; include?: string[] }) {
    setBusy("items");
    try {
      const r = await setItemsAction(biz, run.id, c);
      if (r.ok) onRun(r.run);
      else toast.error(r.message);
    } finally {
      setBusy(null);
    }
  }

  async function apply(confirm?: string) {
    setBusy("apply");
    try {
      const r = await applyAction(biz, run.id, confirm);
      if (r.ok) {
        setConfirmOpen(false);
        toast.success("Copy started.");
        onRun(r.run);
        return;
      }
      toast.error(r.message);
      if (r.drift) {
        setConfirmOpen(false);
        setBusy(null);
        await recheck();
      }
    } finally {
      setBusy(null);
    }
  }

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  // Plan order. A heading starts each run of one pair and section, with its count.
  const headOf = (i: TransferItem) => {
    const s = summary.sections.find((x) => x.pair === i.pair && x.section === i.section);
    const pair = twin ? (i.pair === "twin" ? "Test businesses · " : "Live businesses · ") : "";
    return `${pair}${sectionName(i.section)}${s ? ` · ${filterCount(s.results, result).toLocaleString("en-US")}` : ""}`;
  };
  const rows: Array<{ head: string; key: string } | { item: TransferItem }> = [];
  let last = "";
  for (const i of shown) {
    const head = headOf(i);
    if (head !== last) rows.push({ head, key: `h:${rows.length}` });
    last = head;
    rows.push({ item: i });
  }
  const loadingFirst = list.loading && list.items.length === 0;
  const filtered = section !== "all" || search !== "";
  // Pinned items the list would also hold; they show once, above it.
  const pinnedHere =
    result === "all" ? pinned.filter((i) => section === "all" || i.section === section).length : 0;
  const showing = q
    ? `Showing ${shown.length.toLocaleString("en-US")}`
    : `Showing ${shown.length.toLocaleString("en-US")} of ${Math.max(0, total - pinnedHere).toLocaleString("en-US")}`;

  const changeSub =
    (
      [
        ["new", "new"],
        ["updated", "updated"],
        ["deleted", "deleted"],
      ] as const
    )
      .filter(([k]) => totals[k] > 0)
      .map(([k, w]) => `${totals[k].toLocaleString("en-US")} ${w}`)
      .join(" · ") || "Nothing changes";
  const tabs: Array<{ id: Tab; label: string; n: number; sub: string; red?: boolean }> = [
    { id: "changes", label: "Changes", n: writes, sub: changeSub },
    {
      id: "blocked",
      label: "Blocked",
      n: blockedCount,
      sub: blockedCount ? "Cannot be copied" : "Nothing blocked",
      red: blockedCount > 0,
    },
    { id: "unchanged", label: "Unchanged", n: totals.unchanged, sub: "Same in both" },
    ...(totals.kept > 0 || result === "kept"
      ? [{ id: "kept" as const, label: "Kept", n: totals.kept, sub: "Differs, kept as it is" }]
      : []),
    {
      id: "left_out",
      label: "Left out",
      n: totals.left_out,
      sub: totals.left_out ? "Not copied" : "You left out nothing",
    },
    { id: "all", label: "All", n: summary.total, sub: "Every item checked" },
  ];

  const sectionOptions = [
    { value: "all", label: "All sections", n: filterCount(totals, result) },
    ...sectionIds.map((s) => ({
      value: s,
      label: sectionName(s),
      n: filterCount(resultCounts(summary, s), result),
    })),
  ];

  return (
    <div className="flex flex-col gap-5">
      {warnings.length > 0 && (
        <Alert tone="warning" title="Read these before you copy">
          <MessageList entries={warnings} />
        </Alert>
      )}

      <section
        aria-label="Items"
        className="anim-rise flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card"
      >
        <div
          role="tablist"
          aria-label="Result"
          className="flex flex-wrap gap-px border-b bg-border"
        >
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={result === t.id}
              onClick={() => setResult(t.id)}
              className={cn(
                "flex min-w-0 flex-[1_1_7rem] flex-col bg-card px-5 py-3 text-left transition-colors hover:bg-linear-to-r hover:from-muted/50 hover:to-muted/50 max-sm:px-3",
                result === t.id && "shadow-[inset_0_-2px_0_var(--primary)]",
              )}
            >
              <span
                className={cn(
                  "text-xs",
                  result === t.id ? "font-medium text-primary" : "text-muted-foreground",
                  t.red && "text-destructive",
                )}
              >
                {t.label}
              </span>
              <span
                className={cn(
                  "text-xl font-semibold tabular-nums",
                  t.red ? "text-destructive" : t.n === 0 && "text-muted-foreground",
                )}
              >
                {t.n.toLocaleString("en-US")}
              </span>
              <span className="truncate text-xs text-muted-foreground max-sm:hidden">{t.sub}</span>
            </button>
          ))}
        </div>

        <div className="grid min-w-0 grid-cols-1 @min-[56.875rem]/main:grid-cols-[13rem_minmax(0,1fr)]">
          <nav
            aria-label="Sections"
            className="hidden flex-col gap-0.5 border-r p-3 @min-[56.875rem]/main:flex"
          >
            <span className="px-2.5 pb-1 text-xs text-muted-foreground">Sections</span>
            {sectionOptions.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-current={section === o.value ? "true" : undefined}
                onClick={() => setSection(o.value)}
                className={cn(
                  "flex h-9 items-center justify-between gap-2 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-muted/60",
                  section === o.value
                    ? "bg-muted font-medium text-foreground"
                    : o.n === 0
                      ? "text-muted-foreground"
                      : "text-foreground",
                )}
              >
                <span className="truncate">{o.label}</span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {o.n.toLocaleString("en-US")}
                </span>
              </button>
            ))}
          </nav>

          <div className="flex min-w-0 flex-col">
            {pinnedOn && pinned.length > 0 && (
              <div className="flex flex-col gap-2 border-b p-4">
                <Alert
                  tone="error"
                  title={`${plural(blockedCount, "item")} cannot be copied`}
                  action={
                    blockedKeys.length > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => change({ exclude: blockedKeys })}
                        disabled={busy !== null}
                      >
                        Leave out blocked items
                      </Button>
                    ) : null
                  }
                >
                  Correct the problem in {srcName}, then check again. Or leave the items out.
                </Alert>
                <ul className="m-0 list-none divide-y rounded-xl border border-destructive/25 p-0">
                  {pinned.map((i) => (
                    <BlockedRow
                      key={i.key}
                      item={i}
                      twin={twin}
                      disabled={busy !== null}
                      onInclude={(on) => change(on ? { include: [i.key] } : { exclude: [i.key] })}
                    />
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
              <div className="w-full @min-[56.875rem]/main:hidden">
                <SelectField
                  id="plan-section"
                  value={section}
                  onValueChange={setSection}
                  ariaLabel="Section"
                  options={sectionOptions.map((o) => ({
                    value: o.value,
                    label: `${o.label} · ${o.n.toLocaleString("en-US")}`,
                  }))}
                />
              </div>
              <div className="relative min-w-0 flex-[1_1_16rem] @min-[56.875rem]/main:max-w-sm">
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  type="search"
                  aria-label="Search items"
                  className="pl-9"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name or code"
                  maxLength={200}
                  autoComplete="off"
                />
              </div>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums max-sm:hidden">
                {showing}
              </span>
            </div>

            {list.failed && !list.loading ? (
              <div className="p-4">
                <Alert tone="error">We could not load the items. Reload the page.</Alert>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex flex-wrap items-center gap-3 px-4 py-6 text-sm text-muted-foreground">
                <span>
                  {loadingFirst
                    ? "Loading…"
                    : pinned.length > 0
                      ? "No other items in this list."
                      : "No items in this list."}
                </span>
                {!loadingFirst && filtered && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch("");
                      setSection("all");
                    }}
                  >
                    {search ? "Clear search" : "Clear filters"}
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div
                  aria-hidden
                  className="hidden grid-cols-[3rem_minmax(0,1fr)_10rem_8rem_3rem] items-center border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground sm:grid"
                >
                  <span>Copy</span>
                  <span>Item</span>
                  <span>Section</span>
                  <span>Result</span>
                  <span />
                </div>
                <ul className="m-0 list-none p-0">
                  {rows.map((r) =>
                    "head" in r ? (
                      <li
                        key={r.key}
                        className="border-b bg-muted/30 px-4 py-1.5 text-xs font-medium text-muted-foreground tabular-nums"
                      >
                        {r.head}
                      </li>
                    ) : (
                      <ItemRow
                        key={r.item.key}
                        item={r.item}
                        twin={twin}
                        open={open.has(r.item.key)}
                        onToggle={() => toggle(r.item.key)}
                        disabled={busy !== null}
                        onInclude={(on) =>
                          change(on ? { include: [r.item.key] } : { exclude: [r.item.key] })
                        }
                      />
                    ),
                  )}
                </ul>
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="text-xs text-muted-foreground tabular-nums">{showing}</span>
                  {list.hasMore && (
                    <Button variant="outline" size="sm" onClick={list.more} disabled={list.loading}>
                      {list.loading ? "Loading…" : "Show more"}
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <ActionBar
        status={
          errors.length > 0 || blockedCount > 0 ? (
            "Correct the blocked items or leave them out first."
          ) : writes === 0 ? (
            "Nothing to copy: the destination has every item."
          ) : (
            <>
              <span className="font-medium text-foreground">
                {writes.toLocaleString("en-US")} {writes === 1 ? "item changes" : "items change"}
              </span>{" "}
              in {destLabel}.
            </>
          )
        }
      >
        <span className="sm:hidden">
          <MoreMenu icon label="More actions">
            <button type="button" onClick={changeOptions} disabled={busy !== null}>
              Change the options
            </button>
          </MoreMenu>
        </span>
        <Button
          variant="outline"
          className="max-sm:hidden"
          onClick={changeOptions}
          disabled={busy !== null}
        >
          Change the options
        </Button>
        <Button variant="outline" onClick={() => recheck()} disabled={busy !== null}>
          {busy === "check" ? "Checking…" : "Check again"}
        </Button>
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={errors.length > 0 || blockedCount > 0 || writes === 0 || busy !== null}
        >
          Start the copy
        </Button>
      </ActionBar>

      <ConfirmCopyDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Copy to ${destLabel}?`}
        summary={`${writes.toLocaleString("en-US")} ${writes === 1 ? "item changes" : "items change"}.`}
        destName={destName}
        typedConfirm={run.live_override_needed}
        clearFirst={run.wipe_destination}
        blocked={
          run.live_override_needed && !canOverride
            ? "This plan changes records of a live business. Only an owner or an admin can start it. Leave out the updates, or ask an owner or admin."
            : null
        }
        busy={busy === "apply"}
        action="Start the copy"
        onConfirm={apply}
      />
    </div>
  );
}

function LeaveOutBox({
  item,
  disabled,
  onInclude,
}: {
  item: TransferItem;
  disabled: boolean;
  onInclude: (on: boolean) => void;
}) {
  if (!canLeaveOut(item)) return null;
  return (
    <CheckboxField
      checked={!item.excluded}
      onCheckedChange={onInclude}
      disabled={disabled}
      label={<span className="sr-only">Copy {item.label}</span>}
    />
  );
}

const pairOf = (i: TransferItem, twin: boolean) =>
  twin ? (i.pair === "twin" ? "Test businesses · " : "Live businesses · ") : "";

function BlockedRow({
  item,
  twin,
  disabled,
  onInclude,
}: {
  item: TransferItem;
  twin: boolean;
  disabled: boolean;
  onInclude: (on: boolean) => void;
}) {
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="pt-0.5">
        <LeaveOutBox item={item} disabled={disabled} onInclude={onInclude} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium wrap-break-word">{item.label}</span>
          <span className="text-xs text-muted-foreground">
            {kindName(item.kind)} · {pairOf(item, twin)}
            {sectionName(item.section)}
          </span>
        </div>
        {item.messages.map((m, n) => (
          <p
            key={n}
            className={cn(
              "m-0 mt-0.5 text-xs",
              m.level === "error" ? "text-destructive" : "text-warning",
            )}
          >
            {m.message}
          </p>
        ))}
      </div>
      <Chip tone="red">Blocked</Chip>
    </li>
  );
}

function ItemRow({
  item,
  twin,
  open,
  onToggle,
  disabled,
  onInclude,
}: {
  item: TransferItem;
  twin: boolean;
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  onInclude: (on: boolean) => void;
}) {
  const k = kindOf(item);
  const diff = flatDiff(item.diff);
  const chip = <Chip tone={KIND_TONE[k]}>{KIND_LABEL[k]}</Chip>;
  return (
    <li className={cn("border-b", open && "bg-muted/20")}>
      <div className="flex items-start gap-3 px-4 py-3 sm:grid sm:grid-cols-[3rem_minmax(0,1fr)_10rem_8rem_3rem] sm:items-center sm:gap-0">
        <div className="pt-0.5 sm:pt-0">
          <LeaveOutBox item={item} disabled={disabled} onInclude={onInclude} />
        </div>
        <div className="min-w-0 flex-1 sm:pr-3">
          <div className="flex items-start justify-between gap-2">
            <span className="text-sm wrap-break-word">{item.label}</span>
            <span className="shrink-0 sm:hidden">{chip}</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {kindName(item.kind)}
            <span className="sm:hidden">
              {" · "}
              {pairOf(item, twin)}
              {sectionName(item.section)}
            </span>
          </div>
          {item.messages.map((m, n) => (
            <div
              key={n}
              className={
                item.excluded
                  ? "text-xs text-muted-foreground"
                  : m.level === "error"
                    ? "text-xs text-destructive"
                    : "text-xs text-warning"
              }
            >
              {m.message}
            </div>
          ))}
          {diff.length > 0 && (
            <button
              type="button"
              className="mt-1 text-xs text-primary hover:underline sm:hidden"
              aria-expanded={open}
              onClick={onToggle}
            >
              {open ? "Hide the changes" : "Show the changes"}
            </button>
          )}
        </div>
        <div className="hidden text-sm sm:block">
          {pairOf(item, twin)}
          {sectionName(item.section)}
        </div>
        <div className="hidden sm:block">{chip}</div>
        <div className="hidden justify-end sm:flex">
          {diff.length > 0 && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={open ? "Hide the changes" : "Show the changes"}
              aria-expanded={open}
              onClick={onToggle}
            >
              {open ? <ChevronDown /> : <ChevronRight />}
            </Button>
          )}
        </div>
      </div>
      {open && diff.length > 0 && (
        <div className="px-4 pb-4 sm:pl-16">
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table phone="stack" className="[--phone-row-x:1rem]">
              <TableHeader>
                <TableRow>
                  <TableHead phone="title">Field</TableHead>
                  <TableHead>Current</TableHead>
                  <TableHead>
                    {k === "kept" ? "In this business (not copied)" : "After the copy"}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {diff.map((d) => (
                  <TableRow key={d.key} className="hover:bg-transparent">
                    <TableCell className="align-top font-medium whitespace-normal">
                      {d.label}
                    </TableCell>
                    <TableCell className="align-top break-all whitespace-normal text-muted-foreground">
                      {show(d.from)}
                    </TableCell>
                    <TableCell className="bg-brand-soft/60 align-top break-all whitespace-normal">
                      {show(d.to)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="m-0 border-t px-4 py-2 text-xs text-muted-foreground">
              {diff.length === 1 ? "1 field changes." : `${diff.length} fields change.`}
            </p>
          </div>
        </div>
      )}
    </li>
  );
}
