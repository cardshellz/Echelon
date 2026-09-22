import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { WalmartChannelWorkspace } from "../../../client/src/pages/WalmartChannelPage";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <AuthProvider><WalmartChannelWorkspace channelId={77} /></AuthProvider>
</QueryClientProvider>);
