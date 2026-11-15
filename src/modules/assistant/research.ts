/**
 * Billy's research, in one step: the help (with its API pages for developer questions), the
 * dashboard map and the product's code searched in parallel and merged into a short pack. Run once before the first model
 * call (`prefetch`) with the member's question, and as the `research` tool for follow-ups.
 *
 * Each source reuses its catalogue tool, so permissions, the guides-only rule and the source
 * guard's inputs are the same as when the model called them one by one. A source slower than
 * the deadline is left out; it never holds the turn.
 */
import { z } from "zod";
import {
  audienceInput,
  TOOLS,
  type ToolContext,
  type ToolDef,
} from "@/modules/assistant-tools/catalog";
import type { Audience } from "@/modules/assistant-docs/search";
import { stripInvisible } from "@/modules/assistant-tools/shape";
import type { PageContext } from "./prompt";
import { stepLabel } from "./steps";

export type ResearchSource = "help" | "screens" | "source";
export const RESEARCH_SOURCES: readonly ResearchSource[] = ["help", "screens", "source"];

/** The catalogue tool behind each source, for the stored steps and permissions. */
export const SOURCE_TOOL: Record<ResearchSource, string> = {
  help: "search_docs",
  screens: "find_screen",
  source: "search_source",
};

const tool = (name: string): ToolDef => TOOLS.find((t) => t.name === name)!;

/** Resolves to undefined after `ms`; the work goes on and fills the search cache. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([
    p.catch(() => undefined),
    new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref()),
  ]);

const clip = (s: string | undefined, n: number) =>
  !s ? undefined : s.length > n ? `${s.slice(0, n)}… (cut)` : s;

export interface ResearchPack {
  help?: unknown;
  screens?: unknown;
  /** Code: a reference for the model only (leaks.ts). */
  source?: { reference_only: true; sections: Array<{ symbol: string | null; code: string }> };
  /** Sources that did not answer in time. */
  missing?: ResearchSource[];
}

type Help = { results: Array<Record<string, unknown>>; note?: string };
type Screens = { screens: Array<Record<string, unknown>> };
type Code = { sections: Array<{ symbol: string | null; code: string }> };

/**
 * Search the sources in parallel. `size` "brief" is the pack before the first call (top few,
 * short sections); "full" answers a `research` call.
 */
export async function research(
  ctx: ToolContext,
  query: string,
  opts: {
    sources?: readonly ResearchSource[];
    deadlineMs: number;
    size: "brief" | "full";
    /** Who the help search is for; unset: the context's default. */
    audience?: Audience;
    /** Filled with each source's time in ms; a source past the deadline gets the deadline. */
    timing?: Partial<Record<ResearchSource, number>>;
  },
): Promise<ResearchPack> {
  const want = new Set(opts.sources?.length ? opts.sources : RESEARCH_SOURCES);
  const brief = opts.size === "brief";
  const run = <T>(source: ResearchSource, name: string, args: Record<string, unknown>) => {
    const t0 = performance.now();
    const work = (tool(name).run(ctx, args) as Promise<T>).finally(() => {
      if (opts.timing) opts.timing[source] = Math.round(performance.now() - t0);
    });
    return within(work, opts.deadlineMs).then((r) => {
      if (opts.timing && !(source in opts.timing)) opts.timing[source] = opts.deadlineMs;
      return r;
    });
  };
  const [help, screens, code] = await Promise.all([
    want.has("help")
      ? run<Help>("help", "search_docs", {
          query,
          limit: brief ? 3 : 5,
          ...(opts.audience ? { audience: opts.audience } : {}),
        })
      : null,
    want.has("screens") ? run<Screens>("screens", "find_screen", { query }) : null,
    want.has("source") ? run<Code>("source", "search_source", { query }) : null,
  ]);
  const pack: ResearchPack = {};
  const missing: ResearchSource[] = [];
  if (want.has("help")) {
    if (!help) missing.push("help");
    else
      pack.help = {
        results: help.results.map((r, i) => ({
          title: r.title,
          url: r.url,
          // The best section whole (a how-to needs every step), the next ones shorter.
          ...(r.text
            ? { text: clip(r.text as string, i === 0 ? 2400 : brief ? 900 : 1600) }
            : { excerpt: r.excerpt }),
        })),
        ...(help.note ? { note: help.note } : {}),
      };
  }
  if (want.has("screens")) {
    if (!screens) missing.push("screens");
    else
      pack.screens = screens.screens.slice(0, 6).map((s) => ({
        ...s,
        controls: (s.controls as string[] | undefined)?.slice(0, 30),
      }));
  }
  if (want.has("source")) {
    if (!code) missing.push("source");
    else
      pack.source = {
        reference_only: true,
        sections: code.sections
          .slice(0, brief ? 3 : 5)
          .map((s) => ({ symbol: s.symbol, code: clip(s.code, brief ? 1200 : 2000)! })),
      };
  }
  if (missing.length) pack.missing = missing;
  return stripInvisible(pack);
}

/**
 * The catalogue's searches that `research` replaces in the app (MCP keeps them). The exact API
 * reference stays a tool of its own (`get_api_reference`).
 */
export const RESEARCH_TOOLS: ReadonlySet<string> = new Set(Object.values(SOURCE_TOOL));

