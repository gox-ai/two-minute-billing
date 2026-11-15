<script setup lang="ts">
/**
 * Product: Billy, the AI assistant in the dashboard. Answers from the member's own data with
 * every figure checked, questions with options, changes the member confirms, included use per
 * plan (from the catalogue) and the read-only MCP server.
 */
import MkIllustration from "~/components/marketing/MkIllustration.vue";
import MkCta from "~/components/marketing/MkCta.vue";
import MkFaq from "~/components/marketing/MkFaq.vue";
import MkPageFlow from "~/components/marketing/MkPageFlow.vue";
import MkPageHero from "~/components/marketing/MkPageHero.vue";
import MkPageTrust from "~/components/marketing/MkPageTrust.vue";
import MkPageWhy from "~/components/marketing/MkPageWhy.vue";
import MkPageZig from "~/components/marketing/MkPageZig.vue";
import MkRelated from "~/components/marketing/MkRelated.vue";

definePageMeta({ layout: "marketing", header: false, footer: false });

const GUIDE = "/help/guides/ask-billy";
const MCP_GUIDE = "/help/developers/getting-started/connect-ai-assistants";

const assistantUse = await useAssistantUse();

const why = [
  {
    label: "No spreadsheet hunt",
    body: "Ask what a customer paid or why an invoice changed. Billy reads the records and shows them to you.",
  },
  {
    label: "Figures you can check",
    body: "Billy finds each number in your data before you see it. It marks a number that it cannot find.",
  },
  {
    label: "Your team stays in control",
    body: "Billy uses each member's own permissions. A change waits until a member confirms it.",
  },
];

const ask = [
  {
    icon: "i-lucide-command",
    title: "From any page",
    body: "Select Ask Billy at the top of the menu, press ⌘J, or type a question in the search box.",
  },
  {
    icon: "i-lucide-file-text",
    title: "About this record",
    body: "On an invoice, customer, subscription or payment, Billy starts with that record.",
  },
  {
    icon: "i-lucide-at-sign",
    title: "Mention a record",
    body: "Type @ and a name, an email or an invoice number.",
  },
  {
    icon: "i-lucide-image",
    title: "Attach a screenshot",
    body: "Images only: PNG, JPEG or WebP, up to 10 MB.",
  },
];

const checked = [
  {
    icon: "i-lucide-list-checks",
    title: "The steps it took",
    body: "For example, “Read 6 refunds” and “Checked 4 figures”.",
  },
  {
    icon: "i-lucide-table",
    title: "Record cards and tables",
    body: "Select a record to open it.",
  },
  {
    icon: "i-lucide-badge-check",
    title: "Marked when not found",
    body: "A number that Billy cannot find has a dotted underline and a warning.",
  },
  {
    icon: "i-lucide-link",
    title: "Links to the right screen",
    body: "Open the screen where you act, and questions to ask next.",
  },
];

const questions = [
  {
    icon: "i-lucide-mouse-pointer-click",
    title: "Buttons, not typing",
    body: "Select an option, or press its number key.",
  },
  {
    icon: "i-lucide-star",
    title: "Your default, labelled",
    body: "The option your settings use shows “Your default”.",
  },
  {
    icon: "i-lucide-calculator",
    title: "Real amounts",
    body: "Credits and refunds come from the billing engine's preview, not from the AI model.",
  },
  {
    icon: "i-lucide-pen-line",
    title: "Your own answer",
    body: "“Type a different answer” is always there.",
  },
];

const changes = [
  {
    icon: "i-lucide-shield",
    title: "Off until you turn it on",
    body: "In Settings → Billy, an owner or admin turns on “Let Billy take actions”.",
  },
  {
    icon: "i-lucide-coins",
    title: "Money changes ask twice",
    body: "Refunds, credit notes, charges, voids and credits need a second switch, and “You cannot undo this” each time.",
  },
  {
    icon: "i-lucide-user-check",
    title: "Your permissions, your name",
    body: "The activity log shows that you made the change, via Billy.",
  },
  {
    icon: "i-lucide-timer",
    title: "One time only",
    body: "A change runs once. A card that you do not confirm expires after 15 minutes. A portal link shows once and is not stored.",
  },
];

