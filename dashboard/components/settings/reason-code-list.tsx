"use client";

// The directive is load-bearing: RowLabelInput below calls useFieldError, and without it
// this module sits in the SERVER graph (its only consumer is a server page), so the hook
// arrives as a client reference and calling it throws once a reason code is configured.

import * as React from "react";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ActionForm, useFieldError } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { Input } from "@/components/ui/input";
import { Chip } from "@/components/patterns/chip";
import { Consequence, SettingsCard } from "@/components/settings/settings-layout";
import type { ReasonCode, ReasonCodeAppliesTo } from "@/lib/api/reason-codes";
import {
  createReasonCodeAction,
  updateReasonCodeAction,
  deleteReasonCodeAction,
} from "@/app/(dashboard)/businesses/[biz]/settings/reason-codes/actions";

/*
  Column geometry, shared by the header, the rows and the add form so they line up at
  md+: [label flex-1][code w-52][save w-36] inside the row's label form, then the
  Disable/Delete forms in w-40 outside it. Below md every row stacks.
*/
const ROW = "flex flex-col gap-2 px-5 py-3 xl:flex-row xl:items-center xl:gap-3";
const LEFT = "flex min-w-0 flex-1 flex-col gap-2 xl:flex-row xl:items-center xl:gap-4";
const CODE_COL = "shrink-0 xl:w-52";
const SAVE_COL = "flex shrink-0 items-center gap-2 xl:w-36";
const ACTIONS_COL = "flex shrink-0 items-center gap-2 xl:w-40";

/** Inline label editor for one row. A child of the row's own <ActionForm>, so
 * `useFieldError` reads that submission's errors, not a sibling row's. */
