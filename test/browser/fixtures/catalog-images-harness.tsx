import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../../client/src/lib/auth";
import { getQueryFn } from "../../../client/src/lib/queryClient";
import { Toaster } from "../../../client/src/components/ui/toaster";
import ProductDetail from "../../../client/src/pages/ProductDetail";
import "../../../client/src/index.css";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, queryFn: getQueryFn({ on401: "throw" }) } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><AuthProvider><ProductDetail /><Toaster /></AuthProvider></QueryClientProvider>,
);
