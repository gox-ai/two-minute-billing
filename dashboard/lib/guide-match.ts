/**
 * "Show me" matching rules, kept free of the DOM so they can be tested: how a label answers a
 * guide step's control, which steps save a form, and which found element a step outlines.
 *
 * A step says what the member does (`do`). Guides saved before that field existed are read
 * from the instruction's words instead (`legacy*`).
 */
import type { StepAction } from "./assistant";

export interface StepLike {
  control: string;
  say: string;
  do?: StepAction;
}

export const normLabel = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/[…*:]+$/u, "")
    .trim()
    .toLowerCase();

const words = (s: string) =>
  normLabel(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** A close match must still read as one button, not a row of text. */
const CLOSE_MAX = 60;

/**
 * How `label` answers the step's `control`: the same text, or close ("Save" → "Save changes":
 * the label starts with the control's words, or holds all of them). "Save coupon" is not close
 * to "Save changes".
 */
export function labelMatch(control: string, label: string): "exact" | "close" | null {
  const want = normLabel(control);
  const have = normLabel(label);
  if (!want || !have) return null;
  if (have === want) return "exact";
  if (have.length > CLOSE_MAX) return null;
  if (have.startsWith(want) && /^[^\p{L}\p{N}]/u.test(have.slice(want.length))) return "close";
  const own = new Set(words(have));
  const ws = words(want);
  return ws.length > 0 && ws.every((w) => own.has(w)) ? "close" : null;
}

const SUBMIT_WORD = /^(save|submit|confirm|create|update)\b/;
const SAY_SUBMIT =
  /^(?:(?:then|now|finally|last),?\s+)?(?:(?:select|click|press|tap|use)\s+)?(?:the\s+)?(save|submit|confirm|create)\b/;

/** A step that saves or submits the form. */
export function isSubmitStep(step: StepLike): boolean {
  if (step.do) return step.do === "submit";
  return SUBMIT_WORD.test(normLabel(step.control)) || SAY_SUBMIT.test(normLabel(step.say));
}

const ACTION_WORD =
  /^(save|submit|confirm|create|update|add|apply|cancel|close|delete|remove|archive|restore|done|next|back|continue|send|edit|change|clone|duplicate|enable|disable|import|export|download|upload|reset|retry|refund|void|pause|resume|reactivate|collect|record|issue|invite|revoke|connect|disconnect|generate|preview|publish|schedule|skip|mark)\b/;

/** A control named like a button. Its step never falls back to outlining a whole card. */
export function isActionLabel(control: string): boolean {
  return ACTION_WORD.test(normLabel(control));
}

export interface Candidates<T> {
  /** An element labelled exactly as the control. */
  exact: T | null;
  /** The exact match is a control (button, link, field label), not a heading. */
  exactClickable: boolean;
  /** A clickable whose label is close to the control. */
  close: T | null;
  /** The page's primary submit: an open dialog's, the action bar's, or the only one. */
  submit: T | null;
  /** A row the instruction names. */
  row: T | null;
  /** The previous step's row, where a menu option or a row's Save appears after a click. */
  last: T | null;
  /** The `within` label: a card or row title. */
  within: T | null;
}

export type Via = keyof Omit<Candidates<unknown>, "exactClickable"> | "none";

/**
 * What a step outlines, in order: the exact control; a close one; for a save step, the page's
 * submit button; the named row; the previous row; the `within` card. A save step whose only
 * exact match is a heading ("Coupon info") takes the submit button instead. A button-like
 * control never falls back to its card: nothing is better than a ring on the wrong thing.
 */
export function chooseTarget<T>(c: Candidates<T>, step: StepLike): { el: T | null; via: Via } {
  const submitStep = isSubmitStep(step);
  if (c.exact && (c.exactClickable || !submitStep)) return { el: c.exact, via: "exact" };
  if (c.close) return { el: c.close, via: "close" };
  if (submitStep && c.submit) return { el: c.submit, via: "submit" };
  if (c.exact) return { el: c.exact, via: "exact" };
  if (c.row) return { el: c.row, via: "row" };
  if (c.last) return { el: c.last, via: "last" };
  if (c.within && !isActionLabel(step.control)) return { el: c.within, via: "within" };
  return { el: null, via: "none" };
}

/**
 * The page's primary submit among visible buttons in document order: inside an open dialog
 * first; then the last button of the sticky action bar (the primary sits last); else the one
 * submit button when there is only one. Several and no bar: none, rather than a guess.
 */
export function pickPrimary<T>(
  cands: Array<{ el: T; inBar: boolean; inDialog: boolean; submit: boolean }>,
): T | null {
  const dialog = cands.filter((c) => c.inDialog);
  const pool = dialog.length ? dialog : cands;
  const bar = pool.filter((c) => c.inBar);
  if (bar.length) return bar.at(-1)!.el;
  const submits = pool.filter((c) => c.submit);
  return submits.length === 1 ? submits[0]!.el : null;
}

/** What a found label names: a field to type in, an option to select, or anything else. */
export type ControlKind = "field" | "choice" | "other";

const ENTER_VERB =
  /\b(set|enter|type|fill|put|write|change|increase|decrease|raise|lower|replace|paste)\b/g;
const SELECT_VERB =
  /\b(select|choose|pick|switch|tick|check|uncheck|toggle|turn|enable|disable)\b/g;

/** What the step asks to do with its control: enter a value, select an option, or neither. */
export function stepIntent(step: StepLike): "enter" | "select" | null {
  if (step.do) return step.do === "enter" || step.do === "select" ? step.do : null;
  return legacyIntent(step.control, step.say);
}

/**
 * A guide saved without `do`: "Set Percentage to 40" enters a value; "Select Percentage", "Set
 * Discount type to Percentage" select one (the control follows "to"). The verb nearest before
 * the control decides, then the first one after it; a bare number reads as a value to enter.
 */
function legacyIntent(control: string, say: string): "enter" | "select" | null {
  const s = normLabel(say);
  const at = s.indexOf(normLabel(control));
  const before = at >= 0 ? s.slice(0, at) : s;
  if (at > 0 && /\bto\s*$/.test(before)) return "select";
  const verbs = (text: string) =>
    [
      ...[...text.matchAll(ENTER_VERB)].map((m) => ({ i: m.index, v: "enter" as const })),
      ...[...text.matchAll(SELECT_VERB)].map((m) => ({ i: m.index, v: "select" as const })),
    ].sort((a, b) => a.i - b.i);
  const last = verbs(before).at(-1);
  if (last) return last.v;
  const next = at >= 0 ? verbs(s.slice(at))[0] : undefined;
  if (next) return next.v;
  return /\d/.test(s) ? "enter" : null;
}

/**
 * Several elements carry the control's exact label (an option card and a field both read
 * "Percentage"; a column heading and its field read "Amount"): one the member can use wins
 * (`usable`: a ring on it would point at a control), then the kind the step asks for, then
 * the one whose row the instruction names, then the first.
 */
export function chooseExact<T>(
  found: Array<{ el: T; kind: ControlKind; rowNamed?: boolean; usable?: boolean }>,
  step: StepLike,
): T | null {
  if (!found.length) return null;
  const usable = found.filter((f) => f.usable !== false);
  const base = usable.length ? usable : found;
  const intent = stepIntent(step);
  const want = intent === "enter" ? "field" : intent === "select" ? "choice" : null;
  const fit = base.length > 1 && want ? base.filter((f) => f.kind === want) : [];
  const pool = fit.length ? fit : base;
  return (pool.find((f) => f.rowNamed) ?? pool[0]!).el;
}

/** One element of what a step would ring, as the runner measured it. */
export interface OutlinePart<T> {
  el: T;
  /** A control the member uses: a button, link, field, option card or tab. */
  interactive: boolean;
}

/**
 * What a step may ring: the outline when it holds a control the member can use, else nothing,
 * and the card shows unanchored with the instruction. A heading, a breadcrumb or a container
 * around controls is never ringed: a ring there points at nothing the member can act on.
 */
export function spotlight<T>(outline: Array<OutlinePart<T>>): T[] | null {
  return outline.some((p) => p.interactive) ? outline.map((p) => p.el) : null;
}
