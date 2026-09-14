import React from "react";
import { createRoot } from "react-dom/client";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { BoxCatalogTab } from "../../../client/src/pages/ShippingSettings";
import { DropshipSharedShippingPanel } from "../../../client/src/components/shipping/DropshipSharedShippingPanel";
import { BoxSuitesPanel } from "../../../client/src/components/shipping/BoxSuitesPanel";
import { PackagingAssignmentsPanel } from "../../../client/src/components/shipping/PackagingAssignmentsPanel";
import { ProgramChargesPanel } from "../../../client/src/components/shipping/pricing-programs/ProgramChargesPanel";
import { WarehousePackagingPanel } from "../../../client/src/components/shipping/WarehousePackagingPanel";
import { Toaster } from "../../../client/src/components/ui/toaster";
import { InventoryCutoverOpeningPanel } from "../../../client/src/pages/inventory-cutover-opening-panel";
import "../../../client/src/index.css";

const mode = new URLSearchParams(location.search).get("mode");
const browserState = window as unknown as { __inventoryOpeningChanged?: number };
browserState.__inventoryOpeningChanged = 0;
function CatalogHarness() {
  const query = useQuery({
    queryKey: ["/api/shipping/admin/config"],
    queryFn: async () => (await fetch("/api/shipping/admin/config")).json(),
  });
  return (
    <BoxCatalogTab
      boxes={query.data?.boxes ?? []}
      isLoading={query.isLoading}
    />
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {mode === "warehouse" || mode === "warehouse100" ? (
      <WarehousePackagingPanel canEdit />
    ) : mode === "catalog" ? (
      <CatalogHarness />
    ) : mode === "suites" ? (
      <BoxSuitesPanel />
    ) : mode === "assignments" || mode === "assignments-none" ? (
      <PackagingAssignmentsPanel />
    ) : mode === "charges" ? (
      <ProgramChargesPanel bookId={1} />
    ) : mode === "inventory-opening" ? (
      <InventoryCutoverOpeningPanel actorId="operator-1" canActivate
        onStateChanged={() => { browserState.__inventoryOpeningChanged = (browserState.__inventoryOpeningChanged ?? 0) + 1; }} />
    ) : (
      <DropshipSharedShippingPanel />
    )}
    <Toaster />
  </QueryClientProvider>,
);
