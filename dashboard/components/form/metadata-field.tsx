"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SelectField } from "@/components/ui/select-field";
import { useFieldError } from "@/components/form/action-form";
import { useDefaultState } from "@/lib/use-default-state";
import { MetadataRows } from "@/components/form/metadata-rows";
import { SuggestInput, type Suggestion } from "@/components/form/suggest-input";
import { MetadataJsonField } from "@/components/form/metadata-json-field";
import { checkMetadata } from "@/lib/metadata-form";
import { metaJson, metaRows, type MetaRow } from "@/lib/metadata-rows";
import { checkMetadataWrite, resolvePath } from "@/lib/metadata-rules-check";
import {
  buildRuleTree,
  deleteAt,
  displayOf,
  fieldKind,
  keySuggestions,
  metaText,
  otherKeys,
  parseField,
  pathOfError,
  ruleError,
  setAt,
  toSpec,
  uncoveredChildren,
  valueHints,
  withOtherKeys,
  type EditorRule,
  type Meta,
  type ObservedKey,
  type RuleNode,
} from "@/lib/metadata-editor";

/** What the page loads for the editor. Null when it could not be loaded. */
export interface MetadataEditorData {
  /** The business's active rules for this entity. */
  rules: EditorRule[];
  validation: "on" | "off";
  strict: boolean;
  /** Paths already in use, for suggestions. */
  observed: ObservedKey[];
}

type Raw = string | string[];

const isObj = (v: unknown): v is Meta => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const count = (n: number) => n.toLocaleString("en-US");
const detailOf = (o: ObservedKey) =>
  `${count(o.rows)} ${o.rows === 1 ? "record" : "records"} · ${o.type}`;

/**
 * Customer and subscription metadata.
 *
 * With rules, one control per rule path, plus "Other keys" for paths no rule covers. Without
 * rules, key/value rows. Both suggest keys and values already in use, and both have an "Edit as
 * JSON" view. The field posts the same JSON text the plain textarea posted, so the server
 * actions are unchanged; an unchanged value posts the text it started with.
 */
export function MetadataField({
  name = "metadata",
  metadata,
  editor,
  onTextChange,
}: {
  name?: string;
  metadata: Record<string, unknown> | null | undefined;
  editor: MetadataEditorData | null | undefined;
  onTextChange?: (text: string, valid: boolean) => void;
}) {
  // No editor data (the rules could not be read): the plain JSON field still works.
  if (!editor)
    return <MetadataJsonField name={name} metadata={metadata} onTextChange={onTextChange} />;
  return (
    <StructuredMetadata
      // A new stored value (after a save) starts the editor again from it.
      key={JSON.stringify(metadata ?? null)}
      name={name}
      stored={isObj(metadata) ? metadata : null}
      editor={editor}
      onTextChange={onTextChange}
    />
  );
}

