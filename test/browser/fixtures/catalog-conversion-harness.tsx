import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { ProductConversionCard, ProductConversionSummary } from "../../../client/src/features/inventory-builds/ProductConversionCard";
import type { ProductInventoryStrategy } from "../../../shared/catalog/inventory-strategy";
import "../../../client/src/index.css";

const strategy = (new URLSearchParams(location.search).get("strategy") ?? "physical_fungible") as ProductInventoryStrategy;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><AuthProvider>
    <h1 className="mb-4 text-xl font-semibold">Product variants</h1>
    <div className="mb-4"><ProductConversionSummary productId={17} enabled /></div>
    <ProductConversionCard productId={17} inventoryStrategy={strategy} enabled />
    <button className="mt-6 text-sm underline" onClick={() => client.invalidateQueries()}>Refresh test data</button>
  </AuthProvider></QueryClientProvider>,
);
