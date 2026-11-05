"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { Input } from "@/components/ui/input";
import { SelectField } from "@/components/ui/select-field";
import { cn } from "@/lib/utils";
import { Consequence, FieldLabel, SettingRow } from "@/components/settings/settings-layout";
import {
  composeDocumentNumber,
  DYNAMIC_PREFIX_OPTIONS,
  SEPARATOR_OPTIONS,
  MONTH_OPTIONS,
  type DynamicPrefix,
  type NumberSeparator,
} from "@/lib/document-numbering";

/**
 * The number FORMAT for one document type, with a live preview.
 *
 * The preview is the point of the screen. A merchant editing a prefix is choosing an
 * identifier that will sit on tax documents for years, and "prefix + dynamic prefix +
 * separators + counter" is not a rule anyone can evaluate in their head. Composition
 * mirrors the engine — see `lib/document-numbering.ts` for the source-of-truth pointer.
 *
 * Renders setting rows; place it inside a `SettingsCard`.
 *
 * `name` is prefixed (`inv_` / `cn_`) so the invoice and credit-note cards can post from
 * their own forms without colliding, matching `numberingFrom(fd, prefix)` in the action.
 */
export function DocumentNumberingFields({
  prefix: fieldPrefix,
  label,
  numberPrefix,
  nextNumber,
  timezone,
  dynamicPrefix,
  separator1,
  separator2,
  increment,
  fiscalYearStartMonth,
  prefixFieldName,
  nextNumberFieldName,
}: {
  /** Form-field prefix: `inv_` or `cn_`. */
  prefix: string;
  /** "invoice" / "credit note", used in help text. */
  label: string;
  numberPrefix: string;
  nextNumber: number;
  /** The BUSINESS timezone — the dynamic stamp is resolved there, not in the browser. */
  timezone: string;
  dynamicPrefix: DynamicPrefix;
  separator1: NumberSeparator;
  separator2: NumberSeparator;
  increment: number;
  fiscalYearStartMonth: number;
  /** The existing top-level prefix/counter field names (own columns, not the jsonb). */
  prefixFieldName: string;
  nextNumberFieldName: string;
}) {
  // Re-seeded from the saved row, or the next save posts a stale counter and moves it backwards.
  const [p, setP] = useDefaultState(numberPrefix);
  const [n, setN] = useDefaultState(String(nextNumber));
  const [dyn, setDyn] = useDefaultState<DynamicPrefix>(dynamicPrefix);
  const [s1, setS1] = useDefaultState<NumberSeparator>(separator1);
  const [s2, setS2] = useDefaultState<NumberSeparator>(separator2);
  const [inc, setInc] = useDefaultState(String(increment));
  const [fym, setFym] = useDefaultState(String(fiscalYearStartMonth));

  // One instant for the whole preview, so the two lines below cannot straddle midnight.
  const now = React.useMemo(() => new Date(), []);
  const counter = Number(n);
  const step = Number(inc);
  const preview = (c: number) =>
    composeDocumentNumber({
      prefix: p,
      counter: c,
      dynamicPrefix: dyn,
      separator1: s1,
      separator2: s2,
      fiscalYearStartMonth: Number(fym) || 1,
      at: now,
      timezone,
    });

  const valid = Number.isInteger(counter) && counter >= 1 && Number.isInteger(step) && step >= 1;

  const sepLabel = dyn === "none" ? "Separator" : "Separator — prefix to date";

  return (
    <>
      <SettingRow
        label="Number prefix"
        htmlFor={prefixFieldName}
        errorFor={prefixFieldName}
        help="1–20 characters."
        control={
          <Input
            id={prefixFieldName}
            name={prefixFieldName}
            value={p}
            onChange={(e) => setP(e.target.value)}
            required
            maxLength={20}
            className="w-40 font-mono"
          />
        }
      />
      <SettingRow
        label="Next number"
        htmlFor={nextNumberFieldName}
        errorFor={nextNumberFieldName}
        help={`Only increase this number. If a number in the same format is already issued, the next ${label} fails to issue.`}
        control={
          <Input
            id={nextNumberFieldName}
            name={nextNumberFieldName}
            type="number"
            min={1}
            step={1}
            value={n}
            onChange={(e) => setN(e.target.value)}
            className="w-32 tabular-nums"
          />
        }
      />
      <SettingRow
        label="Dynamic prefix"
        htmlFor={`${fieldPrefix}dynamic_prefix`}
        help={`A date stamp between the prefix and the number, in this business's timezone (${timezone}).`}
        control={
          <SelectField
            name={`${fieldPrefix}dynamic_prefix`}
            value={dyn}
            onValueChange={(v) => setDyn(v as DynamicPrefix)}
            ariaLabel="Dynamic prefix"
            options={DYNAMIC_PREFIX_OPTIONS}
            className="w-full sm:w-56"
          />
        }
      >
        {/* FY cannot render without knowing when the year turns, and markets disagree, so
            it is an explicit choice whenever `fy` is picked. Hidden, never unmounted. */}
        <div className={cn("flex flex-col gap-1.5", dyn !== "fy" && "hidden")}>
          <FieldLabel htmlFor={`${fieldPrefix}fiscal_year_start_month`}>
            Fiscal year starts in
          </FieldLabel>
          <SelectField
            name={`${fieldPrefix}fiscal_year_start_month`}
            value={fym}
            onValueChange={setFym}
            ariaLabel="Fiscal year start month"
            options={MONTH_OPTIONS}
            className="w-full sm:w-56"
          />
          <p className="m-0 text-sm text-muted-foreground">
            In India, the fiscal year is April–March. Most US and EU businesses use the calendar
            year.
          </p>
        </div>
      </SettingRow>
      <SettingRow
        label="Separators"
        // With no stamp there is one joint and it takes separator 1, so separator 2 is
        // hidden — but still posted, so a save keeps its stored value.
        help={dyn === "none" ? "Between the prefix and the number." : undefined}
        control={
          <div className="flex flex-wrap gap-4">
            <div className="flex flex-col gap-1.5">
              <FieldLabel htmlFor={`${fieldPrefix}separator1`}>{sepLabel}</FieldLabel>
              <SelectField
                name={`${fieldPrefix}separator1`}
                value={s1}
                onValueChange={(v) => setS1(v as NumberSeparator)}
                ariaLabel={sepLabel}
                options={SEPARATOR_OPTIONS}
                className="w-44"
              />
            </div>
            <div className={cn("flex flex-col gap-1.5", dyn === "none" && "hidden")}>
              <FieldLabel htmlFor={`${fieldPrefix}separator2`}>
                Separator — date to number
              </FieldLabel>
              <SelectField
                name={`${fieldPrefix}separator2`}
                value={s2}
                onValueChange={(v) => setS2(v as NumberSeparator)}
                ariaLabel="Separator before the number"
                options={SEPARATOR_OPTIONS}
                className="w-44"
              />
            </div>
          </div>
        }
      />
      <SettingRow
        label="Increment by"
        htmlFor={`${fieldPrefix}increment`}
        help={`The amount that the counter increases for each ${label}.`}
        control={
          <Input
            id={`${fieldPrefix}increment`}
            name={`${fieldPrefix}increment`}
            type="number"
            min={1}
            max={1000}
            step={1}
            value={inc}
            onChange={(e) => setInc(e.target.value)}
            className="w-28 tabular-nums"
          />
        }
      />
      <div className="px-5 py-4">
        <Consequence>
          {valid ? (
            <>
              Next {label} will be <b className="font-mono">{preview(counter)}</b>
              {step === 1 ? null : (
                <>
                  , then <b className="font-mono">{preview(counter + step)}</b>
                </>
              )}
              .
            </>
          ) : (
            // Never a fabricated preview: the engine would not produce it.
            `Enter a whole number of 1 or more to preview the next ${label}.`
          )}
        </Consequence>
      </div>
    </>
  );
}
