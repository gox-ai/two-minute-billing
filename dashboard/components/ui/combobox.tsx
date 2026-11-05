"use client";

import * as React from "react";
import { useDefaultState } from "@/lib/use-default-state";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

/**
 * The searchable select — `SelectField` for lists too long to scroll.
 *
 * WHY IT EXISTS. Radix `Select` gives you typeahead, but it matches the START of the
 * rendered label and nothing else. That is fine for eight payment terms and useless for
 * the four long lists this app actually has: ~250 countries, ~200 dial codes, up to 50
 * subdivisions and 44 locales. Two measured consequences of having shipped raw selects
 * there — "Netherlands" was reachable only by typing `N-e-t` inside the typeahead's reset
 * window, and `+65` was not reachable by typing AT ALL, because the label reads
 * `+65 · Singapore` and the typeahead only ever saw the `+`.
 *
 * `components/form/timezone-select.tsx` had already solved this for ~420 IANA zones and
 * was never generalised; this is that pattern extracted, with the search fixed (see
 * `matches` below) and the form contract of `SelectField` preserved exactly.
 *
 * ── THE FORM CONTRACT IS `SelectField`'S, DELIBERATELY ──────────────────────────────
 * Controlled (`value` + `onValueChange`) or uncontrolled (`name` + `defaultValue`), `''`
 * is a legal storable value, and the posted value goes through an input this component
 * owns. Call sites swap `SelectField` → `Combobox` without touching their server action.
 *
 * ⚠️ `required` renders a REAL focusable control, not `type="hidden"` — carried over from
 * `SelectField`, where it was learned the hard way. A hidden input is barred from
 * constraint validation by the HTML spec, so `required` on one is decorative: the
 * asterisk renders and the browser submits the empty form anyway. `sr-only` and
 * `display:none` are no better — they make it unfocusable, and Chrome then refuses to
 * submit at all, logging "An invalid form control is not focusable". One transparent
 * pixel pinned under the trigger keeps it focusable, so the browser scrolls to it and
 * anchors the validation bubble on the control the user can actually see.
 *
 * ── WHY A POPOVER AND NOT A DIALOG ──────────────────────────────────────────────────
 * `timezone-select` uses Command-inside-Dialog and says a popover primitive does not
 * exist; that comment predates `components/ui/popover.tsx`. A modal takeover to pick a
 * country is too heavy for a field, and — more concretely — `AddressFields` renders
 * inside `EditDrawer`, which IS a modal Dialog, so a Dialog-based picker would nest one
 * modal inside another. The popover content is portalled (`PopoverContent` portals) so
 * the drawer body's `overflow-y-auto` cannot clip it.
 */

/**
 * cmdk falls back to an item's rendered TEXT when its `value` is empty, which would put
 * a label into the slot the filter map is keyed on. `''` is a real storable value here
 * (locale's "None — no language set", and every "— none —" option `SelectField` supports),
 * so it gets a private sentinel for cmdk's benefit only — exactly as `SelectField` does
 * for Radix. The value handed to `onValueChange` and posted is always the real one.
 */
const EMPTY = "__empty__";

export interface ComboboxOption {
  value: string;
  /** Trigger text and the primary thing search matches. Plain string, not a node. */
  label: string;
  /**
   * Extra search terms — an ISO code, an alternate spelling, a dial code. Free-form;
   * whitespace-separated is conventional. Never rendered.
   */
  keywords?: string;
  /** Right-aligned muted text on the row: a dial code, an offset, a country count. */
  hint?: string;
  disabled?: boolean;
}

