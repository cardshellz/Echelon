// Frontend-only test entry. Never imported by the production application.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipPricingRulesPanel } from "../../../client/src/pages/dropship/DropshipPricingRulesPanel";
import "../../../client/src/index.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <DropshipPricingRulesPanel storeConnectionId={22} storeName="Test store" onConfigurationChange={() => {
    const state = window as unknown as { __pricingChanged?: number }; state.__pricingChanged = (state.__pricingChanged ?? 0) + 1;
  }} />
</QueryClientProvider>);
