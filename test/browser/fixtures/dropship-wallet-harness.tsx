import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipAuthProvider } from "../../../client/src/lib/dropship-auth";
import DropshipPortalWallet from "../../../client/src/pages/dropship/DropshipPortalWallet";
import "../../../client/src/index.css";

// The real page under the real auth provider; every API call is stubbed by the spec.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <DropshipAuthProvider>
      <DropshipPortalWallet />
    </DropshipAuthProvider>
  </QueryClientProvider>,
);
