/**
 * `payments.metadata` key marking money a gateway captured that no invoice took.
 * A leaf module: `transactions/service` reads it at load time, and importing it from
 * `settlement` closed an import cycle (`stale-pending` failed to load on its own).
 */
export const UNAPPLIED_CAPTURE_KEY = "unapplied_gateway_capture";
