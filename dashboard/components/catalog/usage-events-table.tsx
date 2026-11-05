import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { fmtDateTime } from "@/lib/format";
import type { UsageEvent } from "@/lib/api/meters";

const FLAG_LABEL: Record<string, string> = {
  no_meter: "No meter",
  currency_mismatch: "Currency is different from the price",
};

/** A page of usage events, as the list API returns them. */
export function UsageEventsTable({
  biz,
  events,
  tz,
  valueProperty,
}: {
  biz: string;
  events: UsageEvent[];
  tz?: string | null;
  /** The meter's value property, shown in its own column. */
  valueProperty?: string | null;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-5">Event time</TableHead>
          <TableHead>Customer</TableHead>
          {valueProperty ? <TableHead className="text-right">{valueProperty}</TableHead> : null}
          <TableHead>Properties</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-5">Key</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e) => {
          const rest = Object.entries(e.properties ?? {}).filter(([k]) => k !== valueProperty);
          return (
            <TableRow key={e.id}>
              <TableCell className="pl-5 tabular-nums">
                <span className="flex flex-col">
                  <span>{fmtDateTime(e.timestamp, tz)}</span>
                  <span className="text-xs text-muted-foreground">
                    Received {fmtDateTime(e.created_at, tz)}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                {e.customer ? (
                  <Link
                    href={`/businesses/${biz}/customers/${e.customer}`}
                    className="font-mono text-xs text-primary hover:underline"
                  >
                    {e.customer}
                  </Link>
                ) : null}
                {/* A usage key that is the customer id is shown once. */}
                {e.customer_key !== e.customer ? (
                  <div className="font-mono text-xs wrap-anywhere text-muted-foreground">
                    {e.customer_key}
                  </div>
                ) : null}
              </TableCell>
              {valueProperty ? (
                <TableCell className="text-right font-mono text-xs tabular-nums">
                  {e.properties?.[valueProperty] != null
                    ? String(e.properties[valueProperty])
                    : "—"}
                </TableCell>
              ) : null}
              <TableCell className="max-w-80 font-mono text-xs wrap-anywhere whitespace-normal">
                {rest.length ? rest.map(([k, v]) => `${k}=${String(v)}`).join(" · ") : "—"}
              </TableCell>
              <TableCell>
                <span className="flex flex-wrap gap-1">
                  <StatusChip status={e.status} />
                  {e.flags.map((f) => (
                    <Chip key={f} tone="tan">
                      {FLAG_LABEL[f] ?? f.replace(/_/g, " ")}
                    </Chip>
                  ))}
                </span>
              </TableCell>
              <TableCell className="max-w-56 pr-5 font-mono text-xs wrap-anywhere whitespace-normal">
                {e.key}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
