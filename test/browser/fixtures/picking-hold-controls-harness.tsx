import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { SettingsProvider } from "../../../client/src/lib/settings";
import { getQueryFn } from "../../../client/src/lib/queryClient";
import { TooltipProvider } from "../../../client/src/components/ui/tooltip";
import { Toaster } from "../../../client/src/components/ui/toaster";
import PickingPage from "../../../client/src/pages/Picking";
import "../../../client/src/index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false },
    mutations: { retry: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <SettingsProvider>
        <TooltipProvider>
          <PickingPage />
          <Toaster />
        </TooltipProvider>
      </SettingsProvider>
    </AuthProvider>
  </QueryClientProvider>,
);
