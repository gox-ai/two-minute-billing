"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, FileText, Upload, X } from "lucide-react";
import type { Business } from "@/lib/api";
import type { ImportRun } from "@/lib/api/imports";
import { HISTORY_ENTITIES, IMPORT_ENTITIES, type ImportEntity } from "@/lib/import-entities";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "@/components/settings/settings-layout";
import { ActionBar, BizTile, RouteBand } from "@/components/transfer/RouteBand";
import { IMPORT_SIZE_TEXT, MAX_IMPORT_UPLOAD_BYTES } from "@/lib/import-upload";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/labels";
import { ENTITY_HELP, ENTITY_LABEL } from "./labels";
import { importSteps } from "./steps";
import { FilesTile } from "./FilesTile";

type Slot = ImportEntity | "json";

/** The sections a JSON file fills: a JSON file and these CSV files do not go together. */
const JSON_ENTITIES: ImportEntity[] = ["plans", "customers", "subscriptions"];

const sizeOf = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`;

/** Import files › Set up: one row per section with its file, then the check. */
export function ImportForm({
  biz,
  business,
  focus,
  canManage,
  explainer,
  onRun,
}: {
  biz: string;
  business: Business | undefined;
  /** The section the page was opened for (`?section=`), from a list's Import button. */
  focus: ImportEntity | null;
  canManage: boolean;
  explainer: React.ReactNode;
  onRun: (run: ImportRun) => void;
}) {
  const [files, setFiles] = React.useState<Partial<Record<Slot, File>>>({});
  const [busy, setBusy] = React.useState(false);
  const [showExplainer, setShowExplainer] = React.useState(false);
  const focusRef = React.useRef<HTMLLIElement>(null);

  React.useEffect(() => {
    if (focus) focusRef.current?.scrollIntoView({ block: "center" });
  }, [focus]);

  const chosen = Object.entries(files) as Array<[Slot, File]>;
  const total = chosen.reduce((n, [, f]) => n + f.size, 0);
  const tooBig = total > MAX_IMPORT_UPLOAD_BYTES;
  const hasJson = !!files.json;

  function pick(slot: Slot, file: File | null) {
    setFiles((cur) => {
      const next = { ...cur };
      if (file) next[slot] = file;
      else delete next[slot];
      return next;
    });
  }

  async function check() {
    setBusy(true);
    const body = new FormData();
    for (const [slot, f] of chosen) body.append(slot, f, f.name);
    try {
      const res = await fetch(`/businesses/${biz}/imports/upload`, { method: "POST", body });
      const json = (await res.json().catch(() => null)) as (ImportRun & { error?: string }) | null;
      if (!res.ok || json?.object !== "import") {
        toast.error(
          `We could not upload the files. ${json?.error ?? "Try again."}`.replace(/\.\s*\./, "."),
        );
        return;
      }
      onRun(json);
    } catch {
      toast.error("We could not upload the files. Check your connection, then try again.");
    } finally {
      setBusy(false);
    }
  }

  // The set-up first (with the JSON file that can stand in for three of it), then history.
  const core = IMPORT_ENTITIES.filter((e) => !HISTORY_ENTITIES.includes(e));
  const slots: Slot[] = [...core, "json", ...HISTORY_ENTITIES];

  return (
    <div className="flex flex-col gap-5">
      <RouteBand
        label="Import route"
        from={<FilesTile count={chosen.length} />}
        to={<BizTile label="To" biz={business} />}
        aside={
          showExplainer ? (
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2"
              aria-expanded
              onClick={() => setShowExplainer(false)}
            >
              Hide what is imported
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2"
              aria-expanded={false}
              onClick={() => setShowExplainer(true)}
            >
              Show what is imported
            </Button>
          )
        }
        steps={importSteps(null)}
      >
        {showExplainer ? explainer : null}
      </RouteBand>

      {!canManage && (
        <Alert tone="neutral">
          You can see past imports. To import data, ask an owner or an admin.
        </Alert>
      )}

      <SettingsCard
        title="What to import"
        meta={
          <span className="text-xs text-muted-foreground">
            {chosen.length} of {slots.length - 1} sections
          </span>
        }
      >
        <ul className="m-0 list-none divide-y p-0">
          {slots.map((slot) => {
            const heading =
              slot === HISTORY_ENTITIES[0] ? (
                <li
                  key="history-heading"
                  className="bg-muted/30 px-5 py-2 text-xs text-muted-foreground max-sm:px-4"
                >
                  History. Optional: past invoices, credit notes, payments and usage.
                </li>
              ) : null;
            const off = !canManage || (slot !== "json" && hasJson && JSON_ENTITIES.includes(slot));
            const jsonOff = slot === "json" && JSON_ENTITIES.some((e) => files[e]) && !files.json;
            return [
              heading,
              <FileRow
                key={slot}
                ref={slot === focus ? focusRef : undefined}
                biz={biz}
                slot={slot}
                file={files[slot]}
                focused={slot === focus}
                disabled={off || jsonOff || busy}
                note={
                  off && canManage
                    ? "The JSON file has these records."
                    : jsonOff
                      ? "Remove the plans, customers and subscriptions files to use a JSON file."
                      : null
                }
                onPick={(f) => pick(slot, f)}
              />,
            ];
          })}
        </ul>
      </SettingsCard>

      {tooBig && (
        <Alert tone="error" title="The files are too large">
          {IMPORT_SIZE_TEXT} For larger files, use the API, or import the files in more than one
          import.
        </Alert>
      )}

      <ActionBar
        status={
          busy ? (
            "Uploading the files…"
          ) : chosen.length === 0 ? (
            "Upload at least one file. Nothing changes until you start the import."
          ) : (
            <>
              <span className="font-medium text-foreground">{plural(chosen.length, "file")}</span>{" "}
              to {business?.name ?? "this business"}. Nothing changes until you start the import.
            </>
          )
        }
      >
        <Button onClick={check} disabled={!canManage || !chosen.length || tooBig || busy}>
          Check what changes
        </Button>
      </ActionBar>
    </div>
  );
}

function FileRow({
  ref,
  biz,
  slot,
  file,
  focused,
  disabled,
  note,
  onPick,
}: {
  ref?: React.Ref<HTMLLIElement>;
  biz: string;
  slot: Slot;
  file: File | undefined;
  focused: boolean;
  disabled: boolean;
  note: string | null;
  onPick: (f: File | null) => void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const [over, setOver] = React.useState(false);
  const isJson = slot === "json";
  const label = isJson ? "JSON file" : ENTITY_LABEL[slot];
  const help = isJson
    ? "Plans, customers and subscriptions in one file, in the migration JSON format."
    : ENTITY_HELP[slot];
  return (
    <li
      ref={ref}
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors max-sm:px-4",
        focused && "bg-brand-soft/40",
        over && "bg-muted/60",
      )}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f && !disabled) onPick(f);
      }}
    >
      <div className="flex min-w-0 flex-[1_1_16rem] flex-col">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground">{note ?? help}</span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {file ? (
          <span className="flex min-w-0 items-center gap-1.5 text-sm">
            <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="max-w-56 truncate font-medium">{file.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              · {sizeOf(file.size)}
            </span>
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">No file</span>
        )}
        {/* A file input has no primitive: the visible control is a Button. */}
        <input
          ref={input}
          type="file"
          accept={isJson ? ".json,application/json" : ".csv,.tsv,.txt,text/csv"}
          className="hidden"
          aria-label={`${label} file`}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            e.target.value = "";
          }}
        />
        {file ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPick(null)}
            disabled={disabled}
            aria-label={`Remove the ${label.toLowerCase()} file`}
          >
            <X aria-hidden />
            Remove
          </Button>
        ) : null}
        {file ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => input.current?.click()}
            disabled={disabled}
          >
            <Upload aria-hidden />
            Replace
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => input.current?.click()}
            disabled={disabled}
          >
            <Upload aria-hidden />
            Upload
          </Button>
        )}
        {!isJson && (
          <Button variant="ghost" size="sm" asChild>
            <a href={`/businesses/${biz}/imports/download?template=${slot}`} download>
              <Download aria-hidden />
              Template
            </a>
          </Button>
        )}
      </div>
    </li>
  );
}
