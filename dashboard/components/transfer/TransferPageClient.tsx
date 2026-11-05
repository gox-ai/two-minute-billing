"use client";

import * as React from "react";
import type { Business } from "@/lib/api";
import type {
  TransferHistoryPage,
  TransferJob,
  TransferRequest,
  TransferPreview,
} from "@/lib/api/transfer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TransferForm, type TransferSeed } from "./TransferForm";
import { TransferJobCard } from "./TransferJobCard";
import { TransferHistory } from "./TransferHistory";

interface TransferPageClientProps {
  biz: string;
  currentBizId: string;
  businesses: Business[];
  canOverride: boolean;
  /** What the copy takes and leaves; shown on request. */
  explainer: React.ReactNode;
  previewAction: (
    biz: string,
    body: TransferRequest,
  ) => Promise<{ ok: true; preview: TransferPreview } | { ok: false; message: string }>;
  runAction: (
    biz: string,
    body: TransferRequest,
  ) => Promise<{ ok: boolean; job?: TransferJob; message?: string }>;
  fetchJob: (jobId: string) => Promise<TransferJob | null>;
  listAction: (
    biz: string,
    scope: "business" | "organization",
    cursor?: string,
  ) => Promise<TransferHistoryPage | null>;
}

export function TransferPageClient({
  biz,
  currentBizId,
  businesses,
  canOverride,
  explainer,
  previewAction,
  runAction,
  fetchJob,
  listAction,
}: TransferPageClientProps) {
  const [job, setJob] = React.useState<TransferJob | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [seed, setSeed] = React.useState<TransferSeed | null>(null);
  // A new key remounts the form, so it starts from the seed.
  const [formKey, setFormKey] = React.useState(0);
  const [historyKey, setHistoryKey] = React.useState(0);
  const [showExplainer, setShowExplainer] = React.useState(false);
  const formRef = React.useRef<HTMLDivElement>(null);

  const names = React.useCallback(
    (id: string) => businesses.find((b) => b.id === id)?.name ?? id,
    [businesses],
  );

  function handleJob(j: TransferJob) {
    setJob(j);
    setHistoryKey((k) => k + 1);
  }

  async function handleRefresh() {
    if (!job) return;
    setRefreshing(true);
    try {
      const updated = await fetchJob(job.id);
      if (updated) setJob(updated);
    } finally {
      setRefreshing(false);
    }
  }

  function repeat(j: TransferJob) {
    const n = j.options?.numbering;
    setSeed({
      dest: j.destination_business,
      sections: j.sections,
      invoicePrefix: n?.invoicePrefix,
      creditNotePrefix: n?.creditNotePrefix,
      withTwins: !!j.options?.include_test_twins,
    });
    setJob(null);
    setFormKey((k) => k + 1);
    formRef.current?.scrollIntoView({ block: "start" });
  }

  return (
    <div className="space-y-6">
      <Card ref={formRef}>
        <CardHeader className="border-b">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base font-medium">Copy set-up</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setShowExplainer((v) => !v)}>
              {showExplainer ? "Hide what is copied" : "Show what is copied"}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Copy configuration from this business to another business in this organization.
            Customers, subscriptions, invoices and payments are never copied.
          </p>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          {showExplainer && explainer}
          {job ? (
            <TransferJobCard
              job={job}
              names={names}
              onRefresh={handleRefresh}
              refreshing={refreshing}
              onDone={() => {
                setJob(null);
                setSeed(null);
                setFormKey((k) => k + 1);
              }}
            />
          ) : (
            <TransferForm
              key={formKey}
              biz={biz}
              currentBizId={currentBizId}
              businesses={businesses}
              canOverride={canOverride}
              seed={seed}
              previewAction={previewAction}
              runAction={runAction}
              onJob={handleJob}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b">
          <CardTitle className="text-base font-medium">Past copies</CardTitle>
        </CardHeader>
        <CardContent className="pt-5">
          <TransferHistory
            biz={biz}
            names={names}
            refreshKey={historyKey}
            listAction={listAction}
            onRepeat={repeat}
          />
        </CardContent>
      </Card>
    </div>
  );
}