function StructuredMetadata({
  name,
  stored,
  editor,
  onTextChange,
}: {
  name: string;
  stored: Meta | null;
  editor: MetadataEditorData;
  onTextChange?: (text: string, valid: boolean) => void;
}) {
  const { rules, validation, strict, observed } = editor;
  const hasRules = rules.length > 0;
  const enforce = validation === "on";
  const otherHidden = hasRules && enforce && strict;
  const tree = React.useMemo(() => buildRuleTree(rules), [rules]);
  const observedByPath = React.useMemo(() => new Map(observed.map((o) => [o.path, o])), [observed]);

  const [current, setCurrent] = useDefaultState<Meta>(stored ?? {}, (m) => JSON.stringify(m));
  const [raws, setRaws] = React.useState<Record<string, Raw>>({});
  const [fieldErrs, setFieldErrs] = React.useState<Record<string, string>>({});
  const [rows, setRows] = React.useState<MetaRow[]>(() =>
    metaRows(hasRules ? otherKeys(stored, rules) : stored),
  );
  const [rowsErr, setRowsErr] = React.useState<string | null>(null);
  const [jsonMode, setJsonMode] = React.useState(false);
  const [jsonText, setJsonText] = React.useState("");
  const [jsonErr, setJsonErr] = React.useState<string | null>(null);

  const serverError = useFieldError(name);
  const serverPath = pathOfError(serverError);
  const initialText = metaText(stored);

  // The whole-value check the API runs (strict, blocked paths). Per-field messages come first.
  let topErr: string | null = null;
  if (enforce && hasRules) {
    try {
      checkMetadataWrite({
        validation,
        rules: rules.map(toSpec),
        strict,
        next: current,
        existing: stored,
        mode: "update",
        scope: "enforce",
      });
    } catch (e) {
      topErr = (e as Error).message;
    }
  }
  const anyErr =
    Object.values(fieldErrs).some(Boolean) || !!rowsErr || (jsonMode && !!jsonErr) || !!topErr;
  const text = same(current, stored ?? {}) ? initialText : metaText(current);

  const report = React.useRef(onTextChange);
  React.useEffect(() => {
    report.current = onTextChange;
  });
  React.useEffect(() => {
    report.current?.(text, !anyErr);
  }, [text, anyErr]);

  // A hidden input cannot block a submit; this sr-only one carries the browser's validity.
  const gate = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    gate.current?.setCustomValidity(anyErr ? "Fix the metadata before you save." : "");
  }, [anyErr]);

  // ── edits ──────────────────────────────────────────────────────────────────
  const editField = (node: RuleNode, raw: Raw) => {
    const r = node.rule!;
    setRaws((m) => ({ ...m, [node.path]: raw }));
    const p = parseField(r, fieldKind(r), raw);
    if ("error" in p) {
      setFieldErrs((m) => ({ ...m, [node.path]: p.error }));
      return;
    }
    const next = p.absent ? deleteAt(current, node.segs) : setAt(current, node.segs, p.value);
    setCurrent(next);
    const before = resolvePath(stored, node.segs);
    const changed = !same(
      before.state === "value" ? before.value : undefined,
      p.absent ? undefined : p.value,
    );
    const msg = !p.absent && changed && enforce ? ruleError(r, p.value) : null;
    setFieldErrs((m) => ({ ...m, [node.path]: msg ?? "" }));
  };

  const editRows = (next: MetaRow[]) => {
    setRows(next);
    const { json, error } = metaJson(next);
    setRowsErr(error ?? null);
    if (error) return;
    const parsed: Meta = json ? (JSON.parse(json) as Meta) : {};
    setCurrent(hasRules ? withOtherKeys(current, rules, parsed) : parsed);
  };

  const toJson = () => {
    setJsonText(metaText(current));
    setJsonErr(null);
    setJsonMode(true);
  };
  const editJson = (t: string) => {
    setJsonText(t);
    const r = checkMetadata(t);
    if (!r.ok) {
      setJsonErr(r.error);
      return;
    }
    setJsonErr(null);
    setCurrent(r.value ?? {});
  };
  const toForm = () => {
    if (jsonErr) return;
    setRaws({});
    setFieldErrs({});
    setRows(metaRows(hasRules ? otherKeys(current, rules) : current));
    setRowsErr(null);
    setJsonMode(false);
  };

  // ── suggestions ────────────────────────────────────────────────────────────
  const keySugs = (row: MetaRow): Suggestion[] =>
    keySuggestions(
      observed,
      rules,
      rows.filter((r) => r !== row).map((r) => r.key.trim()),
    ).map((o) => ({ value: o.path, detail: detailOf(o) }));
  const valueSugs = (key: string) =>
    valueHints(observedByPath.get(key)).map((h) => ({
      value: h.text,
      detail: `${count(h.rows)}`,
      json: h.json,
    }));
  const jsonFor = (key: string) => {
    const o = observedByPath.get(key);
    return o ? o.type !== "string" : undefined;
  };

  // ── render ─────────────────────────────────────────────────────────────────
  const fieldMsg = (path: string) =>
    fieldErrs[path] || (serverPath === path ? (serverError ?? null) : null) || null;
  const generalError =
    rowsErr ??
    (serverError && (!serverPath || jsonMode) ? serverError : null) ??
    (topErr && !Object.values(fieldErrs).some(Boolean) ? topErr : null);

  return (
    <div className="flex flex-col gap-4" id={name}>
      <input type="hidden" name={name} value={text} />
      <input
        ref={gate}
        aria-hidden
        tabIndex={-1}
        className="sr-only"
        value={anyErr ? "" : "ok"}
        required
        readOnly
      />

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {hasRules
            ? enforce
              ? "The business checks these paths when you save."
              : "Validation is off, so the rules only arrange this form."
            : "Your own keys and values. We store them with the record. Billing never uses them."}
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={jsonMode ? toForm : toJson}
          disabled={jsonMode && !!jsonErr}
        >
          {jsonMode ? "Edit as form" : "Edit as JSON"}
        </Button>
      </div>

      {jsonMode ? (
        <div className="space-y-1.5">
          <Textarea
            aria-label="Metadata as JSON"
            rows={10}
            spellCheck={false}
            className="font-mono text-xs"
            value={jsonText}
            onChange={(e) => editJson(e.target.value)}
            aria-invalid={jsonErr ? true : undefined}
          />
          {jsonErr ? <p className="text-xs font-medium text-destructive">{jsonErr}</p> : null}
        </div>
      ) : (
        <>
          {tree.map((node) => (
            <RuleNodeView
              key={node.path}
              node={node}
              rules={rules}
              current={current}
              raws={raws}
              observedByPath={observedByPath}
              onEdit={editField}
              messageFor={fieldMsg}
            />
          ))}

          {otherHidden ? (
            hasRules && Object.keys(otherKeys(current, rules)).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Strict mode is on. The business refuses keys that have no rule.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Strict mode is on. The business refuses new keys that have no rule. Stored keys
                without a rule stay as they are.
              </p>
            )
          ) : (
            <div className="flex flex-col gap-2">
              {hasRules ? <span className="text-sm font-medium">Other keys</span> : null}
              <MetadataRows
                rows={rows}
                onChange={editRows}
                keySuggestions={keySugs}
                valueSuggestions={valueSugs}
                jsonFor={jsonFor}
              />
            </div>
          )}
        </>
      )}

      {generalError ? <p className="text-xs font-medium text-destructive">{generalError}</p> : null}
    </div>
  );
}

