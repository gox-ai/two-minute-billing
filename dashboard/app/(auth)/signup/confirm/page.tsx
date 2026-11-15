import { cookies } from "next/headers";
import { Wordmark } from "@/components/wordmark";
import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ActionForm } from "@/components/form/action-form";
import { SIGNUP_CONFIRM_COOKIE } from "@/lib/auth-cookies";
import { confirmSignupAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function ConfirmSignupPage() {
  if (!(await cookies()).get(SIGNUP_CONFIRM_COOKIE)) redirect("/signup?expired=1");
  return (
    <div className="space-y-6">
      <div className="flex justify-center">
        <Wordmark size="lg" />
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">
            <h1>Confirm your email address</h1>
          </CardTitle>
          <p className="text-sm text-muted-foreground">We create your account and sign you in.</p>
        </CardHeader>
        <CardContent>
          <ActionForm action={confirmSignupAction}>
            <Button type="submit" className="w-full">
              Confirm and sign in
            </Button>
          </ActionForm>
        </CardContent>
      </Card>
    </div>
  );
}
