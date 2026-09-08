import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { EbayListingSetupPanel } from "../../../client/src/pages/dropship/EbayListingSetupPanel";
import { EbayListingPolicyOverridePanel } from "../../../client/src/pages/dropship/EbayListingPolicyOverridePanel";
import type { DropshipCatalogRow } from "../../../client/src/lib/dropship-ops-surface";
import "../../../client/src/index.css";

const rows = [{ productVariantId: 101, productName: "Armalope Envelope", variantName: "Pack of 50", variantSku: "ARM-50" }] as DropshipCatalogRow[];
function Harness() {
  const [invalidations, setInvalidations] = useState(0);
  const [showSetup, setShowSetup] = useState(true);
  const onConfigurationChange = () => setInvalidations((count) => count + 1);
  return <QueryClientProvider client={queryClient}><main className="mx-auto max-w-5xl space-y-4 p-3">
    <output aria-label="Preview invalidations">{invalidations}</output>
    <button onClick={() => setShowSetup((shown) => !shown)}>Toggle setup panel</button>
    {showSetup && <EbayListingSetupPanel storeConnectionId={1} storeName="Test store" onConfigurationChange={onConfigurationChange} />}
    <EbayListingPolicyOverridePanel storeConnectionId={1} storeName="Test store" rows={rows} onConfigurationChange={onConfigurationChange} />
  </main></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
