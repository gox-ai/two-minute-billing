<script setup lang="ts">
/**
 * Terms of Service for Two Minute Billing Cloud and this website. Plan facts follow the pricing
 * page and its FAQ; the self-hosted edition follows /open-source. Change them together, and move
 * UPDATED when the text changes.
 */
import MkPageHero from "~/components/marketing/MkPageHero.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const UPDATED = "11 November 2026";

const sections = [
  { id: "agreement", title: "Agreement to these terms" },
  { id: "cloud-and-self-hosted", title: "Cloud and self-hosted" },
  { id: "accounts", title: "Accounts" },
  { id: "gateway", title: "Your payment gateway" },
  { id: "your-customers", title: "Your customers" },
  { id: "plans", title: "Plans and the billing limit" },
  { id: "fees", title: "Fees and payment" },
  { id: "cancellation", title: "Cancellation" },
  { id: "refunds", title: "Refunds" },
  { id: "access", title: "Access to the Service" },
  { id: "links", title: "Links to other websites" },
  { id: "trademarks", title: "Trademarks" },
  { id: "termination", title: "Termination" },
  { id: "warranties", title: "No warranties" },
  { id: "liability", title: "Limit of liability" },
  { id: "indemnity", title: "Indemnity" },
  { id: "governing-law", title: "Governing law" },
  { id: "changes", title: "Changes to these terms" },
  { id: "contact", title: "Contact us" },
];

