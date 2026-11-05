/**
 * Fastify `clientErrorHandler`: requests the HTTP parser refuses before any route runs
 * (an unknown method, a malformed request line, oversized headers, a timeout). Same
 * `{error:{type,message}}` envelope as every other response; no parser detail.
 */
import http from "node:http";
import type { Duplex } from "node:stream";

export function clientErrorResponse(code: string | undefined): { status: number; body: string } {
  const [status, message] =
    code === "ERR_HTTP_REQUEST_TIMEOUT"
      ? [408, "The request took too long to arrive."]
      : code === "HPE_HEADER_OVERFLOW"
        ? [431, "The request headers are too large."]
        : [400, "The server cannot read this request."];
  return { status, body: JSON.stringify({ error: { type: "invalid_request_error", message } }) };
}

export function clientErrorHandler(err: Error & { code?: string }, socket: Duplex): void {
  // A reset socket is already gone; nothing to answer.
  if (err.code === "ECONNRESET" || socket.destroyed) return;
  if (socket.writable) {
    const { status, body } = clientErrorResponse(err.code);
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n${body}`,
    );
  }
  socket.destroy(err);
}
