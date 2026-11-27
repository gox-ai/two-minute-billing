"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download, Eye, RotateCcw, Trash2 } from "lucide-react";
import type { Business } from "@/lib/api";
import type {
  ExportPreview,
  ExportPreviewFile,
  ExportRequest,
  ExportRun,
  ExportRunPage,
} from "@/lib/api/exports";
import type { TemplateField } from "@/lib/api/imports";
import { IMPORT_ENTITIES, type ImportEntity } from "@/lib/import-entities";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/checkbox";
import { SelectField } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Chip } from "@/components/patterns/chip";
import { SettingsCard } from "@/components/settings/settings-layout";
import { ActionBar, FLUSH } from "@/components/transfer/RouteBand";
import { DateInput } from "@/components/reports/date-input";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDate, fmtDateTime } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import { useDefaultState } from "@/lib/use-default-state";
import { ENTITY_LABEL, fieldLabel } from "@/components/imports/labels";
import {
  EXPORT_HELP,
  EXPORT_STATUS,
  EXTRA_COLUMN_HELP,
  INVOICE_STATUS_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  RANGE_OPTIONS,
  SUBSCRIPTION_STATUS_OPTIONS,
  records,
  sizeText,
  type RangePreset,
} from "./labels";

type PreviewResult = { ok: true; preview: ExportPreview } | { ok: false; message: string };
type RunResult = { ok: true; run: ExportRun } | { ok: false; message: string };

export interface ExportActions {
  previewAction: (biz: string, body: ExportRequest) => Promise<PreviewResult>;
  startAction: (biz: string, body: ExportRequest) => Promise<RunResult>;
  getAction: (biz: string, id: string) => Promise<ExportRun | null>;
  listAction: (biz: string, cursor?: string) => Promise<ExportRunPage | null>;
  deleteAction: (biz: string, id: string) => Promise<RunResult>;
}

/** One record type's choices on screen. */
interface Choice {
  status: string;
  range: RangePreset;
  from: string | null;
  to: string | null;
  dateField: "created" | "updated";
  archived: boolean;
}

const BLANK: Choice = {
  status: "all",
  range: "any",
  from: null,
  to: null,
  dateField: "created",
  archived: false,
};
const STATUS_OPTIONS: Partial<Record<ImportEntity, typeof INVOICE_STATUS_OPTIONS>> = {
  subscriptions: SUBSCRIPTION_STATUS_OPTIONS,
  invoices: INVOICE_STATUS_OPTIONS,
  payments: PAYMENT_STATUS_OPTIONS,
};
const DATED: ImportEntity[] = [
  "customers",
  "subscriptions",
  "invoices",
  "credit_notes",
  "payments",
  "usage",
];
const ARCHIVABLE: ImportEntity[] = ["plans", "addons", "coupons"];
const POLL_MS = 2000;

/** Today in the business's time zone, as YYYY-MM-DD. */
function today(tz: string | null): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz ?? "UTC" }).format(new Date());
}
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The preset → the API's `from` (inclusive) and `to` (exclusive), as dates. */
function rangeOf(c: Choice, tz: string | null): { from?: string; to?: string } {
  const t = today(tz);
  const y = Number(t.slice(0, 4));
  switch (c.range) {
    case "last_30_days":
      return { from: addDays(t, -30) };
    case "last_90_days":
      return { from: addDays(t, -90) };
    case "last_12_months":
      return { from: `${y - 1}${t.slice(4)}` };
    case "this_year":
      return { from: `${y}-01-01` };
    case "last_year":
      return { from: `${y - 1}-01-01`, to: `${y}-01-01` };
    case "between":
      return {
        ...(c.from ? { from: c.from } : {}),
        ...(c.to ? { to: addDays(c.to, 1) } : {}),
      };
    default:
      return {};
  }
}

