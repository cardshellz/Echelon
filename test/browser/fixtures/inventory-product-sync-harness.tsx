import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { AuthProvider } from "../../../client/src/lib/auth";
import { Toaster } from "../../../client/src/components/ui/toaster";
import { ProductInventorySyncPanel } from "../../../client/src/pages/ProductDetail";
import ShopifyChannelPage from "../../../client/src/pages/ShopifyChannelPage";
import { InventoryProductSyncButton } from "../../../client/src/features/channel-inventory/components/InventoryProductSync";
import "../../../client/src/index.css";

const surface = new URLSearchParams(location.search).get("surface");
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><AuthProvider>
  <main className="p-4">{surface === "channel" ? <ShopifyChannelPage /> : surface === "preview"
    ? <InventoryProductSyncButton productId={41} />
    : <ProductInventorySyncPanel productId={41} />}</main><Toaster />
</AuthProvider></QueryClientProvider>);
