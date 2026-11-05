import { requirePermission, allows } from "@/lib/session";
import { listBusinesses } from "@/lib/api";
import { getTransferJob } from "@/lib/api/transfer";
import type { TransferJob } from "@/lib/api/transfer";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/states";
import { TransferPageClient } from "@/components/transfer/TransferPageClient";
import { SampleDataSection } from "@/components/transfer/SampleDataSection";
import { TestDataSection } from "@/components/transfer/TestDataSection";
import { TestLimitsSummary } from "@/components/test-limits";
import { getTestLimits } from "@/lib/api/test-limits";
import {
  listTransfersAction,
  previewTransferAction,
  runTransferAction,
  seedSampleDataAction,
  removeSampleDataAction,
  deleteTestDataAction,
} from "./actions";
import type { ActionResult } from "@/lib/action-result";

export const dynamic = "force-dynamic";

/**
 * Transfer Configurations + Sample Data page.
 *
 * Transfer section: preview, then copy catalog / coupons / taxes / settings / company
 * profile / email sending from this business to another. A live destination is merge-only
 * unless an owner or admin applies the live override (the engine enforces it).
 * Customers, subscriptions, and invoices are NEVER transferred.
 *
 * Sample data section (test businesses only): seed / remove demo records.
 */
export default async function TransferPage({ params }: { params: Promise<{ biz: string }> }) {
  const { biz } = await params;
  const user = await requirePermission("transfers:manage", "admin");
  const canOverride = allows(user, "transfers:live_override", "admin");

  let businesses;
  try {
    const res = await listBusinesses();
    businesses = res.data ?? [];
  } catch (e) {
    return (
      <>
        <PageHeader title="Transfer & Sample Data" breadcrumbs={[{ label: "Transfer" }]} />
        <ErrorState description={(e as Error).message} />
      </>
    );
  }

  const currentBiz = businesses.find((b) => b.id === biz);

  // Server action wrapper for fetchJob — passed as a server action to the client
  async function fetchJobAction(jobId: string): Promise<TransferJob | null> {
    "use server";
    try {
      return await getTransferJob(biz, jobId);
    } catch {
      return null;
    }
  }

  async function seedAction(prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
    "use server";
    return seedSampleDataAction(prev, formData);
  }

  async function removeAction(
    prev: ActionResult | null,
    formData: FormData,
  ): Promise<ActionResult> {
    "use server";
    return removeSampleDataAction(prev, formData);
  }

  async function deleteTestAction(
    prev: ActionResult | null,
    formData: FormData,
  ): Promise<ActionResult> {
    "use server";
    return deleteTestDataAction(prev, formData);
  }

  const isTest = currentBiz?.livemode === "test";
  const limits = isTest ? await getTestLimits(biz) : null;

  const breadcrumbs = currentBiz
    ? [{ label: currentBiz.name, href: `/businesses/${biz}` }, { label: "Transfer & Sample Data" }]
    : [{ label: "Transfer & Sample Data" }];

  return (
    <>
      <PageHeader
        title="Transfer & Sample Data"
        description={<span className="font-mono text-xs">{biz}</span>}
        breadcrumbs={breadcrumbs}
      />

      <div className="space-y-6">
        <TransferPageClient
          biz={biz}
          currentBizId={biz}
          businesses={businesses}
          canOverride={canOverride}
          explainer={
            <div className="space-y-2 rounded-md bg-muted/50 p-4 text-sm">
              <p className="font-medium">What the copy takes</p>
              <ul className="list-inside list-disc space-y-1 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Catalog</span>: product groups,
                  products, prices, attached items, differential prices
                </li>
                <li>
                  <span className="font-medium text-foreground">Coupons</span>: coupon codes and
                  item constraints
                </li>
                <li>
                  <span className="font-medium text-foreground">Taxes</span>: tax profiles, regions,
                  rate components and state registrations
                </li>
                <li>
                  <span className="font-medium text-foreground">Settings</span>: billing behavior,
                  such as payment terms, dunning, proration, cancellation and checkout fields
                </li>
                <li>
                  <span className="font-medium text-foreground">Company profile</span>: address, tax
                  registration number, invoice issuer, default HSN/SAC code and tax behavior
                </li>
                <li>
                  <span className="font-medium text-foreground">Email sending</span>: sender details
                  and the SMTP or Amazon SES settings. Secrets are copied but never shown.
                </li>
              </ul>
              <p className="mt-3 font-medium">What stays with the destination</p>
              <p className="text-muted-foreground">
                Its name, currency, invoice and credit note prefixes (unless you set new ones),
                checkout return and cancel URLs, portal error text, branding, logo, contact details,
                timezone, email templates, and the email subject prefix and footer.
              </p>
              <p className="mt-3 font-medium">What is never copied</p>
              <p className="text-muted-foreground">
                Customers, subscriptions, invoices, payments, payment gateways and their
                credentials, API keys and webhooks.
              </p>
              <p className="mt-3 font-medium">Live destinations</p>
              <p className="text-muted-foreground">
                The copy adds new records to a live business and does not change records that exist.
                To also change its settings, company profile, email sending, numbering and tax
                profiles, an owner or admin selects “Also update what is there”.
              </p>
            </div>
          }
          previewAction={previewTransferAction}
          runAction={runTransferAction}
          fetchJob={fetchJobAction}
          listAction={listTransfersAction}
        />

        {/* ── Sample Data (test businesses only) ───────────────────── */}
        {isTest && (
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Sample data
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <SampleDataSection biz={biz} seedAction={seedAction} removeAction={removeAction} />
            </CardContent>
          </Card>
        )}

        {isTest && (
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground">Test data</CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <TestDataSection biz={biz} deleteAction={deleteTestAction} />
            </CardContent>
          </Card>
        )}

        {limits && (
          <Card>
            <CardHeader className="border-b">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Test mode limits
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-4">
              <TestLimitsSummary limits={limits} />
            </CardContent>
          </Card>
        )}

        {!isTest && currentBiz && (
          <p className="text-xs text-muted-foreground">
            Sample data is available only in test mode. This is the live mode of the business.
          </p>
        )}
      </div>
    </>
  );
}
