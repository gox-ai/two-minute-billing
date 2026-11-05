import Link from "next/link";
import { FileText } from "lucide-react";
import { requirePermission } from "@/lib/session";
import { ErrorState, EmptyState } from "@/components/states";
import { buttonVariants } from "@/components/ui/button";
import { StatusChip } from "@/components/patterns/chip";
import { ActionButton } from "@/components/action-button";
import { SettingsCard, SettingsPage } from "@/components/settings/settings-layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { listDunningPolicies, type DunningPolicy } from "@/lib/api/dunning-policies";
import { listProducts } from "@/lib/api";
import { getBusiness } from "@/lib/api/business-settings";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import { SelectField } from "@/components/ui/select-field";
import { archiveDunningPolicyAction, savePlanDunningPoliciesAction } from "./actions";

export const dynamic = "force-dynamic";

// Settings → Dunning → Policies. A bounded config list, so it is read whole.
export default async function DunningPoliciesPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ include_archived?: string }>;
}) {
  const [{ biz }, sp] = await Promise.all([params, searchParams]);
  await requirePermission("dunning_policies:view", "admin");
  const showArchived = sp.include_archived === "true";

  let policies: DunningPolicy[];
  try {
    policies = (await listDunningPolicies(biz, { includeArchived: showArchived })).data;
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }

  // Plan assignments (2.48). Non-critical: without them the policy list still renders.
  const [business, plans] = await Promise.all([
    getBusiness(biz).catch(() => undefined),
    listProducts(biz)
      .then((r) => r.data.filter((p) => (p.kind ?? "plan") === "plan"))
      .catch(() => null),
  ]);
  const planPolicies = business?.dunning_config?.plan_policies ?? {};
  const live = policies.filter((p) => !p.archived);

  const base = `/businesses/${biz}/settings`;
  const listHref = `${base}/dunning/policies`;

  return (
    <SettingsPage
      title="Dunning policies"
      crumbs={[
        { label: "Settings", href: base },
        { label: "Dunning", href: `${base}/dunning` },
        { label: "Policies" },
      ]}
      description="A policy is a named set of dunning settings. Assign it to a customer or to a plan to use it in place of the business dunning settings. A customer’s policy comes before its plan’s. Customers that are excluded from dunning stay excluded."
      actions={
        <Link href={`${listHref}/new`} className={buttonVariants({ size: "sm" })}>
          Create policy
        </Link>
      }
    >
      <SettingsCard
        title={showArchived ? "All policies" : "Policies"}
        meta={`${policies.length} ${policies.length === 1 ? "policy" : "policies"}`}
        actions={
          <Link
            href={showArchived ? listHref : `${listHref}?include_archived=true`}
            className="text-primary hover:underline"
          >
            {showArchived ? "Hide archived policies" : "Show archived policies"}
          </Link>
        }
      >
        {policies.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title="No dunning policies"
            description="Every customer uses the business dunning settings. Create a policy to use different settings for some customers."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead className="text-right">Customers</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-5 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="pl-5 whitespace-normal">
                    <Link
                      href={`${listHref}/${p.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.description ? (
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                    ) : null}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{p.code}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.customer_count}</TableCell>
                  <TableCell>
                    <StatusChip status={p.archived ? "archived" : "active"} />
                  </TableCell>
                  <TableCell className="pr-5 text-right">
                    {p.archived ? null : (
                      <ActionButton
                        resultAction={archiveDunningPolicyAction}
                        fields={{ biz, dpol: p.id }}
                        label="Archive"
                        variant="ghost"
                        size="sm"
                        confirm={{
                          title: `Archive ${p.name}?`,
                          description:
                            p.customer_count > 0
                              ? `${p.customer_count} ${p.customer_count === 1 ? "customer uses" : "customers use"} this policy. We cannot archive a policy while customers use it. Change their dunning policy first.`
                              : "You cannot assign an archived policy to a customer. The policy stays in this list when you show archived policies.",
                          confirmLabel: "Archive",
                        }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SettingsCard>

      {plans && plans.length > 0 ? (
        <SettingsCard title="Plans" meta="A policy for every subscription on a plan">
          <ActionForm action={savePlanDunningPoliciesAction}>
            <input type="hidden" name="biz" value={biz} />
            {business?.resource_version != null ? (
              <input type="hidden" name="expected_version" value={business.resource_version} />
            ) : null}
            <p className="m-0 px-5 pt-4 text-sm text-muted-foreground">
              An invoice uses its customer&rsquo;s policy first. If the customer has no policy, it
              uses the policy of its subscription&rsquo;s plan. If the plan has no policy, it uses
              the business dunning settings.
            </p>
            <ul className="m-0 flex list-none flex-col divide-y p-0">
              {plans.map((plan) => {
                const current = planPolicies[plan.id] ?? "";
                const options = [
                  { value: "", label: "No policy (business settings)" },
                  ...live.map((p) => ({ value: p.id, label: p.name })),
                  ...(current && !live.some((p) => p.id === current)
                    ? [{ value: current, label: `${current} (archived)` }]
                    : []),
                ];
                return (
                  <li
                    key={plan.id}
                    className="grid grid-cols-1 items-center gap-x-4 gap-y-1.5 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_16rem]"
                  >
                    <div className="min-w-0">
                      <p className="m-0 text-sm font-medium">{plan.name}</p>
                      <p className="m-0 font-mono text-xs text-muted-foreground">{plan.id}</p>
                    </div>
                    <SelectField
                      name={`plan_policy:${plan.id}`}
                      ariaLabel={`Dunning policy for ${plan.name}`}
                      defaultValue={current}
                      options={options}
                    />
                  </li>
                );
              })}
            </ul>
            <div className="flex justify-end border-t px-5 py-3">
              <SubmitButton size="sm">Save plan policies</SubmitButton>
            </div>
          </ActionForm>
        </SettingsCard>
      ) : null}
    </SettingsPage>
  );
}
