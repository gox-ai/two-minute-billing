import { PlugZap } from "lucide-react";
import { requireUser } from "@/lib/session";
import { getOAuthRequest } from "@/lib/oauth";
import { Card, CardContent } from "@/components/ui/card";
import { Alert } from "@/components/ui/alert";
import { ConsentForm } from "@/components/developer/consent-form";

// An AI application asks to read one business's billing data (MCP over OAuth). The member
// selects the business and approves or denies; the API then returns them to the application.
export default async function ConsentPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  const request = await getOAuthRequest(id);
  const name = request?.client_name ?? "An application";

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-4 pt-10">
      <Card>
        <CardContent className="flex flex-col gap-5 p-6">
          <PlugZap className="size-8 text-foreground/70" aria-hidden />
          {!request ? (
            <>
              <h1 className="m-0 text-xl font-semibold">Connect an application</h1>
              <Alert tone="warning" title="We could not find this connection request">
                It expired or was already answered. Start again from the application.
              </Alert>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-1.5">
                <h1 className="m-0 text-xl font-semibold">Connect {name}</h1>
                <p className="m-0 text-sm text-muted-foreground">
                  {name} wants to read the billing data of one business. It cannot change anything.
                </p>
              </div>
              <dl className="m-0 flex flex-wrap gap-px overflow-hidden rounded-md border bg-border text-sm">
                <div className="flex-[1_1_12rem] bg-card px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Application</dt>
                  <dd className="m-0 break-all">{name}</dd>
                </div>
                <div className="flex-[1_1_12rem] bg-card px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Returns you to</dt>
                  <dd className="m-0 break-all">{request.redirect_host}</dd>
                </div>
                <div className="flex-[1_1_12rem] bg-card px-3 py-2">
                  <dt className="text-xs text-muted-foreground">Access</dt>
                  <dd className="m-0">Read only</dd>
                </div>
              </dl>
              <p className="m-0 text-sm text-muted-foreground">
                The application can read what you can read in the business: customers,
                subscriptions, invoices, payments and reports. You can disconnect it at any time in
                Settings → Developer.
              </p>
              {request.businesses.length === 0 ? (
                <Alert tone="warning" title="This organization has no business">
                  Create a business first, then start again from the application.
                </Alert>
              ) : (
                <ConsentForm requestId={request.id} businesses={request.businesses} />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
