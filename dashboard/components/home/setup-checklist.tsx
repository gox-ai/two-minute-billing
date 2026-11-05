import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { SetupStep } from "@/lib/setup-readiness";
import { StartTourLink } from "@/components/product-tour";

/**
 * First run, on the one screen a new operator lands on.
 *
 * The product had no first-run path at all: 58 of 117 routes are configuration, and a new
 * business had to work out on its own that a gateway, a recurring price and a customer stand
 * between it and a single rupee. This is not a tour — it reads the REAL state (see
 * `resolveSetupSteps`, which mirrors the engine's own refusals) and disappears the moment the
 * business can bill, so it can never nag about something already done or claim readiness it
 * has not checked.
 *
 * Only steps that BLOCK money are listed. Tax, email and brand are deliberately absent.
 */
export function SetupChecklist({
  steps,
  sampleDataHref,
}: {
  steps: SetupStep[];
  /** Transfer & Sample Data — the fastest way to see the product working. */
  sampleDataHref: string;
}) {
  const outstanding = steps.filter((s) => !s.done);
  // Nothing outstanding = nothing to say. The caller also skips this entirely once the
  // business has an active subscription, so an established business pays no query for it.
  if (outstanding.length === 0) return null;
  const next = outstanding[0]!;
  const done = steps.length - outstanding.length;

  return (
    <Card className="mb-6">
      <CardContent>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Finish setup</h2>
          <p className="text-xs text-muted-foreground">
            {done} of {steps.length} done
          </p>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Complete these steps. Then this business can send its first invoice.
        </p>

        <ol className="mt-4 space-y-3">
          {steps.map((step) => (
            <li key={step.id} className="flex items-start gap-3">
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                  step.done
                    ? "border-transparent bg-success-soft text-success"
                    : "border-input text-muted-foreground",
                )}
              >
                {step.done ? <Check className="size-3" /> : null}
              </span>
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    step.done && "text-muted-foreground line-through",
                  )}
                >
                  {step.label}
                </p>
                {/* The reason is only useful while the step is outstanding — on a done row it
                    is noise, and it is what makes the list read as a nag. */}
                {step.done ? null : (
                  <p className="mt-0.5 text-sm text-muted-foreground">{step.detail}</p>
                )}
              </div>
              {step.done ? null : (
                <Button asChild size="sm" variant={step.id === next.id ? "default" : "outline"}>
                  <Link href={step.href}>{step.cta}</Link>
                </Button>
              )}
            </li>
          ))}
        </ol>

        {/* Step zero, and it already existed — buried at Settings › Transfer & Sample Data,
            where nobody setting up a business would look for it. */}
        <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
          To see the product work first,{" "}
          <Link href={sampleDataHref} className="text-primary hover:underline">
            load sample data
          </Link>
          . It adds a catalog, customers and subscriptions that you can delete. <StartTourLink />
        </p>
      </CardContent>
    </Card>
  );
}
