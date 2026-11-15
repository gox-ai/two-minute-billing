import { requirePermission, allows } from "@/lib/session";
import { listBusinesses } from "@/lib/api";
import Link from "next/link";
import {
  currentTransferRunId,
  getTransferJob,
  getTransferRun,
  listTransferItems,
} from "@/lib/api/transfer";
import type { ItemQuery, TransferRun } from "@/lib/api/transfer";
import { PageHeader } from "@/components/page-header";
import { SettingsCard } from "@/components/settings/settings-layout";
import { Alert } from "@/components/ui/alert";
import { ErrorState } from "@/components/states";
import { TransferPageClient } from "@/components/transfer/TransferPageClient";
import { TransferHistory } from "@/components/transfer/TransferHistory";
import { TransferTabs, tabOf } from "@/components/transfer/TransferTabs";
import { seedOf, type TransferSeed } from "@/components/transfer/seed";
import {
  PLAN_BLOCKED_QUERY,
  PLAN_DEFAULT_QUERY,
  PROGRESS_DEFAULT_QUERY,
} from "@/components/transfer/plan-queries";
import { SampleDataSection } from "@/components/transfer/SampleDataSection";
import { TestDataSection } from "@/components/transfer/TestDataSection";
import { TestLimitsSummary } from "@/components/test-limits";
import { getTestLimits } from "@/lib/api/test-limits";
import {
  applyTransferAction,
  cancelTransferAction,
  excludedKeysAction,
  getRunAction,
  listItemsAction,
  listTransfersAction,
  planTransferAction,
  retryTransferAction,
  setItemsAction,
  seedSampleDataAction,
  removeSampleDataAction,
  deleteTestDataAction,
  resetTestBusinessAction,
} from "./actions";
import type { ActionResult } from "@/lib/action-result";

export const dynamic = "force-dynamic";

const TITLE = "Transfer and sample data";

/**
 * Transfer and sample data page, three URL tabs (`?tab=copy|history|test`).
 *
 * Copy set-up: plan (every item with its action), review, then apply as a background run —
 * catalog / coupons / taxes / settings / company profile / email sending from this business
 * to another. `?run=<id>` names the plan or run on screen; `?repeat=<id>` starts the form
 * from a past copy. Updating a live destination needs an owner or admin and the typed name
 * (the engine enforces both). Customers, subscriptions and invoices are NEVER transferred.
 *
 * Past copies: the run history. Test data (test businesses only): sample data, delete test
 * data, reset the test business, and the test-mode limits.
 */
