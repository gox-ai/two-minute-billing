import Link from "next/link";
import type { ConnectedHubSpot, HubSpotConflict } from "@/lib/api/hubspot";
import { listHubSpotConflicts } from "@/lib/api/hubspot";
import { fmtDateTime } from "@/lib/format";
import { businessTz } from "@/lib/business-tz-server";
import { RecordCard } from "@/components/patterns/record-page";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { resolveHubSpotConflictAction } from "@/app/(dashboard)/businesses/[biz]/integrations/hubspot/actions-conflicts";

const LIMIT = 100;
const REMOTE_LABEL: Record<HubSpotConflict["remote_type"], string> = {
  contact: "Contact",
  company: "Company",
  deal: "Deal",
};

function Resolve({
  biz,
  id,
  keep,
  label,
}: {
  biz: string;
  id: string;
  keep: "ours" | "theirs";
  label: string;
}) {
  return (
    <ActionForm action={resolveHubSpotConflictAction}>
      <input type="hidden" name="biz" value={biz} />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="keep" value={keep} />
      <SubmitButton size="sm" variant="outline">
        {label}
      </SubmitButton>
    </ActionForm>
  );
}

const shown = (v: string | null) =>
  v === null || v === "" ? <span className="text-muted-foreground">blank</span> : v;

/** Records changed on both sides under the `flag` rule. Renders nothing when there are none. */
export async function ConflictsSection({ biz }: { biz: string; hs: ConnectedHubSpot }) {
  const [page, tz] = await Promise.all([
    listHubSpotConflicts(biz, { limit: LIMIT }).catch(() => null),
    businessTz(biz),
  ]);
  if (!page || page.data.length === 0) return null;

  return (
    <RecordCard
      title="Conflicts"
      meta={`${page.has_more ? `${LIMIT}+` : page.data.length} to resolve`}
      flush
    >
      <p className="px-5 pt-4 text-sm text-muted-foreground">
        These records changed here and in HubSpot between syncs. Neither side syncs until you select
        which version to keep.
        {page.has_more
          ? ` This list shows the oldest ${LIMIT}. The others appear when you resolve these.`
          : null}
      </p>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Record</TableHead>
              <TableHead>In HubSpot</TableHead>
              <TableHead>What differs (ours → HubSpot&apos;s)</TableHead>
              <TableHead>Detected</TableHead>
              <TableHead className="text-right">Keep</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.data.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-mono text-xs">
                  {c.local_id ? (
                    <Link
                      className="text-primary hover:underline"
                      href={`/businesses/${biz}/${c.local_type === "customer" ? "customers" : "subscriptions"}/${c.local_id}`}
                    >
                      {c.local_id}
                    </Link>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-sm">
                  {REMOTE_LABEL[c.remote_type]}{" "}
                  <span className="font-mono text-xs text-muted-foreground">{c.remote_id}</span>
                </TableCell>
                <TableCell className="text-sm">
                  <ul className="space-y-1">
                    {c.fields.map((f) => (
                      <li key={f.field}>
                        <span className="font-medium">{f.label}:</span> {shown(f.ours)} →{" "}
                        {shown(f.theirs)}
                      </li>
                    ))}
                  </ul>
                </TableCell>
                <TableCell className="text-sm whitespace-nowrap">
                  {fmtDateTime(c.detected_at, tz)}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Resolve biz={biz} id={c.id} keep="ours" label="Keep ours" />
                    <Resolve biz={biz} id={c.id} keep="theirs" label="Keep HubSpot's" />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </RecordCard>
  );
}
