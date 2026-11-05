import type { ReactNode } from "react";
import { SignupAnalytics } from "@/components/signup-analytics";
import { gaMeasurementId } from "@/lib/analytics";

/** The sign-up pages are the only ones in the app that load Google Analytics. */
export default function SignupLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <SignupAnalytics id={gaMeasurementId()} />
    </>
  );
}
