import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";

import PurchaseOrderDetail from "../../PurchaseOrderDetail";

function renderFailure(path: string, status: number): string {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  client.getQueryCache().build(client, { queryKey: ["/api/purchase-orders/17"] }).setState({
    status: "error",
    fetchStatus: "idle",
    error: new Error(`${status}: Request failed`),
  });
  try {
    return renderToStaticMarkup(createElement(Router, {
      ssrPath: path,
      ssrSearch: "?tab=shipments&purchase=purchase%3A17%3Ashipments&via=shipment%3A42%3Acosts",
    }, createElement(QueryClientProvider, { client }, createElement(PurchaseOrderDetail))));
  } finally {
    client.clear();
  }
}

describe("Purchase order failure navigation", () => {
  it("offers Retry after a request failure while retaining the shipment return and purchase context", () => {
    const markup = renderFailure("/purchase-orders/17", 503).replace(/&amp;/g, "&");
    expect(markup).toContain("Unable to load purchase order.");
    expect(markup).toContain("Retry");
    expect(markup).toContain('aria-label="Purchase context"');
    expect(markup).toContain('href="/shipments/42?tab=costs&purchase=purchase%3A17%3Ashipments"');
    expect(markup).not.toContain("Purchase order not found.");
  });

  it("identifies a missing purchase without presenting a transient failure or Retry", () => {
    const markup = renderFailure("/purchase-orders/17", 404);
    expect(markup).toContain("Purchase order not found.");
    expect(markup).not.toContain("Unable to load purchase order.");
    expect(markup).not.toContain("Retry");
    expect(markup).toContain("Back to shipment #42");
  });

  it("keeps an invalid route in the missing state without adopting a valid record's cached error", () => {
    const markup = renderFailure("/purchase-orders/017", 503);
    expect(markup).toContain("Purchase order not found.");
    expect(markup).not.toContain("Unable to load purchase order.");
    expect(markup).not.toContain("Retry");
    expect(markup).toContain("Back to shipment #42");
  });
});
