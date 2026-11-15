"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { MousePointerClick, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AssistantGuide, StepAction } from "@/lib/assistant";
import { cn } from "@/lib/utils";
import {
  chooseExact,
  chooseTarget,
  isSubmitStep,
  labelMatch,
  normLabel as norm,
  pickPrimary,
  spotlight,
  type ControlKind,
} from "@/lib/guide-match";
import { CoachGrip, useCoachCard } from "@/components/coach-card";

/**
 * "Show me": Billy's answer offers a button; the member clicks it, the screen opens and each
 * control the answer names is highlighted in turn, with one instruction. The runner lives in
 * the layout, not the panel, so it keeps going when the panel closes on a narrow screen.
 * Nothing is dimmed or blocked: the member can use the highlighted control at once.
 */

const START_EVENT = "tmb:assistant-guide";
export const startGuide = (guide: AssistantGuide) =>
  window.dispatchEvent(new CustomEvent(START_EVENT, { detail: guide }));

// Never targets: the assistant (panel, bubble, nudge), this runner, toasts, the app's navigation
// rail, and page chrome (a breadcrumb trail, the page title and its compact copy). A guide names
// the screen's own controls, never the shell around it.
const SKIP = [
  "[data-app-shell]",
  "[data-assistant-panel]",
  '[data-tour="assistant"]',
  "[data-billy-nudge]",
  "[data-guide-runner]",
  "[data-sonner-toaster]",
  'nav[aria-label="Breadcrumb"]',
  "h1",
  "[data-page-title]",
  "[data-compact-title]",
].join(", ");
const CLICKABLE =
  "button, a, label, [role=tab], [role=button], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=radio], [role=checkbox], [role=switch], [role=combobox]";
const BUTTONS = "button, a[href], [role=button], [role=menuitem], [role=tab]";

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

/** What a member reads as the element's label: its accessible name or its own short text. */
function labelOf(el: Element): string | null {
  const aria = el.getAttribute("aria-label") ?? el.getAttribute("title");
  if (aria) return aria;
  const text = el.textContent ?? "";
  return text.length <= 120 ? text : null;
}

/** Visible elements labelled `label`, innermost first in document order. */
function matches(label: string, root: Element = document.body): HTMLElement[] {
  const want = norm(label);
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    if (el.closest(SKIP)) continue;
    const l = labelOf(el);
    if (!l || norm(l) !== want || !visible(el)) continue;
    // Keep the innermost: drop an ancestor already collected for the same text.
    for (let i = out.length - 1; i >= 0; i--) if (out[i]!.contains(el)) out.splice(i, 1);
    out.push(el);
  }
  // Highlight the control itself when the text sits inside one: a button's label, an option
  // card's name. Clicking the text clicks that control, however much else the card says.
  return out.map((el) => {
    const c = el.closest<HTMLElement>(CLICKABLE);
    return c && !c.closest(SKIP) ? c : el;
  });
}

/** Visible buttons and links whose label is close to `label` ("Save" → "Save changes"), shortest first. */
function closeMatches(label: string, root: Element = document.body): HTMLElement[] {
  const out: Array<{ el: HTMLElement; len: number }> = [];
  for (const el of root.querySelectorAll<HTMLElement>(BUTTONS)) {
    if (el.closest(SKIP) || !visible(el)) continue;
    // innerText: a label that shortens on a phone keeps only its visible half.
    const l = el.getAttribute("aria-label") ?? el.innerText ?? "";
    if (labelMatch(label, l) === "close") out.push({ el, len: l.length });
  }
  return out.sort((a, b) => a.len - b.len).map((o) => o.el);
}

/** The page's primary submit: an open dialog's, the sticky action bar's, or the only one. */
function primarySubmit(): HTMLElement | null {
  const cands = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .filter((b) => !b.closest(SKIP) && visible(b))
    .map((b) => ({
      el: b,
      inBar: !!b.closest("[data-action-bar]"),
      inDialog: !!b.closest("[role=dialog][data-state=open], [role=alertdialog][data-state=open]"),
      submit: b.type === "submit" && !!b.form,
    }))
    .filter((c) => c.inBar || c.submit);
  return pickPrimary(cands);
}

