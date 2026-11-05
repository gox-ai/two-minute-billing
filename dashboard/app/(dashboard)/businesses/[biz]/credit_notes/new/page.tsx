import { billingRules } from "@/lib/billing-rules";
import { listBusinesses } from "@/lib/api";
import { requirePermission } from "@/lib/session";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/states";
import { CreateCreditNoteForm } from "@/components/credit-notes/create-form";
import { loadCreditableInvoiceAction } from "../actions";

export const dynamic = "force-dynamic";

// Create a credit note. Reads ?invoice=<id> to preselect; otherwise the form searches
// for the invoice server-side. The backend enforces per-kind eligibility.
export default async function NewCreditNotePage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ invoice?: string }>;
}) {
  const { biz } = await params;
  const { invoice: preselect } = await searchParams;
  await requirePermission("credit_notes:manage", "manager");

  let businesses;
  try {
    businesses = await listBusinesses();
  } catch (e) {
    return (
      <>
        <PageHeader
          title="New Credit Note"
          breadcrumbs={[
            { label: "Businesses", href: "/" },
            { label: biz, href: `/businesses/${biz}` },
            { label: "Credit Notes", href: `/businesses/${biz}/credit_notes` },
            { label: "New" },
          ]}
        />
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </>
    );
  }

  const name = businesses.data.find((b) => b.id === biz)?.name ?? biz;
  const preselected = preselect ? await loadCreditableInvoiceAction(biz, preselect) : null;

  const crumbs = [
    { label: name, href: `/businesses/${biz}` },
    { label: "Credit Notes", href: `/businesses/${biz}/credit_notes` },
    { label: "New credit note" },
  ];

  return (
    <CreateCreditNoteForm
      biz={biz}
      preselected={preselected?.status === "voided" ? null : preselected}
      crumbs={crumbs}
      reasonCodeRequired={
        billingRules(businesses.data.find((b) => b.id === biz)).required_reasons.create_credit_note
      }
    />
  );
}
