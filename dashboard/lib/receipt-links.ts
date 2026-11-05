/** The receipt PDF, proxied server-side so the session never leaves the dashboard. Plain module: server and client both call it. */
export const receiptPdfHref = (biz: string, rcpt: string) =>
  `/businesses/${biz}/receipts/${rcpt}/pdf`;