/** The plan figures come from the catalogue; with none, the section keeps its words only. */
const included = computed(() =>
  assistantUse.value.length
    ? assistantUse.value.map((u) => ({
        figure: u.credits.toLocaleString("en-US"),
        label: u.plan,
        body: "credits each month, about one question each",
      }))
    : [
        {
          label: "Included each month",
          body: "Every Cloud plan includes Billy use, Free too. It starts again on the first day of each month.",
        },
        {
          label: "Your own key",
          body: "Add a key from OpenAI, Anthropic or Google. Billy use then does not count against your plan.",
        },
        {
          label: "Self-hosted",
          body: "Set your own model key, or a local model on an OpenAI-compatible server.",
        },
      ],
);

const mcp = [
  {
    icon: "i-lucide-plug",
    title: "Add the server",
    body: "Add the Two Minute Billing server address as a custom connector in your AI tool.",
  },
  {
    icon: "i-lucide-log-in",
    title: "Sign in and select a business",
    body: "Developer tools use a read-only API key instead.",
  },
  {
    icon: "i-lucide-message-square",
    title: "Ask in your AI tool",
    body: "“Which customers have unpaid invoices?” The tool reads only what you can read.",
  },
  {
    icon: "i-lucide-unplug",
    title: "Disconnect at any time",
    body: "Settings → Developer → Connected apps. Access stops at once.",
  },
];

const faq = computed(() => {
  const use = assistantUse.value;
  return [
    {
      label: "What is Billy?",
      content:
        "Billy is the AI assistant inside the Two Minute Billing dashboard. It answers questions about your invoices, customers, subscriptions, payments and MRR, and about how the product works. It reads your own data and checks every figure in its answer.",
    },
    {
      label: "Can Billy change my billing by itself?",
      content:
        "No. Billy can prepare a change, such as a plan change or a refund, and show you exactly what it will do. Nothing changes until you select Confirm. An owner or admin must turn this on first, and money changes need a second switch and a second confirmation.",
    },
    {
      label: "What data can Billy see?",
      content:
        "Only what your role allows. Billy reads through our API with your sign-in, so a member who cannot see invoices gets no answers about invoices. Your conversations are your own.",
    },
    {
      label: "Which AI model does Billy use?",
      content:
        "On Cloud, Billy uses our AI model provider. You can add your own key from OpenAI, Anthropic or Google instead. On a self-hosted installation, you set the model, which can be a local model on an OpenAI-compatible server.",
    },
    {
      label: "How much Billy use is included?",
      content: use.length
        ? `Each Cloud plan includes Billy credits every month, from ${use[0]!.amount} on ${use[0]!.plan} to ${use.at(-1)!.amount} on ${use.at(-1)!.plan}. A credit is about one question. With your own key, Billy use does not count against your plan.`
        : "Each Cloud plan includes Billy credits every month, Free too. A credit is about one question. The pricing page shows the credits for each plan. With your own key, Billy use does not count against your plan.",
    },
    {
      label: "Can I use my billing data in claude.ai or ChatGPT?",
      content:
        "Yes. Connect our read-only MCP server to claude.ai, ChatGPT, Claude Code, Cursor or another MCP client. It can read your data, but it cannot change anything.",
    },
  ];
});

useMarketingSeo({
  title: "AI assistant for subscription billing",
  crumb: "AI assistant",
  parents: [{ name: "Product", path: "/product" }],
  description:
    "Billy, the AI assistant in Two Minute Billing, answers from your own billing data. It checks every figure, and changes wait for you to confirm them.",
  og: {
    headline: "AI assistant for billing",
    title: "Billy: an AI assistant that answers from your billing data",
    description: "Every figure checked. Changes wait for your click.",
  },
  faq: faq.value,
});
</script>

