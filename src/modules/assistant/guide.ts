/**
 * "Show me": a guide the member opens from an answer. It goes to one dashboard screen and
 * highlights its controls in order, each with one instruction. The model proposes it; this
 * module checks it against the dashboard map, so a guide can only name a real screen, controls
 * that screen renders, and record ids the turn actually read.
 */
import { screenForPath, type MapScreen } from "@/modules/assistant-docs/screens";

export type { MapScreen };

export interface GuideStep {
  /** A control's label, exactly as on the screen. */
  control: string;
  /** A label near it (a card or row title) when the control's label repeats on the screen. */
  within: string | null;
  /** One instruction, in the member's terms. */
  say: string;
  /** What the member does with the control. Absent on guides saved before it existed. */
  do?: StepAction;
  /**
   * The control is an item of a dropdown menu: the label of the trigger that shows it ("" when
   * the trigger has no fixed label). Set from the map, never by the model.
   */
  menu?: string;
}

/** click: a button, tab, row or link · enter: type a value · select: choose an option · submit: save the form. */
export type StepAction = "click" | "enter" | "select" | "submit";
export const STEP_ACTIONS = ["click", "enter", "select", "submit"] as const;

export interface Guide {
  id: string;
  /** The dashboard path to open, with every id filled in. */
  path: string;
  screen: string;
  steps: GuideStep[];
}

/** What the member's question asks to change: one record, or a rule for the whole business. */
export type GuideScope = "one_record" | "whole_business";
export const GUIDE_SCOPES = ["one_record", "whole_business"] as const;

export interface GuideInput {
  /** The screen's path as find_screen returned it; {placeholders} are filled from params. */
  screen: string;
  /**
   * Set by the model. A question about one record is answered on that record's screen: a
   * business-wide screen changes every customer, so it is refused as that question's guide.
   */
  scope?: GuideScope;
  params?: Record<string, string>;
  steps: Array<{ control: string; within?: string; say: string; do?: StepAction }>;
}

const MAX_STEPS = 4;
/** The map's group for a form's sticky action bar. The bar has no visible title to look within. */
export const ACTION_BAR = "Action bar";
const ID = /^[A-Za-z0-9_-]{2,64}$/;
const norm = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/[…*:]+$/u, "")
    .trim()
    .toLowerCase();

/** A screen of one record (a customer, an invoice): its route names a record id. */
export function isRecordScreen(screen: Pick<MapScreen, "route">): boolean {
  return screen.route.split("/").some((p) => /^\{\w+\}$/.test(p) && p !== "{business}");
}

/** Every short id-like string in the turn's tool results: what a path may name. */
export function idsIn(results: unknown[]): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (ID.test(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  results.forEach(walk);
  return out;
}

/**
 * Check a proposed guide. Errors are written for the model, which can correct the call: use
 * the path and labels exactly as find_screen returned them.
 */
export function resolveGuide(a: {
  input: GuideInput;
  businessId: string;
  /** Ids the turn may link to: tool results, the member's page and mentions. */
  known: Set<string>;
  screens: MapScreen[];
  id: string;
}): { guide: Guide } | { error: string } {
  const raw = a.input.screen.trim().split(/[?#]/)[0]!.replace(/\/$/, "");
  const template = raw.replace(`/businesses/${a.businessId}`, "/businesses/{business}");
  // The {placeholder} form, or a real path with its ids (find_screen's on_this_page link).
  const screen = a.screens.find((s) => s.route === template) ?? screenForPath(template, a.screens);
  if (!screen)
    return {
      error:
        "Unknown screen. Pass the screen's path exactly as the reference or research gave it, for example /businesses/{business}/settings/dunning.",
    };
  if (a.input.scope === "one_record" && !isRecordScreen(screen))
    return {
      error:
        "This screen sets a rule for the whole business, and the question is about one record. Give that record's screen and the control that acts on it, or do not offer Show me.",
    };
  const given = template.split("/");
  let path = "";
  const parts = screen.route.split("/");
  for (let i = 0; i < parts.length; i++) {
    const name = /^\{(\w+)\}$/.exec(parts[i]!)?.[1];
    if (!name) {
      path += `${i ? "/" : ""}${parts[i]}`;
      continue;
    }
    if (name === "business") {
      path += `/${a.businessId}`;
      continue;
    }
    const seg = given[i] && !/^\{\w+\}$/.test(given[i]!) ? given[i] : undefined;
    const v = seg ?? a.input.params?.[name];
    if (!v)
      return {
        error: `This screen needs a record id for {${name}}. Pass it in params, from a record you read.`,
      };
    if (!ID.test(v) || !a.known.has(v))
      return {
        error: `Unknown id ${JSON.stringify(v).slice(0, 70)} for {${name}}. Use an id from a record you read in this turn, or the member's page.`,
      };
    path += `/${v}`;
  }
  // A control is something the member acts on: never the page's title, its breadcrumb or a
  // heading (the map leaves those out). A heading is still a place to look within.
  const labels = new Map(screen.controls.map((c) => [norm(c), c]));
  const places = new Map(labels);
  for (const h of [...(screen.headings ?? []), ...(screen.groups ?? []).map((g) => g.title)])
    if (h && h !== ACTION_BAR && !places.has(norm(h))) places.set(norm(h), h);
  const steps: GuideStep[] = [];
  const unknown: string[] = [];
  const headings: string[] = [];
  for (const s of a.input.steps.slice(0, MAX_STEPS)) {
    const control = labels.get(norm(s.control));
    const near = s.within && norm(s.within) !== norm(ACTION_BAR) ? s.within : undefined;
    const within = near ? places.get(norm(near)) : undefined;
    if (!control && places.has(norm(s.control))) headings.push(s.control);
    if (!control || (near && !within)) {
      if (control || !places.has(norm(s.control))) unknown.push(!control ? s.control : near!);
      continue;
    }
    const menu = screen.menus?.[control];
    steps.push({
      control,
      within: within ?? null,
      say: s.say.trim().slice(0, 160),
      ...(s.do ? { do: s.do } : {}),
      ...(menu !== undefined ? { menu } : {}),
    });
  }
  if (headings.length)
    return {
      error: `${headings.map((h) => JSON.stringify(h.slice(0, 60))).join(", ")} is a heading on this screen, not a control. Name the button, field or option to use, and give the heading as within.`,
    };
  if (unknown.length)
    return {
      error: `Not on this screen: ${unknown.map((u) => JSON.stringify(u.slice(0, 60))).join(", ")}. Use control labels exactly as the screen's controls list them.`,
    };
  if (!steps.length) return { error: "Give at least one step." };
  return { guide: { id: a.id, path, screen: screen.label, steps } };
}
