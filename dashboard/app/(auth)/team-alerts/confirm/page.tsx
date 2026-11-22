import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Wordmark } from "@/components/wordmark";

export const dynamic = "force-dynamic";

/**
 * A team alert confirmation link (0495) from before notifications (0533). It confirms nothing
 * now; the API answers 410 for it too.
 */
export default function TeamAlertsLinkRetired() {
  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            <h1>This link is no longer used</h1>
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Team alerts are now part of notifications. Ask an admin of the business to add your
            address again in Team notifications. You then get a new confirmation email.
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}
