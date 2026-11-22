// Needs attention on the organization overview. Server-only: every row is a fact an existing
// API call already returns, and it links to the screen where the person acts on it.
import { listPrices, type Business } from "@/lib/api";
import { listGatewayAccounts, type GatewayAccount } from "@/lib/api/gateways";
import { fetchQueueCounts, queueItems } from "@/lib/attention-queues";
import { getOrganizationSecurity } from "@/lib/org-security";
import { allows, type SessionUser } from "@/lib/session";
import type { PermissionKey } from "@/lib/permissions.generated";
import { fmtDate } from "@/lib/format-date";
import { money } from "@/lib/format";
import { plural } from "@/lib/labels";
import type { CardInfo } from "@/components/analytics/card-info";
import { G } from "@/components/analytics/glossary";
import { ok, splitByKey } from "@/components/analytics/org/conversion";
import type { Answers } from "@/components/overview/totals";

export type AttentionKind =
  | "unpaid"
  | "dispute"
  | "receivables"
  | "pending"
  | "email"
  | "gateway"
  | "catalog"
  | "security";

export interface AttentionRow {
  key: string;
  kind: AttentionKind;
  /** `attention` needs action now; `warning` blocks something later. */
  tone: "attention" | "warning";
  title: string;
  /** The business it belongs to; absent for an organization or account row. */
  business?: string;
  detail?: string;
  info?: CardInfo;
  /** Where the person acts, first action first. */
  actions: Array<{ href: string; label: string }>;
}

/**
 * Urgency: money that cannot be collected first, then money owed and at risk, then what will
 * fail soon, then what blocks billing, then sign-in. A 2FA requirement with a deadline locks
 * the member out, so it sits with the urgent rows.
 */
const RANK: Record<AttentionKind, number> = {
  unpaid: 1,
  dispute: 3,
  receivables: 5,
  pending: 7,
  email: 8,
  gateway: 9,
  catalog: 10,
  security: 11,
};
const REQUIRED_2FA_RANK = 4;

/** Mirrors `handlesCurrency` in `src/modules/gateway/router.ts` (and `lib/setup-readiness.ts`). */
function handlesCurrency(account: GatewayAccount, currency: string): boolean {
  if (account.currencies == null) return true;
  const want = currency.toUpperCase();
  return account.currencies.some((c) => c.toUpperCase() === want);
}

/** "respond by 20 Nov 2026" → "Respond by 20 Nov 2026." */
const sentence = (s: string | undefined) =>
  s ? `${s[0]!.toUpperCase()}${s.slice(1)}${s.endsWith(".") ? "" : "."}` : undefined;

/** Each queue cell of the old attention strip, as a row: its count, words and link. */
const QUEUE_ROW: Record<
  string,
  { kind: AttentionKind; title: (n: number) => string; action: string; perm: PermissionKey }
> = {
  disputes: {
    kind: "dispute",
    title: (n) => `${plural(n, "dispute")} ${n === 1 ? "needs" : "need"} a response`,
    action: "View disputes",
    perm: "payments:view",
  },
  unpaid_after_retries: {
    kind: "unpaid",
    title: (n) => `${plural(n, "invoice")} unpaid after retries`,
    action: "View invoices",
    perm: "invoices:view",
  },
  emails_not_delivered: {
    kind: "email",
    title: (n) => `${plural(n, "email")} not delivered`,
    action: "View emails",
    perm: "emails:view",
  },
  pending_invoices: {
    kind: "pending",
    title: (n) => `${plural(n, "invoice")} pending`,
    action: "View invoices",
    perm: "invoices:view",
  },
};

/**
 * Every row the signed-in member can act on. A read that fails adds no row: a guess here
 * would send someone to fix a problem that may not exist.
 */