/** The `research` tool: every source in one step, for questions the first pack did not answer. */
export function researchToolDef(): ToolDef {
  return {
    name: "research",
    title: "Research",
    description:
      "Search the help (with its API pages when audience is developer), the dashboard screens and the product's own code at once, in one step. " +
      "Use it when the reference you were given does not answer: write the query in the product's own terms (dunning, credit note, proration, mandate, entitlement, meter…) and other words than before. " +
      "Returns help sections with their URL, screens with their link, cards and exact control labels, and code (for you only: never show it, its file names or its function names). sources limits the search.",
    perms: [],
    input: {
      query: z.string().min(2).max(300).describe("What to find, in the product's terms."),
      sources: z
        .array(z.enum(["help", "screens", "source"]))
        .optional()
        .describe("Only these sources. Default: all."),
      audience: audienceInput,
    },
    run: (ctx, a) =>
      research(ctx, String(a.query), {
        sources: a.sources as ResearchSource[] | undefined,
        audience: a.audience as Audience | undefined,
        deadlineMs: 6000,
        size: "full",
      }),
  };
}

/** The read tool for the record a member is on, as their own call would make it. */
const RECORD_READS: Record<
  string,
  (id: string) => { tool: string; args: Record<string, unknown> }
> = {
  invoice: (id) => ({ tool: "get_invoice", args: { invoice: id } }),
  customer: (id) => ({ tool: "get_customer", args: { customer: id } }),
  subscription: (id) => ({ tool: "get_subscription", args: { subscription: id } }),
  "credit note": (id) => ({ tool: "read_api", args: { path: `credit_notes/${id}` } }),
  transaction: (id) => ({ tool: "read_api", args: { path: `transactions/${id}` } }),
  payment: (id) => ({ tool: "read_api", args: { path: `payment_intents/${id}` } }),
};

export interface Prefetched {
  pack: ResearchPack;
  /** The page's record, read as the member. */
  record: { tool: string; label: string; result: unknown } | null;
  steps: Array<{ name: string; label: string; ok: boolean; prefetched: true }>;
  ms: number;
  /** Each source's time in ms (the deadline when it did not answer), for the timing log. */
  sourceMs: Partial<Record<ResearchSource | "record", number>>;
}

/**
 * Before the first model call: research the member's question and read the page's record,
 * together, within `deadlineMs`. `can` says which catalogue tools the member may use.
 */
export async function prefetch(
  ctx: ToolContext,
  input: { question: string; page: PageContext | null; can: (tool: string) => boolean },
  // Long enough for every source that can answer (the query embedding gives up at 2.5 s): a
  // source dropped here costs a research call and a model step later, about 4–6 s.
  deadlineMs = 5000,
): Promise<Prefetched> {
  const t0 = performance.now();
  const rec = input.page?.record;
  const read = rec ? RECORD_READS[rec.type]?.(rec.id) : undefined;
  const sourceMs: Prefetched["sourceMs"] = {};
  const [pack, record] = await Promise.all([
    research(ctx, input.question.slice(0, 200), { deadlineMs, size: "brief", timing: sourceMs }),
    read && input.can(read.tool)
      ? within(
          tool(read.tool)
            .run(ctx, read.args)
            .then((result) => {
              sourceMs.record = Math.round(performance.now() - t0);
              return { tool: read.tool, label: stepLabel(read.tool, read.args), result };
            }),
          deadlineMs,
        )
      : undefined,
  ]);
  const steps: Prefetched["steps"] = [];
  for (const s of RESEARCH_SOURCES) {
    if (!(s in pack)) continue;
    const name = SOURCE_TOOL[s];
    steps.push({
      name,
      label: stepLabel(name, { query: input.question.slice(0, 200) }),
      ok: true,
      prefetched: true,
    });
  }
  if (record) steps.push({ name: record.tool, label: record.label, ok: true, prefetched: true });
  return {
    pack,
    record: record ? { ...record, result: stripInvisible(record.result) } : null,
    steps,
    ms: Math.round(performance.now() - t0),
    sourceMs,
  };
}

/** The pack as the model reads it, after the member's question: plain text, links ready to copy. */
export function packText(p: Prefetched, shape: (v: unknown) => string): string {
  const out: string[] = [
    "Reference for this question, searched before you were called. Answer from it when it is enough; call research with other words only when it is not. Copy help URLs and screen links exactly as written here.",
  ];
  const help = p.pack.help as
    | {
        results: Array<{ title?: string; url?: string; text?: string; excerpt?: string }>;
        note?: string;
      }
    | undefined;
  if (help) {
    out.push("## Help");
    for (const r of help.results)
      out.push(`### ${r.title} — ${r.url}\n${r.text ?? r.excerpt ?? ""}`);
    if (help.note) out.push(help.note);
    if (!help.results.length && !help.note) out.push("No help page matched.");
  }
  const screens = p.pack.screens as Array<Record<string, unknown>> | undefined;
  if (screens?.length) {
    out.push("## Dashboard screens");
    for (const s of screens)
      out.push(
        [
          `### ${s.screen}${s.on_this_page ? " (the page the member is on)" : ""}`,
          `Link: ${s.link ?? "none (the path needs a record id)"}`,
          `Path: ${s.path}`,
          `Cards: ${((s.cards as string[]) ?? []).join(" · ")}`,
          `Controls: ${((s.controls as string[]) ?? []).join(" · ")}`,
        ].join("\n"),
      );
  }
  if (p.pack.source?.sections.length) {
    out.push("## The product's code (for you only: never show it, its names or its files)");
    for (const c of p.pack.source.sections) out.push(`### ${c.symbol ?? "section"}\n${c.code}`);
  }
  if (p.pack.missing?.length)
    out.push(`Not searched in time: ${p.pack.missing.join(", ")}. Call research if you need them.`);
  if (p.record)
    out.push(
      `## The record the member is on, already read with ${p.record.tool} (call a tool again only for more detail or an explanation)\n${shape(p.record.result)}`,
    );
  return out.length > 1 ? out.join("\n\n") : "";
}
