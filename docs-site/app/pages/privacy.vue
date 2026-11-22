<script setup lang="ts">
/**
 * Privacy policy for Two Minute Billing Cloud and this website. Every fact comes from a page
 * that states it (sub-processors, security, pricing, open-source) or from the site's own
 * consent code. Change it with those pages, and move UPDATED when the text changes.
 */
import MkPageHero from "~/components/marketing/MkPageHero.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const UPDATED = "19 November 2026";

const sections = [
  { id: "who-we-are", title: "Who we are" },
  { id: "our-roles", title: "Our two roles" },
  { id: "website", title: "Data from our website" },
  { id: "account", title: "Data from your account" },
  { id: "your-customers", title: "Your customers' data" },
  { id: "use", title: "How we use data" },
  { id: "legal-bases", title: "Legal bases" },
  { id: "cookies", title: "Cookies and analytics" },
  { id: "sharing", title: "Who receives data" },
  { id: "location", title: "Where data is stored" },
  { id: "security", title: "Security" },
  { id: "retention", title: "How long we keep data" },
  { id: "rights", title: "Your rights" },
  { id: "self-hosted", title: "Self-hosted installations" },
  { id: "changes", title: "Changes to this policy" },
  { id: "contact", title: "Contact us" },
];

const rights = [
  "Access the personal data we hold about you.",
  "Correct data that is wrong.",
  "Ask us to delete your data.",
  "Restrict how we process it.",
  "Receive your data in a portable format.",
  "Object to processing.",
  "Not be subject to decisions made only by automated processing.",
  "Withdraw your consent at any time.",
  "Make a complaint to a data protection authority.",
];

