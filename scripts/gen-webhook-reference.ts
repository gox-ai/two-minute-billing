/**
 * Generate the published webhook reference: docs-site/data/webhooks.json,
 * plus the page that renders it (content/05.webhooks/04.events.md).
 *
 *   pnpm gen:webhook-reference            write it
 *   pnpm gen:webhook-reference --check    exit 1 if the committed file is stale
 *
 * ── The split, and why ────────────────────────────────────────────────────────────
 * FACTS are generated: which event types exist, what family each belongs to, how many
 * delivery attempts there are and at what intervals. Those come from the engine — the
 * registry array and the outbox's own constants — so the page cannot promise a retry
 * schedule the deliverer does not run.
 *
 * PROSE is hand-written, in `docs-site/data/webhook-notes.ts`, and deliberately NOT
 * lifted from the registry's comments. Those comments are excellent and they are written
 * for us: they cite `runRemindersPass`, `debitNeedsBuyerAuthentication`, "operator ask 2"
 * and a measurement taken on the dev book on a particular day. Publishing them verbatim
 * would hand a customer our internal vocabulary and call it documentation.
 *
 * The registry's note is still carried through as `internal_note` so a writer can see
 * what the engineer knew, but nothing renders it — `--check` fails when a family has no
 * customer-facing summary, so coverage is visible rather than assumed.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { EVENT_TYPES, resourceTypeOf, type EventType } from "@/modules/events/registry";
import { MAX_DELIVERY_ATTEMPTS, BACKOFF_SECONDS } from "@/modules/webhooks/outbox";
import { FAMILY_SUMMARIES, EVENT_SUMMARIES } from "../docs-site/data/webhook-notes";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = join(root, "src", "modules", "events", "registry.ts");
export const OUT_PATH = join(root, "docs-site", "data", "webhooks.json");

/** The published page. Generated from OUT_PATH, replaced on every run. */
const PAGE_PATH = join(
  root,
  "docs-site",
  "content",
  "help",
  "40.developers",
  "05.webhooks",
  "04.events.md",
);

/** See `scripts/gen-event-types.ts`: the picker's family, not the envelope's key. */
function familyOf(type: EventType): string {
  const resource = resourceTypeOf(type);
  return resource === type ? (type.split("_")[0] ?? type) : resource;
}

/**
 * The comment block sitting above each event in the registry source.
 *
 * Classification is STRUCTURAL, not textual: a comment above the FIRST event of a family
 * describes the family, one above any later event describes that event. Guessing from the
 * wording fails on `refund_settled`, whose note opens with the word "refund".
 */
function readRegistryNotes(): { family: Map<string, string>; event: Map<string, string> } {
  const src = readFileSync(REGISTRY_PATH, "utf8");
  const block = /export const EVENT_TYPES = \[(.*?)\n\] as const;/s.exec(src);
  if (!block?.[1]) throw new Error("EVENT_TYPES array not found in registry.ts");

  const family = new Map<string, string>();
  const event = new Map<string, string>();
  const seenFamilies = new Set<string>();
  let buffer: string[] = [];

  for (const raw of block[1].split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("/**") || line.startsWith("*")) {
      const text = line.replace(/^\/\*\*|^\*\/|^\*|^\/\//, "").trim();
      if (text) buffer.push(text);
      continue;
    }
    const match = /^"([a-z0-9_]+)",$/.exec(line);
    if (!match?.[1]) continue;
    const type = match[1] as EventType;
    const key = familyOf(type);
    const first = !seenFamilies.has(key);
    seenFamilies.add(key);
    if (buffer.length) (first ? family : event).set(first ? key : type, buffer.join(" "));
    buffer = [];
  }
  return { family, event };
}