/** The row a control sits in: its largest ancestor that is still one short line of text. */
function rowOf(el: HTMLElement): HTMLElement {
  let row = el;
  for (let p = el.parentElement; p && !p.closest(SKIP); p = p.parentElement) {
    if ((p.textContent ?? "").length > 200) break;
    row = p;
  }
  return row;
}

/** The first line of a row's text: its label ("Excess payments"). */
const rowLabel = (el: HTMLElement) => norm((rowOf(el).innerText ?? "").split("\n")[0] ?? "");

const FIELD =
  "input:not([type=radio],[type=checkbox],[type=hidden],[type=button],[type=submit],[type=reset]), textarea, select, [role=combobox], [contenteditable=true]";
const CHOICE =
  "input[type=radio], input[type=checkbox], [role=radio], [role=checkbox], [role=switch], [role=tab]";

/**
 * The control a found label names: itself, its `for` target, the element it labels by
 * `aria-labelledby`, the one control inside it (an option card), or the field after it in its
 * wrapper (a Field's label and input).
 */
function namedControl(el: HTMLElement): HTMLElement | null {
  if (el.matches(`${FIELD}, ${CHOICE}`)) return el;
  if (el instanceof HTMLLabelElement && el.control) return el.control as HTMLElement;
  if (el.id) {
    const by = document.querySelector<HTMLElement>(`[aria-labelledby~="${CSS.escape(el.id)}"]`);
    if (by) return by;
  }
  const inner = el.querySelectorAll<HTMLElement>(`${FIELD}, ${CHOICE}`);
  if (inner.length === 1) return inner[0]!;
  const box = el.parentElement;
  const after = [...(box?.querySelectorAll<HTMLElement>(FIELD) ?? [])].filter(
    (c) => el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return after.length === 1 ? after[0]! : null;
}

function kindOf(el: HTMLElement): ControlKind {
  const c = namedControl(el);
  if (!c) return "other";
  return c.matches(CHOICE) ? "choice" : c.matches(FIELD) ? "field" : "other";
}

/**
 * The control for one step. With `within`, the control nearest after that label, inside the
 * smallest container holding both: the "Change" of the "Excess payments" row, not another row's.
 * When the label still repeats, the kind the step asks for wins ("Set Percentage to 40" → the
 * field, "Select Percentage" → the option), then the one whose row the instruction names.
 */
function findControl(
  control: string,
  within: string | null,
  say: string,
  find: (label: string, root?: Element) => HTMLElement[] = matches,
  act?: StepAction,
): HTMLElement | null {
  const said = norm(say);
  const pick = (found: HTMLElement[]) =>
    chooseExact(
      found.map((el) => {
        const l = rowLabel(el);
        return {
          el,
          kind: found.length > 1 ? kindOf(el) : "other",
          rowNamed: l.length > 2 && l !== norm(control) && said.includes(l),
          usable: found.length > 1 ? !!ringOf(el) : true,
        };
      }),
      { control, say, do: act },
    )!;
  if (!within) {
    const all = find(control);
    return all.length ? pick(all) : null;
  }
  for (const anchor of matches(within)) {
    let box: HTMLElement | null = anchor;
    for (let up = 0; box && up < 8; up++, box = box.parentElement) {
      const found = find(control, box).filter((el) => el !== anchor && !el.contains(anchor));
      if (!found.length) continue;
      const after = found.filter(
        (el) => anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      return pick(after.length ? after : found);
    }
  }
  const all = find(control);
  return all.length ? pick(all) : null;
}

/**
 * A visible row label the instruction names ("Under Excess payments, select …"), inside the
 * `within` card when there is one: where to look when the control itself is not on screen yet.
 */
function namedRow(say: string, within: string | null, control: string): HTMLElement | null {
  const said = norm(say);
  const skip = new Set([norm(control), within ? norm(within) : ""]);
  const scope = within ? matches(within)[0] : null;
  let box: HTMLElement | null = scope ?? document.body;
  // The card around its title: the nearest ancestor holding several rows.
  for (let up = 0; scope && box && up < 6 && box.querySelectorAll("dt, label").length < 2; up++)
    box = box.parentElement;
  const rows = [
    ...(box ?? document.body).querySelectorAll<HTMLElement>("dt, label, th, h3, h4, legend"),
  ]
    .filter((el) => !el.closest(SKIP) && visible(el))
    .filter((el) => {
      const t = norm(el.textContent ?? "");
      return t.length >= 4 && t.length <= 60 && !skip.has(t) && said.includes(t);
    });
  // The longest name is the most specific ("Excess payments" over "Payments").
  return (
    rows.sort((a, b) => (b.textContent ?? "").length - (a.textContent ?? "").length)[0] ?? null
  );
}

const HEADING = "h1, h2, h3, h4, h5, h6, th, legend, [role=heading], [role=columnheader]";
const CELL = "td, [role=cell], [role=gridcell]";
const INTERACTIVE =
  "button, a[href], input, select, textarea, [role=combobox], [role=switch], [role=checkbox], [role=radio], [role=tab], [role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=button]";

/** A control the member uses: itself interactive, or a label that names a control. */
function isInteractive(el: HTMLElement): boolean {
  if (el.closest(SKIP)) return false;
  if (el.matches(INTERACTIVE)) return true;
  return el instanceof HTMLLabelElement && !!el.control;
}

/**
 * What to outline for a found label: the label and, when it only names a field or a row, the
 * first control that follows it in the same row, so the member sees what to use. Never past
 * the row: a control in the next card or the next option is not this label's.
 */
function outlineOf(el: HTMLElement): HTMLElement[] {
  if (el.matches(INTERACTIVE)) return [el];
  // A heading names a section or a column, and a table cell holds a record's value: neither
  // labels the control after it.
  if (el.matches(HEADING) || el.closest(CELL)) return [el];
  // A field's label: the label and its own input, not whatever control comes next.
  const own = el instanceof HTMLLabelElement ? (el.control as HTMLElement | null) : null;
  if (own && visible(own) && own.matches(FIELD)) return [el, own];
  const row = rowOf(el);
  let box: HTMLElement | null = el.parentElement;
  for (let up = 0; box && up < 3 && row.contains(box); up++, box = box.parentElement) {
    const next = [...box.querySelectorAll<HTMLElement>(INTERACTIVE)].find(
      (c) =>
        visible(c) &&
        !c.closest(SKIP) &&
        el.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Only a control beside or just below the label is the label's; else the ring would grow
    // to span a stretch of the page.
    if (next) return beside(el, next) ? [el, next] : [el];
  }
  return [el];
}

/** `ctl` sits on the label's line or starts within a line's height below it. */
function beside(label: HTMLElement, ctl: HTMLElement): boolean {
  const a = label.getBoundingClientRect();
  const b = ctl.getBoundingClientRect();
  return b.top <= a.bottom + Math.max(a.height, 24) && b.bottom >= a.top - 4;
}

/** What a step rings for the element it found, or null when that is no control to use. */
function ringOf(el: HTMLElement | null): HTMLElement[] | null {
  if (!el) return null;
  return spotlight(outlineOf(el).map((e) => ({ el: e, interactive: isInteractive(e) })));
}

/**
 * The title row of the section a control sits in: the nearest heading before it in the
 * smallest ancestor that holds one ("Select a provider" above the provider cards). The coach
 * card keeps clear of it, so the member still reads what the section is.
 */
function sectionHeaderOf(el: HTMLElement): HTMLElement | null {
  const TITLES = "h2, h3, h4, legend, [role=heading]";
  for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
    const before = [...box.querySelectorAll<HTMLElement>(TITLES)].filter(
      (h) =>
        !h.contains(el) &&
        !h.closest(SKIP) &&
        visible(h) &&
        h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const h = before.at(-1);
    if (!h) continue;
    // The heading's own row (title, meta, header actions), when that row is not the control's.
    const row = h.parentElement;
    return row && !row.contains(el) && row !== box ? row : h;
  }
  return null;
}

function unionRect(els: HTMLElement[]): DOMRect | null {
  const rs = els.filter((e) => e.isConnected).map((e) => e.getBoundingClientRect());
  if (!rs.length) return null;
  const left = Math.min(...rs.map((r) => r.left));
  const top = Math.min(...rs.map((r) => r.top));
  const right = Math.max(...rs.map((r) => r.right));
  const bottom = Math.max(...rs.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

const WIDTH = 300;
const WAIT_MS = 10_000;

export function GuideRunner() {
  const router = useRouter();
  const path = usePathname();
  const [guide, setGuide] = React.useState<AssistantGuide | null>(null);
  const [i, setI] = React.useState(0);
  // What the current step found, keyed by step so a new step starts empty.
  // `seen`: something matched but it is no control (a heading): the step shows unanchored.
  const [found, setFound] = React.useState<{
    key: string;
    el: HTMLElement | null;
    seen: boolean;
  } | null>(null);
  const arrived = React.useRef(false);
  // The row of the last control found: where a menu option or Save appears after a click.
  const lastRow = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    const onStart = (e: Event) => {
      const g = (e as CustomEvent<AssistantGuide>).detail;
      arrived.current = false;
      lastRow.current = null;
      setGuide(g);
      setI(0);
      if (window.location.pathname !== g.path) router.push(g.path);
    };
    window.addEventListener(START_EVENT, onStart);
    return () => window.removeEventListener(START_EVENT, onStart);
  }, [router]);

  const end = React.useCallback(() => {
    setGuide(null);
    setFound(null);
  }, []);

  // Leaving the screen ends the guide; arriving on it starts the search.
  React.useEffect(() => {
    if (!guide) return;
    if (path === guide.path) arrived.current = true;
    else if (arrived.current) end();
  }, [path, guide, end]);

  // Find the step's control once the screen has rendered it; give up after a while.
  const step = guide?.steps[i];
  const key = guide ? `${guide.id}:${i}` : "";
  React.useEffect(() => {
    if (!guide || !step || path !== guide.path) return;
    const started = Date.now();
    // Polled, not observed: the screen streams in, and a control can appear late.
    const t = window.setInterval(() => {
      const exact = findControl(step.control, step.within, step.say, matches, step.do);
      // Not visible (an option in a closed menu): a close label, the page's submit for a save
      // step, the row the instruction names, the previous step's row, then `within`.
      const close = exact
        ? null
        : findControl(step.control, step.within, step.say, closeMatches, step.do);
      const { el, via } = chooseTarget(
        {
          exact,
          exactClickable: !!exact?.matches(`${CLICKABLE}, ${INTERACTIVE}`),
          close,
          submit: isSubmitStep(step) ? primarySubmit() : null,
          row: exact || close ? null : namedRow(step.say, step.within, step.control),
          last: lastRow.current?.isConnected ? lastRow.current : null,
          within: step.within ? findControl(step.within, null, step.say) : null,
        },
        step,
      );
      // Only a control the member can use is ringed; anything else shows the step unanchored.
      const ring = ringOf(el);
      if (ring && via !== "last" && via !== "within") lastRow.current = rowOf(el!);
      if (ring) el!.scrollIntoView({ block: "center", behavior: "smooth" });
      if (el || Date.now() - started > WAIT_MS) {
        window.clearInterval(t);
        // A row or card fallback is no sighting of the control itself: say it was not found.
        setFound({ key, el: ring ? el : null, seen: via === "exact" || via === "close" });
      }
    }, 250);
    return () => window.clearInterval(t);
  }, [guide, step, path, key]);
  const current = found?.key === key ? found : null;
  const target = current?.el ?? null;
  const missing = !!current && !current.el;
  const notFound = missing && !current.seen;

  React.useEffect(() => {
    if (!guide) return;
    // Radix marks the Escape that closes an open menu; that one closes the menu, not the guide.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && end();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [guide, end]);

  const showing = !!guide && !!step && path === guide.path && (!!target || missing);
  // Placed clear of the control and of the menu it opens; follows scroll, resize and menus.
  const cardRef = React.useRef<HTMLDivElement>(null);
  const coach = useCoachCard({
    cardRef,
    stepKey: showing ? key : null,
    measureTarget: () => (target?.isConnected ? unionRect(outlineOf(target)) : null),
    targetEl: () => target,
    keepOut: () => {
      const head = target?.isConnected ? sectionHeaderOf(target) : null;
      return head ? [head.getBoundingClientRect()] : [];
    },
    width: WIDTH,
  });

  if (!guide || !step || !showing) return null;

  const total = guide.steps.length;
  const last = i === total - 1;
  const rect = coach.target;
  return (
    // Above open menus (z-50), so the ring stays visible on an option inside a list.
    <div data-guide-runner className="pointer-events-none fixed inset-0 z-60" aria-live="polite">
      {rect ? (
        <div
          aria-hidden
          className="fixed animate-pulse rounded-md ring-2 ring-primary ring-offset-2 ring-offset-background transition-all duration-200"
          style={{
            left: rect.left - 4,
            top: rect.top - 4,
            width: rect.right - rect.left + 8,
            height: rect.bottom - rect.top + 8,
          }}
        />
      ) : null}
      <div
        ref={cardRef}
        role="dialog"
        aria-labelledby="guide-step"
        aria-describedby="guide-say"
        data-coach-card
        className="pointer-events-auto fixed flex flex-col gap-2 rounded-xl border bg-popover p-4 text-popover-foreground shadow-lg"
        style={coach.style}
      >
        <div
          {...coach.handleProps}
          className={cn(
            "-mx-2 -mt-2 flex touch-none items-center justify-between gap-2 rounded-md px-2 pt-2 select-none",
            coach.dragging ? "cursor-grabbing" : "cursor-grab",
          )}
        >
          <span className="flex items-center gap-1">
            <CoachGrip onKeyDown={coach.onGripKey} dragging={coach.dragging} />
            <span id="guide-step" className="text-xs font-semibold text-primary">
              {total > 1 ? `Step ${i + 1} of ${total}` : guide.screen}
            </span>
          </span>
          <button
            type="button"
            onClick={end}
            aria-label="End the guide"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <p id="guide-say" className="m-0 text-sm">
          {step.say}
        </p>
        {notFound ? (
          <p className="m-0 text-xs text-muted-foreground">
            We could not find “{step.control}” on this page. It can show only for some roles or
            record states.
          </p>
        ) : null}
        <div className="mt-1 flex justify-end gap-2">
          {i > 0 ? (
            <Button variant="outline" size="sm" onClick={() => setI(i - 1)}>
              Back
            </Button>
          ) : null}
          <Button size="sm" onClick={() => (last ? end() : setI(i + 1))}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Under an answer: opens the screen and starts the guide. */
export function ShowMeButton({
  guide,
  onStart,
  className,
}: {
  guide: AssistantGuide;
  onStart?: () => void;
  className?: string;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("self-start", className)}
      onClick={() => {
        onStart?.();
        startGuide(guide);
      }}
    >
      <MousePointerClick className="size-4" aria-hidden />
      Show me
      <span className="font-normal text-muted-foreground">· {guide.screen}</span>
    </Button>
  );
}
