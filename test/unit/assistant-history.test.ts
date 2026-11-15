import { describe, expect, it } from "vitest";
import {
  chatTime,
  cleanTitle,
  groupChats,
  highlightParts,
  matchRanges,
  patchChat,
  removeChat,
  resultLabel,
  sharedChatId,
  sharedChatUrl,
  sortChats,
  toChat,
  toChatPage,
  upsertChat,
  type ChatSummary,
} from "../../dashboard/lib/assistant-history";

const chat = (id: string, updated_at: string, extra: Partial<ChatSummary> = {}): ChatSummary => ({
  id,
  title: id,
  business: "biz_1",
  created_at: updated_at,
  updated_at,
  archived_at: null,
  pinned_at: null,
  shared_at: null,
  snippet: null,
  ...extra,
});

describe("toChat / toChatPage", () => {
  it("reads missing new fields as null and a missing has_more as false", () => {
    const page = toChatPage({
      data: [
        {
          id: "acv_1",
          title: "Hi",
          created_at: "2026-11-01T00:00:00Z",
          updated_at: "2026-11-02T00:00:00Z",
        },
      ],
    });
    expect(page.has_more).toBe(false);
    expect(page.next_cursor).toBeNull();
    expect(page.data[0]).toMatchObject({
      archived_at: null,
      pinned_at: null,
      shared_at: null,
      snippet: null,
    });
  });
  it("falls back to the last id as the cursor", () => {
    const page = toChatPage({ data: [{ id: "acv_1" }, { id: "acv_2" }], has_more: true });
    expect(page.next_cursor).toBe("acv_2");
  });
  it("drops rows without an id", () => {
    expect(toChat({ title: "x" })).toBeNull();
    expect(toChatPage({ data: [null, { id: "acv_1" }] }).data).toHaveLength(1);
  });
});

describe("groupChats", () => {
  // Wed 11 Nov 2026, 10:00 in Kolkata (04:30Z).
  const now = new Date("2026-11-11T04:30:00Z");
  const tz = "Asia/Kolkata";

  it("puts pinned first, then the relative groups, then months newest first", () => {
    const groups = groupChats(
      [
        chat("pin", "2026-01-01T00:00:00Z", { pinned_at: "2026-11-01T00:00:00Z" }),
        chat("today", "2026-11-10T19:00:00Z"), // 00:30 on 11 Nov in Kolkata
        chat("yday", "2026-11-10T10:00:00Z"),
        chat("mon", "2026-11-09T05:00:00Z"),
        chat("month", "2026-11-03T05:00:00Z"),
        chat("oct", "2026-10-20T05:00:00Z"),
        chat("sep", "2026-09-20T05:00:00Z"),
        chat("oldyear", "2025-11-20T05:00:00Z"),
      ],
      tz,
      now,
    );
    expect(groups.map((g) => [g.label, g.items.map((c) => c.id)])).toEqual([
      ["Pinned", ["pin"]],
      ["Today", ["today"]],
      ["Yesterday", ["yday"]],
      ["Earlier this week", ["mon"]],
      ["Earlier this month", ["month"]],
      ["October 2026", ["oct"]],
      ["September 2026", ["sep"]],
      ["November 2025", ["oldyear"]],
    ]);
  });

  it("counts days in the business time zone, not UTC", () => {
    // 19:00Z on 10 Nov is 11 Nov in Kolkata but 10 Nov in UTC.
    const c = chat("x", "2026-11-10T19:00:00Z");
    expect(groupChats([c], tz, now)[0]!.label).toBe("Today");
    expect(groupChats([c], "UTC", now)[0]!.label).toBe("Yesterday");
  });

  it("keeps a day of last month that falls in this week in the week", () => {
    // Tue 3 Nov 2026; Monday is 2 Nov, Sunday 1 Nov is last week.
    const tue = new Date("2026-11-03T12:00:00Z");
    expect(groupChats([chat("sun", "2026-11-01T12:00:00Z")], "UTC", tue)[0]!.label).toBe(
      "Earlier this month",
    );
    // Wed 2 Dec 2026: Mon 30 Nov is this week but last month.
    const wed = new Date("2026-12-02T12:00:00Z");
    expect(groupChats([chat("mon", "2026-11-30T12:00:00Z")], "UTC", wed)[0]!.label).toBe(
      "Earlier this week",
    );
  });

  it("puts a future time and a bad zone in a group without throwing", () => {
    expect(groupChats([chat("f", "2026-11-12T00:00:00Z")], "UTC", now)[0]!.label).toBe("Today");
    expect(groupChats([chat("z", "2026-11-11T00:00:00Z")], "Not/AZone", now)[0]!.label).toBe(
      "Today",
    );
  });

  it("shows no Pinned group for an archived chat", () => {
    const g = groupChats(
      [chat("a", "2026-11-11T01:00:00Z", { pinned_at: "x", archived_at: "y" })],
      "UTC",
      now,
    );
    expect(g.map((x) => x.label)).toEqual(["Today"]);
  });
});

