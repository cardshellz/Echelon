// Frontend-only entry; never imported by the application.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { getQueryFn } from "../../../client/src/lib/queryClient";
import Transfers from "../../../client/src/pages/Transfers";
import { Toaster } from "../../../client/src/components/ui/toaster";
import "../../../client/src/index.css";
const client = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({
        on401: "throw"
      }), retry: false, refetchOnWindowFocus: false
    }, mutations: {
      retry: false
    }
  }
});
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><AuthProvider><Transfers /><Toaster /></AuthProvider></QueryClientProvider>);
