import { Chip } from "@/components/patterns/chip";
import type { OrderStatus } from "@/lib/api/orders";

/** The values of `order_status` in the engine (`src/modules/invoicing/orders.ts`). */
export const STATUS_OPTIONS: Array<{ value: OrderStatus; label: string }> = [
  { value: "paid", label: "Paid" },
  { value: "due", label: "Due" },
  { value: "refunded", label: "Refunded" },
  { value: "partly_refunded", label: "Partly refunded" },
];

export const STATUS_VIEW: Record<OrderStatus, { label: string; tone: "green" | "tan" | "gray" }> = {
  paid: { label: "Paid", tone: "green" },
  due: { label: "Due", tone: "tan" },
  // A refund is a finished state, so it stays neutral.
  refunded: { label: "Refunded", tone: "gray" },
  partly_refunded: { label: "Partly refunded", tone: "gray" },
};

export function OrderStatusChip({ status }: { status: OrderStatus }) {
  const v = STATUS_VIEW[status] ?? STATUS_VIEW.due;
  return (
    <Chip tone={v.tone} className="whitespace-nowrap">
      {v.label}
    </Chip>
  );
}