function RuleNodeView({
  node,
  rules,
  current,
  raws,
  observedByPath,
  onEdit,
  messageFor,
}: {
  node: RuleNode;
  rules: EditorRule[];
  current: Meta;
  raws: Record<string, Raw>;
  observedByPath: Map<string, ObservedKey>;
  onEdit: (node: RuleNode, raw: Raw) => void;
  messageFor: (path: string) => string | null;
}) {
  const resolved = resolvePath(current, node.segs);
  if (node.children.length) {
    const extra = uncoveredChildren(current, rules, node);
    return (
      <fieldset className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
        <legend className="sr-only">{node.path}</legend>
        <div>
          <span className="font-mono text-sm font-medium">{node.path}</span>
          {node.rule?.description ? (
            <p className="text-xs text-muted-foreground">{node.rule.description}</p>
          ) : null}
        </div>
        {resolved.state === "blocked" ? (
          <p className="text-xs text-muted-foreground">
            “{resolved.at}” holds {JSON.stringify(resolved.value)}, not an object. Edit as JSON to
            change it.
          </p>
        ) : (
          node.children.map((c) => (
            <RuleNodeView
              key={c.path}
              node={c}
              rules={rules}
              current={current}
              raws={raws}
              observedByPath={observedByPath}
              onEdit={onEdit}
              messageFor={messageFor}
            />
          ))
        )}
        {extra.length ? (
          <p className="text-xs text-muted-foreground">
            Also stored here: {extra.join(", ")}. Edit as JSON to change them.
          </p>
        ) : null}
      </fieldset>
    );
  }

  const rule = node.rule!;
  const kind = fieldKind(rule);
  const present = resolved.state === "value";
  const disp =
    resolved.state === "blocked"
      ? { raw: "", readOnly: true }
      : displayOf(rule, kind, present, present ? resolved.value : undefined);
  const raw = raws[node.path] ?? disp.raw;
  const id = `md-${node.path}`;
  const msg = messageFor(node.path);
  const help = [rule.description, hintFor(rule)].filter(Boolean).join(" ");

  let control: React.ReactNode;
  if (disp.readOnly && raws[node.path] === undefined) {
    control = (
      <div className="space-y-1">
        <Input id={id} value={String(disp.raw)} readOnly className="font-mono" />
        <p className="text-xs text-muted-foreground">
          The stored value does not fit this rule. It stays as stored. Edit as JSON to change it.
        </p>
      </div>
    );
  } else if (kind === "select") {
    control = (
      <SelectField
        id={id}
        ariaLabel={node.path}
        value={String(raw)}
        onValueChange={(v) => onEdit(node, v)}
        options={[
          { value: "", label: "None" },
          ...(rule.enum_options ?? []).map((o) => ({ value: o, label: o })),
        ]}
      />
    );
  } else if (kind === "tristate") {
    // A select, not a switch: a switch has no "not set", and every path is optional.
    control = (
      <SelectField
        id={id}
        ariaLabel={node.path}
        value={String(raw)}
        onValueChange={(v) => onEdit(node, v)}
        options={[
          { value: "", label: "Not set" },
          { value: "true", label: "True" },
          { value: "false", label: "False" },
        ]}
      />
    );
  } else if (kind === "number") {
    control = (
      <Input
        id={id}
        type="number"
        inputMode={rule.integer ? "numeric" : "decimal"}
        step={rule.integer ? 1 : "any"}
        min={rule.min ?? undefined}
        max={rule.max ?? undefined}
        value={String(raw)}
        onChange={(e) => onEdit(node, e.target.value)}
        className="max-w-[18rem]"
      />
    );
  } else if (kind === "chips") {
    const chosen = new Set(raw as string[]);
    control = (
      <div className="flex flex-wrap gap-2" role="group" aria-label={node.path}>
        {(rule.item_enum_options ?? []).map((o) => {
          const on = chosen.has(o);
          return (
            <Button
              key={o}
              type="button"
              size="sm"
              variant={on ? "default" : "outline"}
              aria-pressed={on}
              onClick={() =>
                onEdit(
                  node,
                  (rule.item_enum_options ?? []).filter((x) => (x === o ? !on : chosen.has(x))),
                )
              }
            >
              {o}
            </Button>
          );
        })}
      </div>
    );
  } else if (kind === "list") {
    const items = raw as string[];
    control = (
      <div className="flex flex-col gap-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              aria-label={`${node.path} item ${i + 1}`}
              value={it}
              onChange={(e) =>
                onEdit(
                  node,
                  items.map((x, j) => (j === i ? e.target.value : x)),
                )
              }
              className="font-mono"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove item ${i + 1}`}
              onClick={() =>
                onEdit(
                  node,
                  items.filter((_, j) => j !== i),
                )
              }
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
        <div>
          <button
            type="button"
            className="text-sm font-medium text-primary hover:underline"
            onClick={() => onEdit(node, [...items, ""])}
          >
            + Add item
          </button>
        </div>
      </div>
    );
  } else if (kind === "json") {
    control = (
      <Textarea
        id={id}
        rows={3}
        spellCheck={false}
        className="font-mono text-xs"
        value={String(raw)}
        placeholder={rule.data_type === "object" ? '{ "key": "value" }' : "[ ]"}
        onChange={(e) => onEdit(node, e.target.value)}
      />
    );
  } else {
    const hints = valueHints(observedByPath.get(node.path)).filter((h) => !h.json);
    const type =
      kind === "email"
        ? "email"
        : kind === "date" && (raw === "" || /^\d{4}-\d{2}-\d{2}$/.test(String(raw)))
          ? "date"
          : "text";
    control =
      hints.length && kind === "text" ? (
        <SuggestInput
          id={id}
          value={String(raw)}
          onChange={(v) => onEdit(node, v)}
          suggestions={hints.map((h) => ({ value: h.text, detail: count(h.rows) }))}
          maxLength={rule.max_length ?? undefined}
        />
      ) : (
        <Input
          id={id}
          type={type}
          value={String(raw)}
          onChange={(e) => onEdit(node, e.target.value)}
          maxLength={rule.max_length ?? undefined}
        />
      );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="font-mono text-sm font-medium">
        {node.label}
      </Label>
      <div aria-invalid={msg ? true : undefined}>{control}</div>
      {msg ? (
        <p className="text-xs font-medium text-destructive">{msg}</p>
      ) : help ? (
        <p className="text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  );
}

/** One line on what a rule accepts, for the help text. */
function hintFor(r: EditorRule): string {
  if (r.data_type === "number") {
    const parts = [r.integer ? "Whole number" : "Number"];
    if (r.min != null && r.max != null) parts.push(`from ${r.min} to ${r.max}`);
    else if (r.min != null) parts.push(`of ${r.min} or more`);
    else if (r.max != null) parts.push(`of ${r.max} or less`);
    return `${parts.join(" ")}.`;
  }
  if (r.data_type === "array") {
    const parts: string[] = [];
    if (r.item_type && !r.item_enum_options?.length) parts.push(`Items: ${r.item_type}.`);
    if (r.min_items != null && r.max_items != null)
      parts.push(`${r.min_items} to ${r.max_items} items.`);
    else if (r.min_items != null) parts.push(`${r.min_items} or more items.`);
    else if (r.max_items != null) parts.push(`Up to ${r.max_items} items.`);
    return parts.join(" ");
  }
  const parts: string[] = [];
  if (r.pattern) parts.push(`Pattern: ${r.pattern}.`);
  if (r.max_length) parts.push(`Up to ${r.max_length} characters.`);
  return parts.join(" ");
}
