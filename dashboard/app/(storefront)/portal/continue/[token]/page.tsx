import { MousePointerClick } from "lucide-react";
import { Button } from "@/components/ui/button";
import { portalPeekLink } from "@/lib/portal-api";
import { ExpiredCard } from "../../(session)/portal-dead-ends";
import { BrandTheme, NoticeCard, StorefrontHeader } from "../../../chrome";
import { continuePortalLinkAction } from "./actions";

/**
 * Click to continue (Phase 4b). An emailed portal link lands here instead of being spent on
 * load: mail scanners load links before the customer does. Loading this page spends nothing
 * (the peek has no side effects); the button below does.
 */
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Billing",
  // The token is in this URL: never send it as a Referer, never index the page.
  referrer: "no-referrer" as const,
  robots: { index: false, follow: false },
};

const TASK: Record<string, { title: string; text: string; button: string }> = {
  pay_invoice: {
    title: "Pay your invoice",
    text: "Continue to open the invoice and pay it.",
    button: "Continue to payment",
  },
  update_card: {
    title: "Change your payment method",
    text: "Continue to add a payment method.",
    button: "Continue",
  },
  change_plan: {
    title: "Change your plan",
    text: "Continue to select a plan.",
    button: "Continue",
  },
  cancel_subscription: {
    title: "Cancel your subscription",
    text: "Continue to see the options for your subscription.",
    button: "Continue",
  },
};

export default async function ContinuePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A link the engine refused gets the expired card here, branded, instead of a Continue
  // button that only leads to it. A rate limit or an error still gets the button: the POST
  // decides. Never spent on this load.
  const result = await portalPeekLink(token);
  if (result.kind === "dead") return <ExpiredCard business={result.business} reason="link" />;
  const peek = result.kind === "live" ? result.peek : null;
  const task = (peek?.task && TASK[peek.task]) || {
    title: "Open your billing account",
    text: "Continue to see your invoices, plan and payment methods.",
    button: "Continue",
  };
  const action = continuePortalLinkAction.bind(null, token);
  const card = (
    <NoticeCard icon={<MousePointerClick />} title={task.title}>
      <p className="m-0">{task.text}</p>
      <form action={action} className="mt-4">
        <Button type="submit" className="w-full">
          {task.button}
        </Button>
      </form>
    </NoticeCard>
  );
  if (!peek?.business) return card;
  return (
    <BrandTheme brand={peek.business}>
      <StorefrontHeader brand={peek.business} eyebrow="Billing portal" />
      {card}
    </BrandTheme>
  );
}
