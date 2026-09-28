import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipAuthProvider } from "../../../client/src/lib/dropship-auth";
import DropshipPortalCostChanges from "../../../client/src/pages/dropship/DropshipPortalCostChanges";
import "../../../client/src/index.css";

// The real Cost changes page under the real auth provider and portal shell;
// every API call is stubbed by the spec.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <DropshipAuthProvider>
      <DropshipPortalCostChanges />
    </DropshipAuthProvider>
  </QueryClientProvider>,
);
