import { CopyButton } from "@/components/patterns/copy-button";
import { RecordCard } from "@/components/patterns/record-page";

/**
 * One stored body of a request log row, with the capture markers put into words.
 * Markers (set by the engine before the row is written):
 *   {"_omitted":"secret" | "content_type" | "too_large" | "body", …}
 *   {"_truncated":true,"bytes":N,"preview":"…"}
 *   leaf "****", "<prefix>****", "****1234" — a hidden secret or card number
 *   leaf "[omitted: N chars]" — a long value not kept
 */
type Omitted =
  | { _omitted: "secret" }
  | { _omitted: "content_type"; type?: string; bytes?: number }
  | { _omitted: "too_large"; bytes?: number }
  | { _omitted: "body" };
type Truncated = { _truncated: true; bytes?: number; preview?: string };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const fmtBytes = (n: number | undefined) =>
  n == null
    ? ""
    : n >= 1024
      ? ` (${Math.round(n / 1024).toLocaleString("en-US")} KB)`
      : ` (${n} bytes)`;

const HIDDEN = /^(?:[A-Za-z0-9_]*\*{4}|\*{4}\d{0,4})$/;
const LONG = /^\[omitted: \d+ chars\]$/;

/** Which leaf markers the body holds, so each gets one line of explanation. */
function leafMarkers(v: unknown, found = { hidden: false, long: false }, depth = 0) {
  if (depth > 64) return found;
  if (typeof v === "string") {
    if (HIDDEN.test(v)) found.hidden = true;
    else if (LONG.test(v)) found.long = true;
  } else if (Array.isArray(v)) {
    for (const x of v) leafMarkers(x, found, depth + 1);
  } else if (isObj(v)) {
    for (const x of Object.values(v)) leafMarkers(x, found, depth + 1);
  }
  return found;
}

function omittedNote(b: Omitted): string {
  switch (b._omitted) {
    case "secret":
      return "This request returns a secret that shows one time. We never keep its response.";
    case "content_type": {
      const t = "type" in b && b.type ? ` (${b.type})` : "";
      return `The body was not JSON${t}${fmtBytes("bytes" in b ? b.bytes : undefined)}. We keep JSON bodies only.`;
    }
    case "too_large":
      return `The body was more than 256 KB${fmtBytes("bytes" in b ? b.bytes : undefined)}. We did not keep it.`;
    case "body":
      return "This route keeps only the request details. We keep its bodies only when the request fails.";
  }
}

function Json({ value }: { value: unknown }) {
  const json = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div className="relative">
      <CopyButton value={json} className="absolute top-2 right-2" />
      <pre className="max-h-[520px] overflow-auto rounded-md bg-muted p-4 pr-10 font-mono text-xs leading-relaxed">
        {json}
      </pre>
    </div>
  );
}

export function RequestLogBody({
  title,
  body,
  empty,
}: {
  title: string;
  body: unknown;
  /** Why there is no body, in words. */
  empty: string;
}) {
  if (body == null) {
    return (
      <RecordCard title={title}>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </RecordCard>
    );
  }
  if (isObj(body) && typeof body._omitted === "string") {
    return (
      <RecordCard title={title}>
        <p className="text-sm text-muted-foreground">{omittedNote(body as Omitted)}</p>
      </RecordCard>
    );
  }
  if (isObj(body) && body._truncated === true) {
    const t = body as Truncated;
    return (
      <RecordCard title={title} meta="Preview">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            The body was more than 32 KB{fmtBytes(t.bytes)}. We kept only its first 2 KB, shown
            below as text.
          </p>
          <Json value={t.preview ?? ""} />
        </div>
      </RecordCard>
    );
  }
  const marks = leafMarkers(body);
  return (
    <RecordCard title={title}>
      <div className="flex flex-col gap-3">
        <Json value={body} />
        {marks.hidden ? (
          <p className="text-xs text-muted-foreground">
            A value that shows as <code className="font-mono">****</code> is hidden. We hide
            secrets, tokens and card numbers before we keep a body. A prefix or the last four digits
            can stay visible.
          </p>
        ) : null}
        {marks.long ? (
          <p className="text-xs text-muted-foreground">
            A value that shows as <code className="font-mono">[omitted: N chars]</code> was longer
            than 2,048 characters, for example an image. We did not keep it.
          </p>
        ) : null}
      </div>
    </RecordCard>
  );
}
