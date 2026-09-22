import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import Products from "../../../client/src/pages/Products";
import { Toaster } from "../../../client/src/components/ui/toaster";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><AuthProvider><Products /><Toaster /></AuthProvider></QueryClientProvider>,
);
