import Script from "next/script";
import { CONSENT_COOKIE, CONSENT_COUNTRIES } from "@/lib/analytics";

/**
 * GA4 on the sign-up pages, with the website's consent defaults: ads storage off everywhere,
 * analytics off in the consent countries until accepted, and the visitor's saved choice (the
 * cookie the website shares) applied before gtag.js loads. Rendered only by the sign-up layout.
 */
export function SignupAnalytics({ id }: { id?: string }) {
  if (!id) return null;
  const init = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}var m=document.cookie.match(/(?:^|; )${CONSENT_COOKIE}=(granted|denied)/);var d={ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'};gtag('consent','default',Object.assign({analytics_storage:'denied',region:${JSON.stringify(CONSENT_COUNTRIES)}},d));gtag('consent','default',Object.assign({analytics_storage:'granted'},d));if(m)gtag('consent','update',{analytics_storage:m[1]});gtag('js',new Date());gtag('config','${id}');`;
  return (
    <>
      <Script id="ga-init" strategy="afterInteractive">
        {init}
      </Script>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${id}`}
        strategy="afterInteractive"
      />
    </>
  );
}
