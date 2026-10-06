import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { getQueryFn } from "../../../client/src/lib/queryClient";
import Returns from "../../../client/src/pages/Returns";
import { Toaster } from "../../../client/src/components/ui/toaster";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: {
  queries: { queryFn: getQueryFn({ on401: "throw" }),retry: false,refetchOnWindowFocus: false },
  mutations: { retry: false },
} });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <AuthProvider><Returns /><Toaster /></AuthProvider>
</QueryClientProvider>);
