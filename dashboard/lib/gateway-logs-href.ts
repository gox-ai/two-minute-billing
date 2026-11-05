/**
 * The gateway request log for one record: its span when it has one (one collection or one
 * attempt, which can cross requests), else its whole trace (rows written before spans).
 */
export function gatewayLogsHref(
  biz: string,
  r: { trace_id: string | null; span_id?: string | null },
): string | null {
  const base = `/businesses/${biz}/gateway_requests`;
  if (r.span_id) return `${base}?span_id=${encodeURIComponent(r.span_id)}`;
  if (r.trace_id) return `${base}?trace_id=${encodeURIComponent(r.trace_id)}`;
  return null;
}
