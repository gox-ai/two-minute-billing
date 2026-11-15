/**
 * Follow-up questions come as the answer's last line, `Follow-ups: a | b | c`, not as a tool:
 * the tool call cost the member one more model round trip on almost every turn. The line is
 * held out of the stream and becomes the chips.
 */

const MARKERS = ["follow-ups:", "followups:", "follow ups:", "**follow-ups:**", "**follow-ups**:"];
const LINE = /^\s*\**\s*follow[- ]?ups\s*\**\s*:\s*\**\s*(.*)$/i;

const isMarker = (head: string) => MARKERS.some((m) => head.startsWith(m));
const mayBeMarker = (head: string) => MARKERS.some((m) => m.startsWith(head));

/** Passes the answer through, holding back the line that is (or may become) the follow-ups. */
export class FollowUpFilter {
  private line = "";
  private mode: "deciding" | "text" | "follow" = "deciding";
  questions: string[] = [];

  /** The text that can be shown now. */
  push(delta: string): string {
    let out = "";
    for (const ch of delta) {
      if (ch === "\n") {
        out += this.endLine(true);
        continue;
      }
      this.line += ch;
      if (this.mode === "text") out += ch;
      else if (this.mode === "deciding") {
        const head = this.line.trimStart().toLowerCase();
        if (!head) continue;
        if (isMarker(head)) this.mode = "follow";
        else if (!mayBeMarker(head)) {
          this.mode = "text";
          out += this.line;
        }
      }
    }
    return out;
  }

  /** What is left at the end of the answer. */
  flush(): string {
    return this.endLine(false);
  }

  private endLine(newline: boolean): string {
    let out = "";
    if (this.mode === "follow") this.questions = parseFollowUps(LINE.exec(this.line)?.[1] ?? "");
    else out = (this.mode === "deciding" ? this.line : "") + (newline ? "\n" : "");
    this.line = "";
    this.mode = "deciding";
    return out;
  }
}

export function parseFollowUps(list: string): string[] {
  return list
    .split("|")
    .map((q) =>
      q
        .replace(/^[\s\-*\d.)"“`]+|["”`\s*]+$/g, "")
        .trim()
        .slice(0, 120),
    )
    .filter((q) => q.length >= 3)
    .slice(0, 3);
}

/** The answer without its follow-ups line. */
export function withoutFollowUps(text: string): string {
  return text
    .split("\n")
    .filter((l) => !(isMarker(l.trimStart().toLowerCase()) && LINE.test(l)))
    .join("\n")
    .trimEnd();
}
