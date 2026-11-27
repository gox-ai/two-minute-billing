"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Download } from "lucide-react";
import type { Business } from "@/lib/api";
import type {
  ImportEntity,
  ImportFile,
  ImportOptions,
  ImportRun,
  TemplateField,
} from "@/lib/api/imports";
import type { ImportRunResult } from "@/app/(dashboard)/businesses/[biz]/imports/actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { SettingsCard } from "@/components/settings/settings-layout";
import { MoreMenu } from "@/components/patterns/more-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActionBar, FLUSH } from "@/components/transfer/RouteBand";
import { useDisplayTz } from "@/components/business-tz";
import { fmtDate } from "@/lib/format-date";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import { ENTITY_LABEL, NOT_IMPORTED_LABEL, fieldLabel, fmt } from "./labels";
import { RowsPanel, type ListRowsAction, type RowTab } from "./RowsPanel";
import { ConfirmTypedDialog } from "./ConfirmTypedDialog";
import { newCount } from "./steps";

type Mapping = Record<string, string | null>;
const NONE = "__none";

/** Blockers the rows tab shows on its own; the rest are listed above it. */
const ROW_BLOCKERS = ["invalid_rows"];

export function ImportReview({
  biz,
  business,
  run,
  fields,
  canManage,
  listRows,
  recheckAction,
  startAction,
  discardAction,
  onRun,
  onDiscarded,
}: {
  biz: string;
  business: Business | undefined;
  run: ImportRun;
  fields: Partial<Record<ImportEntity, TemplateField[]>>;
  canManage: boolean;
  listRows: ListRowsAction;
  recheckAction: (
    biz: string,
    run: string,
    body: { mapping?: Partial<Record<ImportEntity, Mapping>>; options?: ImportOptions },
  ) => Promise<ImportRunResult>;
  startAction: (biz: string, run: string, confirm?: string) => Promise<ImportRunResult>;
  discardAction: (biz: string, run: string) => Promise<ImportRunResult>;
  onRun: (run: ImportRun) => void;
  onDiscarded: () => void;
}) {
  const tz = useDisplayTz();
  const summary = run.summary!;
  const live = business?.livemode === "live";
  const [busy, setBusy] = React.useState<null | "check" | "start" | "discard">(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [mappings, setMappings] = React.useState<Partial<Record<ImportEntity, Mapping>>>(() =>
    Object.fromEntries(run.files.map((f) => [f.entity, { ...f.mapping }])),
  );
  const changed = run.files.some(
    (f) => JSON.stringify(mappings[f.entity]) !== JSON.stringify(f.mapping),
  );

  const entities = run.files.map((f) => f.entity);
  const count = (k: "new" | "existing" | "invalid" | "excluded") =>
    Object.fromEntries(entities.map((e) => [e, summary.entities[e]?.[k] ?? 0]));
  const invalid = Object.values(count("invalid")).reduce((a, b) => a + b, 0);
  const adding = newCount(run);
  const otherBlockers = summary.blockers.filter((b) => !ROW_BLOCKERS.includes(b.code));
  const renew = summary.warnings.find((w) => w.code === "renews_within_24h");
  const cards = summary.warnings.filter(
    (w) => w.code === "gateway_not_connected" || w.code === "no_card",
  );
  const collection = summary.warnings.find(
    (w) => w.code === "open_invoices_not_collected" || w.code === "open_invoices_collected",
  );
  const otherWarnings = summary.warnings.filter(
    (w) =>
      ![
        "renews_within_24h",
        "gateway_not_connected",
        "no_card",
        "open_invoices_not_collected",
        "open_invoices_collected",
      ].includes(w.code),
  );
  const history = summary.history;
  // Collection on: the import charges nobody, but the retry schedule then collects open invoices.
  const collects = !!run.options.collect_open_invoices && (history?.open_invoices ?? 0) > 0;
  const charged = collects
    ? "The import charges no customer. Open invoices are then collected on your retry schedule."
    : "No customer is charged.";
  const canStart = canManage && summary.ready && !changed && busy === null;

  async function recheck(options?: ImportOptions) {
    setBusy("check");
    const r = await recheckAction(biz, run.id, {
      mapping: changed ? mappings : undefined,
      options: options ?? run.options,
    });
    setBusy(null);
    if (!r.ok) return toast.error(r.message);
    onRun(r.run);
  }

  async function start(confirm?: string) {
    setBusy("start");
    const r = await startAction(biz, run.id, confirm);
    setBusy(null);
    if (!r.ok) return toast.error(r.message);
    setConfirmOpen(false);
    onRun(r.run);
  }

  async function discard() {
    setBusy("discard");
    const r = await discardAction(biz, run.id);
    setBusy(null);
    if (!r.ok) return toast.error(r.message);
    toast("Import discarded.");
    onDiscarded();
  }

  const tabs: RowTab[] = [
    {
      id: "new",
      label: "New",
      counts: count("new"),
      sub: adding ? `${plural(adding, "record")} to add` : "Nothing to add",
      filter: { state: "new" },
    },
    {
      id: "invalid",
      label: "Blocked",
      counts: count("invalid"),
      sub: invalid ? "Cannot be imported" : "Nothing blocked",
      red: true,
      filter: { state: "invalid" },
    },
    {
      id: "existing",
      label: "In this business",
      counts: count("existing"),
      sub: "Kept as it is",
      filter: { state: "existing" },
    },
    {
      id: "excluded",
      label: "Left out",
      counts: count("excluded"),
      sub: "Not imported",
      filter: { state: "excluded" },
    },
    {
      id: "all",
      label: "All",
      counts: Object.fromEntries(entities.map((e) => [e, summary.entities[e]?.rows ?? 0])),
      sub: "Every row checked",
      filter: {},
    },
  ];

  const status =
    busy === "check" ? (
      "Checking the files…"
    ) : busy === "start" ? (
      "Starting the import…"
    ) : changed ? (
      "You changed the columns. Check again to use them."
    ) : !summary.ready ? (
      invalid && !run.options.skip_invalid_rows ? (
        "Correct the blocked rows or leave them out first."
      ) : (
        "Correct the problems above first."
      )
    ) : (
      <>
        <span className="font-medium text-foreground">{plural(adding, "new record")}</span> to{" "}
        {business?.name ?? "this business"}. {charged}
      </>
    );

  return (
    <div className="flex flex-col gap-5">
      {otherBlockers.length > 0 && (
        <Alert tone="error" title="Correct these before you import">
          <ul className="m-0 list-inside list-disc space-y-1 p-0">
            {otherBlockers.map((b) => (
              <li key={b.code + b.message}>{b.message}</li>
            ))}
          </ul>
        </Alert>
      )}
      {renew && (
        <Alert
          tone="warning"
          title={`${plural(renew.count ?? 0, "subscription renews", "subscriptions renew")} in the next 24 hours`}
          action={
            canManage ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => recheck({ ...run.options, exclude_renewing_within_24h: true })}
              >
                Leave them out
              </Button>
            ) : null
          }
        >
          Stop their renewals in your current system first, or leave them out and import them after
          they renew there.
        </Alert>
      )}
      {run.options.exclude_renewing_within_24h && (
        <Alert
          tone="neutral"
          action={
            canManage ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => recheck({ ...run.options, exclude_renewing_within_24h: false })}
              >
                Put them back
              </Button>
            ) : null
          }
        >
          Subscriptions that renew in the next 24 hours are left out.
        </Alert>
      )}
      {cards.length > 0 && (
        <Alert
          tone="warning"
          title="Some renewals cannot take a payment"
          action={
            summary.payment.gateways_not_connected.length ? (
              <Link href={`/businesses/${biz}/settings/gateways`} className="font-medium underline">
                Connect a payment gateway
              </Link>
            ) : null
          }
        >
          {cards.map((w) => (
            <p key={w.code} className="m-0">
              {w.message}
            </p>
          ))}
        </Alert>
      )}
      {collection && (
        <Alert
          tone={run.options.collect_open_invoices ? "warning" : "neutral"}
          title={
            run.options.collect_open_invoices
              ? "Open invoices are collected"
              : "Open invoices are owed, and nothing collects them"
          }
          action={
            canManage ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  recheck({
                    ...run.options,
                    collect_open_invoices: !run.options.collect_open_invoices,
                  })
                }
              >
                {run.options.collect_open_invoices ? <>Do not collect them</> : <>Collect them</>}
              </Button>
            ) : null
          }
        >
          {collection.message}
        </Alert>
      )}
      {otherWarnings.length > 0 && (
        <Alert tone="warning" title="Read these before you import">
          <ul className="m-0 list-inside list-disc space-y-1 p-0">
            {otherWarnings.map((w) => (
              <li key={w.code + w.message}>{w.message}</li>
            ))}
          </ul>
        </Alert>
      )}

      <RowsPanel
        biz={biz}
        runId={run.id}
        version={run.checked_at ?? run.created_at}
        entities={entities}
        tabs={tabs}
        initialTab={invalid && !run.options.skip_invalid_rows ? "invalid" : "new"}
        listRows={listRows}
        aside={(tab) =>
          tab === "invalid" && invalid > 0 ? (
            <div className="border-b p-4">
              <Alert
                tone="error"
                title={`${plural(invalid, "row")} cannot be imported`}
                action={
                  canManage && !run.options.skip_invalid_rows ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => recheck({ ...run.options, skip_invalid_rows: true })}
                    >
                      Leave out blocked rows
                    </Button>
                  ) : null
                }
              >
                Correct the file, then upload it again. Or leave the rows out: a row that needs a
                left-out row is left out too.{" "}
                <DownloadLinks
                  biz={biz}
                  run={run}
                  files={run.files.filter((f) => (summary.entities[f.entity]?.invalid ?? 0) > 0)}
                  label="Download the file with errors"
                />
              </Alert>
            </div>
          ) : tab === "excluded" && run.options.skip_invalid_rows && canManage ? (
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-sm text-muted-foreground">
              Rows with errors are left out.
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => recheck({ ...run.options, skip_invalid_rows: false })}
              >
                Put them back
              </Button>
            </div>
          ) : null
        }
      />

      <div className="grid grid-cols-1 items-start gap-5 @min-[56.875rem]/main:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          {run.files.map((f) => (
            <ColumnsCard
              key={f.entity}
              biz={biz}
              runId={run.id}
              file={f}
              fields={fields[f.entity] ?? []}
              mapping={mappings[f.entity] ?? f.mapping}
              disabled={!canManage || busy !== null}
              listRows={listRows}
              onChange={(m) => setMappings((cur) => ({ ...cur, [f.entity]: m }))}
            />
          ))}
        </div>
        <SettingsCard title="After the import">
          <Fact label="Money that arrives each month">
            {summary.mrr.length
              ? summary.mrr.map((m) => (
                  <div key={m.currency} className="tabular-nums">
                    {money(m.amount_minor, m.currency)} MRR
                  </div>
                ))
              : "No new subscriptions"}
          </Fact>
          <Fact label="Saved cards">
            {summary.payment.with_card_connected +
              summary.payment.with_card_not_connected +
              summary.payment.without_card ===
            0 ? (
              "No new subscriptions"
            ) : (
              <>
                <div className="tabular-nums">
                  {plural(summary.payment.with_card_connected, "customer")} with a card at a
                  connected gateway
                </div>
                {summary.payment.with_card_not_connected > 0 && (
                  <div className="text-warning tabular-nums">
                    {plural(summary.payment.with_card_not_connected, "customer")} with a card at{" "}
                    {summary.payment.gateways_not_connected.join(", ")}, not connected
                  </div>
                )}
                {summary.payment.without_card > 0 && (
                  <div className="text-muted-foreground tabular-nums">
                    {plural(summary.payment.without_card, "customer")} with no card
                  </div>
                )}
              </>
            )}
          </Fact>
          <Fact label="Renewals">
            {summary.renewals.first_at ? (
              <>
                First {fmtDate(summary.renewals.first_at, tz)}
                {summary.renewals.last_at && summary.renewals.last_at !== summary.renewals.first_at
                  ? `, last ${fmtDate(summary.renewals.last_at, tz)}`
                  : ""}
              </>
            ) : (
              "No renewals"
            )}
          </Fact>
          {summary.test_limits && (
            <Fact label="Test business limits">
              {(["customers", "subscriptions"] as const).map((k) => {
                const t = summary.test_limits![k];
                return (
                  <div key={k} className="tabular-nums">
                    {k === "customers" ? "Customers" : "Subscriptions"}: {fmt(t.used + t.adding)}
                    {t.limit != null ? ` of ${fmt(t.limit)}` : ""}
                  </div>
                );
              })}
            </Fact>
          )}
          {history && (
            <>
              <Fact label="Owed on open invoices">
                {history.receivables.length
                  ? history.receivables.map((m) => (
                      <div key={m.currency} className="tabular-nums">
                        {money(m.amount_minor, m.currency)} on{" "}
                        {plural(history.open_invoices, "invoice")}
                      </div>
                    ))
                  : "No open invoices"}
              </Fact>
              {history.credit.length > 0 && (
                <Fact label="Credit customers can use">
                  {history.credit.map((m) => (
                    <div key={m.currency} className="tabular-nums">
                      {money(m.amount_minor, m.currency)}
                    </div>
                  ))}
                </Fact>
              )}
              {history.next_invoice_number != null && (
                <Fact label="Next invoice number">
                  <span className="tabular-nums">{history.next_invoice_number}</span>
                </Fact>
              )}
            </>
          )}
          <Fact label="Not imported">
            <span className="text-muted-foreground">
              {summary.not_imported.map((k) => NOT_IMPORTED_LABEL[k] ?? k).join(", ")}. Set them up
              in this business.
            </span>
          </Fact>
          <Fact label="Emails and webhooks">
            <span className="text-muted-foreground">
              Off for imported records. No customer gets an email. {charged}
            </span>
          </Fact>
        </SettingsCard>
      </div>

      <ActionBar status={status}>
        {canManage && (
          <>
            <MoreMenu icon label="More actions">
              <button type="button" onClick={discard} disabled={busy !== null}>
                Discard this import
              </button>
            </MoreMenu>
            <Button variant="outline" onClick={() => recheck()} disabled={busy !== null}>
              Check again
            </Button>
          </>
        )}
        <Button onClick={() => (live ? setConfirmOpen(true) : start())} disabled={!canStart}>
          Start the import
        </Button>
      </ActionBar>

      <ConfirmTypedDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Import into ${business?.name ?? "this business"}?`}
        description={
          <>
            The import adds {plural(adding, "record")} to the live business {business?.name ?? ""}.
            {charged} No email is sent. You can undo the import until the first renewal, payment or
            change on a record it added.
          </>
        }
        name={business?.name ?? ""}
        busy={busy === "start"}
        action="Start the import"
        busyLabel="Starting…"
        onConfirm={start}
      />
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 px-5 py-3 text-sm">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** One link per file: the file as uploaded, with a result column. */
export function DownloadLinks({
  biz,
  run,
  files,
  label,
}: {
  biz: string;
  run: ImportRun;
  files: ImportFile[];
  label: string;
}) {
  if (!files.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-x-3 gap-y-1">
      {files.map((f) => (
        <a
          key={f.entity}
          href={`/businesses/${biz}/imports/download?run=${run.id}&entity=${f.entity}`}
          download
          className="inline-flex items-center gap-1 font-medium underline"
        >
          <Download aria-hidden className="size-3.5" />
          {files.length > 1 ? `${label}: ${ENTITY_LABEL[f.entity].toLowerCase()}` : label}
        </a>
      ))}
    </span>
  );
}

/** One file's columns: what each is imported as, with its first value. */
function ColumnsCard({
  biz,
  runId,
  file,
  fields,
  mapping,
  disabled,
  listRows,
  onChange,
}: {
  biz: string;
  runId: string;
  file: ImportFile;
  fields: TemplateField[];
  mapping: Mapping;
  disabled: boolean;
  listRows: ListRowsAction;
  onChange: (m: Mapping) => void;
}) {
  const [first, setFirst] = React.useState<Record<string, string> | null>(null);
  React.useEffect(() => {
    let live = true;
    listRows(biz, runId, { entity: file.entity, limit: 1 }).then((p) => {
      if (live) setFirst(p?.data[0]?.values ?? {});
    });
    return () => {
      live = false;
    };
  }, [biz, runId, file.entity, listRows]);

  const mapped = file.headers.filter((h) => mapping[h]).length;
  const used = new Set(Object.values(mapping).filter(Boolean));
  const missing = fields.filter((f) => f.required && !used.has(f.key));
  const options = [
    { value: NONE, label: "Do not import" },
    ...fields.map((f) => ({ value: f.key, label: fieldLabel(f.key) })),
  ];

  function set(header: string, key: string) {
    const next: Mapping = { ...mapping };
    const value = key === NONE ? null : key;
    // A field takes one column: the column that had it is no longer imported.
    if (value) for (const h of Object.keys(next)) if (next[h] === value) next[h] = null;
    next[header] = value;
    onChange(next);
  }

  return (
    <SettingsCard
      title={`Columns · ${file.filename}`}
      meta={
        <span className="text-xs text-muted-foreground tabular-nums">
          {mapped} of {file.headers.length} mapped · {plural(file.rows, "row")}
        </span>
      }
    >
      {missing.length > 0 && (
        <div className="px-5 py-3">
          <Alert tone="error">
            Select a column for {missing.map((f) => fieldLabel(f.key)).join(", ")}.
          </Alert>
        </div>
      )}
      <Table phone="stack" className={FLUSH}>
        <TableHeader>
          <TableRow>
            <TableHead phone="title">Column in your file</TableHead>
            <TableHead>First value</TableHead>
            <TableHead className="w-64">Import as</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {file.headers.map((h) => (
            <TableRow key={h}>
              <TableCell className="align-middle font-medium wrap-break-word whitespace-normal">
                {h || <span className="text-muted-foreground">No name</span>}
              </TableCell>
              <TableCell className="max-w-48 truncate align-middle text-muted-foreground">
                {first == null ? "…" : first[h] || "—"}
              </TableCell>
              <TableCell className="align-middle">
                <SelectField
                  ariaLabel={`Import ${h || "this column"} as`}
                  size="sm"
                  className="w-full"
                  value={mapping[h] ?? NONE}
                  disabled={disabled || fields.length === 0}
                  onValueChange={(v) => set(h, v)}
                  options={options}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SettingsCard>
  );
}
