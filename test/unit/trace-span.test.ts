import { describe, expect, it } from "vitest";
import {
  getSpanId,
  getTraceContext,
  getTraceId,
  ensureSpan,
  joinSpan,
  spanContext,
  withSpan,
  withTraceContext,
} from "@/platform/trace";

describe("withSpan", () => {
  it("keeps the trace and its tenant fields, and gives each unit its own span", async () => {
    const seen = await withTraceContext({ traceId: "job-TESTTRACE01", businessId: "b1" }, () =>
      Promise.all(
        [0, 1].map(() =>
          withSpan(async () => ({
            trace: getTraceId(),
            span: getSpanId(),
            ctx: getTraceContext(),
          })),
        ),
      ),
    );
    expect(seen.map((s) => s.trace)).toEqual(["job-TESTTRACE01", "job-TESTTRACE01"]);
    expect(seen.every((s) => s.ctx?.businessId === "b1")).toBe(true);
    expect(seen[0]!.span).toMatch(/^span-/);
    expect(seen[0]!.span).not.toBe(seen[1]!.span);
  });

  it("does not leak the span past its callback", () => {
    withTraceContext({ traceId: "job-TESTTRACE02" }, () => {
      withSpan(() => undefined);
      expect(getSpanId()).toBeUndefined();
    });
  });

  it("mints a trace outside one, so the span is never orphaned", () => {
    const seen = withSpan(() => ({ trace: getTraceId(), span: getSpanId() }));
    expect(seen.trace).toMatch(/^trace-/);
    expect(seen.span).toMatch(/^span-/);
  });

  it("an attempt's later call joins the caller's trace under the attempt's span", () => {
    const ctx = withTraceContext({ traceId: "api-TESTTRACE03" }, () => spanContext("pi-ATTEMPT1"));
    expect(ctx).toMatchObject({ traceId: "api-TESTTRACE03", spanId: "pi-ATTEMPT1" });
  });

  it("ensureSpan keeps an active span and opens one when there is none", () => {
    withTraceContext({ traceId: "job-TESTTRACE04" }, () => {
      const outer = withSpan(() => ({ span: getSpanId(), inner: ensureSpan(() => getSpanId()) }));
      expect(outer.inner).toBe(outer.span);
      expect(ensureSpan(() => getSpanId())).toMatch(/^span-/);
    });
  });

  it("joinSpan files a later call under the record's span, in the current trace", () => {
    const seen = withTraceContext({ traceId: "job-TESTTRACE05" }, () =>
      joinSpan("span-CHARGE1", () => ({ trace: getTraceId(), span: getSpanId() })),
    );
    expect(seen).toEqual({ trace: "job-TESTTRACE05", span: "span-CHARGE1" });
  });
});
