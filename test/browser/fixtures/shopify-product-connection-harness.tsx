import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { Toaster } from "../../../client/src/components/ui/toaster";
import { ShopifyProductConnectionActions } from "../../../client/src/components/catalog/ShopifyProductConnection";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><AuthProvider><main className="p-4">
    <h1>Shopify Product Mapping</h1><ShopifyProductConnectionActions productId={41} />
  </main><Toaster /></AuthProvider></QueryClientProvider>,
);