describe("chatTime", () => {
  const now = new Date("2026-11-11T04:30:00Z");
  it("shows the time today, the day this year, the full date before", () => {
    expect(chatTime("2026-11-11T03:05:00Z", "Asia/Kolkata", now)).toBe("08:35");
    expect(chatTime("2026-10-12T03:05:00Z", "Asia/Kolkata", now)).toBe("12 Oct");
    expect(chatTime("2025-10-12T03:05:00Z", "Asia/Kolkata", now)).toBe("12 Oct 2025");
  });
});

describe("search highlighting", () => {
  it("matches every word, case-insensitive, and merges touching ranges", () => {
    expect(matchRanges("Refund the Invoice", "invoice refund")).toEqual([
      [0, 6],
      [11, 18],
    ]);
    expect(matchRanges("abcd", "ab bc")).toEqual([[0, 3]]);
  });
  it("cuts text into parts", () => {
    expect(highlightParts("Why did MRR fall?", "mrr")).toEqual([
      { text: "Why did ", match: false },
      { text: "MRR", match: true },
      { text: " fall?", match: false },
    ]);
  });
  it("treats regex characters as text", () => {
    expect(matchRanges("cost (USD) +5%", "(usd) +5%")).toEqual([
      [5, 10],
      [11, 14],
    ]);
  });
  it("returns the text whole for an empty query", () => {
    expect(highlightParts("abc", "  ")).toEqual([{ text: "abc", match: false }]);
  });
  it("counts results", () => {
    expect(resultLabel(1, false)).toBe("1 chat found");
    expect(resultLabel(3, false)).toBe("3 chats found");
    expect(resultLabel(30, true)).toBe("30+ chats found");
  });
});

describe("the optimistic list", () => {
  const a = chat("a", "2026-11-10T00:00:00Z");
  const b = chat("b", "2026-11-09T00:00:00Z");
  const now = "2026-11-11T00:00:00Z";

  it("sorts pinned first, then newest", () => {
    const p = { ...b, pinned_at: now };
    expect(sortChats([a, p]).map((c) => c.id)).toEqual(["b", "a"]);
  });

  it("drops an archived chat from Chats and adds it to Archived", () => {
    const archived = patchChat(a, { archived: true }, now);
    expect(upsertChat([a, b], archived, "active").map((c) => c.id)).toEqual(["b"]);
    expect(upsertChat([], archived, "archived").map((c) => c.id)).toEqual(["a"]);
  });

  it("puts an undone archive back in its place", () => {
    const archived = patchChat(a, { archived: true }, now);
    const without = upsertChat([a, b], archived, "active");
    const back = patchChat(archived, { archived: false }, now);
    expect(upsertChat(without, back, "active").map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("keeps search results to the server's matches", () => {
    expect(upsertChat([b], a, "active", false)).toEqual([b]);
    expect(upsertChat([a, b], { ...a, title: "x" }, "active", false)[0]!.title).toBe("x");
  });

  it("rolls back by putting the old row again", () => {
    const renamed = patchChat(a, { title: "New" }, now);
    const list = upsertChat([a, b], renamed, "active");
    expect(upsertChat(list, a, "active")[0]!.title).toBe("a");
    expect(removeChat(list, "a").map((c) => c.id)).toEqual(["b"]);
  });

  it("archiving unpins; pin and share stamp times", () => {
    const pinned = patchChat(a, { pinned: true, shared: true }, now);
    expect(pinned.pinned_at).toBe(now);
    expect(pinned.shared_at).toBe(now);
    const archived = patchChat(pinned, { archived: true }, now);
    expect(archived.pinned_at).toBeNull();
    expect(patchChat(pinned, { shared: false }, now).shared_at).toBeNull();
  });
});

describe("titles and links", () => {
  it("refuses an empty title and caps at 120", () => {
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle("  a   b ")).toBe("a b");
    expect(cleanTitle("x".repeat(200))).toHaveLength(120);
  });
  it("builds and reads the shared link", () => {
    const url = sharedChatUrl("https://app.example.com", "biz_1", "acv_0abc123XYZ");
    expect(url).toBe("https://app.example.com/businesses/biz_1?billy=acv_0abc123XYZ");
    expect(sharedChatId(new URL(url).search)).toBe("acv_0abc123XYZ");
    expect(sharedChatId("?billy=../etc")).toBeNull();
    expect(sharedChatId("?support=sr_123456")).toBeNull();
  });
});
