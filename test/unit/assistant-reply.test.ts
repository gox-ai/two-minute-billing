import { describe, expect, it } from "vitest";
import {
  answerPlainText,
  charsLeftNote,
  columnAlign,
  dropSlash,
  filterCommands,
  isFigure,
  isWideTable,
  parseAnswer,
  slashQuery,
  stepsSummary,
  unansweredQuestions,
} from "../../dashboard/lib/assistant-reply";

const TABLE = [
  "| Invoice | Customer | Status | Total |",
  "|---|---|---|---:|",
  "| INV-1043 | Meera Pillai | Paid | ₹4,999.00 |",
  "| INV-1044 | Ostrander Labs | Not paid | ₹12,500.00 |",
].join("\n");

describe("parseAnswer", () => {
  it("reads headings, lists, tables, code and paragraphs as separate blocks", () => {
    const md = [
      "## Summary",
      "Two invoices are **unpaid**.",
      "",
      "- First item",
      "  carries on",
      "- Second item",
      "",
      "3. Third",
      "4. Fourth",
      "",
      TABLE,
      "",
      "```json",
      '{ "a": 1 }',
      "```",
      "> A note",
    ].join("\n");
    const kinds = parseAnswer(md).map((b) => b.kind);
    expect(kinds).toEqual(["heading", "para", "list", "list", "table", "code", "quote"]);
    const [, , bullets, numbered] = parseAnswer(md);
    expect(bullets).toMatchObject({
      ordered: false,
      items: ["First item carries on", "Second item"],
    });
    expect(numbered).toMatchObject({ ordered: true, start: 3 });
  });

  it("stops a paragraph at a heading or a list with no blank line between", () => {
    expect(parseAnswer("Intro line\n### Next\n- item").map((b) => b.kind)).toEqual([
      "para",
      "heading",
      "list",
    ]);
  });

  it("keeps an unclosed fence as code while the answer streams", () => {
    expect(parseAnswer("```\ncurl -X POST")).toEqual([
      { kind: "code", lang: null, text: "curl -X POST" },
    ]);
  });

  it("pads a short table row to the head's width", () => {
    const [t] = parseAnswer("| a | b | c |\n|---|---|---|\n| 1 |");
    expect(t).toMatchObject({ kind: "table", rows: [["1", "", ""]] });
  });
});

describe("table layout", () => {
  it("right-aligns figure columns and keeps text columns left", () => {
    const [t] = parseAnswer(TABLE);
    expect(t).toMatchObject({ align: ["left", "left", "left", "right"] });
    expect(
      columnAlign(
        ["---", "---"],
        [
          ["Plan", "$29.00"],
          ["Pro", "—"],
        ],
        2,
      ),
    ).toEqual(["left", "right"]);
  });

  it("knows a figure when it sees one", () => {
    for (const s of ["$1,204.00", "−₹12.50", "18%", "1,204", "42 USD", "**$5.00**"])
      expect(isFigure(s), s).toBe(true);
    for (const s of ["INV-1043", "Paid", "sub_XXXXXXXXXXXX01", "12 Dec 2026"])
      expect(isFigure(s), s).toBe(false);
  });

  it("scrolls a table of four columns or more", () => {
    expect(isWideTable(["a", "b", "c"])).toBe(false);
    expect(isWideTable(["a", "b", "c", "d"])).toBe(true);
  });
});

describe("answerPlainText", () => {
  it("drops marks and writes tables tab-separated", () => {
    const text = answerPlainText(
      `**Two** invoices, see [the list](/businesses/b/invoices).\n\n${TABLE}`,
    );
    expect(text).toBe(
      [
        "Two invoices, see the list.",
        "",
        "Invoice\tCustomer\tStatus\tTotal",
        "INV-1043\tMeera Pillai\tPaid\t₹4,999.00",
        "INV-1044\tOstrander Labs\tNot paid\t₹12,500.00",
      ].join("\n"),
    );
  });

  it("numbers an ordered list from its start and keeps code as is", () => {
    expect(answerPlainText("2. b\n3. c\n\n```\nx  y\n```")).toBe("2. b\n3. c\n\nx  y");
  });
});

describe("slash menu", () => {
  it("opens at the start of a line only", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/expl")).toBe("expl");
    expect(slashQuery("first line\n  /find sc")).toBe("find sc");
    expect(slashQuery("why does /v1")).toBeNull();
    expect(slashQuery("/v1/customers")).toBeNull();
  });

  it("removes the typed command and keeps the rest", () => {
    expect(dropSlash("/expl")).toBe("");
    expect(dropSlash("line one\n  /find")).toBe("line one\n");
  });

  it("filters by word starts across the label and keywords", () => {
    const items = [
      { label: "Explain an invoice" },
      { label: "Explain an MRR change" },
      { label: "Attach a file", keywords: ["image", "screenshot"] },
    ];
    expect(filterCommands(items, "").length).toBe(3);
    expect(filterCommands(items, "expl inv").map((i) => i.label)).toEqual(["Explain an invoice"]);
    expect(filterCommands(items, "screen").map((i) => i.label)).toEqual(["Attach a file"]);
    expect(filterCommands(items, "zzz")).toEqual([]);
  });
});

describe("limits and steps", () => {
  it("shows the character count only near the limit", () => {
    expect(charsLeftNote(100)).toBeNull();
    expect(charsLeftNote(3600)).toBe("400 characters left");
    expect(charsLeftNote(3999)).toBe("1 character left");
  });

  it("summarizes the steps of a finished answer", () => {
    expect(stepsSummary([{ phase: "done" }])).toBe("Used 1 step");
    expect(stepsSummary([{ phase: "done" }, { phase: "error" }, { phase: "done" }])).toBe(
      "Used 3 steps, 1 failed",
    );
  });

  it("finds questions with no answer after them", () => {
    const roles = ["user", "assistant", "user", "user", "assistant", "user"].map((role) => ({
      role,
    }));
    expect([...unansweredQuestions(roles)]).toEqual([2, 5]);
  });
});
