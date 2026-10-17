import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CustomerOrderEditor } from "../../../client/src/customer-account/CustomerOrderEditor";
import { createCustomerAccountTransport } from "../../../client/src/customer-account/customer-account.transport";
import "../../../client/src/index.css";
import "../../../client/src/customer-account/storefront.css";

// Real customer component and signed-account transport; the spec mocks only HTTP.
const api = createCustomerAccountTransport({
  themeId: "174740308127",
  customerId: "100",
  proxyPath: "/apps/echelon-returns",
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const onBusy = () => {};
await api.bootstrap();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <div className="csz-account-ui">
      <CustomerOrderEditor
        api={api}
        connectionId={4}
        omsOrderId={1}
        actorKey="customer:36:100"
        enabled={true}
        onBusy={onBusy}
      />
    </div>
  </QueryClientProvider>,
);
