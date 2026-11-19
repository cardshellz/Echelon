import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { AuthProvider, useAuth } from "../../../client/src/lib/auth";
import { RfqWorkflowPanel } from "../../../client/src/features/purchasing/RfqWorkflowPanel";
import { RfqCommandRecovery } from "../../../client/src/features/purchasing/RfqCommandRecovery";
import { useRfqCommands } from "../../../client/src/features/purchasing/use-rfq-commands";
import "../../../client/src/index.css";

function Panels() {
  const { user, refetch, isLoading } = useAuth();
  const commands = useRfqCommands();
  if (isLoading || !user) return <p>Loading fixture authentication</p>;
  return <main className="space-y-4 p-4">
    <button onClick={() => void refetch()}>Refresh fixture permissions</button>
    <RfqCommandRecovery commands={commands} />
    <section aria-label="First RFQ panel"><RfqWorkflowPanel rfqId={10} showRecovery={false} /></section>
    <section aria-label="Second RFQ panel"><RfqWorkflowPanel rfqId={10} showRecovery={false} /></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}><AuthProvider><Panels /></AuthProvider></QueryClientProvider>,
);
