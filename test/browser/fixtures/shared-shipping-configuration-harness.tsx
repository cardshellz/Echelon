import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipSharedShippingPanel } from "../../../client/src/components/shipping/DropshipSharedShippingPanel";
import { BoxSuitesPanel } from "../../../client/src/components/shipping/BoxSuitesPanel";
import { ProgramChargesPanel } from "../../../client/src/components/shipping/pricing-programs/ProgramChargesPanel";
import "../../../client/src/index.css";

const mode = new URLSearchParams(location.search).get("mode");
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider
    client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
  >
    {mode === "suites" ? (
      <BoxSuitesPanel />
    ) : mode === "charges" ? (
      <ProgramChargesPanel bookId={1} />
    ) : (
      <DropshipSharedShippingPanel />
    )}
  </QueryClientProvider>,
);
