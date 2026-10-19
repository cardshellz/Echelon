// Frontend-only harness for an in-place ownership or permission refresh.
import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { AuthProvider, useAuth } from "../../../client/src/lib/auth";
import { Toaster } from "../../../client/src/components/ui/toaster";
import APInvoiceDetail from "../../../client/src/pages/APInvoiceDetail";
import InboundShipmentDetail from "../../../client/src/pages/InboundShipmentDetail";
import "../../../client/src/index.css";
const shipment = new URLSearchParams(window.location.search).get("screen") === "shipment";
window.history.replaceState(null, "", shipment ? "/shipments/42?tab=costs" : "/ap-invoices/71");
function Harness() {
  const { refetch } = useAuth();
  useEffect(() => {
    const refreshAuth = () => { void refetch(); };
    const refreshRecord = () => { void queryClient.invalidateQueries({ queryKey: [shipment ? "/api/inbound-shipments/42" : "/api/vendor-invoices/71"] }); };
    window.addEventListener("invoice-ownership-test-refresh-auth", refreshAuth);
    window.addEventListener("invoice-ownership-test-refresh-record", refreshRecord);
    return () => { window.removeEventListener("invoice-ownership-test-refresh-auth", refreshAuth); window.removeEventListener("invoice-ownership-test-refresh-record", refreshRecord); };
  }, [refetch]);
  return <>{shipment ? <InboundShipmentDetail /> : <APInvoiceDetail />}<Toaster /></>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><AuthProvider><Harness /></AuthProvider></QueryClientProvider>);
