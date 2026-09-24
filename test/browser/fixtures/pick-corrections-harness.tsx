import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PickCorrections } from "../../../client/src/features/picking/PickCorrections";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <PickCorrections userId="picker" canPerform={!new URLSearchParams(location.search).has("readonly")} />
  <main className="p-4"><h1>Picking queue</h1><p>The original order has shipped; ordinary picks stay closed.</p></main>
</QueryClientProvider>);