export async function loadAttention({
  user,
  orgName,
  orgTz,
  businesses,
  answers,
}: {
  user: SessionUser;
  orgName: string;
  orgTz: string | null;
  businesses: Business[];
  /** The Metrics-basis totals. */
  answers: Answers;
}): Promise<AttentionRow[]> {
  // A permission every fixed role holds is checked by key only for a custom role.
  const any = (k: PermissionKey) => user.role !== "custom" || allows(user, k);
  const canInvoices = allows(user, "invoices:view", "ops");
  const canGateways = allows(user, "gateways:manage", "admin");
  const canCatalog = allows(user, "catalog:manage", "manager");
  const canSettings = allows(user, "settings:manage", "admin");
  const can = (k: PermissionKey) =>
    k === "invoices:view" ? canInvoices : k === "payments:view" ? allows(user, k, "ops") : any(k);

  const recvResult = ok(answers.get("recv_biz"));
  const recv = splitByKey(recvResult);
  const paying = splitByKey(ok(answers.get("paying_biz")));

  const perBusiness = await Promise.all(
    businesses.map(async (b) => {
      const base = `/businesses/${b.id}`;
      const out: AttentionRow[] = [];
      const [queues, accounts, prices] = await Promise.all([
        fetchQueueCounts(b.id),
        canGateways && b.default_currency ? listGatewayAccounts(b.id).catch(() => null) : null,
        canCatalog && !(paying.get(b.id)?.total ?? 0) ? listPrices(b.id).catch(() => null) : null,
      ]);

      // The queue cells, with the old strip's conditions, cap and links.
      for (const item of queueItems(queues, () => b.id, b.timezone ?? orgTz)) {
        const q = QUEUE_ROW[item.key];
        const n = queues[item.key as keyof typeof queues]?.count ?? 0;
        if (!q || !can(q.perm)) continue;
        out.push({
          key: `${item.key}_${b.id}`,
          kind: q.kind,
          tone: item.tone === "attention" ? "attention" : "warning",
          title: q.title(n),
          business: b.name,
          detail: sentence(item.note),
          info: item.info,
          actions: [{ href: item.href, label: q.action }],
        });
      }

      const owed = recv.get(b.id)?.total ?? 0;
      if (canInvoices && owed > 0 && recvResult?.currency)
        out.push({
          key: `recv_${b.id}`,
          kind: "receivables",
          tone: "warning",
          title: `${money(owed, recvResult.currency)} in unpaid invoices`,
          business: b.name,
          info: G.receivables,
          actions: [{ href: `${base}/invoices?segment=unpaid`, label: "View unpaid invoices" }],
        });

      // What stops this business billing. Two gaps share one row, with an action for each.
      const setup: Array<{
        kind: AttentionKind;
        title: string;
        detail?: string;
        actions: Array<{ href: string; label: string }>;
      }> = [];
      if (accounts && b.default_currency) {
        const cur = b.default_currency;
        const matching = accounts.data.filter(
          (a) => a.status === "active" && handlesCurrency(a, cur),
        );
        if (matching.length === 0)
          setup.push({
            kind: "gateway",
            title: `No gateway charges ${cur}`,
            detail: "Connect a payment gateway before you bill customers.",
            actions: [{ href: `${base}/settings/gateways/new`, label: "Add gateway" }],
          });
        else if (matching.length > 1 && !matching.some((a) => a.default))
          setup.push({
            kind: "gateway",
            title: "No default gateway",
            detail: `${matching.length} gateway accounts charge ${cur}. Charges fail until one is the default.`,
            actions: [{ href: `${base}/settings/gateways`, label: "Select default" }],
          });
      }
      // Not ready only with no active price at all: a plan or a charge can bill a customer.
      if (prices && !prices.data.some((p) => p.active !== false))
        setup.push({
          kind: "catalog",
          title: "No price",
          detail: "Create a plan or a charge before you bill customers.",
          actions: [
            { href: `${base}/catalog/plans/new`, label: "Create plan" },
            { href: `${base}/catalog/charges/new`, label: "Create charge" },
          ],
        });
      if (setup.length > 0)
        out.push({
          key: `setup_${b.id}`,
          kind: setup[0]!.kind,
          tone: "warning",
          title: setup.length === 1 ? setup[0]!.title : "Not ready to bill",
          business: b.name,
          detail: setup.length === 1 ? setup[0]!.detail : setup.map((x) => `${x.title}.`).join(" "),
          actions: setup.flatMap((x) => x.actions),
        });
      return out;
    }),
  );

  const security: AttentionRow[] = [];
  const orgTfa = user.organization_two_factor;
  const s = await getOrganizationSecurity();
  const ownOff = orgTfa?.required ? !orgTfa.satisfied : s ? !s.caller_has_two_factor : false;
  if (ownOff)
    security.push({
      key: "own_2fa",
      kind: "security",
      tone: orgTfa?.required ? "attention" : "warning",
      title: "Two-factor authentication is off for your account",
      detail:
        orgTfa?.required && orgTfa.deadline_day
          ? `${orgName} requires it. Enable it by ${fmtDate(orgTfa.deadline_day, "UTC")}.`
          : orgTfa?.required
            ? `${orgName} requires it.`
            : "Enable it to protect your sign-in.",
      actions: [{ href: "/account#two-factor", label: "Enable 2FA" }],
    });
  // Only a member who can change the setting is shown it. Turning it on needs their own 2FA.
  if (canSettings && s && !s.require_two_factor && s.caller_has_two_factor)
    security.push({
      key: "org_2fa",
      kind: "security",
      tone: "warning",
      title: "Members can sign in without two-factor authentication",
      detail: `${s.members_with_two_factor} of ${plural(s.members, "member")} use 2FA.`,
      actions: [{ href: "/settings/security", label: "View security settings" }],
    });

  const rank = (r: AttentionRow) =>
    r.key === "own_2fa" && r.tone === "attention" ? REQUIRED_2FA_RANK : RANK[r.kind];
  // Stable within a rank, so each business's rows keep the business order.
  return [...perBusiness.flat(), ...security].sort((a, z) => rank(a) - rank(z));
}
