import { allows, requirePermission } from "@/lib/session";
import { listBusinesses } from "@/lib/api";
import {
  IMPORT_ENTITIES,
  currentImportRunId,
  getImportRun,
  getTemplateFields,
  type ImportEntity,
  type ImportRun,
  type TemplateField,
} from "@/lib/api/imports";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { ImportTabs, importTabOf } from "@/components/imports/ImportTabs";
import { ImportPageClient } from "@/components/imports/ImportPageClient";
import { ImportHistory } from "@/components/imports/ImportHistory";
import { ExportPanel } from "@/components/exports/ExportPanel";
import { getExportRun, listExportRuns, type ExportRun } from "@/lib/api/exports";
import {
  deleteExportAction,
  getExportAction,
  listExportsAction,
  previewExportAction,
  startExportAction,
  discardImportAction,
  getImportAction,
  listImportRowsAction,
  listImportsAction,
  recheckImportAction,
  startImportAction,
  undoImportAction,
} from "./actions";

export const dynamic = "force-dynamic";

const TITLE = "Import and export data";

/**
 * Import and export data, three URL tabs (`?tab=files|history|export`).
 *
 * Import files: upload one CSV per section (or the migration JSON file), check, review, then
 * import as a background job; undo until the first billing activity. `?run=<id>` names the
 * import on screen; `?section=<entity>` marks the section a list's Import button opened.
 * Past imports: every import of this business, newest first.
 * Export data: every record type as CSV files in the import's columns, in the background;
 * `?export=<id>` names the export on screen (the link in the email), `?section=` preselects one.
 */
export default async function ImportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{
    run?: string | string[];
    export?: string | string[];
    section?: string;
    tab?: string;
  }>;
}) {
  const { biz } = await params;
  const sp = await searchParams;
  const tab = importTabOf(sp.tab);
  const user = await requirePermission(tab === "export" ? "exports:view" : "imports:view", "admin");
  const canManage = allows(user, tab === "export" ? "exports:manage" : "imports:manage", "admin");
  const tabs = [
    ...(allows(user, "imports:view", "admin") ? (["files", "history"] as const) : []),
    ...(allows(user, "exports:view", "admin") ? (["export"] as const) : []),
  ];

  let businesses;
  try {
    businesses = (await listBusinesses()).data ?? [];
  } catch (e) {
    return (
      <>
        <PageHeader title="Import and export data" breadcrumbs={[{ label: TITLE }]} />
        <ErrorState description={(e as Error).message} />
      </>
    );
  }
  const business = businesses.find((b) => b.id === biz);
  if (!business)
    return (
      <>
        <PageHeader title="Import and export data" breadcrumbs={[{ label: TITLE }]} />
        <ErrorState description="We could not find this business. Select a business, then try again." />
      </>
    );
  const breadcrumbs = [{ label: business.name, href: `/businesses/${biz}` }, { label: TITLE }];

  const header = (
    <>
      <PageHeader
        title="Import and export data"
        description={
          tab === "export" ? (
            <>
              Export the records of <span className="font-medium">{business.name}</span> as CSV
              files in the columns the import reads.
            </>
          ) : (
            <>
              Import plans, customers, saved cards, subscriptions and their history from CSV files
              into <span className="font-medium">{business.name}</span>.
            </>
          )
        }
        breadcrumbs={breadcrumbs}
      />
      <div className="mb-5">
        <ImportTabs biz={biz} active={tab} show={[...tabs]} />
      </div>
    </>
  );

  if (tab === "history")
    return (
      <>
        {header}
        <ImportHistory biz={biz} listAction={listImportsAction} />
      </>
    );

  // The fields each column can be imported as, for the column mapping (and the export's help).
  const fields: Partial<Record<ImportEntity, TemplateField[]>> = {};
  await Promise.all(
    IMPORT_ENTITIES.map(async (e) => {
      try {
        fields[e] = (await getTemplateFields(biz, e)).fields;
      } catch {
        /* The mapping is read-only without it. */
      }
    }),
  );

  const focus = IMPORT_ENTITIES.includes(sp.section as ImportEntity)
    ? (sp.section as ImportEntity)
    : null;

  if (tab === "export") {
    // The export in the URL, else this business's newest one if it is still running.
    let initialExport: ExportRun | null = null;
    const id = typeof sp.export === "string" ? sp.export : null;
    try {
      if (id) initialExport = await getExportRun(biz, id);
      else {
        const newest = (await listExportRuns(biz)).data[0];
        if (newest && (newest.status === "queued" || newest.status === "running"))
          initialExport = newest;
      }
    } catch {
      initialExport = null;
    }
    return (
      <>
        {header}
        <ExportPanel
          biz={biz}
          business={business}
          canManage={canManage}
          focus={focus}
          initialRun={initialExport}
          fields={fields}
          actions={{
            previewAction: previewExportAction,
            startAction: startExportAction,
            getAction: getExportAction,
            listAction: listExportsAction,
            deleteAction: deleteExportAction,
          }}
        />
      </>
    );
  }

  // The import in the URL, else this business's open one. A stale id shows the form.
  let initialRun: ImportRun | null = null;
  const runParam = typeof sp.run === "string" ? sp.run : null;
  try {
    const id = runParam ?? (await currentImportRunId(biz));
    initialRun = id ? await getImportRun(biz, id) : null;
  } catch {
    initialRun = null;
  }

  return (
    <>
      {header}
      <ImportPageClient
        biz={biz}
        business={business}
        canManage={canManage}
        initialRun={initialRun}
        focus={focus}
        fields={fields}
        explainer={EXPLAINER}
        actions={{
          getAction: getImportAction,
          listRowsAction: listImportRowsAction,
          recheckAction: recheckImportAction,
          startAction: startImportAction,
          undoAction: undoImportAction,
          discardAction: discardImportAction,
        }}
      />
    </>
  );
}

