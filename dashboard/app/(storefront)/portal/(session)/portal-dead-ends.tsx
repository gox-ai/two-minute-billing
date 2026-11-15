import type { ReactNode } from "react";
import { Clock, LifeBuoy, LogOut } from "lucide-react";
import { portalLinkNotice, type PortalLinkNotice } from "@/lib/portal-api";
import { readPortalBusiness } from "@/lib/storefront-session";
import { SafeHtml } from "@/components/safe-html";
import { BrandTheme, NoticeCard, StorefrontHeader } from "../../chrome";
import { EmailCodeSignIn } from "./email-code-sign-in";

const NOTICE_HTML =
  "[&_a]:text-primary [&_a]:underline [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_ol]:list-inside [&_ol]:list-decimal [&_p]:my-2 [&_ul]:list-inside [&_ul]:list-disc";

/** A website for display: no scheme, no trailing slash. */
function siteLabel(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "");
}

/** A link only for an http(s) address: the value is the merchant's, not ours. */
function safeSite(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * "Contact <business>" with its support email and website, when the business set them.
 * Renders nothing when neither is set.
 */
export function PortalContact({
  name,
  supportEmail,
  website,
  className = "mt-3",
}: {
  name: string;
  supportEmail?: string | null;
  website?: string | null;
  className?: string;
}) {
  const site = safeSite(website);
  if (!supportEmail && !site) return null;
  return (
    <p className={`m-0 text-sm text-muted-foreground ${className}`}>
      Contact {name}:{" "}
      {supportEmail ? (
        <a
          href={`mailto:${supportEmail}`}
          className="font-medium whitespace-nowrap text-primary hover:underline"
        >
          {supportEmail}
        </a>
      ) : null}
      {supportEmail && site ? " · " : null}
      {site ? (
        <a
          href={site}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium whitespace-nowrap text-primary hover:underline"
        >
          {siteLabel(site)}
        </a>
      ) : null}
    </p>
  );
}

function branded(notice: PortalLinkNotice | null, card: ReactNode) {
  if (!notice) return card;
  return (
    <BrandTheme brand={notice.business}>
      <div className="flex flex-col gap-4 sm:gap-5">
        <StorefrontHeader brand={notice.business} eyebrow="Billing portal" />
        {card}
      </div>
    </BrandTheme>
  );
}

/**
 * No session. `link`: the buyer just opened a link the engine refused. `session`: a session
 * ended, or a dead link reached us another way. With no business known, the visitor
 * opened no link we can name, so the card says where links come from.
 */
export async function ExpiredCard({
  business,
  reason = "session",
}: {
  business?: string | null;
  reason?: "link" | "session";
}) {
  const biz = business ?? (await readPortalBusiness());
  const notice = biz ? await portalLinkNotice(biz) : null;
  const name = notice?.business.name ?? null;
  const codeOn = !!biz && !!notice?.email_code;
  const title = codeOn
    ? "Sign in to manage your billing"
    : reason === "link"
      ? "This link is not valid or is expired"
      : name
        ? "Your billing session ended"
        : "Open your billing link";
  const text = codeOn
    ? reason === "link"
      ? "This link is not valid or is expired. Sign in with your email to continue."
      : "Sign in with your email to continue."
    : name
      ? `To open your billing account, ask ${name} for a new link.`
      : "To manage your billing, open the link in the latest email from the business that bills you. If the link does not work, ask the business for a new link.";
  return branded(
    notice,
    <NoticeCard icon={codeOn ? <LifeBuoy /> : <Clock />} title={title}>
      {notice?.message_html ? (
        <SafeHtml html={notice.message_html} className={NOTICE_HTML} />
      ) : (
        <p className="m-0">{text}</p>
      )}
      {codeOn ? <EmailCodeSignIn business={biz!} heading={false} /> : null}
      {name ? (
        <PortalContact
          name={name}
          supportEmail={notice?.business.support_email}
          website={notice?.business.website}
          className="mt-4"
        />
      ) : null}
    </NoticeCard>,
  );
}

/** Right after "Sign out": the buyer chose to leave, so no word of expiry. */
export async function SignedOutCard() {
  const biz = await readPortalBusiness();
  const notice = biz ? await portalLinkNotice(biz) : null;
  const codeOn = !!biz && !!notice?.email_code;
  const name = notice?.business.name ?? null;
  return branded(
    notice,
    <NoticeCard icon={<LogOut />} title="You are signed out">
      <p className="m-0">
        {codeOn
          ? "Your billing session ended. To return, sign in with your email."
          : name
            ? `Your billing session ended. To return, ask ${name} for a new link.`
            : "Your billing session ended. To return, ask for a new link."}
      </p>
      {codeOn ? <EmailCodeSignIn business={biz!} /> : null}
      {name ? (
        <PortalContact
          name={name}
          supportEmail={notice?.business.support_email}
          website={notice?.business.website}
          className="mt-4"
        />
      ) : null}
    </NoticeCard>,
  );
}
