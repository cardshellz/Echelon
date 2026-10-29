import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { AuthProvider } from "../../../client/src/lib/auth";
import { Toaster } from "../../../client/src/components/ui/toaster";
import { ShopifyProductMappingPanel } from "../../../client/src/pages/ProductDetail";
import ShopifyChannelPage from "../../../client/src/pages/ShopifyChannelPage";
import { InventoryStockSendButton } from "../../../client/src/features/channel-inventory/components/InventoryStockSend";
import "../../../client/src/index.css";

const surface = new URLSearchParams(location.search).get("surface");
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><AuthProvider>
  <main className="p-4">{surface === "channel" ? <ShopifyChannelPage /> : surface === "preview"
    ? <InventoryStockSendButton productId={41} channelId={7} publicationTargetId={9} />
    : <ShopifyProductMappingPanel productId={41} enabled />}</main><Toaster />
</AuthProvider></QueryClientProvider>);
