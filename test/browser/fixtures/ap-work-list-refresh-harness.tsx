import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import APInvoices from "../../../client/src/pages/APInvoices";
import { AddInvoiceFromCostsModal } from "../../../client/src/components/shipment/AddInvoiceFromCostsModal";
import "../../../client/src/index.css";
function Harness() {
  const [open, setOpen] = useState(false);
  return <QueryClientProvider client={queryClient}><button onClick={() => setOpen(true)}>Create shipment invoice</button><APInvoices /><AddInvoiceFromCostsModal open={open} onOpenChange={setOpen} shipmentId={42}/></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