<template>
  <div>
    <MkPageHero
      eyebrow="Billy, the AI assistant"
      title="An AI assistant that answers from your billing data"
      description="Ask Billy about invoices, customers, subscriptions, payments and MRR. Billy reads your own data with your permissions, checks every figure, and links to the screen where you act."
      :secondary="{ label: 'Read the Billy guide', to: GUIDE }"
      note="Included in every Cloud plan, Free too. No credit card required."
    >
      <MkIllustration
        name="IllBillyHero"
        :width="600"
        :height="460"
        :phone="{ width: 390, height: 690 }"
        alt="On the Larkfield Studio customer page, Billy answers how much the customer paid this year: $11,800.00 across 10 paid invoices of $1,180.00, with every figure found in your data."
        eager
      />
    </MkPageHero>

    <MkPageWhy
      kicker="Why it matters"
      title="Answers from your own billing records, with your team in control"
      description="A customer asks about a charge. Finance asks why MRR moved. Billy finds the answer in your data and shows the records behind it."
      :items="why"
    />

    <MkPageZig
      kicker="Ask"
      title="Ask about any invoice, customer or MRR change"
      accent="any invoice"
      description="Open Billy from any page, or from a record. Ask in plain words. Or attach a screenshot, such as an email from a bank, and Billy explains it."
      :points="ask"
      :links="[{ label: 'Read the Billy guide', to: GUIDE }]"
    >
      <MkIllustration
        name="IllBillyAsk"
        :width="600"
        :height="460"
        :phone="{ width: 390, height: 461 }"
        alt="A screenshot of a bank email is attached. Billy explains that the bank approved automatic card payments for Larkfield Studio, up to $1,180.00 a month, with the next charge on 12 Nov."
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Checked answers"
      title="Every figure in an answer is found in your data"
      accent="found in your data"
      description="Billy shows the steps it took and the records it read. It matches each number to those records before the answer reaches you."
      :points="checked"
    >
      <MkIllustration
        name="IllBillyFigures"
        :width="600"
        :height="460"
        :phone="{ width: 390, height: 473 }"
        alt="Billy answers how much was refunded in October: $1,420.00 across 6 refunds, the largest $600.00 to Northgate Labs, with every figure found in your data."
      />
    </MkPageZig>

    <MkPageZig
      kicker="Questions"
      title="When a request needs a choice, Billy asks"
      accent="Billy asks"
      description="For a cancellation or a refund, Billy asks one short question at a time. Your business's own default is selected. The amounts come from the billing engine's preview."
      :points="questions"
    >
      <MkIllustration
        name="IllBillyQuestion"
        :width="600"
        :height="460"
        :phone="{ width: 390, height: 458 }"
        alt="Billy asks how to treat 19 unused days when Larkfield Studio's subscription ends now: no credit $0.00, prorated credit $747.33 (your default, selected) or full credit $1,180.00."
      />
    </MkPageZig>

    <MkPageZig
      flip
      kicker="Changes you confirm"
      title="Billy prepares the change. You confirm it."
      accent="You confirm it."
      description="Ask Billy to update a customer, change a subscription or pause dunning. Billy can also send a billing email, a payment link or a portal link, and give a refund or credit. Billy shows exactly what will change. For an email, you see the full email and can edit the note. Nothing changes until you select Confirm."
      :points="changes"
    >
      <MkIllustration
        name="IllBillyConfirm"
        :width="600"
        :height="460"
        :phone="{ width: 390, height: 496 }"
        alt="Billy prepares a change from Growth monthly to Growth yearly, with the preview: a $747.33 credit for unused time and $11,052.67 due now. After Confirm: done, changed by you, via Billy."
      />
    </MkPageZig>

    <div class="mk-tint border-y border-default">
      <MkPageWhy
        title="Billy credits are included in every Cloud plan"
        description="Each plan includes Billy credits every month. A credit is about one question; a long question that reads a lot of data can use more. Credits start again on the first day of each month. Add your own key from OpenAI, Anthropic or Google, and your questions do not count against them."
        :items="included"
      >
        <p class="mt-6 text-sm text-muted">
          Self-hosted: set your own model key, or a local model on an OpenAI-compatible server.
          <ULink to="/pricing" class="font-medium text-primary">Compare plans</ULink>
        </p>
      </MkPageWhy>
    </div>

    <MkPageFlow
      kicker="Your AI tools"
      title="Use your billing data in claude.ai, ChatGPT, Claude Code and Cursor"
      description="Our MCP server lets the AI tool you already use read your billing data. It is read-only. It can look things up and ask for estimates, but it cannot change anything."
      :steps="mcp"
    >
      <UButton :to="MCP_GUIDE" color="neutral" variant="outline" class="mt-10 bg-default">
        Connect an AI assistant
      </UButton>
    </MkPageFlow>

    <MkPageTrust />

    <MkFaq :items="faq" title="Questions about Billy" />

    <MkRelated />

    <MkCta
      title="Ask your billing a question today"
      accent="question"
      description="Start on the Free plan. Billy is included, and no credit card is required."
      :secondary="{ label: 'Read the Billy guide', to: GUIDE }"
    />
  </div>
</template>
