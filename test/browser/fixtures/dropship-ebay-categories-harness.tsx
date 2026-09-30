// Frontend-only test entry. Never imported by the production application.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipEbayCategoryRulesPanel } from "../../../client/src/pages/dropship/DropshipEbayCategoryRulesPanel";
import "../../../client/src/index.css";

type HarnessCounters = { __saveStarted?: number; __saveSettled?: number; __previewRefreshed?: number };
const counters = window as unknown as HarnessCounters;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });

// The real reconnect control needs a signed-in portal session; its own tests cover it, so a stub stands in here.
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <DropshipEbayCategoryRulesPanel
    storeConnectionId={22}
    storeName="Test store"
    renderAuthorizationRecovery={() => <button type="button">Refresh eBay authorization for Test store</button>}
    onSaveStarted={() => { counters.__saveStarted = (counters.__saveStarted ?? 0) + 1; }}
    onSaveSettled={() => { counters.__saveSettled = (counters.__saveSettled ?? 0) + 1; }}
    onSaved={async () => { counters.__previewRefreshed = (counters.__previewRefreshed ?? 0) + 1; }}
  />
</QueryClientProvider>);
