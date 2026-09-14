// Frontend-only test entry. Never imported by the production application.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "../../../client/src/lib/auth";
import InventoryExposure from "../../../client/src/pages/InventoryExposure";
import "../../../client/src/index.css";

const client = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <AuthProvider>
      <InventoryExposure />
    </AuthProvider>
  </QueryClientProvider>,
);