function requestOf(
  selected: ImportEntity[],
  choices: Record<ImportEntity, Choice>,
  includeRelated: boolean,
  tz: string | null,
): ExportRequest {
  const filters: ExportRequest["filters"] = {};
  for (const e of selected) {
    const c = choices[e];
    filters[e] = {
      ...(STATUS_OPTIONS[e] && c.status !== "all" ? { status: [c.status] } : {}),
      ...(DATED.includes(e) ? rangeOf(c, tz) : {}),
      ...(e === "customers" || e === "subscriptions" ? { date_field: c.dateField } : {}),
      ...(ARCHIVABLE.includes(e) ? { include_archived: c.archived } : {}),
    };
  }
  return { entities: selected, filters, include_related: includeRelated };
}

/** A past export's request → choices on screen (Export again). Ranges come back as dates. */
function choicesOf(run: ExportRun): Partial<Record<ImportEntity, Choice>> {
  const out: Partial<Record<ImportEntity, Choice>> = {};
  for (const e of run.entities) {
    const f = run.filters[e] ?? {};
    out[e] = {
      ...BLANK,
      status: f.status?.[0] ?? "all",
      dateField: f.dateField ?? "created",
      archived: !!f.includeArchived,
      ...(f.from || f.to
        ? {
            range: "between" as const,
            from: f.from ? f.from.slice(0, 10) : null,
            to: f.to ? addDays(f.to.slice(0, 10), -1) : null,
          }
        : {}),
    };
  }
  return out;
}

