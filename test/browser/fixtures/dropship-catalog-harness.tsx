import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipAuthProvider } from "../../../client/src/lib/dropship-auth";
import { queryClient as appQueryClient } from "../../../client/src/lib/queryClient";
import DropshipPortalCatalog from "../../../client/src/pages/dropship/DropshipPortalCatalog";
import "../../../client/src/index.css";

// The real Catalog page under the real auth provider; every API call is stubbed by the spec. A journey can ask for the
// app's own client (`serveAppQueryClient` in the stubs: staleTime Infinity, refetchOnMount "always", as App.tsx serves the
// portal) to see what production keeps in its cache; every other journey keeps this harness's client.
const wantsAppClient = (window as Window & { __CATALOG_APP_QUERY_CLIENT__?: boolean }).__CATALOG_APP_QUERY_CLIENT__ === true;
const client = wantsAppClient ? appQueryClient : new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <DropshipAuthProvider>
      <DropshipPortalCatalog />
    </DropshipAuthProvider>
  </QueryClientProvider>,
);
