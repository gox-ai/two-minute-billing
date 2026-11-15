/**
 * One chip system. `StatusBadge` drew a dot beside the label while `StatusChip` did not,
 * so "Active" looked like two different marks on neighbouring screens. The vocabulary
 * that only this file knew (ops, deliveries) now lives in `patterns/chip.tsx`.
 */
export { StatusChip as StatusBadge } from "@/components/patterns/chip";
