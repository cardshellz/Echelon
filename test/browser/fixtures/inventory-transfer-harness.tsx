import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { getQueryFn } from "../../../client/src/lib/queryClient";
import InlineTransferDialog from "../../../client/src/components/operations/InlineTransferDialog";
import { Toaster } from "../../../client/src/components/ui/toaster";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: {
  queries: { queryFn: getQueryFn({ on401: "throw" }), retry: false, refetchOnWindowFocus: false },
  mutations: { retry: false },
} });
function Harness() {
  const [open, setOpen] = useState(false);
  const fixed = new URLSearchParams(location.search).get("fixed") !== "false";
  return <><button onClick={() => setOpen(true)}>Move cases</button>
    <InlineTransferDialog open={open} onOpenChange={setOpen}
      defaultFromLocationId={fixed ? 9 : undefined} defaultFromLocationCode={fixed ? "FLOOR-01" : undefined}
      defaultVariantId={fixed ? 174 : undefined} defaultSku={fixed ? "SHLZ-SEMI-OVR-C2000" : undefined} />
    <Toaster /></>;
}
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}><AuthProvider><Harness /></AuthProvider></QueryClientProvider>);