/** Settings › Import and export data › Export data. */
export function ExportPanel({
  biz,
  business,
  canManage,
  focus,
  initialRun,
  fields,
  actions,
}: {
  biz: string;
  business: Business | undefined;
  canManage: boolean;
  /** The record type a list's "Export all in the background" opened. */
  focus: ImportEntity | null;
  initialRun: ExportRun | null;
  /** The import's fields per file: what each column holds. */
  fields: Partial<Record<ImportEntity, TemplateField[]>>;
  actions: ExportActions;
}) {
  const tz = useDisplayTz();
  // A list's "Export all in the background" opens with its record type alone.
  const [selected, setSelected] = useDefaultState<ImportEntity[]>(
    focus ? [focus] : IMPORT_ENTITIES.filter((e) => e !== "usage"),
    (v) => v.join(","),
  );
  const [choices, setChoices] = React.useState<Record<ImportEntity, Choice>>(
    () =>
      Object.fromEntries(
        IMPORT_ENTITIES.map((e) => [
          e,
          e === "usage" ? { ...BLANK, range: "last_30_days" } : BLANK,
        ]),
      ) as Record<ImportEntity, Choice>,
  );
  const [includeRelated, setIncludeRelated] = React.useState(true);
  const [preview, setPreview] = React.useState<ExportPreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [counting, setCounting] = React.useState(false);
  const [run, setRun] = useDefaultState<ExportRun | null>(initialRun, (r) => r?.id ?? null);
  const [starting, setStarting] = React.useState(false);
  const [sample, setSample] = React.useState<ExportPreviewFile | null>(null);
  const [historyKey, setHistoryKey] = React.useState(0);
  const top = React.useRef<HTMLDivElement>(null);

  const request = React.useMemo(
    () => requestOf(selected, choices, includeRelated, tz),
    [selected, choices, includeRelated, tz],
  );
  const usageNeedsDate = selected.includes("usage") && !request.filters?.usage?.from;

  // Counts and samples follow the choices, a moment after the last change.
  const nothingToCount = !selected.length || usageNeedsDate;
  React.useEffect(() => {
    if (nothingToCount) return;
    let live = true;
    const t = setTimeout(async () => {
      setCounting(true);
      const res = await actions.previewAction(biz, request);
      if (!live) return;
      setCounting(false);
      if (res.ok) {
        setPreview(res.preview);
        setPreviewError(null);
      } else setPreviewError(res.message);
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [actions, biz, request, nothingToCount]);

  // A running export is read again until it ends.
  const active = run?.status === "queued" || run?.status === "running";
  React.useEffect(() => {
    if (!run || !active) return;
    const t = setInterval(async () => {
      const next = await actions.getAction(biz, run.id);
      if (!next) return;
      setRun(next);
      if (next.status === "succeeded") {
        toast.success("Export ready.");
        setHistoryKey((k) => k + 1);
      } else if (next.status === "failed") setHistoryKey((k) => k + 1);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [actions, active, biz, run, setRun]);

  // Nothing selected (or usage with no dates): no counts, whatever the last preview said.
  const shown = nothingToCount ? null : preview;
  const fileOf = (e: ImportEntity) => shown?.files.find((f) => f.entity === e) ?? null;
  const total = shown?.files.reduce((n, f) => n + f.rows, 0) ?? 0;
  const fileCount = shown?.files.filter((f) => f.rows > 0).length ?? 0;

  function toggle(e: ImportEntity, on: boolean) {
    setSelected((cur) =>
      on ? IMPORT_ENTITIES.filter((x) => x === e || cur.includes(x)) : cur.filter((x) => x !== e),
    );
  }
  const change = (e: ImportEntity, patch: Partial<Choice>) =>
    setChoices((cur) => ({ ...cur, [e]: { ...cur[e], ...patch } }));

  async function start() {
    setStarting(true);
    const res = await actions.startAction(biz, request);
    setStarting(false);
    if (!res.ok) {
      toast.error(`We could not start the export. ${res.message}`.replace(/\.\s*\./, "."));
      return;
    }
    setRun(res.run);
    setHistoryKey((k) => k + 1);
  }

  function again(r: ExportRun) {
    setSelected(IMPORT_ENTITIES.filter((e) => r.entities.includes(e)));
    setChoices((cur) => ({ ...cur, ...choicesOf(r) }));
    setIncludeRelated(r.include_related);
    top.current?.scrollIntoView({ block: "start" });
  }

  return (
    <div ref={top} className="flex scroll-mt-20 flex-col gap-5">
      {!canManage && (
        <Alert tone="neutral">
          You can see and download past exports. To start an export, ask an owner or an admin.
        </Alert>
      )}

      {run && (
        <ExportRunCard
          biz={biz}
          run={run}
          canManage={canManage}
          tz={tz}
          onAgain={again}
          onChange={(r) => {
            setRun(r);
            setHistoryKey((k) => k + 1);
          }}
          deleteAction={actions.deleteAction}
        />
      )}

      <SettingsCard
        title="What to export"
        meta={
          <span className="text-xs text-muted-foreground tabular-nums">
            {selected.length} of {IMPORT_ENTITIES.length} record types
          </span>
        }
        actions={
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={includeRelated}
              onCheckedChange={setIncludeRelated}
              disabled={!canManage}
              aria-describedby="related-help"
            />
            Include the records they refer to
          </label>
        }
      >
        <p
          id="related-help"
          className="m-0 bg-muted/30 px-5 py-2 text-xs text-muted-foreground max-sm:px-4"
        >
          {includeRelated
            ? "An invoice also brings its customer, subscription and prices, so the files import on their own."
            : "Only the records your choices select. The files may not import on their own."}
        </p>
        <ul className="m-0 list-none divide-y p-0">
          {IMPORT_ENTITIES.map((e) => (
            <EntityRow
              key={e}
              entity={e}
              on={selected.includes(e)}
              choice={choices[e]}
              file={fileOf(e)}
              counting={counting}
              tz={tz}
              disabled={!canManage || starting}
              focused={e === focus}
              onToggle={(on) => toggle(e, on)}
              onChange={(p) => change(e, p)}
              onSample={() => {
                const f = fileOf(e);
                if (f) setSample(f);
              }}
            />
          ))}
        </ul>
      </SettingsCard>

      {previewError && !nothingToCount && (
        <Alert tone="error" title="We could not count the records">
          {previewError}
        </Alert>
      )}

      <ExportHistory
        key={historyKey}
        biz={biz}
        tz={tz}
        listAction={actions.listAction}
        onAgain={again}
        canManage={canManage}
      />

      <ActionBar
        status={
          active ? (
            "An export is in progress. You can close this page: we send you an email when it ends."
          ) : !selected.length ? (
            "Select at least one record type."
          ) : usageNeedsDate ? (
            "Select a date range for usage. Usage can be very large."
          ) : counting && !shown ? (
            "Counting the records…"
          ) : (
            <>
              <span className="font-medium text-foreground tabular-nums">
                {total.toLocaleString("en-US")} records
              </span>{" "}
              in {fileCount} {fileCount === 1 ? "file" : "files"} from{" "}
              {business?.name ?? "this business"}, all from one moment. We keep the files for 7
              days.
            </>
          )
        }
      >
        <Button
          onClick={start}
          disabled={
            !canManage || !selected.length || usageNeedsDate || active || starting || total === 0
          }
        >
          <Download aria-hidden />
          {starting ? "Starting…" : "Export"}
        </Button>
      </ActionBar>

      <SampleSheet file={sample} fields={fields} onClose={() => setSample(null)} />
    </div>
  );
}

function EntityRow({
  entity,
  on,
  choice,
  file,
  counting,
  tz,
  disabled,
  focused,
  onToggle,
  onChange,
  onSample,
}: {
  entity: ImportEntity;
  on: boolean;
  choice: Choice;
  file: ExportPreviewFile | null;
  counting: boolean;
  tz: string | null;
  disabled: boolean;
  focused: boolean;
  onToggle: (on: boolean) => void;
  onChange: (p: Partial<Choice>) => void;
  onSample: () => void;
}) {
  const statusOptions = STATUS_OPTIONS[entity];
  const dated = DATED.includes(entity);
  const label = ENTITY_LABEL[entity];
  return (
    <li
      className={cn(
        "flex flex-col gap-3 px-5 py-4 max-sm:px-4",
        focused && "bg-brand-soft/40",
        !on && "bg-muted/20",
      )}
    >
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <CheckboxField
          className="min-w-0 flex-[1_1_16rem]"
          label={label}
          hint={EXPORT_HELP[entity]}
          checked={on}
          onCheckedChange={onToggle}
          disabled={disabled}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {file && file.rows > 0 ? (
            <>
              <span className="tabular-nums">
                <span className="font-medium">{records(entity, file.rows)}</span>
                {on && file.related > 0 ? (
                  <span className="text-muted-foreground">
                    {" "}
                    · {file.related.toLocaleString("en-US")} added because other rows refer to them
                  </span>
                ) : null}
                {!on ? (
                  <span className="text-muted-foreground"> that the chosen rows refer to</span>
                ) : null}
              </span>
              <Button variant="ghost" size="sm" onClick={onSample}>
                <Eye aria-hidden />
                Preview
              </Button>
            </>
          ) : on ? (
            <span className="text-muted-foreground">
              {counting ? "Counting…" : file ? "No records" : ""}
            </span>
          ) : null}
        </div>
      </div>
      {on && (statusOptions || dated || ARCHIVABLE.includes(entity)) ? (
        <div className="flex flex-wrap items-end gap-3 pl-7 max-sm:pl-0">
          {statusOptions ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Status</span>
              <SelectField
                size="sm"
                className="w-44"
                ariaLabel={`${label}: status`}
                options={statusOptions}
                value={choice.status}
                onValueChange={(v) => onChange({ status: v })}
                disabled={disabled}
              />
            </div>
          ) : null}
          {entity === "customers" || entity === "subscriptions" ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Date</span>
              <SelectField
                size="sm"
                className="w-36"
                ariaLabel={`${label}: date`}
                options={[
                  { value: "created", label: "Created" },
                  { value: "updated", label: "Last changed" },
                ]}
                value={choice.dateField}
                onValueChange={(v) => onChange({ dateField: v as Choice["dateField"] })}
                disabled={disabled}
              />
            </div>
          ) : null}
          {dated ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                {entity === "invoices" || entity === "credit_notes"
                  ? "Issued"
                  : entity === "payments"
                    ? "Paid or refunded"
                    : entity === "usage"
                      ? "Recorded"
                      : "When"}
              </span>
              <SelectField
                size="sm"
                className="w-40"
                ariaLabel={`${label}: date range`}
                options={
                  entity === "usage"
                    ? RANGE_OPTIONS.filter((o) => o.value !== "any")
                    : RANGE_OPTIONS
                }
                value={choice.range}
                onValueChange={(v) => onChange({ range: v as RangePreset })}
                disabled={disabled}
              />
            </div>
          ) : null}
          {dated && choice.range === "between" ? (
            <>
              <div className="flex w-40 flex-col gap-1">
                <span className="text-xs text-muted-foreground">From</span>
                <DateInput
                  id={`export-${entity}-from`}
                  name={`${entity}_from`}
                  label="From"
                  defaultValue={choice.from ?? addDays(today(tz), -30)}
                  tz={tz}
                  onValueChange={(d) => onChange({ from: d })}
                />
              </div>
              <div className="flex w-40 flex-col gap-1">
                <span className="text-xs text-muted-foreground">To</span>
                <DateInput
                  id={`export-${entity}-to`}
                  name={`${entity}_to`}
                  label="To"
                  defaultValue={choice.to ?? today(tz)}
                  tz={tz}
                  onValueChange={(d) => onChange({ to: d })}
                />
              </div>
            </>
          ) : null}
          {ARCHIVABLE.includes(entity) ? (
            <CheckboxField
              className="pb-1.5"
              label="Include archived"
              checked={choice.archived}
              onCheckedChange={(v) => onChange({ archived: v })}
              disabled={disabled}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** The first rows of one file, as the file has them, and what each column holds. */
function SampleSheet({
  file,
  fields,
  onClose,
}: {
  file: ExportPreviewFile | null;
  fields: Partial<Record<ImportEntity, TemplateField[]>>;
  onClose: () => void;
}) {
  const help = new Map((file ? (fields[file.entity] ?? []) : []).map((f) => [f.key, f.help]));
  const importCols = new Set((file ? (fields[file.entity] ?? []) : []).map((f) => f.key));
  return (
    <Sheet open={!!file} onOpenChange={(o) => (o ? null : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        {file ? (
          <>
            <SheetHeader>
              <SheetTitle>{ENTITY_LABEL[file.entity]}</SheetTitle>
              <SheetDescription>
                The first rows, as the file has them. {records(file.entity, file.rows)} in all.
              </SheetDescription>
            </SheetHeader>
            <div className="px-4">
              <Table phone="scroll" className="rounded-xl border">
                <TableHeader>
                  <TableRow>
                    {file.columns.map((c) => (
                      <TableHead key={c} className="font-mono text-xs whitespace-nowrap">
                        {c}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {file.sample.map((row, i) => (
                    <TableRow key={i}>
                      {row.map((v, j) => (
                        <TableCell key={j} className="max-w-56 truncate text-xs">
                          {v || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="px-4 pb-6">
              <h3 className="mt-2 mb-2 text-sm font-medium">The columns</h3>
              <dl className="m-0 grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
                {file.columns.map((c) => (
                  <React.Fragment key={c}>
                    <dt className="font-mono text-xs">{c}</dt>
                    <dd className="m-0 text-muted-foreground">
                      {importCols.has(c)
                        ? help.get(c) || `${fieldLabel(c)}.`
                        : `${EXTRA_COLUMN_HELP[c] ?? fieldLabel(c)} The import does not read it.`}
                    </dd>
                  </React.Fragment>
                ))}
              </dl>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** The export on screen: its progress, or its files to download. */
function ExportRunCard({
  biz,
  run,
  canManage,
  tz,
  onAgain,
  onChange,
  deleteAction,
}: {
  biz: string;
  run: ExportRun;
  canManage: boolean;
  tz: string | null;
  onAgain: (r: ExportRun) => void;
  onChange: (r: ExportRun) => void;
  deleteAction: ExportActions["deleteAction"];
}) {
  const s = EXPORT_STATUS[run.status];
  const [confirm, setConfirm] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const file = (entity?: string) =>
    `/businesses/${biz}/imports/export-file?export=${run.id}${entity ? `&entity=${entity}` : ""}`;
  const p = run.progress;
  const pct = p && p.rows ? Math.min(100, Math.round((p.done / p.rows) * 100)) : 0;

  async function remove() {
    setDeleting(true);
    const res = await deleteAction(biz, run.id);
    setDeleting(false);
    setConfirm(false);
    if (!res.ok) {
      toast.error(`We could not delete the files. ${res.message}`.replace(/\.\s*\./, "."));
      return;
    }
    toast.success("Files deleted.");
    onChange(res.run);
  }

  return (
    <SettingsCard
      title={`Export of ${fmtDateTime(run.snapshot_at ?? run.created_at, tz)}`}
      meta={<Chip tone={s.tone}>{s.label}</Chip>}
      actions={
        run.status === "succeeded" ? (
          <Button asChild size="sm">
            <a href={file()} download>
              <Download aria-hidden />
              Download all (zip, {sizeText(run.size_bytes)})
            </a>
          </Button>
        ) : run.status === "failed" || run.status === "expired" || run.status === "deleted" ? (
          <Button size="sm" variant="outline" onClick={() => onAgain(run)} disabled={!canManage}>
            <RotateCcw aria-hidden />
            Export again
          </Button>
        ) : null
      }
    >
      {run.status === "queued" || run.status === "running" ? (
        <div className="flex flex-col gap-2 px-5 py-4">
          <div
            role="progressbar"
            aria-label="Export progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-(--dur-base)"
              style={{ width: `${pct}%` }}
            />
          </div>
          <p className="m-0 text-sm text-muted-foreground tabular-nums">
            {run.status === "queued"
              ? "Waiting to start."
              : p?.entity
                ? `Writing ${ENTITY_LABEL[p.entity as ImportEntity]?.toLowerCase() ?? p.entity}: ${p.done.toLocaleString("en-US")} of ${p.rows.toLocaleString("en-US")} records.`
                : "Counting the records."}{" "}
            You can close this page: we send you an email when it ends.
          </p>
        </div>
      ) : run.status === "failed" ? (
        <div className="px-5 py-4">
          <Alert tone="error" title="The export failed">
            {run.error ?? "Export again, or contact support."}
          </Alert>
        </div>
      ) : (
        <>
          {run.files.length ? (
            <Table phone="stack" className={FLUSH}>
              <TableHeader>
                <TableRow>
                  <TableHead phone="title">File</TableHead>
                  <TableHead phone="aside">Rows</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.files.map((f) => (
                  <TableRow key={f.entity}>
                    <TableCell>
                      <div className="font-medium">{f.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {ENTITY_LABEL[f.entity]}
                        {f.related
                          ? ` · ${f.related.toLocaleString("en-US")} added because other rows refer to them`
                          : ""}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{f.rows.toLocaleString("en-US")}</TableCell>
                    <TableCell>
                      {run.status === "succeeded" ? (
                        <div className="flex justify-end max-sm:justify-start">
                          <Button variant="ghost" size="sm" asChild>
                            <a href={file(f.entity)} download>
                              <Download aria-hidden />
                              Download
                            </a>
                          </Button>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="m-0 px-5 py-4 text-sm text-muted-foreground">No records to export.</p>
          )}
          {run.skipped.length ? (
            <div className="px-5 py-3">
              <Alert tone="neutral" title="Left out, because the import cannot read them">
                <ul className="m-0 list-inside list-disc">
                  {run.skipped.map((k) => (
                    <li key={`${k.entity}:${k.reason}`}>
                      {ENTITY_LABEL[k.entity as ImportEntity] ?? k.entity}:{" "}
                      {k.count.toLocaleString("en-US")}. {k.reason}
                    </li>
                  ))}
                </ul>
              </Alert>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-sm text-muted-foreground">
            <span className="min-w-0 flex-[1_1_20rem]">
              {run.created_by ? `Started by ${run.created_by}. ` : ""}
              {run.status === "succeeded" && run.expires_at
                ? `We delete the files on ${fmtDate(run.expires_at, tz)}. `
                : "The files are deleted. "}
              To bring them into another business, upload them on{" "}
              <Link
                href={`/businesses/${biz}/imports?tab=files`}
                className="text-primary hover:underline"
              >
                Import files
              </Link>
              .
            </span>
            {run.status === "succeeded" ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirm(true)}
                disabled={!canManage}
              >
                <Trash2 aria-hidden />
                Delete files
              </Button>
            ) : null}
          </div>
        </>
      )}
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete the files of this export?</DialogTitle>
            <DialogDescription>
              Nobody can download them after this. The export stays in the list. You cannot undo
              this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete files"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsCard>
  );
}

/** Past exports, newest first: what, when, who, and Download or Export again. */
function ExportHistory({
  biz,
  tz,
  canManage,
  listAction,
  onAgain,
}: {
  biz: string;
  tz: string | null;
  canManage: boolean;
  listAction: ExportActions["listAction"];
  onAgain: (r: ExportRun) => void;
}) {
  const [runs, setRuns] = React.useState<ExportRun[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let live = true;
    listAction(biz).then((page) => {
      if (!live) return;
      setFailed(!page);
      setRuns(page?.data ?? []);
      setHasMore(!!page?.has_more);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [biz, listAction]);

  async function more() {
    const last = runs[runs.length - 1];
    if (!last) return;
    setLoading(true);
    const page = await listAction(biz, last.id);
    setRuns((r) => [...r, ...(page?.data ?? [])]);
    setHasMore(!!page?.has_more);
    setLoading(false);
  }

  return (
    <SettingsCard title="Past exports">
      {failed ? (
        <p className="m-0 px-5 py-4 text-sm text-destructive">
          We could not load the past exports. Reload the page.
        </p>
      ) : loading && runs.length === 0 ? (
        <p className="m-0 px-5 py-6 text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="m-0 px-5 py-6 text-sm text-muted-foreground">No exports yet.</p>
      ) : (
        <Table phone="stack" className={FLUSH}>
          <TableHeader>
            <TableRow>
              <TableHead phone="title">Record types</TableHead>
              <TableHead phone="aside">Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => {
              const s = EXPORT_STATUS[r.status];
              const rows = r.files.reduce((n, f) => n + f.rows, 0);
              return (
                <TableRow key={r.id}>
                  <TableCell className="max-w-72 align-top whitespace-normal">
                    {r.entities.map((e) => ENTITY_LABEL[e]).join(", ")}
                  </TableCell>
                  <TableCell className="align-top">
                    <Chip tone={s.tone}>{s.label}</Chip>
                  </TableCell>
                  <TableCell className="align-top tabular-nums">
                    {r.status === "succeeded" || r.status === "expired" || r.status === "deleted"
                      ? rows.toLocaleString("en-US")
                      : "—"}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="whitespace-nowrap">{fmtDateTime(r.created_at, tz)}</div>
                    <div className="text-xs wrap-break-word text-muted-foreground">
                      {r.created_by ? `by ${r.created_by}` : "By: not recorded"}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex justify-end gap-2 max-sm:justify-start">
                      {r.status === "succeeded" ? (
                        <Button variant="outline" size="sm" asChild>
                          <a
                            href={`/businesses/${biz}/imports/export-file?export=${r.id}`}
                            download
                          >
                            <Download aria-hidden />
                            Download
                          </a>
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => onAgain(r)}
                        disabled={!canManage}
                      >
                        <RotateCcw aria-hidden />
                        Export again
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {hasMore && (
        <div className="flex justify-center px-5 py-3">
          <Button variant="outline" size="sm" onClick={more} disabled={loading}>
            {loading ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}
