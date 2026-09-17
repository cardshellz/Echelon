import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { SettingsProvider } from "../../../client/src/lib/settings";
import { AuthProvider } from "../../../client/src/lib/auth";
import { PageDataHealth } from "../../../client/src/components/page-data-health";
import Orders from "../../../client/src/pages/Orders";
import OmsOrders from "../../../client/src/pages/OmsOrders";
import OrderHistory from "../../../client/src/pages/OrderHistory";
import InventoryHistory from "../../../client/src/pages/InventoryHistory";
import Picking from "../../../client/src/pages/Picking";
import "../../../client/src/index.css";

function ExamplePage() {
  const { data } = useQuery({ queryKey: ["/api/test/page-data"] });
  return <p>{data ? "Page data loaded" : "Page data unavailable"}</p>;
}
function HealthHarness() {
  const [mounted, setMounted] = useState(true);
  return <><PageDataHealth /><button onClick={() => setMounted(false)}>Leave page</button>{mounted && <ExamplePage />}</>;
}
const mode = new URLSearchParams(location.search).get("mode");
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider><SettingsProvider>
      {mode === "health" ? <HealthHarness /> : mode === "oms" ? <OmsOrders /> :
        mode === "history" ? <OrderHistory /> : mode === "inventory" ? <InventoryHistory /> : mode === "picking" ? <Picking /> : <Orders />}
    </SettingsProvider></AuthProvider>
  </QueryClientProvider>,
);