export function renderWebhookReference(): string {
  const notes = readRegistryNotes();
  const families = new Map<string, EventType[]>();
  for (const type of EVENT_TYPES) {
    const key = familyOf(type);
    const bucket = families.get(key);
    if (bucket) bucket.push(type);
    else families.set(key, [type]);
  }

  const doc = {
    // Regenerate with `pnpm gen:webhook-reference`; do not hand-edit.
    generated_from: ["src/modules/events/registry.ts", "src/modules/webhooks/outbox.ts"],
    event_count: EVENT_TYPES.length,
    family_count: families.size,
    delivery: {
      success: "Any 2xx response.",
      max_attempts: MAX_DELIVERY_ATTEMPTS,
      backoff_seconds: BACKOFF_SECONDS,
      ordered: false,
    },
    families: [...families].map(([key, types]) => ({
      key,
      summary: FAMILY_SUMMARIES[key] ?? null,
      internal_note: notes.family.get(key) ?? null,
      events: types.map((type) => ({
        type,
        summary: EVENT_SUMMARIES[type] ?? null,
        internal_note: notes.event.get(type) ?? null,
      })),
    })),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Families with no customer-facing summary — the coverage the gate reports. */
export function uncoveredFamilies(): string[] {
  const doc = JSON.parse(renderWebhookReference()) as {
    families: { key: string; summary: string | null }[];
  };
  return doc.families.filter((f) => !f.summary).map((f) => f.key);
}

function main(): void {
  const next = renderWebhookReference();
  const check = process.argv.includes("--check");
  let current = "";
  try {
    current = readFileSync(OUT_PATH, "utf8");
  } catch {
    if (check) {
      console.error(`MISSING: ${OUT_PATH}. Run \`pnpm gen:webhook-reference\`.`);
      process.exit(1);
    }
  }

  const uncovered = uncoveredFamilies();
  if (current !== next) {
    if (check) {
      console.error(
        `STALE: ${OUT_PATH} does not match the engine. Run \`pnpm gen:webhook-reference\`.`,
      );
      process.exit(1);
    }
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, next);
    console.log(`wrote ${OUT_PATH}`);
  } else {
    console.log(`${OUT_PATH} is current`);
  }

  writeEventsPage(JSON.parse(next));

  console.log(`${EVENT_TYPES.length} event types in ${JSON.parse(next).family_count} families`);
  if (uncovered.length) {
    console.error(
      `no customer-facing summary for ${uncovered.length} families: ${uncovered.join(", ")}`,
    );
    process.exit(1);
  }
}

/**
 * Render the reference as a page.
 *
 * Markdown rather than a component reading the JSON at render time: Docus builds
 * navigation and search from the content tree, so a family that is not in a file is
 * a family nobody can search for. `internal_note` is deliberately never rendered —
 * those are the registry's own comments, written for whoever maintains the engine.
 */
function writeEventsPage(ref: {
  event_count: number;
  family_count: number;
  delivery: { success: string; max_attempts: number; backoff_seconds: number[] };
  families: { key: string; summary: string; events: { type: string; summary: string | null }[] }[];
}) {
  const human = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${s / 60} min` : `${s / 3600} h`);
  const out: string[] = [
    "---",
    'title: "Event reference"',
    `description: "Every event type tmbilling emits, grouped by the resource it belongs to."`,
    "navigation:",
    "  icon: i-lucide-list",
    "---",
    "",
    "<!-- GENERATED by scripts/gen-webhook-reference.ts from the engine's event registry.",
    "     Do not edit — including in Studio; the next build replaces this file. -->",
    "",
    `${ref.event_count} event types across ${ref.family_count} resource families. Subscribe an`,
    "endpoint to any subset; an endpoint with no list receives all of them.",
    "",
    "::note",
    `Delivery succeeds on ${ref.delivery.success.toLowerCase().replace(/\.$/, "")}. A failure is retried up to`,
    `${ref.delivery.max_attempts} times, backing off ${ref.delivery.backoff_seconds.map(human).join(", ")}.`,
    "::",
    "",
  ];
  for (const family of ref.families) {
    out.push(`## \`${family.key}\``, "", family.summary, "");
    out.push("| Event type | |", "|---|---|");
    for (const e of family.events) out.push(`| \`${e.type}\` | ${e.summary ?? ""} |`);
    out.push("");
  }
  mkdirSync(dirname(PAGE_PATH), { recursive: true });
  writeFileSync(PAGE_PATH, out.join("\n"));
  console.log(`wrote ${PAGE_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