useMarketingSeo({
  title: "Terms of Service",
  description:
    "The terms for Two Minute Billing Cloud and our website: accounts, plans and the billing limit, fees, cancellation, refunds, and governing law.",
  og: {
    headline: "Terms of Service",
    title: "Two Minute Billing Terms of Service",
    description: "Accounts, plans, fees, cancellation, refunds and governing law for our Cloud.",
  },
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Legal"
      title="Terms of Service"
      description="The terms for using Two Minute Billing Cloud and our website: your account, your plan, payment, cancellation and refunds. Please read them before you use the Service."
      :primary="{ label: 'Privacy Policy', to: '/privacy' }"
      :secondary="{ label: 'Pricing', to: '/pricing' }"
      :note="`Last updated ${UPDATED}`"
    />

    <UContainer class="py-14 lg:py-20">
      <div class="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-16">
        <nav aria-label="On this page" class="lg:sticky lg:top-[calc(6rem+var(--mk-campaign-h))] lg:self-start">
          <p class="mk-label">On this page</p>
          <ol class="mt-3 grid gap-1 text-sm max-lg:grid-cols-2 max-lg:gap-x-6">
            <li v-for="s in sections" :key="s.id">
              <a :href="`#${s.id}`" class="legal-toc">{{ s.title }}</a>
            </li>
          </ol>
        </nav>

        <article class="legal">
          <section>
            <h2 :id="sections[0]!.id">{{ sections[0]!.title }}</h2>
            <p>
              These Terms of Service ("Terms") apply to Two Minute Billing Cloud and the website
              twominutebilling.com (together, the "Service"). Neelanadhi Private Limited ("we",
              "us") operates the Service.
            </p>
            <p>
              These Terms apply to all visitors, users and others who use the Service. When you use
              the Service, you agree to these Terms. If you do not agree with a part of them, do not
              use the Service. Our <NuxtLink to="/privacy">Privacy Policy</NuxtLink> tells you how
              we handle data.
            </p>
          </section>

          <section>
            <h2 :id="sections[1]!.id">{{ sections[1]!.title }}</h2>
            <p>
              These Terms cover the Cloud service that we host for you. The
              <NuxtLink to="/open-source">open-source edition</NuxtLink> that you run on your own
              servers is under its licence: the AGPL-3.0 for the engine, the dashboard and the docs,
              and the MIT licence for the API client. That licence, not these Terms, applies to the
              software you run yourself.
            </p>
          </section>

          <section>
            <h2 :id="sections[2]!.id">{{ sections[2]!.title }}</h2>
            <p>
              When you create an account, give information that is accurate, complete and current,
              and keep it current. If you do not, you break these Terms, and we can close your
              account immediately.
            </p>
          </section>

          <section>
            <h2 :id="sections[3]!.id">{{ sections[3]!.title }}</h2>
            <p>
              The Service charges your customers through your own payment gateway account, such as
              Stripe, Razorpay or PayPal. Your gateway collects the payments and stores the cards.
              The money goes to your gateway account. We never hold your money, and card numbers
              never reach our servers.
            </p>
            <p>
              Your agreement with your gateway, including its fees, is between you and your gateway.
              The same applies to other services you connect, such as an integration, your own email
              server or your own AI provider.
            </p>
          </section>

          <section>
            <h2 :id="sections[4]!.id">{{ sections[4]!.title }}</h2>
            <p>
              You use the Service to bill your own customers. We process their data for you, as our
              <NuxtLink to="/privacy">Privacy Policy</NuxtLink> describes. You are responsible for
              your right to give us that data, and for the prices, taxes and terms that you set for
              your customers.
            </p>
          </section>

          <section>
            <h2 :id="sections[5]!.id">{{ sections[5]!.title }}</h2>
            <ul>
              <li>
                <strong>Free plan.</strong> Free while you bill less than its limit in a month, in
                live mode, with every feature and no time limit.
              </li>
              <li>
                <strong>Paid plans.</strong> Billed monthly or yearly. Each plan has a monthly
                billing limit. The current plans and limits are on our
                <NuxtLink to="/pricing">pricing page</NuxtLink>.
              </li>
              <li>
                <strong>Billing volume.</strong> The payments you collect in live mode in a calendar
                month, less refunds, in your plan's currency. Test mode never counts.
              </li>
              <li>
                <strong>Above your limit.</strong> Your billing continues, and your customers are
                still billed. We tell you on the Billing page and ask you to change to a larger
                plan. If you stay above the limit, we can make your dashboard read-only until you
                change plan.
              </li>
              <li>
                <strong>Changing plans.</strong> You can change your plan at any time in Settings →
                Billing, within the same currency.
              </li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[6]!.id">{{ sections[6]!.title }}</h2>
            <ul>
              <li>
                <strong>Payment terms.</strong> Fees for monthly and yearly plans are due in
                advance. You pay with the methods shown when you buy or renew.
              </li>
              <li>
                <strong>Renewal.</strong> Plans renew automatically at the end of each monthly or
                yearly period.
              </li>
              <li>
                <strong>Currency.</strong> Organizations in India pay in INR, in the European Union
                in EUR, and everywhere else in USD.
              </li>
              <li>
                <strong>Taxes.</strong> Prices do not include tax. You pay all taxes that apply to
                your purchase.
              </li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[7]!.id">{{ sections[7]!.title }}</h2>
            <ul>
              <li>You can cancel your plan at any time before your next renewal date.</li>
              <li>
                To stop the charge for the next period, cancel at least one day before the current
                period ends.
              </li>
              <li>
                When you cancel before the renewal date, your plan stays active until the end of the
                current period. After that, we do not charge you again.
              </li>
              <li>
                If you do not cancel before the renewal date, your plan renews for the next period.
              </li>
            </ul>
            <p>
              To cancel, <NuxtLink to="/contact">contact us</NuxtLink>. We send you a confirmation
              when the cancellation is complete. You can start a new plan at any time. The prices
              that apply then are the current prices, not your earlier price.
            </p>
          </section>

          <section>
            <h2 :id="sections[8]!.id">{{ sections[8]!.title }}</h2>
            <ul>
              <li>
                You can ask for a refund in the first 30 days after your first payment for a paid
                plan.
              </li>
              <li>We refund the full amount of that payment.</li>
              <li>After a renewal charge is successful, that payment cannot be refunded.</li>
              <li>
                We do not refund a part of a billing period, or a cancellation after a renewal.
              </li>
            </ul>
            <p>
              To ask for a refund, <NuxtLink to="/contact">contact us</NuxtLink> with your account
              details and the reason. Look at your renewal dates and manage your plan before them,
              so that you do not get a charge you do not expect.
            </p>
          </section>

          <section>
            <h2 :id="sections[9]!.id">{{ sections[9]!.title }}</h2>
            <p>
              The Service is software that we provide online. We do not ship anything. Your access
              starts immediately when you sign up or buy a plan.
            </p>
          </section>

          <section>
            <h2 :id="sections[10]!.id">{{ sections[10]!.title }}</h2>
            <p>
              The Service can contain links to websites and services that we do not own or control.
              We are not responsible for their content, privacy policies or practices, or for any
              damage or loss caused by your use of them. Read the terms and privacy policies of each
              website or service that you visit.
            </p>
          </section>

          <section>
            <h2 :id="sections[11]!.id">{{ sections[11]!.title }}</h2>
            <p>
              The names and logos of payment gateways and other products on this website are
              trademarks of their owners. Two Minute Billing is independent. These owners do not
              endorse or sponsor us.
            </p>
          </section>

          <section>
            <h2 :id="sections[12]!.id">{{ sections[12]!.title }}</h2>
            <p>
              We can stop or suspend your access to the Service immediately, without notice or
              liability, for any reason, including if you break these Terms. When this occurs, your
              right to use the Service stops immediately.
            </p>
            <p>
              To end your account, you can stop using the Service. The parts of these Terms that by
              their nature must continue after termination continue to apply. These include the
              sections on warranties, liability, indemnity and governing law.
            </p>
          </section>

          <section>
            <h2 :id="sections[13]!.id">{{ sections[13]!.title }}</h2>
            <p>
              We provide the Service "as is" and "as available". To the extent the law permits, we
              give no warranties, express or implied. This includes warranties of merchantability,
              fitness for a particular purpose and non-infringement.
            </p>
            <p>
              We do not warrant that the Service will have no interruptions or errors. You are
              responsible for your prices, your taxes and the invoices that you send to your
              customers. Your payment gateway, not the Service, moves and holds your money.
            </p>
          </section>

          <section>
            <h2 :id="sections[14]!.id">{{ sections[14]!.title }}</h2>
            <p>
              To the extent the law permits, we are not liable for indirect, incidental, special or
              consequential damages. We are also not liable for lost profits, lost revenue, lost
              data or lost goodwill.
            </p>
            <p>
              Our total liability for all claims about the Service is limited to the fees that you
              paid us for the Service in the 12 months before the event that caused the claim.
              Nothing in these Terms limits liability that the law does not let us limit.
            </p>
          </section>

          <section>
            <h2 :id="sections[15]!.id">{{ sections[15]!.title }}</h2>
            <p>
              You agree to defend us and to pay our costs if a third party makes a claim against us
              because of your use of the Service, your breach of these Terms, or your dealings with
              your customers. This includes the data that you give us about them and the prices,
              taxes and terms that you set for them.
            </p>
          </section>

          <section>
            <h2 :id="sections[16]!.id">{{ sections[16]!.title }}</h2>
            <p>
              The laws of the British Indian Ocean Territory govern these Terms, without regard to
              conflict-of-law rules.
            </p>
            <p>
              If we do not enforce a right or a part of these Terms, we do not give up that right.
              If a court finds a part of these Terms invalid, the other parts stay in effect. These
              Terms are the full agreement between you and us about the Service, and they replace
              all earlier agreements about it.
            </p>
          </section>

          <section>
            <h2 :id="sections[17]!.id">{{ sections[17]!.title }}</h2>
            <p>
              We can change or replace these Terms at any time. For a material change, we try to
              tell you at least 30 days before the new terms start. We decide what is a material
              change. If you continue to use the Service after the new terms start, you agree to
              them. If you do not agree, stop using the Service.
            </p>
          </section>

          <section>
            <h2 :id="sections[18]!.id">{{ sections[18]!.title }}</h2>
            <p>
              For questions about these Terms, <NuxtLink to="/contact">contact us</NuxtLink> or send
              an email to <a href="mailto:support@gox.ai">support@gox.ai</a>.
            </p>
            <address>
              Neelanadhi Private Limited<br />
              1st Floor, 73, 6th Street, Y Block, Anna Nagar<br />
              Chennai, Tamil Nadu 600040<br />
              India
            </address>
          </section>
        </article>
      </div>
    </UContainer>
  </div>
</template>

<style scoped>
.legal {
  max-width: 68ch;
  color: var(--ui-text-toned);
  line-height: 1.7;
}
.legal section + section {
  margin-top: 2.75rem;
}
.legal h2 {
  scroll-margin-top: calc(6rem + var(--mk-campaign-h));
  font-size: 1.375rem;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: var(--ui-text-highlighted);
}
.legal p,
.legal ul,
.legal address {
  margin-top: 0.875rem;
}
.legal ul {
  display: grid;
  gap: 0.5rem;
  padding-left: 1.25rem;
  list-style: disc;
}
.legal strong {
  font-weight: 600;
  color: var(--ui-text-highlighted);
}
.legal address {
  font-style: normal;
}
.legal a {
  color: var(--ui-primary);
}
.legal a:hover {
  text-decoration: underline;
}
.legal-toc {
  display: inline-block;
  padding-block: 0.25rem;
  color: var(--ui-text-muted);
}
.legal-toc:hover {
  color: var(--ui-primary);
}
</style>
