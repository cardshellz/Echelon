import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "../../../client/src/lib/queryClient";
import { DropshipCostChangePolicyPanel } from "../../../client/src/pages/dropship-cost-change-policy-panel";
import "../../../client/src/index.css";

// `?canEdit=false` renders the tab as a viewer without dropship:manage_operations.
const canEdit = new URLSearchParams(window.location.search).get("canEdit") !== "false";

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <main className="mx-auto max-w-6xl p-3">
      <DropshipCostChangePolicyPanel canView canEdit={canEdit} />
    </main>
  </QueryClientProvider>,
);
