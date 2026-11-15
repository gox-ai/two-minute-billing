"use client";

import * as React from "react";
import { rememberRecordLabel } from "@/lib/assistant";

/** Whether the assistant can answer here; set once by the shell from the API's status. */
const AvailableContext = React.createContext(false);

export function AssistantAvailability({
  available,
  children,
}: {
  available: boolean;
  children: React.ReactNode;
}) {
  return <AvailableContext.Provider value={available}>{children}</AvailableContext.Provider>;
}

export const useAssistantAvailable = () => React.useContext(AvailableContext);

/**
 * Names the record on this page for the assistant, so its welcome reads "How can I help with
 * INV-0042?" instead of the raw id. Renders nothing: the bubble on the page asks about it.
 */
export function AssistantRecordLabel({ id, label, state }: { id: string; label: string; state?: string }) {
  const available = useAssistantAvailable();
  React.useEffect(() => {
    if (available) rememberRecordLabel(id, label, state);
  }, [available, id, label, state]);
  return null;
}