useMarketingSeo({
  title: "Privacy Policy",
  description:
    "How Two Minute Billing collects, uses and protects data: your account, your customers' billing data, website analytics, cookies, and your rights.",
  og: {
    headline: "Privacy Policy",
    title: "Two Minute Billing Privacy Policy",
    description:
      "What data Two Minute Billing collects, why, who receives it, and the rights you have.",
  },
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Legal"
      title="Privacy Policy"
      description="What data we collect when you use Two Minute Billing Cloud or visit our website, why we collect it, who receives it, and the rights you have. We do not sell your data."
      :primary="{ label: 'Sub-processors', to: '/sub-processors' }"
      :secondary="{ label: 'Billing security', to: '/security' }"
      :note="`Last updated ${UPDATED}`"
    />

    <UContainer class="py-14 lg:py-20">
      <div class="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-16">
        <nav
          aria-label="On this page"
          class="lg:sticky lg:top-[calc(6rem+var(--mk-campaign-h))] lg:self-start"
        >
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
              Neelanadhi Private Limited, a company in Chennai, India ("we", "us"), runs Two Minute
              Billing Cloud (the "Service") and the website twominutebilling.com.
            </p>
            <p>
              This policy tells you what data we collect, why we collect it, how we handle it, and
              the rights you have. We do not sell your data. Read it together with our
              <NuxtLink to="/terms">Terms of Service</NuxtLink>.
            </p>
          </section>

          <section>
            <h2 :id="sections[1]!.id">{{ sections[1]!.title }}</h2>
            <p>
              <strong>Controller.</strong> For the data about you and your team that we need to run
              your account, and for the data from our website, we decide how the data is used. We
              are the controller of this data.
            </p>
            <p>
              <strong>Processor.</strong> You use the Service to bill your own customers. For the
              data about your customers, you are the controller. We process that data only to
              provide the Service to you, and on your instructions.
            </p>
          </section>

          <section>
            <h2 :id="sections[2]!.id">{{ sections[2]!.title }}</h2>
            <p>What we collect depends on what you do on our website:</p>
            <ul>
              <li>
                <strong>When you only visit.</strong> Your IP address, your approximate location,
                the pages you view and how long you stay. We use this to understand how people use
                the website. See <a href="#cookies">Cookies and analytics</a>.
              </li>
              <li>
                <strong>When you contact us.</strong> Your name, your work email, your company and
                your message, so that we can reply.
              </li>
              <li>
                <strong>Bot checks.</strong> At sign-up, at sign-in and on the contact form,
                Cloudflare reads browser signals to stop automated abuse.
              </li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[3]!.id">{{ sections[3]!.title }}</h2>
            <p>When you or your team use the Service, we collect:</p>
            <ul>
              <li>
                <strong>Account data.</strong> Your name and email address, for your account, for
                sign-in links, and for messages about the Service.
              </li>
              <li>
                <strong>Sign-in data.</strong> Your passkeys and two-factor settings. If you sign in
                with Google, we receive the email address of your Google account.
              </li>
              <li>
                <strong>Organization data.</strong> The details of your organization and your
                businesses, and the settings you choose.
              </li>
              <li>
                <strong>Plan payments.</strong> Your billing contact and the payment details you
                give at checkout. Stripe, Razorpay or PayPal collect the payment for your plan.
              </li>
              <li>
                <strong>Usage data and logs.</strong> Technical details of each request, record IDs
                and error messages. We use them to find and correct errors and to keep the Service
                secure.
              </li>
              <li>
                <strong>Billy conversations.</strong> The questions you ask Billy, the in-app
                assistant, and the records it reads to answer them. Screenshots you add are deleted
                with the conversation, and in all cases after 90 days.
              </li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[4]!.id">{{ sections[4]!.title }}</h2>
            <p>
              To bill your customers, the Service stores data about them: names, email addresses,
              billing addresses, subscriptions, invoices, payments, and a reference to each saved
              card with its last four digits.
            </p>
            <ul>
              <li>
                <strong>Card numbers never reach our servers.</strong> Your customer enters the card
                on a field that your payment gateway hosts. Your gateway stores the card and gives
                us a reference.
              </li>
              <li>
                <strong>We never hold your money.</strong> Payments are made through your own
                payment gateway account, and the money goes to that account.
              </li>
              <li>
                <strong>We send emails for you.</strong> Invoices, receipts and payment reminders go
                to your customers from the Service.
              </li>
              <li>
                <strong>Visits to checkout and billing portal pages.</strong> When your customer
                opens a checkout link or the billing portal, we record the type of device, the
                browser family, the operating system family, the website that sent them, the
                campaign tags in the link, the country, and how long each step is on screen. We do
                not use cookies or any other identifier for this, and we do not keep the IP address
                or the full browser details. If the browser sends a Global Privacy Control or Do Not
                Track signal, we record nothing about that visit.
              </li>
              <li>
                <strong>Email opens and clicks.</strong> If you turn on open and click tracking, we
                add a small image to the emails we send for you, and we send each link through our
                server. We record when an email is opened or a link is clicked, the type of device
                and browser family, and the link. We do not keep the IP address or the recipient's
                address with these records. You can turn this off for each business.
              </li>
            </ul>
            <p>
              If you are a customer of a business that uses Two Minute Billing, that business
              controls your data. Send questions and requests about your data to that business.
            </p>
          </section>

          <section>
            <h2 :id="sections[5]!.id">{{ sections[5]!.title }}</h2>
            <p>We use data to:</p>
            <ul>
              <li>Provide the Service, and send the emails that it needs.</li>
              <li>Answer your questions and give support.</li>
              <li>Keep the Service and your account secure.</li>
              <li>Find and correct errors, and make the Service better.</li>
              <li>Obey the law, for example to keep financial records.</li>
            </ul>
            <p>We do not sell personal data, and we do not use it for advertising.</p>
          </section>

          <section>
            <h2 :id="sections[6]!.id">{{ sections[6]!.title }}</h2>
            <p>
              Data protection laws, such as the General Data Protection Regulation (GDPR), require a
              legal basis to process personal data. We use these:
            </p>
            <ul>
              <li>
                <strong>Consent.</strong> For example, for analytics cookies where the law requires
                consent. You can withdraw your consent at any time. This does not change the
                processing that occurred before.
              </li>
              <li><strong>Contract.</strong> To provide the Service you signed up for.</li>
              <li>
                <strong>Legal obligation.</strong> For example, to keep financial records or to
                answer a lawful request.
              </li>
              <li>
                <strong>Legitimate interests.</strong> To keep the Service secure, to correct errors
                and to make the Service better, when these interests do not override your rights.
              </li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[7]!.id">{{ sections[7]!.title }}</h2>
            <p>
              <strong>On our website.</strong> We use Google Analytics to count visits. In countries
              where the law requires consent, its cookies stay off until you accept them.
              Advertising cookies and ad personalization are always off. To change your choice,
              select "Cookie settings" at the bottom of any page. We keep your choice in a cookie
              for one year.
            </p>
            <p>
              <strong>In the Service.</strong> The dashboard uses cookies to keep you signed in and
              to keep your account secure. The checkout and billing portal pages that we host for
              your business set no analytics cookies.
            </p>
          </section>

          <section>
            <h2 :id="sections[8]!.id">{{ sections[8]!.title }}</h2>
            <ul>
              <li>
                <strong>Sub-processors.</strong> Companies that help us run the Service, such as
                hosting, email and logging. Our
                <NuxtLink to="/sub-processors">sub-processors page</NuxtLink> names each one, the
                data it receives and where.
              </li>
              <li>
                <strong>Services you connect.</strong> Your payment gateways, integrations such as
                HubSpot, your own email server and your own AI provider. They receive data because
                you connect them, under your own agreement with each one.
              </li>
              <li><strong>Authorities.</strong> When the law requires it.</li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[9]!.id">{{ sections[9]!.title }}</h2>
            <p>
              The servers and the database that hold your account are in Germany. Some
              sub-processors are in other countries, such as the United States and India. The
              <NuxtLink to="/sub-processors">sub-processors page</NuxtLink> shows the location of
              each one.
            </p>
          </section>

          <section>
            <h2 :id="sections[10]!.id">{{ sections[10]!.title }}</h2>
            <p>
              Card numbers never reach our servers, so card-data scope stays at PCI DSS SAQ-A. Your
              gateway credentials are encrypted at rest. Roles, two-factor sign-in and an audit log
              control and record who does what. Read more on our
              <NuxtLink to="/security">security page</NuxtLink>.
            </p>
          </section>

          <section>
            <h2 :id="sections[11]!.id">{{ sections[11]!.title }}</h2>
            <ul>
              <li>
                <strong>While your account is open.</strong> We keep your account data, so that you
                can use the Service and we can send you messages about it.
              </li>
              <li>
                <strong>After you close your account.</strong> We keep data only as long as we need
                to obey the law, to settle disputes and to enforce our agreements.
              </li>
              <li>
                <strong>Billy screenshots.</strong> Deleted with the conversation, and in all cases
                after 90 days.
              </li>
              <li>
                <strong>Page visits and email opens and clicks.</strong> We delete them after 13
                months.
              </li>
            </ul>
          </section>

          <section>
            <h2 :id="sections[12]!.id">{{ sections[12]!.title }}</h2>
            <p>Under the GDPR and other data protection laws, you can:</p>
            <ul>
              <li v-for="r in rights" :key="r">{{ r }}</li>
            </ul>
            <p>
              To use a right, <NuxtLink to="/contact">contact us</NuxtLink>. We reply as the law
              requires and in a reasonable time. If we hold your data as a processor for one of our
              customers, we send your request to that customer.
            </p>
          </section>

          <section>
            <h2 :id="sections[13]!.id">{{ sections[13]!.title }}</h2>
            <p>
              This policy covers our Cloud and our website. When you run the open-source edition on
              your own servers, your billing data stays on your infrastructure and we receive none
              of it. You are then the controller of that data.
            </p>
          </section>

          <section>
            <h2 :id="sections[14]!.id">{{ sections[14]!.title }}</h2>
            <p>
              We can change this policy when laws, technology or the Service change. The date at the
              top shows when we last changed it. For a significant change, we tell you at least 30
              days before it starts, on our website or by email. If you continue to use the Service
              after a change starts, you accept the new policy.
            </p>
          </section>

          <section>
            <h2 :id="sections[15]!.id">{{ sections[15]!.title }}</h2>
            <p>
              For questions about privacy or your data, or to use your rights,
              <NuxtLink to="/contact">contact us</NuxtLink> or send an email to
              <a href="mailto:support@gox.ai">support@gox.ai</a>.
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
