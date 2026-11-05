/**
 * The SHAPE of a release note, importable from anywhere.
 *
 * Split from `lib/release-notes.ts` deliberately: that module reads the filesystem, so a client
 * component importing it drags `node:fs` into the browser bundle and the page fails to build.
 * Same rule as the `next/headers` one in `dashboard/README.md` — a module that touches Node is
 * server-only, and anything both halves need lives in a file that touches neither.
 */

export type Span =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; spans: Span[] }
  | { kind: "em"; spans: Span[] }
  | { kind: "link"; href: string; spans: Span[] };

export type Block =
  | { kind: "p"; spans: Span[] }
  | { kind: "h"; level: 2 | 3; spans: Span[] }
  | { kind: "ul"; items: Span[][] }
  | { kind: "ol"; items: Span[][] }
  | { kind: "pre"; text: string };

/**
 * What KIND of change a note is, so the page can be scanned for one. A closed set, validated
 * at parse time: an open-ended string drifts into "Fixes"/"Bugfix"/"bug fix" within a month
 * and then cannot be filtered on. Add a value here rather than inventing one in a file.
 */
export const RELEASE_TYPES = ["Feature", "Fix", "Improvement", "Performance", "Security"] as const;
export type ReleaseType = (typeof RELEASE_TYPES)[number];

export interface ReleaseNote {
  /** Filename without `.md`; also the anchor id on the page. */
  slug: string;
  title: string;
  type: ReleaseType;
  /** `YYYY-MM-DD`, a calendar date — deliberately NOT an instant, so no zone shifts it. */
  date: string;
  /** Optional: we do not tag product versions yet, so most notes are dated only. */
  version?: string;
  tags: string[];
  /** One line under the title, for scanning the list without opening each entry. */
  summary?: string;
  blocks: Block[];
}

/**
 * The notes this person has not acknowledged, newest first.
 *
 * Notes are append-only and sorted newest-first, so the unread ones are simply the first
 * `total - seen` of them. A COUNT is the highwater rather than a date because notes carry a
 * calendar date only: two notes published on the same day are indistinguishable by date, and
 * the second would never be announced to anyone who dismissed that morning.
 *
 * `null`/`undefined` means the highwater was never initialised — a new account — and is read as
 * CAUGHT UP, not as "has seen nothing". The migration backfills everyone who predates the
 * feature to 0 instead, so they get exactly one launch announcement.
 *
 * Clamped: a note deleted from the repo would otherwise make the count negative.
 */
export function unreadNotes(
  notes: ReleaseNote[],
  seenCount: number | null | undefined,
): ReleaseNote[] {
  if (seenCount === null || seenCount === undefined) return [];
  return notes.slice(0, Math.max(0, notes.length - seenCount));
}
