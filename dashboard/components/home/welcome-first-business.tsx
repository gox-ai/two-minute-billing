import { createBusiness } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/form/field";
import { CurrencySelect } from "@/components/form/currency-select";
import { PageHeader } from "@/components/page-header";
import { currencyForCountry } from "@/lib/country-currency";
import { regionName } from "@/lib/countries";
import { signupGatewayName } from "@/lib/signup-gateway";

/**
 * The org home for an owner with no business yet: the create form itself, not a lone button
 * on an empty dashboard. The currency is preset from the sign-up country.
 */
export function WelcomeFirstBusiness({
  personName,
  country,
  signupGateway,
}: {
  personName: string | null;
  country: string | null;
  signupGateway: string | null;
}) {
  const currency = currencyForCountry(country);
  const first = personName?.trim().split(/\s+/)[0];
  const gateway = signupGatewayName(signupGateway);
  const steps = [
    {
      title: "A short tour",
      detail: "About one minute. It shows where each part of billing is.",
    },
    {
      title: gateway ? `Connect ${gateway}` : "Connect your payment gateway",
      detail: gateway
        ? "The gateway you told us you use. You can select a different one."
        : "The gateway charges your customers. We never store card numbers.",
    },
    {
      title: "Create a price and a customer",
      detail: "Or load sample data to see a complete business first.",
    },
    {
      title: "Create a test subscription",
      detail: "See its first invoice before you bill a real customer.",
    },
  ];

  return (
    <>
      <PageHeader
        title={first ? `Welcome, ${first}` : "Welcome to Two Minute Billing"}
        description="Create your first business to start billing. A business has its own products, prices, customers and payment gateway."
      />
      <div className="flex flex-wrap items-start gap-5">
        <Card className="min-w-0 flex-[3_1_26rem]">
          <CardContent>
            <h2 className="text-lg font-semibold">Create business</h2>
            <form action={createBusiness} className="mt-5 max-w-[720px] space-y-5">
              <input type="hidden" name="first" value="1" />
              <Field name="name" label="Business name" required>
                <Input name="name" placeholder="Business name" required />
              </Field>
              <Field
                name="default_currency"
                label="Default currency"
                help={
                  country
                    ? `Selected from your country, ${regionName(country)}. This business prices and invoices in this currency.`
                    : "This business prices and invoices in this currency."
                }
                required
              >
                <CurrencySelect name="default_currency" defaultValue={currency} />
              </Field>
              <Alert tone="info">
                Each business has a test mode. Test mode does not bill real customers, so you can
                try each step there first.
              </Alert>
              <div className="flex justify-end">
                <Button type="submit">Create business</Button>
              </div>
            </form>
          </CardContent>
        </Card>
        <Card className="min-w-0 flex-[2_1_18rem]">
          <CardContent>
            <h2 className="text-lg font-semibold">What happens next</h2>
            <ol className="mt-4 space-y-4">
              {steps.map((s, i) => (
                <li key={s.title} className="flex gap-3">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-primary">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{s.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{s.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
