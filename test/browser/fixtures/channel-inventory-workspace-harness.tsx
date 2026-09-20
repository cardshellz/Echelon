// Frontend-only entry. API calls are intercepted by the browser suite.
import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { Toaster } from "../../../client/src/components/ui/toaster";
import ChannelInventory from "../../../client/src/pages/ChannelInventory";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
window.addEventListener("channel-inventory-test-refresh", () => { void client.invalidateQueries(); });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <AuthProvider><ChannelInventory /><Toaster /></AuthProvider>
</QueryClientProvider>);
