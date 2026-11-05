import { Chip, StatusChip } from "@/components/patterns/chip";

/** Webhook delivery status. `delivered` is healthy, which the shared status map does not know. */
export function DeliveryStatusChip({ status }: { status: string | null | undefined }) {
  if ((status ?? "").toLowerCase() === "delivered") return <Chip tone="green">Delivered</Chip>;
  return <StatusChip status={status} />;
}
