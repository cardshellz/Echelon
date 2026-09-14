// Frontend-only test entry. Never imported by the production application.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AuthProvider } from "../../../client/src/lib/auth";
import { getQueryFn } from "../../../client/src/lib/queryClient";
import ChannelAllocation from "../../../client/src/pages/ChannelAllocation";
import Reserves from "../../../client/src/pages/Reserves";
import Warehouses from "../../../client/src/pages/Warehouses";
import "../../../client/src/index.css";

const mode = new URLSearchParams(location.search).get("mode");
const client = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      retry: false,
      refetchOnWindowFocus: false,
    },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <AuthProvider>
      {mode === "warehouses"
        ? <Warehouses />
        : mode === "reserves"
          ? <Reserves />
          : <ChannelAllocation />}
    </AuthProvider>
  </QueryClientProvider>,
);
