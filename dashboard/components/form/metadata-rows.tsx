"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SuggestInput, type Suggestion } from "@/components/form/suggest-input";
import type { MetaRow } from "@/lib/metadata-rows";

/**
 * Key/value rows for metadata. Shared by the catalog editor and the customer and subscription
 * editor. With `keySuggestions` the key input lists keys in use; with `valueSuggestions` the
 * value input lists that key's common values.
 */
export function MetadataRows({
  rows,
  onChange,
  keySuggestions,
  valueSuggestions,
  jsonFor,
  addLabel = "+ Add key",
}: {
  rows: MetaRow[];
  onChange: (rows: MetaRow[]) => void;
  keySuggestions?: (row: MetaRow) => Suggestion[];
  valueSuggestions?: (key: string) => Array<Suggestion & { json?: boolean }>;
  /** Whether values of this key are JSON (a number, object…). Applied while the value is empty. */
  jsonFor?: (key: string) => boolean | undefined;
  addLabel?: string;
}) {
  const upd = (i: number, patch: Partial<MetaRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <>
      {rows.map((r, i) => {
        const values = valueSuggestions?.(r.key.trim()) ?? [];
        return (
          <div
            key={i}
            className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2rem] items-center gap-2"
          >
            {keySuggestions ? (
              <SuggestInput
                aria-label={`Metadata key ${i + 1}`}
                value={r.key}
                onChange={(key) => {
                  const json = r.value.trim() ? undefined : jsonFor?.(key.trim());
                  upd(i, json === undefined ? { key } : { key, json });
                }}
                suggestions={keySuggestions(r)}
                placeholder="key"
                maxLength={64}
                className="font-mono"
              />
            ) : (
              <Input
                aria-label={`Metadata key ${i + 1}`}
                value={r.key}
                onChange={(e) => upd(i, { key: e.target.value })}
                placeholder="key"
                maxLength={64}
                className="font-mono"
              />
            )}
            {values.length ? (
              <SuggestInput
                aria-label={`Metadata value ${i + 1}`}
                value={r.value}
                onChange={(value) => {
                  // A suggested number or boolean is stored as that type, not as text.
                  const hit = values.find((v) => v.value === value);
                  upd(i, { value, json: hit ? !!hit.json : r.json });
                }}
                suggestions={values}
                placeholder={r.json ? "JSON value" : "value"}
                className="font-mono"
              />
            ) : (
              <Input
                aria-label={`Metadata value ${i + 1}`}
                value={r.value}
                onChange={(e) => upd(i, { value: e.target.value })}
                placeholder={r.json ? "JSON value" : "value"}
                className="font-mono"
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove metadata key ${r.key || i + 1}`}
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              <X className="size-4" />
            </Button>
          </div>
        );
      })}
      <div>
        <button
          type="button"
          className="text-sm font-medium text-primary hover:underline"
          onClick={() => onChange([...rows, { key: "", value: "", json: false }])}
        >
          {addLabel}
        </button>
      </div>
    </>
  );
}