function RowLabelInput({ code, label }: { code: string; label: string }) {
  const error = useFieldError("label");
  return (
    <div className="min-w-0 flex-1">
      <Input
        name="label"
        defaultValue={label}
        aria-label={`Label for ${code}`}
        aria-invalid={error ? true : undefined}
        maxLength={200}
        className="h-8 w-full"
      />
      {error ? <p className="mt-1 text-xs font-medium text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * One reason-code card (per `applies_to`): the configured rows, or the built-in
 * fallbacks greyed out when nothing is configured, plus an inline add row.
 * Showing the fallbacks matters — an empty list would imply the picker offers nothing.
 */
export function ReasonCodeList({
  biz,
  appliesTo,
  title,
  rows,
  fallback,
  help,
  emptyText,
}: {
  biz: string;
  appliesTo: ReasonCodeAppliesTo;
  title: string;
  rows: ReasonCode[];
  fallback: ReadonlyArray<{ code: string; label: string }>;
  /** Where this list is offered — one line under the header. */
  help?: React.ReactNode;
  /** Shown when nothing is configured and there is no built-in list. */
  emptyText?: React.ReactNode;
}) {
  const usingFallback = rows.length === 0 && fallback.length > 0;
  const enabled = rows.filter((r) => r.enabled).length;
  const disabled = rows.length - enabled;
  const meta = usingFallback
    ? "Not configured · built-in list offered"
    : rows.length === 0
      ? "None configured"
      : `${enabled} offered${disabled ? ` · ${disabled} disabled` : ""}`;

  return (
    <SettingsCard id={appliesTo} title={title} meta={meta}>
      {help ? (
        <div className="px-5 py-3">
          <p className="m-0 text-sm text-muted-foreground">{help}</p>
        </div>
      ) : null}

      {/* Columns named once, here, rather than per row. */}
      {usingFallback || rows.length > 0 ? (
        <div className="hidden items-center gap-3 bg-muted/40 px-5 py-2 text-xs font-medium text-muted-foreground xl:flex">
          <div className="flex min-w-0 flex-1 items-center gap-4">
            <span className="flex-1">Label</span>
            <span className={CODE_COL}>Code</span>
            <span className={SAVE_COL} />
          </div>
          <span className={ACTIONS_COL} />
        </div>
      ) : null}

      {usingFallback
        ? fallback.map((f) => (
            // The opacity marks them as built-in, not rows you can edit.
            <div key={f.code} className={cn(ROW, "opacity-60")}>
              <div className={LEFT}>
                <span className="flex-1 text-sm">{f.label}</span>
                <code className={cn(CODE_COL, "font-mono text-xs text-muted-foreground")}>
                  {f.code}
                </code>
                <span className={cn(SAVE_COL, "max-xl:hidden")} />
              </div>
              <span className={cn(ACTIONS_COL, "max-xl:hidden")} />
            </div>
          ))
        : null}

      {!usingFallback && rows.length === 0 ? (
        <p className="m-0 px-5 py-3 text-sm text-muted-foreground">
          {emptyText ?? "None configured."}
        </p>
      ) : null}

      {rows.map((r) => (
        <div key={r.id} className={ROW}>
          <ActionForm action={updateReasonCodeAction} className={LEFT}>
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="id" value={r.id} />
            <RowLabelInput code={r.code} label={r.label} />
            {/* Left aligned: an identifier reads from its start. */}
            <code className={cn(CODE_COL, "truncate font-mono text-xs text-muted-foreground")}>
              {r.code}
            </code>
            <span className={SAVE_COL}>
              <SubmitButton size="sm" variant="outline">
                Save
              </SubmitButton>
              {!r.enabled ? <Chip tone="gray">Disabled</Chip> : null}
            </span>
          </ActionForm>

          <span className={ACTIONS_COL}>
            <ActionForm action={updateReasonCodeAction}>
              <input type="hidden" name="biz" value={biz} />
              <input type="hidden" name="id" value={r.id} />
              <input type="hidden" name="enabled" value={r.enabled ? "false" : "true"} />
              <SubmitButton size="sm" variant="ghost">
                {r.enabled ? "Disable" : "Enable"}
              </SubmitButton>
            </ActionForm>
            {/* No confirm: records keep their stored code, and the row can be re-added. */}
            <ActionForm action={deleteReasonCodeAction}>
              <input type="hidden" name="biz" value={biz} />
              <input type="hidden" name="id" value={r.id} />
              <SubmitButton size="sm" variant="ghost" className="text-destructive">
                Delete
              </SubmitButton>
            </ActionForm>
          </span>
        </div>
      ))}

      {/* All disabled: the picker falls back as if nothing were configured. */}
      {rows.length > 0 && enabled === 0 ? (
        <div className="px-5 py-3">
          <Consequence>
            {fallback.length > 0
              ? "All codes here are disabled, so we offer the built-in list."
              : "All codes here are disabled, so we offer no codes."}
          </Consequence>
        </div>
      ) : null}

      <ActionForm action={createReasonCodeAction} className={cn(ROW, "bg-muted/40")}>
        <input type="hidden" name="biz" value={biz} />
        <input type="hidden" name="applies_to" value={appliesTo} />
        <div className={LEFT}>
          <Input
            name="label"
            aria-label={`Label for a new ${title.toLowerCase()} reason`}
            placeholder="e.g. Switched to another product"
            className="h-8 w-full xl:w-auto xl:flex-1"
            required
            maxLength={200}
          />
          <Input
            name="code"
            aria-label={`Code for a new ${title.toLowerCase()} reason`}
            placeholder="Code (derived from label)"
            maxLength={64}
            className={cn(CODE_COL, "h-8 w-full font-mono text-xs")}
          />
          <span className={SAVE_COL}>
            <SubmitButton size="sm">
              <Plus className="mr-1 size-3.5" aria-hidden />
              Create
            </SubmitButton>
          </span>
        </div>
        <span className={cn(ACTIONS_COL, "max-xl:hidden")} />
      </ActionForm>
    </SettingsCard>
  );
}
