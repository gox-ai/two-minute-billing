import Link from "next/link";
import { type DifferentialPrice, type Product } from "@/lib/api";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";

/**
 * Differential-pricing overview: one row per applicable plan
 * with a count of prices already set and a "View Price →" link into that plan's
 * grid (?plan=). The searchable modal in the card header is the other entry
 * point; both land on the same per-plan grid.
 */
export function DifferentialOverview({
  biz,
  addon,
  plans,
  rows,
}: {
  biz: string;
  addon: Product;
  /** Plans this addon/charge can attach to (union of applicable + already-set). */
  plans: Array<{ id: string; name: string }>;
  rows: DifferentialPrice[];
}) {
  const baseUrl = `/businesses/${biz}/catalog/products/${addon.id}`;
  const countFor = (planId: string) => rows.filter((r) => r.plan === planId).length;

  if (plans.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This {addon.kind ?? "item"} does not apply to a plan yet. Add it to a plan first. Then you
        can set a plan-specific price here.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Plan</TableHead>
          <TableHead>Prices set</TableHead>
          <TableHead className="text-right" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {plans.map((p) => {
          const n = countFor(p.id);
          return (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>
                {n > 0 ? (
                  <span className="text-muted-foreground tabular-nums">
                    {n} price{n !== 1 ? "s" : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60">Not set</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                <Link
                  href={`${baseUrl}?plan=${encodeURIComponent(p.id)}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View Price →
                </Link>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