export default async function TransferPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ run?: string | string[]; repeat?: string | string[]; tab?: string }>;
}) {
  const { biz } = await params;
  const sp = await searchParams;
  const tab = tabOf(sp.tab);
  const runParam = typeof sp.run === "string" ? sp.run : null;
  const repeatParam = typeof sp.repeat === "string" ? sp.repeat : null;
  const user = await requirePermission("transfers:manage", "admin");
  const canOverride = allows(user, "transfers:live_override", "admin");

  let businesses;
  try {
    const res = await listBusinesses();
    businesses = res.data ?? [];
  } catch (e) {
    return (
      <>
        <PageHeader title={TITLE} breadcrumbs={[{ label: TITLE }]} />
        <ErrorState description={(e as Error).message} />
      </>
    );
  }

  const currentBiz = businesses.find((b) => b.id === biz);
  const isTest = currentBiz?.livemode === "test";

  const breadcrumbs = currentBiz
    ? [{ label: currentBiz.name, href: `/businesses/${biz}` }, { label: TITLE }]
    : [{ label: TITLE }];

  const header = (
    <>
      <PageHeader
        title={TITLE}
        description={
          currentBiz ? (
            <>
              Copy the set-up of <span className="font-medium">{currentBiz.name}</span> to another
              business{isTest ? ", and manage its test data" : ""}.
            </>
          ) : undefined
        }
        breadcrumbs={breadcrumbs}
      />
      <div className="mb-5">
        <TransferTabs biz={biz} active={tab} />
      </div>
    </>
  );

  if (tab === "history")
    return (
      <>
        {header}
        <TransferHistory biz={biz} businesses={businesses} listAction={listTransfersAction} />
      </>
    );

  if (tab === "test") {
    const limits = isTest ? await getTestLimits(biz) : null;
    async function seedAction(
      prev: ActionResult | null,
      formData: FormData,
    ): Promise<ActionResult> {
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
    async function resetTestAction(
      prev: ActionResult | null,
      formData: FormData,
    ): Promise<ActionResult> {
      "use server";
      return resetTestBusinessAction(prev, formData);
    }
    return (
      <>
        {header}
        {isTest ? (
          <div className="grid grid-cols-1 items-start gap-5 @min-[56.875rem]/main:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-5">
              <SettingsCard title="Sample data">
                <SampleDataSection biz={biz} seedAction={seedAction} removeAction={removeAction} />
              </SettingsCard>
              <SettingsCard title="Test data">
                <TestDataSection
                  biz={biz}
                  bizName={currentBiz?.name ?? ""}
                  canReset={!!currentBiz?.live_business_id}
                  deleteAction={deleteTestAction}
                  resetAction={resetTestAction}
                />
              </SettingsCard>
            </div>
            {limits && (
              <SettingsCard title="Test mode limits">
                <TestLimitsSummary limits={limits} />
              </SettingsCard>
            )}
          </div>
        ) : (
          <Alert
            tone="neutral"
            action={
              currentBiz?.test_business_id ? (
                <Link
                  href={`/businesses/${currentBiz.test_business_id}/transfer?tab=test`}
                  className="font-medium underline"
                >
                  View the test business
                </Link>
              ) : null
            }
          >
            Sample data is available only in test mode. This is the live mode of the business.
          </Alert>
        )}
      </>
    );
  }

  // Repeat: the form starts from a past copy of this business.
  let initialSeed: TransferSeed | null = null;
  if (repeatParam) {
    try {
      const job = await getTransferJob(biz, repeatParam);
      if (job.source_business === biz) initialSeed = seedOf(job);
    } catch {
      initialSeed = null;
    }
  }

  // The run in the URL, else this business's open plan or active run. A stale id shows the form.
  // Counts only, then the first page of items: a plan can hold tens of thousands.
  let initialRun: TransferRun | null = null;
  if (!initialSeed) {
    try {
      const id = runParam ?? (await currentTransferRunId(biz));
      initialRun = id ? await getTransferRun(biz, id) : null;
    } catch {
      initialRun = null;
    }
  }
  const firstPage = async (run: TransferRun, query: ItemQuery) => {
    try {
      return { query, page: await listTransferItems(biz, run.id, query) };
    } catch {
      return null;
    }
  };
  const initialItems = !initialRun
    ? null
    : initialRun.status === "planned"
      ? {
          plan: {
            list: await firstPage(initialRun, PLAN_DEFAULT_QUERY),
            blocked: initialRun.summary.results.blocked
              ? await firstPage(initialRun, PLAN_BLOCKED_QUERY)
              : null,
          },
        }
      : initialRun.status === "superseded"
        ? null
        : { progress: await firstPage(initialRun, PROGRESS_DEFAULT_QUERY) };

  return (
    <>
      {header}
      <TransferPageClient
        key={repeatParam ?? "copy"}
        biz={biz}
        businesses={businesses}
        canOverride={canOverride}
        initialRun={initialRun}
        initialItems={initialItems}
        initialSeed={initialSeed}
        explainer={EXPLAINER}
        planAction={planTransferAction}
        getRunAction={getRunAction}
        setItemsAction={setItemsAction}
        applyAction={applyTransferAction}
        retryAction={retryTransferAction}
        cancelAction={cancelTransferAction}
        listItemsAction={listItemsAction}
        excludedKeysAction={excludedKeysAction}
      />
    </>
  );
}

/** What the copy takes and leaves, under "Show what is copied". */
const EXPLAINER = (
  <div className="space-y-2 rounded-md bg-muted/50 p-4 text-sm">
    <p className="font-medium">What the copy takes</p>
    <ul className="list-inside list-disc space-y-1 text-muted-foreground">
      <li>
        <span className="font-medium text-foreground">Catalog</span>: product groups, products,
        prices, attached items, differential prices
      </li>
      <li>
        <span className="font-medium text-foreground">Coupons</span>: coupon codes and item
        constraints
      </li>
      <li>
        <span className="font-medium text-foreground">Taxes</span>: tax profiles, regions, rate
        components and state registrations
      </li>
      <li>
        <span className="font-medium text-foreground">Settings</span>: billing behavior, such as
        payment terms, dunning, proration, cancellation and checkout fields
      </li>
      <li>
        <span className="font-medium text-foreground">Company profile</span>: address, tax
        registration number, invoice issuer, default HSN/SAC code and tax behavior
      </li>
      <li>
        <span className="font-medium text-foreground">Email sending</span>: sender details and the
        SMTP or Amazon SES settings. Passwords and secret keys are not copied: enter them in the
        destination.
      </li>
    </ul>
    <p className="mt-3 font-medium">What stays with the destination</p>
    <p className="text-muted-foreground">
      Its name, currency, invoice and credit note prefixes (unless you set new ones), checkout
      return and cancel URLs, portal error text, branding, logo, contact details, timezone, email
      templates, and the email subject prefix and footer.
    </p>
    <p className="mt-3 font-medium">What is never copied</p>
    <p className="text-muted-foreground">
      Customers, subscriptions, invoices, payments, payment gateways and their credentials, API keys
      and webhooks.
    </p>
    <p className="mt-3 font-medium">Records that are in both businesses</p>
    <p className="text-muted-foreground">
      For each section, select “Keep what is there” or “Update what is there”. A live business keeps
      what is there unless an owner or admin selects the update and types the business name to
      confirm. New records are always added.
    </p>
    <p className="mt-3 font-medium">How the copy runs</p>
    <p className="text-muted-foreground">
      “Check what changes” shows each item and what happens to it. You can leave out items. The copy
      then runs in the background, one item at a time. You can close this page and come back. If an
      item fails, the other items continue, and you can try the failed items again.
    </p>
  </div>
);
