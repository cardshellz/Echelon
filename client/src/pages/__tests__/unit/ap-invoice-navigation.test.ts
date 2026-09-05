import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";

import APInvoiceDetail from "../../APInvoiceDetail";
import { useProcurementNavigation } from "../../../hooks/use-procurement-navigation";

const invoice = {
  id: 71,
  invoiceNumber: "VENDOR-071",
  vendorName: "Example Supplier",
  status: "paid",
  inboundShipmentId: 42,
  invoicedAmountCents: 1800000,
  paidAmountCents: 1800000,
  balanceCents: 0,
  poLinks: [{ id: 1, purchaseOrderId: 99, poNumber: "PO-0099" }],
  lines: [],
  payments: [],
  attachments: [],
};

function renderAt(href: string, component: ReactElement): string {
  const url = new URL(href, "https://echelon.test");
  return renderToStaticMarkup(createElement(Router, {
    ssrPath: url.pathname,
    ssrSearch: url.search,
  }, component));
}

function navigationAt(href: string, destination = "/shipments/42") {
  let result: {
    childHref: string;
    backHref: string;
    purchaseHref: string | null;
    purchaseId: number | null;
    tab: string;
  } | undefined;
  function Probe() {
    const navigation = useProcurementNavigation();
    result = {
      childHref: navigation.childHref(destination),
      backHref: navigation.backHref("/ap-invoices"),
      purchaseHref: navigation.purchaseHref,
      purchaseId: navigation.purchaseId,
      tab: navigation.tab,
    };
    return null;
  }
  renderAt(href, createElement(Probe));
  if (!result) throw new Error("Navigation probe did not render.");
  return result;
}

function renderInvoice(href: string, state: "loaded" | "loading" | "error" | "missing" = "loaded") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  const queryKey = ["/api/vendor-invoices/71"];
  if (state === "loaded") queryClient.setQueryData(queryKey, invoice);
  if (state === "missing") queryClient.setQueryData(queryKey, null);
  if (state === "error") {
    queryClient.getQueryCache().build(queryClient, { queryKey }).setState({
      status: "error",
      fetchStatus: "idle",
      error: new Error("503: Service unavailable"),
    });
  }
  try {
    return renderAt(href, createElement(QueryClientProvider, { client: queryClient }, createElement(APInvoiceDetail)));
  } finally {
    queryClient.clear();
  }
}

function anchors(markup: string) {
  return [...markup.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: match[1].replace(/&amp;/g, "&"),
    text: match[2].replace(/<[^>]*>/g, ""),
  }));
}

function purchaseJourney(invoiceTab = "lines") {
  const shipmentHref = navigationAt("/purchase-orders/17?tab=shipments", "/shipments/42?tab=costs").childHref;
  const invoiceHref = navigationAt(shipmentHref, `/ap-invoices/71?tab=${invoiceTab}`).childHref;
  return { shipmentHref, invoiceHref };
}

describe("AP invoice purchase navigation", () => {
  it("renders a native return link to the original shipment Costs tab and purchase anchor", () => {
    const { shipmentHref, invoiceHref } = purchaseJourney("details");
    const markup = renderInvoice(invoiceHref);
    const links = anchors(markup);

    expect(links.some((link) => link.href === shipmentHref)).toBe(true);
    expect(markup).toContain("Invoice Details");
    expect(markup).not.toContain("Invoice Line Items");
    const purchaseHref = navigationAt(invoiceHref).purchaseHref;
    expect(purchaseHref).not.toBeNull();
    expect(links.some((link) => link.href === purchaseHref)).toBe(true);
    expect(navigationAt(shipmentHref).tab).toBe("costs");
    expect(navigationAt(shipmentHref).purchaseId).toBe(17);
  });

  it("keeps the originating purchase when inspecting another PO on a shared invoice", () => {
    const { invoiceHref } = purchaseJourney();
    const links = anchors(renderInvoice(invoiceHref));
    const purchaseLink = links.find((link) => link.text === "PO-0099");

    expect(purchaseLink).toBeDefined();
    expect(new URL(purchaseLink!.href, "https://echelon.test").pathname).toBe("/purchase-orders/99");
    expect(navigationAt(purchaseLink!.href).purchaseId).toBe(17);
    expect(navigationAt(purchaseLink!.href).backHref).toBe(invoiceHref);
  });

  it("carries the invoice return path and purchase context on the source shipment link", () => {
    const { invoiceHref } = purchaseJourney("attachments");
    const links = anchors(renderInvoice(invoiceHref));
    const shipmentLink = links.find((link) => link.text.includes("Source: Shipment"));

    expect(shipmentLink).toBeDefined();
    expect(navigationAt(shipmentLink!.href).purchaseId).toBe(17);
    expect(navigationAt(shipmentLink!.href).backHref).toBe(invoiceHref);
  });

  it("restores a directly opened invoice tab and safely defaults invalid tabs", () => {
    expect(renderInvoice("/ap-invoices/71?tab=attachments")).toContain("No attachments.");
    expect(renderInvoice("/ap-invoices/71?tab=not-a-tab")).toContain("Invoice Line Items");
    expect(anchors(renderInvoice("/ap-invoices/71")).some((link) => link.href === "/ap-invoices")).toBe(true);
  });

  it.each(["loading", "error", "missing"] as const)("retains the purchase anchor and return link while %s", (state) => {
    const { shipmentHref, invoiceHref } = purchaseJourney();
    const markup = renderInvoice(invoiceHref, state);
    const links = anchors(markup);

    expect(links.some((link) => link.href === shipmentHref)).toBe(true);
    expect(links.some((link) => link.href === navigationAt(invoiceHref).purchaseHref)).toBe(true);
    if (state === "loading") expect(markup).toContain('aria-label="Loading invoice"');
    if (state === "error") {
      expect(markup).toContain("Unable to load invoice.");
      expect(markup).toContain("Retry");
      expect(markup).not.toContain("Invoice not found.");
    }
    if (state === "missing") expect(markup).toContain("Invoice not found.");
  });
});
