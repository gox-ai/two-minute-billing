import { describe, expect, it } from "vitest";
import { earlierRecords, earlierText, FORCEABLE_TOOLS } from "@/modules/assistant/run";
import { todayIn } from "@/modules/assistant/prompt";
import { feedbackDownText } from "@/modules/assistant/support-notify";

const answer = (data: unknown[]) => ({ role: "assistant", data });

describe("earlierRecords", () => {
  it("collects records from earlier answers, newest first, with the best label", () => {
    const stored = [
      { role: "user", data: null },
      answer([
        {
          name: "get_customer",
          label: "",
          data: {
            id: "cus_AAAAAA01",
            first_name: "Maren",
            last_name: "Holt",
            email: "m@example.com",
          },
        },
      ]),
      answer([
        {
          name: "list_invoices",
          label: "",
          data: {
            data: [
              { id: "inv_BBBBBB01", number: "INV-1043", customer: { id: "cus_AAAAAA01" } },
              { id: "inv_BBBBBB02", status: "paid" },
            ],
          },
        },
      ]),
    ];
    expect(earlierRecords(stored)).toEqual([
      { id: "inv_BBBBBB01", label: "INV-1043" },
      // Seen bare in the newer answer, then named by the older one.
      { id: "cus_AAAAAA01", label: "Maren Holt" },
      { id: "inv_BBBBBB02", label: null },
    ]);
  });

  it("skips research, user messages and strings that are not record ids", () => {
    const stored = [
      { role: "user", data: [{ name: "x", data: { id: "cus_USER0001" } }] },
      answer([
        { name: "research", label: "", data: { help: { results: [{ id: "doc_RESEARCH1" }] } } },
        { name: "get_invoice", label: "", data: { id: "INV-1", customer: "cus_STRING01" } },
      ]),
    ];
    expect(earlierRecords(stored)).toEqual([]);
  });

  it("caps the list at 40", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: `cus_${String(i).padStart(8, "0")}`,
    }));
    expect(
      earlierRecords([answer([{ name: "list_customers", data: { data: rows } }])]),
    ).toHaveLength(40);
  });
});

describe("earlierText", () => {
  it("lists id and label, and stays under 1,500 characters", () => {
    expect(earlierText([])).toBe("");
    const t = earlierText([
      { id: "cus_AAAAAA01", label: "Maren Holt" },
      { id: "inv_BBBBBB01", label: null },
    ]);
    expect(t).toContain("cus_AAAAAA01 — Maren Holt · inv_BBBBBB01");
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `cus_${String(i).padStart(8, "0")}`,
      label: "x".repeat(80),
    }));
    expect(earlierText(many).length).toBeLessThanOrEqual(1500);
  });
});

describe("todayIn", () => {
  // 2026-11-12 20:30 UTC is already 13 November in Kolkata and still 12 November in New York.
  const at = new Date("2026-11-12T20:30:00Z");
  it("gives the calendar date in the business timezone", () => {
    expect(todayIn(at, "Asia/Kolkata")).toBe("2026-11-13");
    expect(todayIn(at, "America/New_York")).toBe("2026-11-12");
  });
  it("falls back to UTC for no zone or an invalid one", () => {
    expect(todayIn(at, null)).toBe("2026-11-12");
    expect(todayIn(at, "Not/AZone")).toBe("2026-11-12");
  });
});

describe("menu tasks", () => {
  it("only offers tasks whose tool the app still has", () => {
    expect([...FORCEABLE_TOOLS]).toEqual(["explain_invoice", "explain_mrr_change"]);
  });
});

describe("feedbackDownText", () => {
  it("names the organization, masks emails, and never carries the answer", () => {
    const t = feedbackDownText({
      organizationName: "Larkfield Studio",
      question: `why was m@example.com charged twice? ${"x".repeat(300)}`,
      comment: null,
    });
    const [head, question, comment] = t.split("\n");
    expect(head).toBe("👎 Billy answer rated not helpful · Larkfield Studio");
    expect(question).toContain("[email]");
    expect(question).not.toContain("@");
    expect(question!.length).toBeLessThanOrEqual(160);
    expect(comment).toBe("(no comment)");
  });
});
