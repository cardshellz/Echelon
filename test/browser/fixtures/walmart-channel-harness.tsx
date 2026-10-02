import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route } from "wouter";
import { AuthProvider } from "../../../client/src/lib/auth";
import { WalmartChannelRouteHost } from "../../../client/src/pages/WalmartChannelPage";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <AuthProvider><WalmartChannelRouteHost /><Route path="/test-other"><p>Another staff page</p></Route></AuthProvider>
</QueryClientProvider>);