export function Combobox({
  name,
  options,
  defaultValue = "",
  value: controlledValue,
  onValueChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyMessage = "No match.",
  className,
  contentClassName,
  id,
  ariaLabel,
  disabled,
  required,
  size = "default",
  "aria-invalid": ariaInvalid,
  "aria-describedby": ariaDescribedBy,
  onSearchChange,
  selectedLabel,
  loading = false,
}: {
  name?: string;
  options: ComboboxOption[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: React.ReactNode;
  className?: string;
  /** Width/height of the panel. Defaults to the trigger's width. */
  contentClassName?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
  /** Trigger height: 36px default, 32px `sm` — the `SelectField` scale. */
  size?: "sm" | "default";
  "aria-invalid"?: boolean;
  "aria-describedby"?: string;
  /**
   * SERVER SEARCH. When given, the caller owns the matching: each keystroke is handed
   * here and `options` is whatever the server answered, shown unfiltered. For lists too
   * large to load whole (invoices), where client search would only see one page.
   */
  onSearchChange?: (query: string) => void;
  /** Trigger text for a value no longer in `options` — server results move under it. */
  selectedLabel?: string;
  /** A server search is in flight. */
  loading?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const remote = onSearchChange != null;
  const [internal, setInternal] = useDefaultState(defaultValue);
  // Own the trigger's id rather than relying on `Field`'s clone, which does not reach this
  // component during SSR — the server then rendered no id, React refused to patch the
  // mismatch, and the label pointed at nothing. See the note in `select-field.tsx`.
  const triggerId = id ?? name;
  const isControlled = controlledValue !== undefined;
  const real = isControlled ? controlledValue : internal;

  const commit = (next: string) => {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
    setOpen(false);
  };

  /**
   * Search haystack per option, keyed by LOWERCASED value.
   *
   * The lowercasing is not defensive styling — cmdk normalises an item's `value` before
   * handing it to `filter`, so a map keyed on the raw value misses every option whose
   * value has an uppercase letter. That is `US`, `GB`, `en-US`, `KA` — i.e. every option
   * in every list this component was built for. `timezone-select` has the same lookup and
   * gets away with it only because its fallback (`itemValue.includes(q)`) happens to be
   * adequate for IANA ids; here it would silently reduce search to "value contains query"
   * and `keywords` would do nothing at all.
   */
  const haystack = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const o of options) {
      const key = (o.value || EMPTY).toLowerCase();
      m.set(key, `${o.label} ${o.keywords ?? ""} ${o.hint ?? ""} ${o.value}`.toLowerCase());
    }
    return m;
  }, [options]);

  const selected = options.find((o) => o.value === real);
  const triggerLabel = selected?.label ?? (real ? selectedLabel : undefined);

  return (
    <div className={cn("relative", !name && "contents")}>
      {name ? (
        required ? (
          <input
            name={name}
            value={real}
            required
            // NOT `readOnly`: a readonly input is barred from constraint validation exactly
            // like a hidden one. `onChange` is the no-op React needs for a controlled input
            // nobody types into — the trigger below is what sets the value.
            onChange={() => {}}
            tabIndex={-1}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 left-3 size-px opacity-0"
          />
        ) : (
          <input type="hidden" name={name} value={real} />
        )
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          id={triggerId}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          disabled={disabled}
          data-size={size}
          data-placeholder={triggerLabel ? undefined : ""}
          className={cn(
            "flex w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-left text-sm shadow-xs transition-[color,box-shadow] outline-none",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
            "data-[size=default]:h-9 data-[size=sm]:h-8",
            "dark:bg-input/30 hover:dark:bg-input/50",
            !triggerLabel && "text-muted-foreground",
            className,
          )}
        >
          <span className="truncate">{triggerLabel ?? placeholder}</span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" aria-hidden />
        </PopoverTrigger>

        <PopoverContent
          align="start"
          className={cn("w-(--radix-popover-trigger-width) min-w-56 p-0", contentClassName)}
        >
          <Command
            shouldFilter={!remote}
            // cmdk sorts by score: an exact code ("DE") first, then a label that starts with
            // the query, then any match.
            filter={(itemValue, search) => {
              const q = search.toLowerCase().trim();
              if (!q) return 1;
              const v = itemValue.toLowerCase();
              const hay = haystack.get(v) ?? v;
              if (!hay.includes(q)) return 0;
              if (v === q) return 3;
              return hay.startsWith(q) ? 2 : 1;
            }}
          >
            <CommandInput
              placeholder={searchPlaceholder}
              autoFocus
              {...(remote
                ? {
                    value: query,
                    onValueChange: (q: string) => {
                      setQuery(q);
                      onSearchChange(q);
                    },
                  }
                : {})}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>{loading ? "Searching…" : emptyMessage}</CommandEmpty>
              {options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.value || EMPTY}
                  disabled={o.disabled}
                  onSelect={() => commit(o.value)}
                >
                  <CheckIcon
                    className={cn(
                      "size-4 shrink-0",
                      o.value === real ? "opacity-100" : "opacity-0",
                    )}
                    aria-hidden
                  />
                  <span className="flex-1 truncate">{o.label}</span>
                  {o.hint ? (
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                      {o.hint}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
