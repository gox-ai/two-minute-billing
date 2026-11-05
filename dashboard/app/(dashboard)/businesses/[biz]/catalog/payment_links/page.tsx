import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { listPrices, listProducts } from "@/lib/api";
import { listPaymentLinks, type PaymentLink } from "@/lib/api/payment-links";
import { paymentLinkPriceOptions } from "@/lib/payment-link-options";
import { PageHeader } from "@/components/page-header";
import { EmptyState, ErrorState } from "@/components/states";
import { Chip, StatusChip } from "@/components/patterns/chip";
import { CopyButton } from "@/components/patterns/copy-button";
import { ActionButton } from "@/components/action-button";
import { PaymentLinkDialog } from "@/components/catalog/payment-link-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { updatePaymentLinkAction } from "./actions";

export const dynamic = "force-dynamic";

/** A buy button a merchant pastes into their website: a plain link, no script. */
function buyButtonHtml(link: PaymentLink): string {
  const label = link.mode === "create" ? "Subscribe" : "Buy";
  return `<a href="${link.url}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#2563eb;color:#fff;font:600 15px system-ui,sans-serif;text-decoration:none">${label}</a>`;
}

export default async function PaymentLinksPage({
  params,
  searchParams,
}: {
  params: Promise<{ biz: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  await requirePermission("payments:view", "manager");
  const { biz } = await params;
  const { archived } = await searchParams;
  const showArchived = archived === "1";

  let links: PaymentLink[];
  let picker: ReturnType<typeof paymentLinkPriceOptions>;
  try {
    const [l, prices, products] = await Promise.all([
      listPaymentLinks(biz, { includeArchived: showArchived }),
      listPrices(biz),
      listProducts(biz),
    ]);
    links = l.data;
    picker = paymentLinkPriceOptions(prices.data, products.data);
  } catch (e) {
    return (
      <ErrorState description={<span className="font-mono text-xs">{(e as Error).message}</span>} />
    );
  }
  const productName = new Map(picker.options.map((o) => [o.value, String(o.group ?? "")]));
  // The pricing page lives on the storefront host, the same one the links use.
  const storefront = links.find((l) => l.url)?.url?.replace(/\/buy\/[^/]+$/, "") ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Payment links"
        description="Reusable links for your website. Any visitor can open one, and each visitor gets their own checkout."
        breadcrumbs={[
          { label: "Product Catalog", href: `/businesses/${biz}/catalog/plans` },
          { label: "Payment links" },
        ]}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            {storefront ? (
              <a
                href={`${storefront}/pricing/${biz}`}
                target="_blank"
                rel="noreferrer"
                className="text-sm text-primary hover:underline"
              >
                View pricing page
              </a>
            ) : null}
            <Link
              href={`/businesses/${biz}/catalog/payment_links${showArchived ? "" : "?archived=1"}`}
              className="text-sm text-primary hover:underline"
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </Link>
            <PaymentLinkDialog biz={biz} options={picker.options} meta={picker.meta} />
          </div>
        }
      />
      <div className="overflow-hidden rounded-xl border bg-card">
        {links.length === 0 ? (
          <EmptyState
            title="No payment links yet"
            description="Create a payment link, then put it on your website as a buy button."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Sells</TableHead>
                <TableHead className="text-right">Opens</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead>Link</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{l.name}</span>
                      {l.active ? null : <StatusChip status="archived" />}
                      {l.show_on_pricing_page ? <Chip>On pricing page</Chip> : null}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {l.mode === "create" ? "Subscription" : "One-time purchase"}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {[...new Set(l.items.map((i) => productName.get(i.price) ?? i.price))].join(
                      ", ",
                    )}
                  </TableCell>
                  <TableCell className="text-right">{l.opens}</TableCell>
                  <TableCell className="text-right">{l.completions}</TableCell>
                  <TableCell>
                    {l.url ? (
                      <div className="flex flex-col gap-1 text-xs">
                        <span className="flex items-center gap-1">
                          <span className="max-w-56 truncate font-mono">{l.url}</span>
                          <CopyButton value={l.url} />
                        </span>
                        <span className="flex items-center gap-1 text-muted-foreground">
                          Buy button HTML
                          <CopyButton value={buyButtonHtml(l)} />
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Set the storefront address to get a link
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {l.active ? (
                        <ActionButton
                          resultAction={updatePaymentLinkAction}
                          fields={{
                            biz,
                            id: l.id,
                            field: "show_on_pricing_page",
                            value: String(!l.show_on_pricing_page),
                          }}
                          label={
                            l.show_on_pricing_page
                              ? "Hide from pricing page"
                              : "Show on pricing page"
                          }
                          size="sm"
                        />
                      ) : null}
                      <ActionButton
                        resultAction={updatePaymentLinkAction}
                        fields={{ biz, id: l.id, field: "active", value: String(!l.active) }}
                        label={l.active ? "Archive" : "Restore"}
                        size="sm"
                        {...(l.active
                          ? {
                              confirm: {
                                title: "Archive this payment link?",
                                description:
                                  "Visitors who open it see that it is not available. Checkouts already started can still finish. You can restore it later.",
                                confirmLabel: "Archive",
                              },
                            }
                          : {})}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
