import { listBusinesses, PUBLIC_API_URL, publicApiReachable } from "@/lib/api";
import { businessCurrencyOptions } from "@/lib/business-currencies";
import {
  getGatewayAccount,
  getDefaultGatewayAccountId,
  getGatewayWebhookEndpoint,
  getGatewayCatalog,
  getGatewayBalance,
  type GatewayWebhookEndpoint,
} from "@/lib/api/gateways";
import { gatewayEntry, methodTypeLabel } from "@/components/gateways/gateway-meta";
import { CopyButton } from "@/components/patterns/copy-button";
import { LOGO_SIZE, PartnerLogo } from "@/components/partner-logo";
import { requirePermission } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import { ErrorState } from "@/components/states";
import { Alert } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { Chip, IdChip, ChipRow } from "@/components/patterns/chip";
import { ActionForm } from "@/components/form/action-form";
import { SubmitButton } from "@/components/form/submit-button";
import {
  SettingRow,
  SettingsCard,
  SettingsColumns,
  SettingsPage,
  SettingsSummary,
  type AttentionItem,
} from "@/components/settings/settings-layout";
import { CredentialFields } from "@/components/gateways/credential-fields";
import { GatewayDetailActions } from "@/components/gateways/gateway-detail-actions";
import { GatewaySettingsFields } from "@/components/gateways/gateway-settings-fields";
import { GatewayWebhookCard } from "@/components/gateways/gateway-webhook-card";
import { WalletDomainCard } from "@/components/gateways/wallet-domain-card";
import { fmtDateTime, money } from "@/lib/format";
import {
  updateGatewayAccountAction,
  rotateCredentialsAction,
  verifyGatewayAccountAction,
  setDefaultGatewayAction,
  deleteGatewayAccountAction,
  provisionWebhookEndpointAction,
  registerWalletDomainAction,
  revealWebhookSecretAction,
  saveWebhookSecretAction,
} from "../actions";

export const dynamic = "force-dynamic";