/** What the import takes and leaves, under "Show what is imported". */
const EXPLAINER = (
  <div className="space-y-2 rounded-md bg-muted/50 p-4 text-sm">
    <p className="font-medium">What the import adds</p>
    <ul className="list-inside list-disc space-y-1 text-muted-foreground">
      <li>
        <span className="font-medium text-foreground">Plans and add-ons</span>: their flat, per-unit
        and tiered prices
      </li>
      <li>
        <span className="font-medium text-foreground">Coupons</span>: percentage and fixed-amount
        coupons with their codes
      </li>
      <li>
        <span className="font-medium text-foreground">Customers</span>: contacts, addresses, tax IDs
        and references to cards saved at your payment gateway. Card numbers are never in the file.
      </li>
      <li>
        <span className="font-medium text-foreground">Subscriptions</span>: items, coupons, trials
        and the current term. They renew on their current term end.
      </li>
    </ul>
    <p className="mt-3 font-medium">History, if you add it</p>
    <ul className="list-inside list-disc space-y-1 text-muted-foreground">
      <li>
        <span className="font-medium text-foreground">Invoices</span>: paid, open and void, with
        their lines, tax and discount. An open invoice is owed, and nothing collects it unless you
        turn on collection for the import.
      </li>
      <li>
        <span className="font-medium text-foreground">Credit notes</span>: the credit a customer can
        still use becomes credit on the customer.
      </li>
      <li>
        <span className="font-medium text-foreground">Payments and refunds</span>: with the invoice
        they paid.
      </li>
      <li>
        <span className="font-medium text-foreground">Usage</span>: of a usage price that is on a
        subscription.
      </li>
    </ul>
    <p className="mt-3 font-medium">What the import does not do</p>
    <p className="text-muted-foreground">
      It does not charge customers, and it sends no emails or webhooks for imported records. It does
      not change a record that is in this business already: a row with the same ID is kept as it is.
      Tax rates, payment gateway credentials, dunning rules and email templates are not imported.
      Imported invoice numbers can move your next invoice number; the review tells you before you
      start.
    </p>
    <p className="mt-3 font-medium">How the import runs</p>
    <p className="text-muted-foreground">
      “Check what changes” reads each row and shows what happens to it. Nothing changes until you
      start the import. The import then runs in the background: you can close this page. You can
      undo an import until the first renewal, payment or change on a record it added.
    </p>
  </div>
);
