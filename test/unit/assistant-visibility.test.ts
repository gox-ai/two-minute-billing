import { describe, expect, it } from "vitest";
import { memberData, memberSteps } from "@/modules/assistant/visibility";
import { serializeMessage } from "@/modules/assistant/service";

describe("what reaches the member's browser", () => {
  const steps = [
    { name: "get_subscription", label: "Read subscription sub_1", ok: true },
    { name: "search_docs", label: "Searched help: excess payments", ok: true },
    { name: "get_api_reference", label: "Read the API reference: PATCH …", ok: true },
    { name: "find_screen", label: "Found the screen: …", ok: true },
    { name: "search_source", label: "Checked how the product works", ok: true },
    { name: "propose_action", label: "Prepared a change for you to confirm", ok: true },
  ];
  it("never research steps: help search, screens, source, the API reference", () => {
    expect(memberSteps(steps).map((s) => s.name)).toEqual(["get_subscription", "propose_action"]);
  });
  it("tool output only for what the panel draws as a card", () => {
    const data = [
      { id: "1", name: "get_subscription", label: "", data: {} },
      { id: "2", name: "search_docs", label: "", data: {} },
      { id: "3", name: "read_api", label: "", data: {} },
    ];
    expect(memberData(data).map((d) => d.name)).toEqual(["get_subscription"]);
  });
  it("a stored message is returned without them; the row itself keeps them", () => {
    const row = {
      publicId: "amsg_1",
      role: "assistant",
      content: "x",
      steps,
      data: [{ id: "2", name: "search_docs", label: "", data: { results: [] } }],
    } as unknown as Parameters<typeof serializeMessage>[0];
    const out = serializeMessage(row);
    expect(out.steps).toHaveLength(2);
    expect(out.data).toEqual([]);
    expect((row as unknown as { steps: unknown[] }).steps).toHaveLength(6);
  });
});