/** Gateway account detail: edit, rotate credentials, verify, set default, delete, webhooks. */
export default async function GatewayDetailPage({
  params,
}: {
  params: Promise<{ biz: string; gwa: string }>;
}) {
  const { biz, gwa } = await params;
  await requirePermission("gateways:view", "admin");

  const listHref = `/businesses/${biz}/settings/gateways`;
  const baseCrumbs = [
    { label: "Settings", href: `/businesses/${biz}/settings` },
    { label: "Payment gateways", href: listHref },
  ];
  let businesses, account, defaultId: string | null, catalog;
  try {
    [businesses, account, defaultId, catalog] = await Promise.all([
      listBusinesses(),
      getGatewayAccount(biz, gwa),
      getDefaultGatewayAccountId(biz),
      getGatewayCatalog(),
    ]);
  } catch (e) {
    return (
      <SettingsPage title="Gateway account" crumbs={[...baseCrumbs, { label: "Account" }]}>
        <ErrorState
          description={<span className="font-mono text-xs">{(e as Error).message}</span>}
        />
      </SettingsPage>
    );
  }
  // Non-fatal: an older API without this route falls back to the static instructions.
  let webhookEndpoint: GatewayWebhookEndpoint | null = null;
  // Non-fatal too: the balance is advice, and most gateways have none to read.
  const [endpointResult, balance] = await Promise.all([
    getGatewayWebhookEndpoint(biz, gwa).catch(() => null),
    getGatewayBalance(biz, gwa).catch(() => null),
  ]);
  webhookEndpoint = endpointResult;
  const business = businesses.data.find((b) => b.id === biz) ?? null;
  const tz = business?.timezone ?? null;
  const isDefault = defaultId !== null && defaultId === account.id;
  const entry = gatewayEntry(catalog, account.gateway_key);
  const gatewayName = entry?.display_name ?? account.gateway_key;
  const credentialFields = entry?.credential_fields ?? [];
  const hasCredentialFields = credentialFields.length > 0;
  // FALLBACK only — must match `gatewayNotificationUrl` in src/providers/notification-url.ts:
  // the PUBLIC base (never the internal API_URL), the account in `?id=` or, for a gateway
  // that refuses a query string, in the path.
  const notificationUrl =
    `${PUBLIC_API_URL}/v1/gateway_webhooks/${encodeURIComponent(account.gateway_key)}` +
    (entry?.webhook_account_id_in_path
      ? `/${encodeURIComponent(account.id)}`
      : `?id=${encodeURIComponent(account.id)}`);
  const webhookPending =
    webhookEndpoint != null &&
    webhookEndpoint.mode !== "not_applicable" &&
    !webhookEndpoint.configured;

  const attention: AttentionItem[] = [];
  if (account.status === "disabled")
    attention.push({
      key: "disabled",
      tone: "warning",
      title: "This account is disabled",
      detail:
        "We route no payments here, and we refuse its webhooks. Payment methods saved on it go to another account, which usually cannot charge them.",
      actions: (
        <a href="#settings" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Change status
        </a>
      ),
    });
  else if (webhookPending)
    attention.push({
      key: "webhook",
      tone: "warning",
      title: "Webhook not configured",
      detail: `We reject events that ${gatewayName} sends for this account until you configure the webhook.`,
      actions: (
        <a href="#webhooks" className={buttonVariants({ variant: "outline", size: "sm" })}>
          Configure webhook
        </a>
      ),
    });

  const summary = (
    <>
      <SettingsSummary
        title="This account"
        items={[
          { label: "Status", value: <StatusBadge status={account.status} /> },
          {
            label: "Default gateway",
            value: isDefault ? "Yes. It takes a charge that more than one account can take" : "No",
          },
          {
            label: "Currencies",
            value:
              account.international_enabled === false && entry?.international_domestic_currency
                ? `${entry.international_domestic_currency} only. International payments are off`
                : account.currencies?.length
                  ? account.currencies.join(", ")
                  : entry?.currencies
                    ? `Every currency that ${entry.display_name} takes`
                    : "Every currency",
          },
          {
            label: "Payment methods",
            value: account.method_types?.length
              ? account.method_types
                  .map((m) => methodTypeLabel(catalog, account.gateway_key, m))
                  .join(", ")
              : "Any this gateway supports",
          },
          {
            label: "Credentials",
            value: hasCredentialFields ? "Stored encrypted · never shown" : "None needed",
          },
          webhookEndpoint &&
            webhookEndpoint.mode !== "not_applicable" && {
              label: "Webhook",
              value:
                webhookEndpoint.mode === "url_only"
                  ? "Uses your API keys"
                  : webhookEndpoint.configured
                    ? webhookEndpoint.mode === "self_provisioned"
                      ? `Registered with ${gatewayName}`
                      : webhookEndpoint.mode === "secret_in"
                        ? "Secret saved"
                        : "Secret generated"
                    : "Not configured",
            },
          { label: "Created", value: fmtDateTime(account.created_at, tz) },
        ]}
      />
      <div className="border-t px-5 py-4">
        <GatewayDetailActions
          isDefault={isDefault}
          label={account.label}
          listHref={listHref}
          verify={verifyGatewayAccountAction.bind(null, biz, gwa)}
          setDefault={setDefaultGatewayAction.bind(null, biz, gwa)}
          destroy={deleteGatewayAccountAction.bind(null, biz, gwa)}
        />
      </div>
    </>
  );

  return (
    <SettingsPage
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PartnerLogo brand={account.gateway_key} name={gatewayName} {...LOGO_SIZE.title} fit />
          <span className="min-w-0 wrap-anywhere">{account.label}</span>
        </span>
      }
      crumbs={[...baseCrumbs, { label: account.label }]}
      description={
        <ChipRow className="mt-1">
          <Chip>{gatewayName}</Chip>
          <Chip
            tone={account.livemode ? "green" : "tan"}
            className="text-xs font-bold tracking-wide uppercase"
          >
            {account.livemode ? "Live" : "Test"}
          </Chip>
          {isDefault ? (
            <Badge variant="outline" className="border-primary/40 text-primary">
              Default
            </Badge>
          ) : null}
          <IdChip id={account.id} />
        </ChipRow>
      }
      attention={attention}
    >
      <SettingsColumns summary={summary}>
        {balance?.supported ? (
          <SettingsCard id="balance" title="Balance" meta={`Read from ${gatewayName}`} padded>
            {!balance.available ? (
              <Alert tone="info" title={`We cannot read the ${gatewayName} balance.`}>
                {balance.message}
              </Alert>
            ) : balance.balances.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">
                {gatewayName} returned no balance for this account.
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="overflow-x-auto rounded-xl border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Currency</TableHead>
                        <TableHead className="text-right">Available</TableHead>
                        <TableHead className="text-right">Withheld</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {balance.balances.map((b) => (
                        <TableRow key={b.currency}>
                          <TableCell className="font-medium">{b.currency}</TableCell>
                          <TableCell className="text-right">
                            {money(b.available_minor, b.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            {money(b.withheld_minor, b.currency)}
                          </TableCell>
                          <TableCell className="text-right">
                            {money(b.total_minor, b.currency)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                <p className="m-0 text-sm text-muted-foreground">
                  {gatewayName} pays refunds from the available balance.
                  {balance.as_of
                    ? ` ${gatewayName} updated these figures on ${fmtDateTime(balance.as_of, tz)}.`
                    : ""}
                </p>
              </div>
            )}
          </SettingsCard>
        ) : null}
        <ActionForm action={updateGatewayAccountAction}>
          <input type="hidden" name="biz" value={biz} />
          <input type="hidden" name="gwa" value={gwa} />
          <SettingsCard
            id="settings"
            title="Settings"
            meta="Routing for this account"
            footer={
              <div className="flex justify-end py-1.5">
                <SubmitButton>Save changes</SubmitButton>
              </div>
            }
          >
            <GatewaySettingsFields
              account={account}
              methodTypes={entry?.method_types ?? []}
              currencyOptions={business ? businessCurrencyOptions(business) : null}
              gateway={entry}
            />
          </SettingsCard>
        </ActionForm>

        {hasCredentialFields ? (
          <ActionForm action={rotateCredentialsAction} resetOnSuccess>
            <input type="hidden" name="biz" value={biz} />
            <input type="hidden" name="gwa" value={gwa} />
            <input type="hidden" name="gateway_key" value={account.gateway_key} />
            <SettingsCard
              id="credentials"
              title="Credentials"
              meta="Write-only"
              footer={
                <div className="flex justify-end py-1.5">
                  <SubmitButton variant="outline">Rotate credentials</SubmitButton>
                </div>
              }
            >
              <SettingRow
                label="Rotate"
                help="We encrypt stored credentials, and nobody can view them. Enter new values to replace the stored set."
                control={<CredentialFields fields={credentialFields} />}
              />
            </SettingsCard>
          </ActionForm>
        ) : (
          <SettingsCard id="credentials" title="Credentials" padded>
            <p className="m-0 text-sm text-muted-foreground">
              The {gatewayName} requires no credentials. There is nothing to rotate.
            </p>
          </SettingsCard>
        )}

        {/* Only a gateway that registers wallet domains; the API answers 409 for the others. */}
        {entry?.wallet_domains ? (
          <SettingsCard title="Apple Pay & Google Pay" meta="Storefront domain" padded>
            <WalletDomainCard
              gatewayName={gatewayName}
              register={registerWalletDomainAction.bind(null, biz, gwa)}
            />
          </SettingsCard>
        ) : null}

        <SettingsCard id="webhooks" title="Webhooks" meta={`Events from ${gatewayName}`} padded>
          {webhookEndpoint ? (
            <GatewayWebhookCard
              gatewayName={gatewayName}
              endpoint={webhookEndpoint}
              provision={provisionWebhookEndpointAction.bind(null, biz, gwa)}
              reveal={revealWebhookSecretAction.bind(null, biz, gwa)}
              saveSecret={saveWebhookSecretAction.bind(null, biz, gwa)}
            />
          ) : (
            <div className="flex flex-col gap-4">
              {publicApiReachable ? (
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="notification_url" className="text-sm font-semibold">
                    Notification URL
                  </label>
                  <div className="flex max-w-xl items-center gap-2">
                    <Input
                      id="notification_url"
                      readOnly
                      value={notificationUrl}
                      className="font-mono text-xs"
                    />
                    <CopyButton value={notificationUrl} className="size-8 shrink-0 border" />
                  </div>
                  <p className="m-0 text-sm text-muted-foreground">
                    Configure this URL in your {gatewayName} dashboard so gateway events reach
                    tmbilling.
                  </p>
                </div>
              ) : (
                // No copyable field without a reachable URL: a loopback address would
                // look like it worked and silently receive nothing.
                <Alert tone="warning">
                  This deployment has no public API URL configured, so we cannot show the
                  Notification URL. Set{" "}
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                    TMBILLING_PUBLIC_API_URL
                  </code>{" "}
                  on the dashboard to the origin where this API is reachable.
                </Alert>
              )}
              <ol className="m-0 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                {(entry?.webhook_instructions ?? []).map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </SettingsCard>
      </SettingsColumns>
    </SettingsPage>
  );
}
