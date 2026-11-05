import { CreditCard, Landmark, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { PaymentMark, paymentMarkKey } from "./payment-mark";

/**
 * The right icon for one payment instrument — the network's own mark where we know it, a
 * rail-appropriate glyph where we do not.
 *
 * Extracted from the storefront's `MethodGlyph` so the dashboard shows a payer's instrument
 * the same way the payer does. It was only ever in portal and checkout; every operator
 * surface drew a generic credit-card outline, so a RuPay card, a UPI mandate and a bank
 * debit were indistinguishable at a glance on the screens where someone is triaging a failed
 * payment.
 *
 * The mark is never INVENTED: `paymentMarkKey` returns null for a brand we have no artwork
 * for, and the fallback follows the instrument rather than always drawing a card — a wallet
 * gets a wallet, a bank rail gets a bank. Guessing would be worse than the generic glyph,
 * because a wrong logo is read as fact.
 *
 * Renders the artwork ALONE, sized by the caller: storefront rows wrap it in a 36px `Glyph`
 * tile, operator tables want it inline at text height. The tile is not shared because the
 * two contexts genuinely differ; the icon choice is what must not.
 */
export function InstrumentMark({
  brand,
  type,
  mandateRail,
  last4,
  className,
}: {
  brand?: string | null;
  type?: string | null;
  mandateRail?: string | null;
  /** Only used for the fallback: something with a last4 is a card even if `type` is vague. */
  last4?: string | null;
  className?: string;
}) {
  const mark = paymentMarkKey({ brand, type, mandateRail });
  if (mark) return <PaymentMark mark={mark} className={cn("h-4 w-7", className)} />;

  const t = (type ?? "").toLowerCase();
  const Icon =
    t === "paypal" || t === "wallet" ? Wallet : t === "card" || last4 ? CreditCard : Landmark;
  return <Icon className={cn("size-3.5 text-muted-foreground", className)} aria-hidden />;
}
