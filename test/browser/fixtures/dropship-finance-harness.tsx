import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { TooltipProvider } from "../../../client/src/components/ui/tooltip";
import { DropshipFinancePanel } from "../../../client/src/pages/dropship-finance-panel";
import "../../../client/src/index.css";

// The real Program finance tab under the app's query client, served at
// /dropship?tab=finance so the panel's own URL writes stay on this page.
// Every API call is stubbed by the spec. The clock is the §6.4 fixture's
// (Oct 5, 2026, 9:14 AM Eastern) so the custom-date picker is deterministic.
const FIXTURE_NOW = new Date("2026-10-05T13:14:00.000Z");
const clock = () => FIXTURE_NOW;

// The Dropship page's own padding (p-4 md:p-6): the sticky period bar bleeds into it.
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <main className="p-4 md:p-6">
        <DropshipFinancePanel canView clock={clock} />
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
);
