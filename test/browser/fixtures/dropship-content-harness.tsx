import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DropshipListingContentEditor } from "../../../client/src/pages/dropship/DropshipListingContentEditor";
import { DropshipContentTemplatesPanel } from "../../../client/src/pages/dropship/DropshipContentTemplatesPanel";
import "../../../client/src/index.css";
const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
function Harness() {
  const [token, setToken] = useState<string | undefined>();
  const callbacks = { onSaveStarted() {}, onSaveSettled() {}, async onSaved() {
    const state = window as unknown as { __contentRefreshed?: number };
    state.__contentRefreshed = (state.__contentRefreshed ?? 0) + 1;
    const result = await (await fetch("/api/dropship/listings/stores/22/variants/101/content")).json();
    setToken(result.content.resolved.evidenceHash);
  } };
  return <QueryClientProvider client={client}><div className="space-y-4">
    <DropshipContentTemplatesPanel storeConnectionId={22} storeName="Test store" {...callbacks} />
    <DropshipListingContentEditor storeConnectionId={22} productVariantId={101} previewEvidenceHash={token} {...callbacks} />
  </div></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
