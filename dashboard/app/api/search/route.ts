import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { listCustomers, listSubscriptions, listInvoices, type Invoice } from "@/lib/api";
import type { InvoiceExtras } from "@/lib/api/invoices";
import { accountHolderName } from "@/lib/names";

export const dynamic = "force-dynamic";

/** The list serializer emits customer identity the frozen `Invoice` type does not name. */
type InvoiceRow = Invoice & InvoiceExtras;

/** The strings a hit was found by, empties dropped. Never the query itself. */
const terms = (...vals: Array<string | null | undefined>) =>
  vals.map((v) => v?.trim()).filter((v): v is string => !!v);

/**
 * ⌘K entity search within a business: top matches across customers /
 * subscriptions / invoices by name, email or id. BFF-side so the org API key
 * never reaches the browser.
 *
 * All three searches run in SQL (each list endpoint's `q`) — filtering a default
 * first page here only ever searched the newest 50 rows. `terms` carries the raw
 * fields the engine matched against, because cmdk re-filters every rendered item
 * against its `value` and would otherwise hide a hit found by phone or company.
 */
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const biz = req.nextUrl.searchParams.get("biz");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  if (!biz || q.length < 2)
    return NextResponse.json({ customers: [], subscriptions: [], invoices: [] });

  try {
    const [customers, subscriptions, invoices] = await Promise.all([
      listCustomers(biz, { q, limit: 5 }),
      listSubscriptions(biz, undefined, { q, limit: 5 }),
      listInvoices(biz, undefined, { q, limit: 5 }),
    ]);
    return NextResponse.json({
      customers: customers.data.map((c) => ({
        id: c.id,
        label: accountHolderName(c) ?? c.email ?? c.id,
        email: c.email ?? null,
        company: c.company ?? null,
        terms: terms(c.id, c.email, c.first_name, c.last_name, c.company, c.phone),
      })),
      subscriptions: subscriptions.data.map((s) => {
        const item = s.items?.[0];
        return {
          id: s.id,
          label: item?.product_name ?? s.id,
          customer_name: s.customer_name ?? s.customer_email ?? null,
          status: s.status,
          // The first item's price for one period — what the plan costs, not the invoice.
          amount_minor:
            item?.unit_price_minor != null ? item.unit_price_minor * (item.quantity || 1) : null,
          currency: s.currency,
          interval: item?.interval ?? null,
          renews_at: s.next_billing_at ?? s.current_period_end ?? null,
          ends_at: s.cancel_at_period_end ? (s.current_period_end ?? null) : null,
          cancelled_at: s.canceled_at ?? null,
          terms: terms(
            s.id,
            s.status,
            s.customer,
            s.customer_name,
            s.customer_company,
            s.customer_email,
            item?.product_name,
          ),
        };
      }),
      invoices: (invoices.data as InvoiceRow[]).map((i) => ({
        id: i.id,
        label: i.number ?? i.id,
        customer_name: i.customer_name ?? i.customer_email ?? null,
        status: i.status,
        amount_minor: i.total_minor,
        currency: i.currency,
        due_date: i.due_date ?? null,
        date: i.created_at ?? null,
        terms: terms(i.id, i.number, i.status, i.customer, i.customer_name, i.customer_email),
      })),
    });
  } catch {
    return NextResponse.json({ customers: [], subscriptions: [], invoices: [] });
  }
}
